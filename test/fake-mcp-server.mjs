import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-downstream", version: "1.0.0" }, { capabilities: { tools: {} } });

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
      _meta: { fixture: true },
    }],
    nextCursor: "page-2",
  };
});

server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({
  content: [{ type: "text", text: `echo=${String(params.arguments?.value)}` }],
  structuredContent: { echoed: params.arguments?.value },
}));

await server.connect(new StdioServerTransport());
