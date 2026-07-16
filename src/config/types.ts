import type { JsonValue } from "../types.js";

export type ApprovalMode = "auto" | "prompt" | "writes" | "approve";

export interface ToolPolicy {
  approvalMode?: ApprovalMode;
}

export interface McpServerCommon {
  id: string;
  required: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools?: string[];
  disabledTools: string[];
  defaultApprovalMode?: ApprovalMode;
  tools: Record<string, ToolPolicy>;
}

export interface StdioMcpServer extends McpServerCommon {
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  envVars: Array<{ name: string; source: "local" | "remote" }>;
  experimentalEnvironment: "local" | "remote";
}

export interface HttpMcpServer extends McpServerCommon {
  transport: "http";
  url: string;
  auth?: "oauth" | "chatgpt";
  bearerTokenEnvVar?: string;
  httpHeaders: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  oauthResource?: string;
  scopes: string[];
  independentlyUsable: boolean;
}

export type McpServer = StdioMcpServer | HttpMcpServer;

export interface InlineMediaConfig {
  roots: string[];
  maxBytes: number;
  tools?: string[];
}

export interface SelectedServer {
  id: string;
  alias: string;
  inlineMedia?: InlineMediaConfig;
}

export interface ProjectOpenHook {
  projectRoot: string;
  argv: string[];
}

export interface ProjectBinding {
  server: string;
  tool: string;
  arguments: { [key: string]: JsonValue };
}

export interface LocalDevConfig {
  version: 1;
  projectRoots: string[];
  approvedBrowserOrigins: string[];
  selectedServers: SelectedServer[];
  projectOpenHooks: ProjectOpenHook[];
  projectBindings: ProjectBinding[];
}

export interface ResolvedSelectedServer {
  alias: string;
  server: McpServer;
  inlineMedia?: InlineMediaConfig;
}

export interface LoadedConfiguration {
  codexConfigPath: string;
  localDevConfigPath: string;
  servers: McpServer[];
  localDev: LocalDevConfig;
  selectedServers: ResolvedSelectedServer[];
  skippedServers: Array<{ id: string; code: "DISABLED" | "MANAGED_AUTH" }>;
}
