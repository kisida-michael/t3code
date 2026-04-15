import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GitHubCopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "githubCopilot";
}

export class GitHubCopilotAdapter extends Context.Service<
  GitHubCopilotAdapter,
  GitHubCopilotAdapterShape
>()("t3/provider/Services/GitHubCopilotAdapter") {}
