#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadConfiguration } from "./config/index.js";
import { coreTools, CoreRuntime } from "./core/index.js";
import { ProxyManager } from "./proxy.js";
import { failure } from "./result.js";
import { ToolRegistry } from "./registry.js";

export async function runServer(): Promise<void> {
  const nodeBin = dirname(process.execPath);
  process.env.PATH = process.env.PATH ? `${nodeBin}${delimiter}${process.env.PATH}` : nodeBin;
  const configuration = await loadConfiguration();
  const proxy = new ProxyManager();
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
  const server = new Server(
    { name: "local-dev", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Resolve a project automatically before running local commands. Infer an existing project name or path from the user's request and call project.open. If no existing project fits, choose onMissing=create for durable work or onMissing=temporary for disposable experiments; temporary projects are deleted when the Local Dev runtime closes. Never ask the user to choose from a project picker. If project.open returns ambiguous candidates, select the best candidate from the request and retry with its exact path. Project activation synchronizes configured downstream project bindings. Prefer downstream semantic code tools for navigation and precise edits. Use dev.run for one direct argv command or dev.batch for bounded sequential commands; never invoke a shell with evaluation flags. Use relative cwd for monorepo subdirectories, dev.poll for the single background process, and dev.stop to terminate it. After all file-changing operations for a user request, run the repository check and call dev.diff at most once.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.list() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const entry = registry.get(params.name);
    if (entry === undefined) return failure(params.name, "UNKNOWN_TOOL", "The requested tool is not registered.") as never;
    return await entry.call(params.arguments ?? {});
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
