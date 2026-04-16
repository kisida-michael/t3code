import type {
  GitHubCopilotSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Data, Duration, Effect, Equal, Layer, Option, Result, Stream } from "effect";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  createGitHubCopilotAcpConnection,
  killGitHubCopilotChildProcess,
} from "../githubCopilotAcp";
import { resolveGitHubCopilotConfigDir } from "../githubCopilotSettings";
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "githubCopilot" as const;

class GitHubCopilotSessionModelProbeError extends Data.TaggedError(
  "GitHubCopilotSessionModelProbeError",
)<{ cause: unknown }> {}

const DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} satisfies NonNullable<ServerProviderModel["capabilities"]>;

const FALLBACK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5-mini",
    name: "GPT-5 mini",
    isCustom: false,
    capabilities: DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-4.1",
    name: "GPT-4.1",
    isCustom: false,
    capabilities: DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
  },
];

const toTitleCaseLabel = (slug: string): string =>
  slug
    .split("-")
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) {
        return part;
      }
      if (part.length <= 3) {
        return part.toUpperCase();
      }
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join(" ");

const buildModelsFromSlugs = (slugs: ReadonlyArray<string>): ReadonlyArray<ServerProviderModel> => {
  const seen = new Set<string>();
  const models = slugs
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !seen.has(entry) && seen.add(entry))
    .map(
      (slug) =>
        ({
          slug,
          name: toTitleCaseLabel(slug),
          isCustom: false,
          capabilities: DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
        }) satisfies ServerProviderModel,
    );

  return models.length > 0 ? models : FALLBACK_BUILT_IN_MODELS;
};

function extractOptionHelpBlock(output: string, optionPattern: RegExp): string | null {
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !optionPattern.test(line)) {
      continue;
    }

    const block = [line];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      if (!nextLine?.trim()) {
        break;
      }
      if (/^\s{2,}\S/.test(nextLine) && !/^\s{2,}--/.test(nextLine)) {
        block.push(nextLine);
        continue;
      }
      break;
    }
    return block.join("\n");
  }

  return null;
}

export const parseModelsFromHelp = (result: CommandResult): ReadonlyArray<ServerProviderModel> => {
  const output = `${result.stdout}\n${result.stderr}`;
  const modelOptionBlock = extractOptionHelpBlock(output, /--model <model>/);
  const choiceList = modelOptionBlock?.match(/\(choices:\s*([^)]+)\)/)?.[1];
  if (!choiceList) {
    return FALLBACK_BUILT_IN_MODELS;
  }

  return buildModelsFromSlugs(
    choiceList.split(",").map((entry) => entry.replace(/["']/g, "").trim()),
  );
};

export const modelsFromSessionConfigOptions = (
  configOptions: ReadonlyArray<SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> => {
  const modelOption = configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.id === "model" && option.type === "select",
  );
  if (!modelOption) {
    return FALLBACK_BUILT_IN_MODELS;
  }

  const choices = modelOption.options.flatMap((candidate) =>
    "value" in candidate ? [candidate.value] : candidate.options.map((option) => option.value),
  );
  return buildModelsFromSlugs(choices);
};

const runGitHubCopilotCommand = Effect.fn("runGitHubCopilotCommand")(function* (
  args: ReadonlyArray<string>,
) {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.map((currentSettings) => currentSettings.providers.githubCopilot),
  );
  const command = ChildProcess.make(settings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(settings.binaryPath, command);
});

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* () {
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.map((currentSettings) => currentSettings.providers.githubCopilot),
    );
    const checkedAt = new Date().toISOString();
    const helpProbe = yield* runGitHubCopilotCommand(["help"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );
    const helpModels =
      Result.isSuccess(helpProbe) && Option.isSome(helpProbe.success)
        ? parseModelsFromHelp(helpProbe.success.value)
        : FALLBACK_BUILT_IN_MODELS;
    const fallbackModels = providerModelsFromSettings(
      helpModels,
      PROVIDER,
      settings.customModels,
      DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
    );

    if (!settings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    const versionProbe = yield* runGitHubCopilotCommand(["version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : `Failed to execute GitHub Copilot CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "GitHub Copilot CLI timed out while running the version command.",
        },
      });
    }

    const versionResult = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(
      `${versionResult.stdout}\n${versionResult.stderr}`,
    );
    if (versionResult.code !== 0) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message:
            detailFromResult(versionResult) ?? "GitHub Copilot CLI failed its version check.",
        },
      });
    }

    const sessionModelProbe = yield* Effect.tryPromise({
      try: async () => {
        const configDir = resolveGitHubCopilotConfigDir(settings);
        const connection = await createGitHubCopilotAcpConnection({
          binaryPath: settings.binaryPath,
          ...(configDir ? { configDir } : {}),
          onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          onSessionUpdate: async () => {},
        });

        try {
          const session = await connection.connection.newSession({
            cwd: process.cwd(),
            mcpServers: [],
          });
          return modelsFromSessionConfigOptions(session.configOptions ?? []);
        } finally {
          killGitHubCopilotChildProcess(connection.child);
        }
      },
      catch: (cause) => new GitHubCopilotSessionModelProbeError({ cause }),
    }).pipe(Effect.timeoutOption(Duration.millis(DEFAULT_TIMEOUT_MS)), Effect.result);

    const sessionModels =
      Result.isSuccess(sessionModelProbe) && Option.isSome(sessionModelProbe.success)
        ? sessionModelProbe.success.value
        : helpModels;

    const models = providerModelsFromSettings(
      sessionModels,
      PROVIDER,
      settings.customModels,
      DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
    );

    const auth: ServerProviderAuth = { status: "unknown" };
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth,
        message:
          "GitHub Copilot CLI is installed. Authentication and account-scoped model availability are verified when a session starts.",
      },
    });
  },
);

const makePendingGitHubCopilotProvider = (settings: GitHubCopilotSettings): ServerProvider =>
  buildServerProvider({
    provider: PROVIDER,
    enabled: settings.enabled,
    checkedAt: new Date().toISOString(),
    models: providerModelsFromSettings(
      FALLBACK_BUILT_IN_MODELS,
      PROVIDER,
      settings.customModels,
      DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
    ),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking GitHub Copilot CLI installation and configuration."
        : "GitHub Copilot is disabled in T3 Code settings.",
    },
  });

export const GitHubCopilotProviderLive = Layer.effect(
  GitHubCopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkGitHubCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GitHubCopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.githubCopilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.githubCopilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingGitHubCopilotProvider,
      checkProvider,
      refreshInterval: Duration.seconds(60),
    });
  }),
);
