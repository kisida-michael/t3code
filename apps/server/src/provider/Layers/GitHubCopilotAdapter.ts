import {
  type ContentBlock,
  type ContentChunk,
  type Plan,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallUpdate,
  type UsageUpdate,
} from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  createGitHubCopilotAcpConnection,
  GITHUB_COPILOT_MODE_IDS,
  type GitHubCopilotAcpConnection,
  killGitHubCopilotChildProcess,
} from "../githubCopilotAcp.ts";
import { resolveGitHubCopilotConfigDir } from "../githubCopilotSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterShape,
} from "../Services/GitHubCopilotAdapter.ts";

const PROVIDER = "githubCopilot" as const;

type CopilotPromptTurnState = {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly assistantItemId: RuntimeItemId;
  readonly reasoningItemId: RuntimeItemId;
  assistantText: string;
  reasoningText: string;
};

type PendingApproval = {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly resolve: (outcome: RequestPermissionOutcome) => void;
};

type CopilotTurnSnapshot = {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
};

type CopilotSessionContext = {
  session: ProviderSession;
  readonly child: GitHubCopilotAcpConnection["child"];
  readonly connection: GitHubCopilotAcpConnection["connection"];
  acpSessionId: string;
  currentModeId: string | undefined;
  currentModelId: string | undefined;
  configOptions: Map<string, SessionConfigOption>;
  currentTurn: CopilotPromptTurnState | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<CopilotTurnSnapshot>;
  stopping: boolean;
  suppressSessionUpdates: boolean;
};

export interface GitHubCopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("session not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (message.toLowerCase().includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: message,
    cause,
  });
}

function normalizeRequestType(tool: ToolCallUpdate): CanonicalRequestType {
  switch (tool.kind) {
    case "execute":
      return "command_execution_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    default:
      return "unknown";
  }
}

function normalizeItemType(tool: ToolCall | ToolCallUpdate): CanonicalItemType {
  switch (tool.kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    default:
      return "unknown";
  }
}

function itemIdForToolCall(toolCallId: string): RuntimeItemId {
  return RuntimeItemId.make(`github-copilot-tool:${toolCallId}`);
}

function detailFromToolCall(tool: ToolCall | ToolCallUpdate): string | undefined {
  if (typeof tool.title === "string" && tool.title.trim().length > 0) {
    return tool.title.trim();
  }
  if ("rawInput" in tool && tool.rawInput && typeof tool.rawInput === "object") {
    const command =
      "command" in tool.rawInput && typeof tool.rawInput.command === "string"
        ? tool.rawInput.command
        : undefined;
    if (command?.trim()) {
      return command.trim();
    }
  }
  if ("rawOutput" in tool && tool.rawOutput && typeof tool.rawOutput === "object") {
    const message =
      "message" in tool.rawOutput && typeof tool.rawOutput.message === "string"
        ? tool.rawOutput.message
        : undefined;
    if (message?.trim()) {
      return message.trim();
    }
  }
  return undefined;
}

function mapPlanEntries(
  plan: Plan["entries"],
): Array<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  return plan.map((entry) => ({
    step: entry.content,
    status:
      entry.status === "in_progress"
        ? "inProgress"
        : entry.status === "completed"
          ? "completed"
          : "pending",
  }));
}

function isTextChunk(update: SessionUpdate): update is Extract<SessionUpdate, ContentChunk> {
  return (
    update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk"
  );
}

function contentBlockText(block: ContentBlock): string | undefined {
  return block.type === "text" ? block.text : undefined;
}

function setSelectConfigValue(
  configOptions: Map<string, SessionConfigOption>,
  configId: string,
  value: string,
): { readonly configId: string; readonly value: string } | undefined {
  const option = configOptions.get(configId);
  if (!option || option.type !== "select") {
    return undefined;
  }
  const candidates = option.options.flatMap((candidate) =>
    "value" in candidate ? [candidate] : candidate.options,
  );
  return candidates.some((candidate) => candidate.value === value)
    ? { configId, value }
    : undefined;
}

