import { parse } from "smol-toml";

import { ConfigError } from "./error.js";
import type {
  ApprovalMode,
  HttpMcpServer,
  InlineMediaConfig,
  LocalDevConfig,
  McpServer,
  McpServerCommon,
  ProjectBinding,
  ProjectOpenHook,
  SelectedServer,
  StdioMcpServer,
  ToolPolicy,
} from "./types.js";
import { isAbsolute, relative, sep } from "node:path";

import type { JsonValue } from "../types.js";

type UnknownRecord = Record<string, unknown>;

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/u;
const APPROVAL_MODES = new Set<ApprovalMode>(["auto", "prompt", "writes", "approve"]);
const DEFAULT_INLINE_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_MEDIA_BYTES = 25 * 1024 * 1024;

function record(value: unknown, path: string, code = "INVALID_CODEX_CONFIG"): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(code as "INVALID_CODEX_CONFIG", path, `${path} must be a table.`);
  }
  return value as UnknownRecord;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `${path} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, path: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `${path} must contain non-empty strings.`);
  }
  return [...value] as string[];
}

function stringMap(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  const input = record(value, path);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string") {
      throw new ConfigError("INVALID_CODEX_CONFIG", `${path}.${key}`, `${path}.${key} must be a string.`);
    }
    output[key] = item;
  }
  return output;
}

function booleanValue(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `${path} must be a boolean.`);
  }
  return value;
}

function positiveNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `${path} must be a positive number.`);
  }
  return value;
}

function approvalMode(value: unknown, path: string): ApprovalMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !APPROVAL_MODES.has(value as ApprovalMode)) {
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `${path} has an unsupported approval mode.`);
  }
  return value as ApprovalMode;
}

function parseTools(value: unknown, path: string): Record<string, ToolPolicy> {
  if (value === undefined) return {};
  const input = record(value, path);
  const output: Record<string, ToolPolicy> = {};
  for (const [name, raw] of Object.entries(input)) {
    const tool = record(raw, `${path}.${name}`);
    const mode = approvalMode(tool.approval_mode, `${path}.${name}.approval_mode`);
    output[name] = mode === undefined ? {} : { approvalMode: mode };
  }
  return output;
}

function common(id: string, input: UnknownRecord): McpServerCommon {
  const base = `mcp_servers.${id}`;
  const startupMs = input.startup_timeout_ms === undefined
    ? positiveNumber(input.startup_timeout_sec, `${base}.startup_timeout_sec`, 10) * 1000
    : positiveNumber(input.startup_timeout_ms, `${base}.startup_timeout_ms`, 10_000);
  return {
    id,
    required: booleanValue(input.required, `${base}.required`, false),
    startupTimeoutMs: startupMs,
    toolTimeoutMs: positiveNumber(input.tool_timeout_sec, `${base}.tool_timeout_sec`, 60) * 1000,
    ...(input.enabled_tools === undefined
      ? {}
      : { enabledTools: stringArray(input.enabled_tools, `${base}.enabled_tools`) }),
    disabledTools: stringArray(input.disabled_tools, `${base}.disabled_tools`),
    ...(input.default_tools_approval_mode === undefined
      ? {}
      : { defaultApprovalMode: approvalMode(input.default_tools_approval_mode, `${base}.default_tools_approval_mode`) as ApprovalMode }),
    tools: parseTools(input.tools, `${base}.tools`),
  };
}

function parseEnvVars(value: unknown, path: string): StdioMcpServer["envVars"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("INVALID_CODEX_CONFIG", path, `${path} must be an array.`);
  }
  return value.map((item, index) => {
    if (typeof item === "string" && item.length > 0) return { name: item, source: "local" as const };
    const entry = record(item, `${path}[${index}]`);
    const name = optionalString(entry.name, `${path}[${index}].name`);
    const source = entry.source ?? "local";
    if (name === undefined || (source !== "local" && source !== "remote")) {
      throw new ConfigError("INVALID_CODEX_CONFIG", `${path}[${index}]`, `${path}[${index}] is invalid.`);
    }
    return { name, source };
  });
}

export function parseCodexConfig(source: string, sourcePath = "config.toml"): {
  servers: McpServer[];
  disabledIds: string[];
} {
  let root: UnknownRecord;
  try {
    root = record(parse(source), "config");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("INVALID_TOML", sourcePath, `Could not parse ${sourcePath}.`);
  }

  const serversTable = root.mcp_servers === undefined ? {} : record(root.mcp_servers, "mcp_servers");
  const servers: McpServer[] = [];
  const disabledIds: string[] = [];
  for (const [id, raw] of Object.entries(serversTable)) {
    if (!SERVER_ID.test(id)) {
      throw new ConfigError("INVALID_CODEX_CONFIG", `mcp_servers.${id}`, "MCP server id is invalid.");
    }
    const input = record(raw, `mcp_servers.${id}`);
    if (!booleanValue(input.enabled, `mcp_servers.${id}.enabled`, true)) {
      disabledIds.push(id);
      continue;
    }
    const command = optionalString(input.command, `mcp_servers.${id}.command`);
    const url = optionalString(input.url, `mcp_servers.${id}.url`);
    if ((command === undefined) === (url === undefined)) {
      throw new ConfigError(
        "INVALID_CODEX_CONFIG",
        `mcp_servers.${id}`,
        `mcp_servers.${id} must define exactly one of command or url.`,
      );
    }
    const shared = common(id, input);
    if (command !== undefined) {
      const environment = input.experimental_environment ?? "local";
      if (environment !== "local" && environment !== "remote") {
        throw new ConfigError("INVALID_CODEX_CONFIG", `mcp_servers.${id}.experimental_environment`, "Unsupported environment.");
      }
      servers.push({
        ...shared,
        transport: "stdio",
        command,
        args: stringArray(input.args, `mcp_servers.${id}.args`),
        ...(input.cwd === undefined ? {} : { cwd: optionalString(input.cwd, `mcp_servers.${id}.cwd`) as string }),
        env: stringMap(input.env, `mcp_servers.${id}.env`),
        envVars: parseEnvVars(input.env_vars, `mcp_servers.${id}.env_vars`),
        experimentalEnvironment: environment,
      });
      continue;
    }
    const auth = input.auth;
    if (auth !== undefined && auth !== "oauth" && auth !== "chatgpt") {
      throw new ConfigError("INVALID_CODEX_CONFIG", `mcp_servers.${id}.auth`, "Unsupported MCP auth mode.");
    }
    const bearerTokenEnvVar = optionalString(input.bearer_token_env_var, `mcp_servers.${id}.bearer_token_env_var`);
    const httpHeaders = stringMap(input.http_headers, `mcp_servers.${id}.http_headers`);
    const envHttpHeaders = stringMap(input.env_http_headers, `mcp_servers.${id}.env_http_headers`);
    const hasAuthorizationHeader = Object.keys(httpHeaders).some((key) => key.toLowerCase() === "authorization");
    const independentlyUsable = auth === undefined || bearerTokenEnvVar !== undefined || hasAuthorizationHeader || Object.keys(envHttpHeaders).length > 0;
    const server: HttpMcpServer = {
      ...shared,
      transport: "http",
      url: url as string,
      ...(auth === undefined ? {} : { auth }),
      ...(bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar }),
      httpHeaders,
      envHttpHeaders,
      ...(input.oauth_resource === undefined
        ? {}
        : { oauthResource: optionalString(input.oauth_resource, `mcp_servers.${id}.oauth_resource`) as string }),
      scopes: stringArray(input.scopes, `mcp_servers.${id}.scopes`),
      independentlyUsable,
    };
    servers.push(server);
  }
  return { servers, disabledIds };
}

function localRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", path, `${path} must be an object.`);
  }
  return value as UnknownRecord;
}

function requireKeys(input: UnknownRecord, allowed: string[], path: string): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.${unknown}`, `${path}.${unknown} is not supported.`);
  }
}

