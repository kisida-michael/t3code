import { homedir } from "node:os";
import { join } from "node:path";

import type { GitHubCopilotSettings } from "@t3tools/contracts";

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function resolveGitHubCopilotConfigDir(settings: GitHubCopilotSettings): string | undefined {
  const selectedProfile = settings.selectedProfileId
    ? settings.profiles.find((profile) => profile.id === settings.selectedProfileId)
    : undefined;
  const rawConfigDir = selectedProfile?.configDir ?? settings.configDir;
  const trimmed = rawConfigDir.trim();

  return trimmed ? expandHomePath(trimmed) : undefined;
}