async function applySessionSelection(
  context: CopilotSessionContext,
  input: {
    readonly model: string | undefined;
    readonly reasoningEffort: string | undefined;
    readonly interactionMode: "default" | "plan" | undefined;
  },
): Promise<void> {
  if (input.interactionMode) {
    const modeId =
      input.interactionMode === "plan"
        ? GITHUB_COPILOT_MODE_IDS.plan
        : GITHUB_COPILOT_MODE_IDS.default;
    if (context.currentModeId !== modeId) {
      await context.connection.setSessionMode({
        sessionId: context.acpSessionId,
        modeId,
      });
      context.currentModeId = modeId;
    }
  }

  if (input.model) {
    const modelSelection = setSelectConfigValue(context.configOptions, "model", input.model);
    if (modelSelection) {
      const response = await context.connection.setSessionConfigOption({
        sessionId: context.acpSessionId,
        configId: modelSelection.configId,
        value: modelSelection.value,
      });
      context.configOptions = new Map(response.configOptions.map((option) => [option.id, option]));
      context.currentModelId = input.model;
    }
  }

  if (input.reasoningEffort) {
    const effortSelection = setSelectConfigValue(
      context.configOptions,
      "reasoning_effort",
      input.reasoningEffort,
    );
    if (effortSelection) {
      const response = await context.connection.setSessionConfigOption({
        sessionId: context.acpSessionId,
        configId: effortSelection.configId,
        value: effortSelection.value,
      });
      context.configOptions = new Map(response.configOptions.map((option) => [option.id, option]));
    }
  }
}

function autoPermissionOutcome(
  runtimeMode: ProviderSession["runtimeMode"],
  tool: ToolCallUpdate,
): RequestPermissionOutcome | undefined {
  const allowAlways = { outcome: "selected" as const, optionId: "allow_always" };
  const allowOnce = { outcome: "selected" as const, optionId: "allow_once" };

  if (runtimeMode === "full-access") {
    return allowAlways;
  }

  if (runtimeMode === "auto-accept-edits") {
    switch (tool.kind) {
      case "edit":
      case "delete":
      case "move":
      case "read":
      case "search":
        return allowOnce;
      default:
        return undefined;
    }
  }

  return undefined;
}

function permissionOutcomeFromDecision(
  decision: ProviderApprovalDecision,
): RequestPermissionOutcome {
  switch (decision) {
    case "acceptForSession":
      return { outcome: "selected", optionId: "allow_always" };
    case "accept":
      return { outcome: "selected", optionId: "allow_once" };
    case "decline":
      return { outcome: "selected", optionId: "reject_once" };
    case "cancel":
    default:
      return { outcome: "cancelled" };
  }
}

