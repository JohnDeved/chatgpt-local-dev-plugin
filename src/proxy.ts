import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { HttpMcpServer, ResolvedSelectedServer, StdioMcpServer } from "./config/types.js";
import { inlineLocalMedia } from "./media.js";
import { attachMediaViewer } from "./media-viewer.js";
import { failure } from "./result.js";
import type { RegistryEntry } from "./registry.js";

interface Connection {
  client: Client;
  entries: RegistryEntry[];
  resources: ProxiedResource[];
}

interface ProxiedResource {
  client: Client;
  originalUri: string;
  exposedUri: string;
  timeoutMs: number;
  descriptor: Resource;
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

async function discoverResources(client: Client, timeout: number): Promise<Resource[]> {
  if (client.getServerCapabilities()?.resources === undefined) return [];
  const resources: Resource[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor === undefined ? undefined : { cursor }, { timeout });
    resources.push(...page.resources);
    cursor = page.nextCursor;
    if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 99)) throw new Error("INVALID_RESOURCE_PAGINATION");
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return resources;
}

function toolResourceUri(tool: Tool): string | undefined {
  const metadata = tool._meta;
  if (metadata === undefined) return undefined;
  const ui = typeof metadata.ui === "object" && metadata.ui !== null && !Array.isArray(metadata.ui)
    ? metadata.ui as Record<string, unknown>
    : undefined;
  if (typeof ui?.resourceUri === "string") return ui.resourceUri;
  return typeof metadata["openai/outputTemplate"] === "string" ? metadata["openai/outputTemplate"] : undefined;
}

function proxyResourceUri(alias: string, originalUri: string): string {
  const digest = createHash("sha256").update(originalUri).digest("hex").slice(0, 20);
  return `ui://local-dev/${encodeURIComponent(alias)}/${digest}.html`;
}

function rewriteToolResource(tool: Tool, resourceUri: string): Tool {
  const metadata = tool._meta ?? {};
  const ui = typeof metadata.ui === "object" && metadata.ui !== null && !Array.isArray(metadata.ui)
    ? metadata.ui as Record<string, unknown>
    : {};
  return {
    ...tool,
    _meta: {
      ...metadata,
      ui: { ...ui, resourceUri },
      "openai/outputTemplate": resourceUri,
    },
  };
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
  const listedResources = await discoverResources(client, server.startupTimeoutMs).catch(() => []);
  const resourcesByUri = new Map(listedResources.map((resource) => [resource.uri, resource]));
  const resources = new Map<string, ProxiedResource>();
  const entries = tools.map((tool): RegistryEntry => {
    const exposedName = `${alias}.${tool.name}`;
    const originalResourceUri = toolResourceUri(tool);
    let exposedTool = tool;
    if (originalResourceUri !== undefined) {
      const exposedUri = proxyResourceUri(alias, originalResourceUri);
      exposedTool = rewriteToolResource(tool, exposedUri);
      if (!resources.has(exposedUri)) {
        const listed = resourcesByUri.get(originalResourceUri);
        resources.set(exposedUri, {
          client,
          originalUri: originalResourceUri,
          exposedUri,
          timeoutMs: server.toolTimeoutMs,
          descriptor: {
            ...(listed ?? { uri: originalResourceUri, name: `${tool.title ?? tool.name} interface` }),
            uri: exposedUri,
            name: `${alias}: ${listed?.name ?? tool.title ?? tool.name}`,
          },
        });
      }
    }
    const mediaConfiguration = inlineMedia !== undefined && (inlineMedia.tools === undefined || inlineMedia.tools.includes(tool.name))
      ? inlineMedia
      : undefined;
    return {
      tool: { ...(mediaConfiguration === undefined ? exposedTool : attachMediaViewer(exposedTool)), name: exposedName },
      call: async (arguments_) => {
        try {
          const result = await client.callTool(
            { name: tool.name, arguments: arguments_ },
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
  return { client, entries, resources: [...resources.values()] };
}

export class ProxyManager {
  private readonly connections: Connection[] = [];
  private readonly resources = new Map<string, ProxiedResource>();

  async connect(selections: ResolvedSelectedServer[]): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    for (const selection of selections) {
      try {
        const connection = await connectSelected(selection);
        this.connections.push(connection);
        entries.push(...connection.entries);
        for (const resource of connection.resources) this.resources.set(resource.exposedUri, resource);
      } catch {
        if (selection.server.required) throw new Error(`REQUIRED_SERVER_UNAVAILABLE:${selection.alias}`);
      }
    }
    return entries;
  }

  listResources(): Resource[] {
    return [...this.resources.values()].map(({ descriptor }) => structuredClone(descriptor));
  }

  async readResource(uri: string): Promise<ReadResourceResult | undefined> {
    const resource = this.resources.get(uri);
    if (resource === undefined) return undefined;
    const result = await resource.client.readResource({ uri: resource.originalUri }, { timeout: resource.timeoutMs });
    return {
      ...result,
      contents: result.contents.map((content) => ({
        ...content,
        uri: content.uri === resource.originalUri ? resource.exposedUri : content.uri,
      })),
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map(({ client }) => client.close()));
    this.connections.length = 0;
    this.resources.clear();
  }
}
