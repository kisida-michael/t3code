import type {
  GitHubCopilotSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Duration, Effect, Equal, Layer, Option, Result, Stream } from "effect";

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
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "githubCopilot" as const;

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

const parseModelsFromHelp = (result: CommandResult): ReadonlyArray<ServerProviderModel> => {
  const output = `${result.stdout}\n${result.stderr}`;
  const choiceList = output.match(/--model <model>[\s\S]*?\(choices:\s*([^)]+)\)/)?.[1];
  if (!choiceList) {
    return FALLBACK_BUILT_IN_MODELS;
  }

  const models = choiceList
    .split(",")
    .map((entry) => entry.replace(/["']/g, "").trim())
    .filter((entry) => entry.length > 0)
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
    const builtInModels =
      Result.isSuccess(helpProbe) && Option.isSome(helpProbe.success)
        ? parseModelsFromHelp(helpProbe.success.value)
        : FALLBACK_BUILT_IN_MODELS;
    const models = providerModelsFromSettings(
      builtInModels,
      PROVIDER,
      settings.customModels,
      DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
    );

    if (!settings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
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
        models,
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
        models,
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
        models,
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
