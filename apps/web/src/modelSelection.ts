import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type GitHubCopilotModelOptions,
  type ModelSelection,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
  PROVIDER_KINDS,
} from "@t3tools/contracts";
import { normalizeModelSlug, resolveSelectableModel } from "@t3tools/shared/model";
import { getComposerProviderState } from "./components/chat/composerProviderRegistry";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex":
      return options
        ? { provider, model, options: options as CodexModelOptions }
        : { provider, model };
    case "claudeAgent":
      return options
        ? { provider, model, options: options as ClaudeModelOptions }
        : { provider, model };
    case "githubCopilot":
      return options
        ? { provider, model, options: options as GitHubCopilotModelOptions }
        : { provider, model };
  }
}

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  codex: {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
  githubCopilot: {
    provider: "githubCopilot",
    title: "GitHub Copilot",
    description: "Save additional GitHub Copilot model slugs for the picker and `/model` command.",
    placeholder: "your-copilot-model-slug",
    example: "gpt-5-mini",
  },
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG);

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getProviderModels(providers, provider).map(
    ({ slug, name, isCustom }) => ({
      slug,
      name,
      isCustom,
    }),
  );
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();
  const builtInModelSlugs = new Set(
    getProviderModels(providers, provider)
      .filter((model) => !model.isCustom)
      .map((model) => model.slug),
  );

  const customModels = settings.providers[provider].customModels;
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  const selectedModelMatchesExistingName =
    typeof trimmedSelectedModel === "string" &&
    options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
  if (
    normalizedSelectedModel &&
    !seen.has(normalizedSelectedModel) &&
    !selectedModelMatchesExistingName
  ) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
  allowedProviders?: ReadonlyArray<ProviderKind>,
): string {
  const scopedProviders =
    allowedProviders === undefined
      ? providers
      : providers.filter((candidate) => allowedProviders.includes(candidate.provider));
  const resolvedProvider = resolveSelectableProvider(scopedProviders, provider);
  const options = getAppModelOptions(settings, scopedProviders, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(scopedProviders, resolvedProvider)
  );
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
  allowedProviders?: ReadonlyArray<ProviderKind>,
): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  const scopedProviders =
    allowedProviders === undefined
      ? providers
      : providers.filter((candidate) => allowedProviders.includes(candidate.provider));
  const result = {} as Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  for (const provider of PROVIDER_KINDS) {
    result[provider] =
      allowedProviders !== undefined && !allowedProviders.includes(provider)
        ? []
        : getAppModelOptions(
            settings,
            scopedProviders,
            provider,
            selectedProvider === provider ? selectedModel : undefined,
          );
  }
  return result;
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  allowedProviders?: ReadonlyArray<ProviderKind>,
): ModelSelection {
  const scopedProviders =
    allowedProviders === undefined
      ? providers
      : providers.filter((candidate) => allowedProviders.includes(candidate.provider));
  const selection = settings.textGenerationModelSelection ?? {
    provider: "codex" as const,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  };
  const provider = resolveSelectableProvider(scopedProviders, selection.provider);

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = provider === selection.provider ? selection.model : null;
  const model = resolveAppModelSelection(
    provider,
    settings,
    scopedProviders,
    selectedModel,
    allowedProviders,
  );
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(scopedProviders, provider),
    prompt: "",
    modelOptions: {
      [provider]: provider === selection.provider ? selection.options : undefined,
    },
  });

  return buildModelSelection(provider, model, modelOptionsForDispatch);
}
