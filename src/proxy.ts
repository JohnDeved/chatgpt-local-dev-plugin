import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ElicitRequestSchema, type CallToolResult, type ElicitRequest, type ElicitResult, type Progress, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { activityEvent, activityFailure, currentActivity } from "./activity.js";
import type { HttpMcpServer, ResolvedSelectedServer, StdioMcpServer } from "./config/types.js";
import { inlineLocalMedia } from "./media.js";
import { failure } from "./result.js";
import type { RegistryEntry } from "./registry.js";
import { prepareProxiedTool } from "./tool-metadata.js";
import { prepareStdioLaunch } from "./trusted-runtime.js";

interface Connection { client: Client; entries: RegistryEntry[]; }
type ElicitInput = (params: ElicitRequest["params"]) => Promise<ElicitResult>;
type Observe = (type: string, detail: unknown) => void;

function stdioTransport(server: StdioMcpServer, observe?: Observe): StdioClientTransport {
  const launch = prepareStdioLaunch(server);
  const env = { ...getDefaultEnvironment(), ...server.env };
  for (const { name } of server.envVars) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  observe?.("downstream.starting", { server: server.id, ...launch, cwd: server.cwd, environment: env });
  const transport = new StdioClientTransport({
    command: launch.command, args: launch.args, env, stderr: "pipe",
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    try {
      observe?.("downstream.stderr", { server: server.id, bytes: chunk.length, text: chunk.toString("utf8"), bytesBase64: chunk.toString("base64") });
    } catch { void transport.close().catch(() => undefined); }
  });
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

async function connectSelected(selection: ResolvedSelectedServer, elicitInput: ElicitInput | undefined, observe?: Observe): Promise<Connection> {
  const { alias, inlineMedia, server } = selection;
  const client = new Client(
    { name: `local-dev-${alias}`, version: "0.3.0" },
    elicitInput === undefined ? undefined : { capabilities: { elicitation: { form: {} } } },
  );
  if (elicitInput !== undefined) client.setRequestHandler(ElicitRequestSchema, async ({ params }) => await elicitInput(params));
  const transport = server.transport === "stdio" ? stdioTransport(server, observe) : httpTransport(server);
  let tools: Tool[];
  try {
    await client.connect(transport as Transport, { timeout: server.startupTimeoutMs });
    tools = (await discover(client, server.startupTimeoutMs)).filter((tool) => included(tool, server));
    observe?.("downstream.connected", { server: alias, tools: tools.map((tool) => tool.name) });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  const entries = tools.map((tool): RegistryEntry => {
    const exposedName = `${alias}.${tool.name}`;
    const mediaConfiguration = inlineMedia !== undefined && (inlineMedia.tools === undefined || inlineMedia.tools.includes(tool.name)) ? inlineMedia : undefined;
    return {
      tool: prepareProxiedTool({ ...tool, name: exposedName }, { serverId: server.id, alias, sourceName: tool.name }),
      call: async (arguments_, context) => {
        const current = currentActivity();
        try {
          context?.signal?.throwIfAborted();
          activityEvent("downstream.requested", { server: alias, tool: tool.name, arguments: arguments_, metadata: context?.meta });
          const progress = context?.progress;
          const result = await client.callTool(
            { name: tool.name, arguments: arguments_, ...(context?.meta === undefined ? {} : { _meta: context.meta }) },
            CallToolResultSchema,
            {
              timeout: server.toolTimeoutMs,
              maxTotalTimeout: server.toolTimeoutMs,
              ...(context?.signal === undefined ? {} : { signal: context.signal }),
              ...(progress === undefined ? {} : {
                onprogress: (update: Progress) => {
                  current?.hub.record("downstream.progress", { tool: exposedName, ...update }, current.operationId);
                  const fraction = update.total === undefined || update.total <= 0 ? undefined : update.progress / update.total;
                  void progress.report(update.message ?? `Running ${tool.title ?? tool.name}…`, fraction === undefined ? undefined : 0.05 + Math.min(Math.max(fraction, 0), 1) * 0.9);
                },
              }),
            },
          ) as CallToolResult;
          activityEvent("downstream.result", { tool: exposedName, result });
          return await inlineLocalMedia(result, mediaConfiguration);
        } catch (error) {
          activityEvent("downstream.error", { tool: exposedName, error: activityFailure(error) });
          const cancelled = context?.signal?.aborted === true;
          const timedOut = error instanceof Error && /timed?\s*out|timeout/iu.test(error.message);
          const code = cancelled ? "OPERATION_CANCELLED" : timedOut ? "DOWNSTREAM_TIMEOUT" : "DOWNSTREAM_UNAVAILABLE";
          return failure(exposedName, code, `Selected MCP server ${alias}: ${code}. Full diagnostics are available locally.`) as unknown as CallToolResult;
        }
      },
    };
  });
  return { client, entries };
}

export class ProxyManager {
  private readonly connections: Connection[] = [];
  constructor(private readonly elicitInput?: ElicitInput, private readonly observe?: Observe) {}

  async connect(selections: ResolvedSelectedServer[]): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    for (const selection of selections) {
      try {
        const connection = await connectSelected(selection, this.elicitInput, this.observe);
        this.connections.push(connection);
        entries.push(...connection.entries);
      } catch (error) {
        this.observe?.("downstream.connectionFailed", { server: selection.alias, error: activityFailure(error) });
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