const makeGitHubCopilotAdapter = Effect.fn("makeGitHubCopilotAdapter")(function* (
  options?: GitHubCopilotAdapterLiveOptions,
) {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CopilotSessionContext>();
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;

  const writeNativeEvent = (payload: unknown) =>
    nativeEventLogger
      ? nativeEventLogger.write(payload as Record<string, unknown>, null).pipe(Effect.ignore)
      : Effect.void;

  const emit = (event: ProviderRuntimeEvent) =>
    Effect.all([writeNativeEvent(event), Queue.offer(runtimeEventQueue, event)], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const buildSession = (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode: ProviderSession["runtimeMode"];
    readonly model: string | undefined;
    readonly resumeCursor: string | undefined;
  }): ProviderSession => ({
    provider: PROVIDER,
    status: "ready",
    runtimeMode: input.runtimeMode,
    threadId: input.threadId,
    ...(input.model ? { model: input.model } : {}),
    ...(input.resumeCursor ? { resumeCursor: input.resumeCursor } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const stopContext = Effect.fn("stopContext")(function* (context: CopilotSessionContext) {
    if (context.stopping) {
      return;
    }
    context.stopping = true;
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve({ outcome: "cancelled" });
    }
    context.pendingApprovals.clear();
    yield* Effect.sync(() => {
      killGitHubCopilotChildProcess(context.child);
    });
  });

  const handleSessionUpdate = (context: CopilotSessionContext, params: SessionNotification) =>
    Effect.gen(function* () {
      if (context.suppressSessionUpdates) {
        return;
      }

      const turn = context.currentTurn;
      if (!turn) {
        return;
      }

      const update = params.update;
      yield* writeNativeEvent({
        source: "githubCopilot.acp.session-update",
        payload: update,
        sessionId: context.acpSessionId,
        threadId: context.session.threadId,
      });

      if (update.sessionUpdate === "plan") {
        yield* emit({
          eventId: EventId.make(crypto.randomUUID()),
          type: "turn.plan.updated",
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          createdAt: nowIso(),
          payload: {
            plan: mapPlanEntries(update.entries),
          },
          raw: {
            source: "githubCopilot.acp.session-update",
            payload: update,
          },
        });
        return;
      }

      if (update.sessionUpdate === "usage_update") {
        const usageUpdate = update as UsageUpdate;
        yield* emit({
          eventId: EventId.make(crypto.randomUUID()),
          type: "thread.token-usage.updated",
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          createdAt: nowIso(),
          payload: {
            usage: {
              usedTokens: Math.max(0, usageUpdate.used),
              maxTokens: usageUpdate.size > 0 ? usageUpdate.size : undefined,
            },
          },
          raw: {
            source: "githubCopilot.acp.session-update",
            payload: update,
          },
        });
        return;
      }

      if (isTextChunk(update)) {
        const text = contentBlockText(update.content);
        if (!text) {
          return;
        }
        const isReasoning = update.sessionUpdate === "agent_thought_chunk";
        if (isReasoning) {
          turn.reasoningText += text;
        } else {
          turn.assistantText += text;
        }
        yield* emit({
          eventId: EventId.make(crypto.randomUUID()),
          type: "content.delta",
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          itemId: isReasoning ? turn.reasoningItemId : turn.assistantItemId,
          createdAt: nowIso(),
          payload: {
            streamKind: isReasoning ? "reasoning_text" : "assistant_text",
            delta: text,
          },
          raw: {
            source: "githubCopilot.acp.session-update",
            payload: update,
          },
        });
        return;
      }

      if (update.sessionUpdate === "tool_call") {
        const tool = update as ToolCall;
        yield* emit({
          eventId: EventId.make(crypto.randomUUID()),
          type: "item.started",
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          itemId: itemIdForToolCall(tool.toolCallId),
          createdAt: nowIso(),
          payload: {
            itemType: normalizeItemType(tool),
            status: tool.status === "failed" ? "failed" : "inProgress",
            title: tool.title,
            ...(detailFromToolCall(tool) ? { detail: detailFromToolCall(tool) } : {}),
            data: tool.rawInput,
          },
          raw: {
            source: "githubCopilot.acp.session-update",
            payload: update,
          },
        });
        return;
      }

      if (update.sessionUpdate === "tool_call_update") {
        const tool = update as ToolCallUpdate;
        const eventType =
          tool.status === "completed" || tool.status === "failed"
            ? "item.completed"
            : "item.updated";
        yield* emit({
          eventId: EventId.make(crypto.randomUUID()),
          type: eventType,
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          itemId: itemIdForToolCall(tool.toolCallId),
          createdAt: nowIso(),
          payload: {
            itemType: normalizeItemType(tool),
            ...(tool.status === "failed"
              ? { status: "failed" as const }
              : tool.status === "completed"
                ? { status: "completed" as const }
                : { status: "inProgress" as const }),
            ...(tool.title ? { title: tool.title } : {}),
            ...(detailFromToolCall(tool) ? { detail: detailFromToolCall(tool) } : {}),
            ...(tool.rawOutput !== undefined ? { data: tool.rawOutput } : {}),
          },
          raw: {
            source: "githubCopilot.acp.session-update",
            payload: update,
          },
        });
      }
    });

  const startSession: GitHubCopilotAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const existing = sessions.get(input.threadId);
      if (existing) {
        return existing.session;
      }

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((currentSettings) => currentSettings.providers.githubCopilot),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail:
                cause instanceof Error ? cause.message : "Failed to load GitHub Copilot settings.",
              cause,
            }),
        ),
      );

      const configDir = resolveGitHubCopilotConfigDir(settings);
      const connection = yield* Effect.tryPromise({
        try: () =>
          createGitHubCopilotAcpConnection({
            binaryPath: settings.binaryPath,
            ...(configDir ? { configDir } : {}),
            onRequestPermission: async (params: RequestPermissionRequest) => {
              const context = Array.from(sessions.values()).find(
                (candidate) => candidate.acpSessionId === params.sessionId,
              );
              if (!context) {
                return { outcome: { outcome: "cancelled" } };
              }
              const turnId = context.currentTurn?.turnId;
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const requestType = normalizeRequestType(params.toolCall);

              await Effect.runPromise(
                emit({
                  eventId: EventId.make(crypto.randomUUID()),
                  type: "request.opened",
                  provider: PROVIDER,
                  threadId: context.session.threadId,
                  ...(turnId ? { turnId } : {}),
                  requestId: RuntimeRequestId.make(requestId),
                  createdAt: nowIso(),
                  payload: {
                    requestType,
                    ...(detailFromToolCall(params.toolCall)
                      ? { detail: detailFromToolCall(params.toolCall) }
                      : {}),
                    args: params.toolCall.rawInput,
                  },
                  raw: {
                    source: "githubCopilot.acp.permission",
                    payload: params,
                  },
                }),
              );

              const autoOutcome = autoPermissionOutcome(
                context.session.runtimeMode,
                params.toolCall,
              );
              if (autoOutcome) {
                await Effect.runPromise(
                  emit({
                    eventId: EventId.make(crypto.randomUUID()),
                    type: "request.resolved",
                    provider: PROVIDER,
                    threadId: context.session.threadId,
                    ...(turnId ? { turnId } : {}),
                    requestId: RuntimeRequestId.make(requestId),
                    createdAt: nowIso(),
                    payload: {
                      requestType,
                      decision:
                        autoOutcome.outcome === "selected" ? autoOutcome.optionId : "cancelled",
                    },
                    raw: {
                      source: "githubCopilot.acp.permission",
                      payload: params,
                    },
                  }),
                );
                return { outcome: autoOutcome };
              }

              return await new Promise((resolve) => {
                context.pendingApprovals.set(requestId, {
                  threadId: context.session.threadId,
                  turnId,
                  requestId,
                  requestType,
                  resolve: async (outcome) => {
                    context.pendingApprovals.delete(requestId);
                    await Effect.runPromise(
                      emit({
                        eventId: EventId.make(crypto.randomUUID()),
                        type: "request.resolved",
                        provider: PROVIDER,
                        threadId: context.session.threadId,
                        ...(turnId ? { turnId } : {}),
                        requestId: RuntimeRequestId.make(requestId),
                        createdAt: nowIso(),
                        payload: {
                          requestType,
                          decision: outcome.outcome === "selected" ? outcome.optionId : "cancelled",
                        },
                        raw: {
                          source: "githubCopilot.acp.permission",
                          payload: params,
                        },
                      }),
                    );
                    resolve({ outcome });
                  },
                });
              });
            },
            onSessionUpdate: (params) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const context = Array.from(sessions.values()).find(
                    (candidate) => candidate.acpSessionId === params.sessionId,
                  );
                  if (!context) {
                    return;
                  }
                  yield* handleSessionUpdate(context, params);
                }),
              ),
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      let resumeCursor: string | undefined;
      const sessionResponse = yield* Effect.tryPromise({
        try: async () => {
          if (typeof input.resumeCursor === "string" && input.resumeCursor.trim().length > 0) {
            resumeCursor = input.resumeCursor;
            return await connection.connection.loadSession({
              sessionId: input.resumeCursor,
              cwd: input.cwd ?? process.cwd(),
              mcpServers: [],
            });
          }

          const createdSession = await connection.connection.newSession({
            cwd: input.cwd ?? process.cwd(),
            mcpServers: [],
          });
          resumeCursor = createdSession.sessionId;
          return createdSession;
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail:
              cause instanceof Error ? cause.message : "Failed to start GitHub Copilot session.",
            cause,
          }),
      }).pipe(
        Effect.tapError(() => Effect.sync(() => killGitHubCopilotChildProcess(connection.child))),
      );
      const acpSessionId: string =
        "sessionId" in sessionResponse ? String(sessionResponse.sessionId) : (resumeCursor ?? "");

      const context: CopilotSessionContext = {
        session: buildSession({
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          model: sessionResponse.models?.currentModelId ?? undefined,
          resumeCursor,
        }),
        child: connection.child,
        connection: connection.connection,
        acpSessionId,
        currentModeId: sessionResponse.modes?.currentModeId ?? undefined,
        currentModelId: sessionResponse.models?.currentModelId ?? undefined,
        configOptions: new Map(
          (sessionResponse.configOptions ?? []).map((option) => [option.id, option]),
        ),
        currentTurn: undefined,
        pendingApprovals: new Map(),
        turns: [],
        stopping: false,
        suppressSessionUpdates: Boolean(input.resumeCursor),
      };

      sessions.set(input.threadId, context);

      try {
        yield* Effect.tryPromise({
          try: () =>
            applySessionSelection(context, {
              model:
                input.modelSelection?.provider === PROVIDER
                  ? input.modelSelection.model
                  : undefined,
              reasoningEffort:
                input.modelSelection?.provider === PROVIDER
                  ? input.modelSelection.options?.reasoningEffort
                  : undefined,
              interactionMode: undefined,
            }),
          catch: (cause) => toRequestError(input.threadId, "session/configure", cause),
        });
      } finally {
        context.suppressSessionUpdates = false;
      }

      const currentModel =
        (input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined) ??
        context.currentModelId;
      context.session = {
        ...context.session,
        ...(currentModel ? { model: currentModel } : {}),
        ...(resumeCursor ? { resumeCursor } : {}),
      };

      yield* emit({
        eventId: EventId.make(crypto.randomUUID()),
        type: "session.started",
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: nowIso(),
        payload: resumeCursor ? { resume: resumeCursor } : {},
        raw: {
          source: "githubCopilot.acp.session-update",
          payload: sessionResponse,
        },
      });
      yield* emit({
        eventId: EventId.make(crypto.randomUUID()),
        type: "session.state.changed",
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: nowIso(),
        payload: { state: "ready" },
      });
      yield* emit({
        eventId: EventId.make(crypto.randomUUID()),
        type: "thread.started",
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: nowIso(),
        payload: {
          providerThreadId: context.acpSessionId,
        },
      });

      connection.child.on("exit", () => {
        const active = sessions.get(input.threadId);
        if (!active || active.stopping) {
          sessions.delete(input.threadId);
          return;
        }
        active.session = {
          ...active.session,
          status: "closed",
          updatedAt: nowIso(),
          lastError: "GitHub Copilot session exited unexpectedly.",
        };
        sessions.delete(input.threadId);
        void Effect.runPromise(
          emit({
            eventId: EventId.make(crypto.randomUUID()),
            type: "session.exited",
            provider: PROVIDER,
            threadId: input.threadId,
            createdAt: nowIso(),
            payload: {
              exitKind: "error",
              reason: "GitHub Copilot session exited unexpectedly.",
              recoverable: true,
            },
          }),
        );
      });

      return context.session;
    },
  );

  const sendTurn: GitHubCopilotAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.currentTurn) {
      return yield* Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/prompt",
          detail: "GitHub Copilot already has an active turn for this thread.",
        }),
      );
    }

    const turnId = TurnId.make(crypto.randomUUID());
    const turnState: CopilotPromptTurnState = {
      turnId,
      startedAt: nowIso(),
      assistantItemId: RuntimeItemId.make(`github-copilot-assistant:${turnId}`),
      reasoningItemId: RuntimeItemId.make(`github-copilot-reasoning:${turnId}`),
      assistantText: "",
      reasoningText: "",
    };
    context.currentTurn = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: nowIso(),
    };

    const inputText = input.input?.trim();
    const prompt: ContentBlock[] = [];
    if (inputText) {
      prompt.push({ type: "text", text: inputText });
    }
    for (const attachment of input.attachments ?? []) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        continue;
      }
      const exists = yield* fileSystem
        .exists(attachmentPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        continue;
      }
      prompt.push({
        type: "resource_link",
        name: attachment.name,
        uri: `file://${attachmentPath}`,
        mimeType: attachment.mimeType,
      });
    }

    yield* Effect.tryPromise({
      try: () =>
        applySessionSelection(context, {
          model:
            input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined,
          reasoningEffort:
            input.modelSelection?.provider === PROVIDER
              ? input.modelSelection.options?.reasoningEffort
              : undefined,
          interactionMode: input.interactionMode,
        }),
      catch: (cause) => toRequestError(input.threadId, "session/configure", cause),
    });

    const activeModel =
      (input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined) ??
      context.currentModelId;
    context.session = {
      ...context.session,
      ...(activeModel ? { model: activeModel } : {}),
      updatedAt: nowIso(),
    };

    yield* emit({
      eventId: EventId.make(crypto.randomUUID()),
      type: "session.state.changed",
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      turnId,
      payload: { state: "running" },
    });
    yield* emit({
      eventId: EventId.make(crypto.randomUUID()),
      type: "turn.started",
      provider: PROVIDER,
      threadId: input.threadId,
      turnId,
      createdAt: nowIso(),
      payload: {
        ...(activeModel ? { model: activeModel } : {}),
        ...(input.modelSelection?.provider === PROVIDER &&
        input.modelSelection.options?.reasoningEffort
          ? { effort: input.modelSelection.options.reasoningEffort }
          : {}),
      },
    });

    const response = yield* Effect.tryPromise({
      try: () =>
        context.connection.prompt({
          sessionId: context.acpSessionId,
          prompt,
        }),
      catch: (cause) => toRequestError(input.threadId, "session/prompt", cause),
    });

    if (turnState.reasoningText.trim().length > 0) {
      yield* emit({
        eventId: EventId.make(crypto.randomUUID()),
        type: "item.completed",
        provider: PROVIDER,
        threadId: input.threadId,
        turnId,
        itemId: turnState.reasoningItemId,
        createdAt: nowIso(),
        payload: {
          itemType: "reasoning",
          status: "completed",
          detail: turnState.reasoningText.trim(),
        },
      });
    }

    if (turnState.assistantText.trim().length > 0) {
      yield* emit({
        eventId: EventId.make(crypto.randomUUID()),
        type: "item.completed",
        provider: PROVIDER,
        threadId: input.threadId,
        turnId,
        itemId: turnState.assistantItemId,
        createdAt: nowIso(),
        payload: {
          itemType: "assistant_message",
          status: response.stopReason === "cancelled" ? "declined" : "completed",
          detail: turnState.assistantText.trim(),
        },
      });
    }

    const completedState =
      response.stopReason === "cancelled"
        ? "cancelled"
        : response.stopReason === "refusal"
          ? "failed"
          : "completed";

    yield* emit({
      eventId: EventId.make(crypto.randomUUID()),
      type: "turn.completed",
      provider: PROVIDER,
      threadId: input.threadId,
      turnId,
      createdAt: nowIso(),
      payload: {
        state: completedState,
        stopReason: response.stopReason,
        ...(turnState.assistantText.trim().length === 0 && completedState === "failed"
          ? { errorMessage: "GitHub Copilot did not return an assistant message." }
          : {}),
      },
    });

    context.turns.push({
      id: turnId,
      items: [
        ...(turnState.reasoningText ? [{ type: "reasoning", text: turnState.reasoningText }] : []),
        ...(turnState.assistantText
          ? [{ type: "assistant_message", text: turnState.assistantText }]
          : []),
      ],
    });
    context.currentTurn = undefined;
    const { activeTurnId: _completedTurnId, ...sessionWithoutActiveTurn } = context.session;
    context.session = {
      ...sessionWithoutActiveTurn,
      status: "ready",
      updatedAt: nowIso(),
      ...(activeModel ? { model: activeModel } : {}),
    };

    yield* emit({
      eventId: EventId.make(crypto.randomUUID()),
      type: "session.state.changed",
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      payload: { state: "ready" },
    });

    return {
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor ? { resumeCursor: context.session.resumeCursor } : {}),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: GitHubCopilotAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => context.connection.cancel({ sessionId: context.acpSessionId }),
        catch: (cause) => toRequestError(threadId, "session/cancel", cause),
      });
    },
  );

  const readThread: GitHubCopilotAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return {
        threadId,
        turns: [...context.turns],
      };
    },
  );

  const rollbackThread: GitHubCopilotAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId) {
      yield* requireSession(threadId);
      return yield* Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail:
            "GitHub Copilot ACP sessions do not currently support server-side conversation rollback.",
        }),
      );
    },
  );

  const respondToRequest: GitHubCopilotAdapterShape["respondToRequest"] = Effect.fn(
    "respondToRequest",
  )(function* (threadId, requestId, decision) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "requestPermission",
          detail: `Unknown pending approval request: ${requestId}`,
        }),
      );
    }
    pending.resolve(permissionOutcomeFromDecision(decision));
  });

  const respondToUserInput: GitHubCopilotAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (_threadId, _requestId, _answers: ProviderUserInputAnswers) {
    return yield* Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input",
        detail: "GitHub Copilot ACP user-input requests are not implemented.",
      }),
    );
  });

  const stopSession: GitHubCopilotAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopContext(context);
      sessions.delete(threadId);
      yield* emit({
        eventId: EventId.make(crypto.randomUUID()),
        type: "session.exited",
        provider: PROVIDER,
        threadId,
        createdAt: nowIso(),
        payload: {
          exitKind: "graceful",
          reason: "Session stopped",
          recoverable: true,
        },
      });
    },
  );

  const listSessions: GitHubCopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => context.session));

  const hasSession: GitHubCopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const stopAll: GitHubCopilotAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
    yield* Effect.forEach(Array.from(sessions.values()), stopContext, {
      concurrency: "unbounded",
      discard: true,
    });
    sessions.clear();
  });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies GitHubCopilotAdapterShape;
});

export const GitHubCopilotAdapterLive = Layer.effect(
  GitHubCopilotAdapter,
  makeGitHubCopilotAdapter(),
);

export function makeGitHubCopilotAdapterLive(options?: GitHubCopilotAdapterLiveOptions) {
  return Layer.effect(GitHubCopilotAdapter, makeGitHubCopilotAdapter(options));
}
