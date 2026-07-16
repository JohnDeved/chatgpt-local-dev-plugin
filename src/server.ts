#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { chromeCompatibilityEntries } from "./chrome-compat.js";
import { loadConfiguration } from "./config/index.js";
import { coreTools, CoreRuntime } from "./core/index.js";
import { resolveElicitation } from "./elicitation.js";
import { createToolProgress } from "./progress.js";
import { ProxyManager } from "./proxy.js";
import { failure } from "./result.js";
import { requestMetadataForTool } from "./request-meta.js";
import { ToolRegistry } from "./registry.js";
import { toolInvokedStatus, toolInvokingStatus } from "./tool-metadata.js";

const SERVER_INSTRUCTIONS = [
  "Keep the user visibly informed during Local Dev work.",
  "Name the exact Local Dev tool, executable path, and command arguments being used; do not mask, summarize, or omit tool inputs in status updates.",
  "Before the first tool call in a multi-step workflow, send a concise update naming the immediate next action.",
  "After each meaningful milestone or roughly every three tool calls, send another concise update with what finished and what comes next.",
  "Before a command or browser action that may take more than ten seconds, say what is about to run.",
  "Do not remain silent through long-running work, but do not narrate every trivial read.",
  "Resolve a project automatically before running local commands.",
  "Infer an existing project name or path from the user's request and call project.open.",
  "If no existing project fits, choose onMissing=create for durable work or onMissing=temporary for disposable experiments; temporary projects are deleted when the Local Dev runtime closes.",
  "Never ask the user to choose from a project picker.",
  "If project.open returns ambiguous candidates, select the best candidate from the request and retry with its exact path.",
  "Project activation synchronizes configured downstream project bindings.",
  "Prefer downstream semantic code tools for navigation and precise edits.",
  "Use dev.run for one direct argv command or dev.batch for bounded sequential commands; never invoke a shell with evaluation flags.",
  "Use relative cwd for monorepo subdirectories, dev.poll for the single background process, and dev.stop to terminate it.",
  "After all file-changing operations for a user request, run the repository check and call dev.diff at most once.",
].join(" ");

export async function runServer(): Promise<void> {
  const nodeBin = dirname(process.execPath);
  process.env.PATH = process.env.PATH ? `${nodeBin}${delimiter}${process.env.PATH}` : nodeBin;
  const configuration = await loadConfiguration();
  const server = new Server(
    { name: "local-dev", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  const proxy = new ProxyManager(async (params) =>
    await resolveElicitation(
      params,
      configuration.localDev.approvedBrowserOrigins,
      async (request) => await server.elicitInput(request),
    )
  );
  const downstreamEntries = await proxy.connect(configuration.selectedServers);
  const downstream = new Map(downstreamEntries.map((entry) => [entry.tool.name, entry]));
  const runtime = new CoreRuntime(
    configuration.localDev.projectRoots,
    configuration.localDev.projectOpenHooks,
    configuration.localDev.projectBindings,
    async (name, arguments_) => await downstream.get(name)?.call(arguments_),
  );
  const registry = new ToolRegistry();
  registry.addAll(coreTools(runtime));
  registry.addAll(downstreamEntries);
  registry.addAll(chromeCompatibilityEntries(downstream));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.list() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const entry = registry.get(params.name);
    if (entry === undefined) return failure(params.name, "UNKNOWN_TOOL", "The requested tool is not registered.") as never;
    const metadata = requestMetadataForTool(
      params.name,
      params._meta ?? extra._meta,
      extra.sessionId,
      extra.requestId,
    );
    const progress = createToolProgress(metadata, extra.sendNotification);
    await progress?.report(toolInvokingStatus(entry.tool), 0);
    try {
      const result = await entry.call(params.arguments ?? {}, {
        ...(metadata === undefined ? {} : { meta: metadata }),
        signal: extra.signal,
        ...(progress === undefined ? {} : { progress }),
      });
      await progress?.report(toolInvokedStatus(entry.tool), 1);
      return result;
    } catch (error) {
      await progress?.report(`${entry.tool.title ?? entry.tool.name} failed`, 1);
      throw error;
    }
  });
  const transport = new StdioServerTransport();

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await runtime.close();
    await proxy.close();
    await server.close();
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  await server.connect(transport);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch(() => {
    process.stderr.write("local-dev: server failed to start.\n");
    process.exitCode = 1;
  });
}