function localString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", path, `${path} must be a non-empty string.`);
  }
  return value;
}

function localJsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 12) throw new ConfigError("INVALID_LOCAL_CONFIG", path, `${path} exceeds the supported nesting depth.`);
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item, index) => localJsonValue(item, `${path}[${index}]`, depth + 1));
  if (typeof value !== "object") throw new ConfigError("INVALID_LOCAL_CONFIG", path, `${path} must contain only JSON values.`);
  return Object.fromEntries(Object.entries(value as UnknownRecord).map(([key, item]) => [
    key,
    localJsonValue(item, `${path}.${key}`, depth + 1),
  ]));
}

function parseInlineMedia(value: unknown, path: string): InlineMediaConfig | undefined {
  if (value === undefined) return undefined;
  const input = localRecord(value, path);
  requireKeys(input, ["roots", "maxBytes", "tools"], path);
  if (!Array.isArray(input.roots) || input.roots.length === 0) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.roots`, `${path}.roots must be a non-empty array.`);
  }
  const roots = input.roots.map((value, index) => {
    const root = localString(value, `${path}.roots[${index}]`);
    if (!isAbsolute(root)) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.roots[${index}]`, "Inline media roots must be absolute.");
    }
    return root;
  });
  if (new Set(roots).size !== roots.length) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.roots`, "Inline media roots must be unique.");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_INLINE_MEDIA_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0 || (maxBytes as number) > MAX_INLINE_MEDIA_BYTES) {
    throw new ConfigError(
      "INVALID_LOCAL_CONFIG",
      `${path}.maxBytes`,
      `${path}.maxBytes must be a positive integer no greater than ${MAX_INLINE_MEDIA_BYTES}.`,
    );
  }
  const tools = input.tools === undefined ? undefined : stringArray(input.tools, `${path}.tools`);
  if (tools !== undefined && (tools.length === 0 || new Set(tools).size !== tools.length)) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.tools`, `${path}.tools must contain unique tool names.`);
  }
  return { roots, maxBytes: maxBytes as number, ...(tools === undefined ? {} : { tools }) };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function defaultLocalDevConfig(): LocalDevConfig {
  return { version: 1, projectRoots: [], selectedServers: [], projectOpenHooks: [], projectBindings: [] };
}

