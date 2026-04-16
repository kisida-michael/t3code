import { homedir } from "node:os";
import { join } from "node:path";

import type { GitHubCopilotModelOptions, GitHubCopilotSettings } from "@t3tools/contracts";

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function resolveGitHubCopilotConfigDir(
  settings: GitHubCopilotSettings,
  modelOptions?: GitHubCopilotModelOptions | null,
): string | undefined {
  const modelConfigDir = modelOptions?.configDir?.trim();
  if (modelConfigDir) {
    return expandHomePath(modelConfigDir);
  }

  const selectedProfileId = modelOptions?.accountProfileId || settings.selectedProfileId;
  const selectedProfile = selectedProfileId
    ? settings.profiles.find((profile) => profile.id === selectedProfileId)
    : undefined;
  const rawConfigDir = selectedProfile?.configDir ?? settings.configDir;
  const trimmed = rawConfigDir.trim();

  return trimmed ? expandHomePath(trimmed) : undefined;
}
