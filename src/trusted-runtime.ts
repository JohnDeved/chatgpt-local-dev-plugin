import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StdioMcpServer } from "./config/types.js";

export interface StdioLaunchCommand {
  command: string;
  args: string[];
}

const trustedRuntimeLauncher = fileURLToPath(
  new URL("../scripts/openai-runtime-chain.mjs", import.meta.url),
);

export function prepareStdioLaunch(server: StdioMcpServer): StdioLaunchCommand {
  if (server.id !== "node_repl" || basename(server.command) !== "node_repl") {
    return { command: server.command, args: server.args };
  }

  return {
    command: join(dirname(server.command), "node"),
    args: [trustedRuntimeLauncher, "1", server.command, ...server.args],
  };
}
