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
import { ProxyManager } from "./proxy.js";
import { failure } from "./result.js";
import { ToolRegistry } from "./registry.js";
import { MEDIA_VIEWER_HTML, MEDIA_VIEWER_MIME_TYPE, MEDIA_VIEWER_URI } from "./media-viewer.js";

export async function runServer(): Promise<void> {
  const configuration = await loadConfiguration();
  const runtime = new CoreRuntime(configuration.localDev.projectRoots, configuration.localDev.projectOpenHooks);
  const proxy = new ProxyManager();
  const registry = new ToolRegistry();
  registry.addAll(coreTools(runtime));
  registry.addAll(await proxy.connect(configuration.selectedServers));
  const server = new Server(
    { name: "local-dev", version: "0.3.0" },
    {
      capabilities: { resources: {}, tools: {} },
      instructions:
        "Open a configured project before running commands. Use dev.run with an argv array, dev.poll for the single background process, and dev.stop to terminate it.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.list() }));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{ name: "Local Dev media viewer", uri: MEDIA_VIEWER_URI, mimeType: MEDIA_VIEWER_MIME_TYPE }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => {
    if (params.uri !== MEDIA_VIEWER_URI) throw new Error("UNKNOWN_RESOURCE");
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
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const entry = registry.get(params.name);
    if (entry === undefined) return failure(params.name, "UNKNOWN_TOOL", "The requested tool is not registered.") as never;
    return entry.call(params.arguments ?? {});
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