export function parseLocalDevConfig(source: string, sourcePath = "config.json"): LocalDevConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    throw new ConfigError("INVALID_LOCAL_CONFIG", sourcePath, `Could not parse ${sourcePath}.`);
  }
  const input = localRecord(raw, "localDev");
  requireKeys(input, ["version", "projectRoots", "selectedServers", "projectOpenHooks", "projectBindings"], "localDev");
  if (input.version !== 1) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.version", "localDev.version must be 1.");
  }
  if (!Array.isArray(input.projectRoots)) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.projectRoots", "localDev.projectRoots must be an array.");
  }
  const projectRoots = input.projectRoots.map((value, index) => {
    const root = localString(value, `localDev.projectRoots[${index}]`);
    if (!isAbsolute(root)) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `localDev.projectRoots[${index}]`, "Project roots must be absolute.");
    }
    return root;
  });
  if (new Set(projectRoots).size !== projectRoots.length) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.projectRoots", "Project roots must be unique.");
  }
  if (!Array.isArray(input.selectedServers)) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.selectedServers", "localDev.selectedServers must be an array.");
  }
  const selectedServers: SelectedServer[] = input.selectedServers.map((value, index) => {
    const entry = localRecord(value, `localDev.selectedServers[${index}]`);
    requireKeys(entry, ["id", "alias", "inlineMedia"], `localDev.selectedServers[${index}]`);
    const id = localString(entry.id, `localDev.selectedServers[${index}].id`);
    const alias = localString(entry.alias, `localDev.selectedServers[${index}].alias`);
    if (!SERVER_ID.test(id) || !ALIAS.test(alias)) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `localDev.selectedServers[${index}]`, "Selected server id or alias is invalid.");
    }
    const inlineMedia = parseInlineMedia(entry.inlineMedia, `localDev.selectedServers[${index}].inlineMedia`);
    return { id, alias, ...(inlineMedia === undefined ? {} : { inlineMedia }) };
  });
  if (new Set(selectedServers.map(({ id }) => id)).size !== selectedServers.length || new Set(selectedServers.map(({ alias }) => alias)).size !== selectedServers.length) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.selectedServers", "Selected server ids and aliases must be unique.");
  }
  if (!Array.isArray(input.projectOpenHooks)) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.projectOpenHooks", "localDev.projectOpenHooks must be an array.");
  }
  const projectOpenHooks: ProjectOpenHook[] = input.projectOpenHooks.map((value, index) => {
    const entry = localRecord(value, `localDev.projectOpenHooks[${index}]`);
    requireKeys(entry, ["projectRoot", "argv"], `localDev.projectOpenHooks[${index}]`);
    const projectRoot = localString(entry.projectRoot, `localDev.projectOpenHooks[${index}].projectRoot`);
    if (!isAbsolute(projectRoot) || !projectRoots.some((root) => inside(root, projectRoot)) || !Array.isArray(entry.argv) || entry.argv.length === 0) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `localDev.projectOpenHooks[${index}]`, "Hook root must be inside a configured root and argv must be non-empty.");
    }
    const argv = entry.argv.map((item, argumentIndex) => localString(item, `localDev.projectOpenHooks[${index}].argv[${argumentIndex}]`));
    return { projectRoot, argv };
  });
  const rawBindings = input.projectBindings ?? [];
  if (!Array.isArray(rawBindings)) {
    throw new ConfigError("INVALID_LOCAL_CONFIG", "localDev.projectBindings", "localDev.projectBindings must be an array.");
  }
  const selectedAliases = new Set(selectedServers.map(({ alias }) => alias));
  const projectBindings: ProjectBinding[] = rawBindings.map((value, index) => {
    const path = `localDev.projectBindings[${index}]`;
    const entry = localRecord(value, path);
    requireKeys(entry, ["server", "tool", "arguments"], path);
    const server = localString(entry.server, `${path}.server`);
    const tool = localString(entry.tool, `${path}.tool`);
    if (!ALIAS.test(server) || !selectedAliases.has(server)) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.server`, "Binding server must be a selected server alias.");
    }
    if (tool.length > 256) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.tool`, "Binding tool must be no longer than 256 characters.");
    }
    const arguments_ = entry.arguments === undefined ? {} : localJsonValue(entry.arguments, `${path}.arguments`);
    if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
      throw new ConfigError("INVALID_LOCAL_CONFIG", `${path}.arguments`, "Binding arguments must be a JSON object.");
    }
    return { server, tool, arguments: arguments_ };
  });
  return { version: 1, projectRoots, selectedServers, projectOpenHooks, projectBindings };
}
