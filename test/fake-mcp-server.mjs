import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const WIDGET_URI = "ui://widget/downstream-echo-v1.html";
const server = new Server(
  { name: "fake-downstream", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
  if (params?.cursor === "page-2") {
    return {
      tools: [{
        name: "blocked",
        description: "Filtered tool",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      }],
    };
  }
  return {
    tools: [{
      name: "echo",
      title: "Downstream echo",
      description: "Echo through the generic proxy.",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { fixture: true, ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI },
    }],
    nextCursor: "page-2",
  };
});

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: WIDGET_URI, name: "Downstream echo widget", mimeType: "text/html;profile=mcp-app" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => {
  if (params.uri !== WIDGET_URI) throw new Error("UNKNOWN_RESOURCE");
  return {
    contents: [{
      uri: WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: "<!doctype html><p id=echo>Downstream widget</p>",
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  };
});

server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({
  content: [{ type: "text", text: `echo=${String(params.arguments?.value)}` }],
  structuredContent: { echoed: params.arguments?.value },
}));

await server.connect(new StdioServerTransport());
