import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "./error.js";
import { defaultLocalDevConfig, parseCodexConfig, parseLocalDevConfig } from "./parse.js";
import type { LoadedConfiguration, McpServer, ResolvedSelectedServer } from "./types.js";

export interface LoadConfigurationOptions {
  home?: string;
  codexConfigPath?: string;
  localDevConfigPath?: string;
}

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readRequired(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missingFile(error)) {
      throw new ConfigError("CONFIG_NOT_FOUND", path, `Required configuration file is missing: ${path}`);
    }
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `Could not read configuration file: ${path}`);
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missingFile(error)) return undefined;
    throw new ConfigError("INVALID_LOCAL_CONFIG", path, `Could not read configuration file: ${path}`);
  }
}

function resolveSelections(
  selected: Array<{ id: string; alias: string }>,
  servers: McpServer[],
  disabledIds: string[],
): { selectedServers: ResolvedSelectedServer[]; skippedServers: LoadedConfiguration["skippedServers"] } {
  const byId = new Map(servers.map((server) => [server.id, server]));
  const selectedServers: ResolvedSelectedServer[] = [];
  const skippedServers: LoadedConfiguration["skippedServers"] = disabledIds.map((id) => ({ id, code: "DISABLED" }));
  for (const selection of selected) {
    if (disabledIds.includes(selection.id)) {
      throw new ConfigError("UNAVAILABLE_SERVER", `selectedServers.${selection.id}`, `Selected MCP server ${selection.id} is disabled.`);
    }
    const server = byId.get(selection.id);
    if (server === undefined) {
      throw new ConfigError("UNKNOWN_SERVER", `selectedServers.${selection.id}`, `Selected MCP server ${selection.id} is not configured.`);
    }
    if (server.transport === "http" && !server.independentlyUsable) {
      if (server.required) {
        throw new ConfigError("UNAVAILABLE_SERVER", `selectedServers.${selection.id}`, `Required MCP server ${selection.id} needs Codex-managed authentication.`);
      }
      skippedServers.push({ id: selection.id, code: "MANAGED_AUTH" });
      continue;
    }
    selectedServers.push({ alias: selection.alias, server });
  }
  return { selectedServers, skippedServers };
}

export async function loadConfiguration(options: LoadConfigurationOptions = {}): Promise<LoadedConfiguration> {
  const home = options.home ?? homedir();
  const codexConfigPath = options.codexConfigPath ?? join(home, ".codex", "config.toml");
  const localDevConfigPath = options.localDevConfigPath ?? join(home, ".local-dev", "config.json");
  const codexSource = await readRequired(codexConfigPath);
  const localSource = await readOptional(localDevConfigPath);
  const { servers, disabledIds } = parseCodexConfig(codexSource, codexConfigPath);
  const localDev = localSource === undefined
    ? defaultLocalDevConfig()
    : parseLocalDevConfig(localSource, localDevConfigPath);
  const resolved = resolveSelections(localDev.selectedServers, servers, disabledIds);
  return { codexConfigPath, localDevConfigPath, servers, localDev, ...resolved };
}
