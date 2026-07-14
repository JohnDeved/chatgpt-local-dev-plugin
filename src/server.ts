#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfiguration } from "./config/index.js";
import { coreTools, CoreRuntime } from "./core/index.js";
import { startDashboard, type DashboardRuntime } from "./dashboard.js";
import { ProxyManager } from "./proxy.js";
import { observabilityTools } from "./observability-tools.js";
import { questionTools } from "./question-tools.js";
import { failure } from "./result.js";
import { ToolRegistry } from "./registry.js";
import { MEDIA_VIEWER_HTML, MEDIA_VIEWER_MIME_TYPE, MEDIA_VIEWER_URI } from "./media-viewer.js";
import { CallJournal } from "./observability.js";
import { setupPaths } from "./setup/paths.js";
import { listUiResources, readUiResource } from "./ui/index.js";

export async function runServer(): Promise<void> {
  const configuration = await loadConfiguration();
  const runtime = new CoreRuntime(configuration.localDev.projectRoots, configuration.localDev.projectOpenHooks);
  const proxy = new ProxyManager();
  const registry = new ToolRegistry();
  const journal = new CallJournal();
  registry.addAll(coreTools(runtime));
  registry.addAll(questionTools());
  registry.addAll(observabilityTools(journal));
  registry.addAll(await proxy.connect(configuration.selectedServers));
  let dashboard: DashboardRuntime | undefined;
  if (process.env.LOCAL_DEV_DASHBOARD !== "0") dashboard = await startDashboard(journal, setupPaths().dashboardUrl);
  const server = new Server(
    { name: "local-dev", version: "0.3.0" },
    {
      capabilities: { resources: {}, tools: {} },
      instructions:
        "Open a configured project before running commands. Use project.list when a visual project picker helps. Use dev.run with an argv array, dev.poll for the single background process, and dev.stop to terminate it. Use question.ask when one to four concrete user decisions can be collected together.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.list() }));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { name: "Local Dev media viewer", uri: MEDIA_VIEWER_URI, mimeType: MEDIA_VIEWER_MIME_TYPE },
      ...listUiResources(),
      ...proxy.listResources(),
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri === MEDIA_VIEWER_URI) {
      return {
        contents: [{
          uri: MEDIA_VIEWER_URI,
          mimeType: MEDIA_VIEWER_MIME_TYPE,
          text: MEDIA_VIEWER_HTML,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription": "Displays image and audio media returned by a local MCP tool.",
            "openai/widgetPrefersBorder": false,
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        }],
      };
    }
    const local = readUiResource(params.uri);
    if (local !== undefined) return { contents: [local] };
    const proxied = await proxy.readResource(params.uri);
    if (proxied !== undefined) return proxied;
    throw new Error("UNKNOWN_RESOURCE");
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tracked = journal.begin(params.name, params.arguments ?? {});
    const entry = registry.get(params.name);
    if (entry === undefined) {
      const result = failure(params.name, "UNKNOWN_TOOL", "The requested tool is not registered.") as never;
      journal.complete(tracked, result);
      return result;
    }
    try {
      const result = await entry.call(params.arguments ?? {});
      journal.complete(tracked, result);
      return result;
    } catch (error) {
      journal.fail(tracked);
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
    await dashboard?.close();
    await server.close();
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  await server.connect(transport);
}
