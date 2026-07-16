import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import type { HttpMcpServer, ResolvedSelectedServer, StdioMcpServer } from "./config/types.js";
import { inlineLocalMedia } from "./media.js";
import { failure } from "./result.js";
import type { RegistryEntry } from "./registry.js";
import { prepareProxiedTool } from "./tool-metadata.js";

interface Connection {
  client: Client;
  entries: RegistryEntry[];
}

function stdioTransport(server: StdioMcpServer): StdioClientTransport {
  const env = { ...getDefaultEnvironment(), ...server.env };
  for (const { name } of server.envVars) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env,
    stderr: "pipe",
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
  });
  transport.stderr?.on("data", () => undefined);
  return transport;
}

function httpTransport(server: HttpMcpServer): StreamableHTTPClientTransport {
  const headers: Record<string, string> = { ...server.httpHeaders };
  for (const [header, variable] of Object.entries(server.envHttpHeaders)) {
    const value = process.env[variable];
    if (value !== undefined) headers[header] = value;
  }
  if (server.bearerTokenEnvVar !== undefined) {
    const token = process.env[server.bearerTokenEnvVar];
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
}

function included(tool: Tool, server: ResolvedSelectedServer["server"]): boolean {
  if (server.enabledTools !== undefined && !server.enabledTools.includes(tool.name)) return false;
  return !server.disabledTools.includes(tool.name);
}

async function discover(client: Client, timeout: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 99)) throw new Error("INVALID_PAGINATION");
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return tools;
}

async function connectSelected(selection: ResolvedSelectedServer): Promise<Connection> {
  const { alias, inlineMedia, server } = selection;
  const client = new Client({ name: `local-dev-${alias}`, version: "0.3.0" });
  const transport = server.transport === "stdio" ? stdioTransport(server) : httpTransport(server);
  let tools: Tool[];
  try {
    await client.connect(transport as Transport, { timeout: server.startupTimeoutMs });
    tools = (await discover(client, server.startupTimeoutMs)).filter((tool) => included(tool, server));
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  const entries = tools.map((tool): RegistryEntry => {
    const exposedName = `${alias}.${tool.name}`;
    const mediaConfiguration = inlineMedia !== undefined && (inlineMedia.tools === undefined || inlineMedia.tools.includes(tool.name))
      ? inlineMedia
      : undefined;
    return {
      tool: prepareProxiedTool({ ...tool, name: exposedName }, { serverId: server.id, alias, sourceName: tool.name }),
      call: async (arguments_, meta) => {
        try {
          const result = await client.callTool(
            { name: tool.name, arguments: arguments_, ...(meta === undefined ? {} : { _meta: meta }) },
            CallToolResultSchema,
            { timeout: server.toolTimeoutMs },
          ) as CallToolResult;
          return await inlineLocalMedia(result, mediaConfiguration);
        } catch {
          return failure(exposedName, "DOWNSTREAM_UNAVAILABLE", `Selected MCP server ${alias} is unavailable.`) as unknown as CallToolResult;
        }
      },
    };
  });
  return { client, entries };
}

export class ProxyManager {
  private readonly connections: Connection[] = [];

  async connect(selections: ResolvedSelectedServer[]): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    for (const selection of selections) {
      try {
        const connection = await connectSelected(selection);
        this.connections.push(connection);
        entries.push(...connection.entries);
      } catch {
        if (selection.server.required) throw new Error(`REQUIRED_SERVER_UNAVAILABLE:${selection.alias}`);
      }
    }
    return entries;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map(({ client }) => client.close()));
    this.connections.length = 0;
  }
}
