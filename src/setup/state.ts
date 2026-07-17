import type { SetupState } from "./types.js";

export function parseSetupState(source: string): SetupState | undefined {
  try {
    const state = JSON.parse(source) as Partial<SetupState>;
    if (state.version !== 1 || typeof state.alias !== "string" || typeof state.binaryPath !== "string" ||
      typeof state.tunnelId !== "string" || typeof state.runtimeKeyRef !== "string" || typeof state.mcpCommand !== "string") {
      return undefined;
    }
    return {
      version: 1,
      alias: state.alias,
      binaryPath: state.binaryPath,
      tunnelId: state.tunnelId,
      runtimeKeyRef: state.runtimeKeyRef,
      mcpCommand: state.mcpCommand,
      launchAgentPath: typeof state.launchAgentPath === "string" ? state.launchAgentPath : null,
      configuredAt: typeof state.configuredAt === "string" ? state.configuredAt : "unknown",
    };
  } catch {
    return undefined;
  }
}
