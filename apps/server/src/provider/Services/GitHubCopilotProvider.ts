import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface GitHubCopilotProviderShape extends ServerProviderShape {}

export class GitHubCopilotProvider extends Context.Service<
  GitHubCopilotProvider,
  GitHubCopilotProviderShape
>()("t3/provider/Services/GitHubCopilotProvider") {}
