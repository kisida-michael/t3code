import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

export const GITHUB_COPILOT_MODE_IDS = {
  default: "https://agentclientprotocol.com/protocol/session-modes#agent",
  plan: "https://agentclientprotocol.com/protocol/session-modes#plan",
} as const;

export interface GitHubCopilotAcpConnectionOptions {
  readonly binaryPath: string;
  readonly configDir?: string;
  readonly onRequestPermission: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  readonly onSessionUpdate: (params: acp.SessionNotification) => Promise<void>;
}

export interface GitHubCopilotAcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: acp.ClientSideConnection;
  readonly initializeResponse: acp.InitializeResponse;
}

function buildArgs(input: { readonly configDir?: string }): string[] {
  return [
    "--acp",
    "--stdio",
    "--no-color",
    "--no-auto-update",
    ...(input.configDir && input.configDir.trim().length > 0
      ? ["--config-dir", input.configDir.trim()]
      : []),
  ];
}

export async function createGitHubCopilotAcpConnection(
  options: GitHubCopilotAcpConnectionOptions,
): Promise<GitHubCopilotAcpConnection> {
  const child = spawn(options.binaryPath, buildArgs(options), {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("GitHub Copilot ACP process did not expose stdio pipes.");
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inputStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, inputStream);
  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: options.onRequestPermission,
      sessionUpdate: options.onSessionUpdate,
    }),
    stream,
  );

  try {
    const initializeResponse = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    return { child, connection, initializeResponse };
  } catch (error) {
    killGitHubCopilotChildProcess(child);
    throw error;
  }
}

export function killGitHubCopilotChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) {
    return;
  }
  child.stdin.end();
  child.kill("SIGTERM");
}
