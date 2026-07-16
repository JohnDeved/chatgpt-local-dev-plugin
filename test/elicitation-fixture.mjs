import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "elicitation-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{
    name: "confirm",
    inputSchema: { type: "object", properties: {} },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  const result = await server.elicitInput({
    mode: "form",
    message: "Allow the fixture action?",
    requestedSchema: {
      type: "object",
      properties: { allow: { type: "boolean" } },
      required: ["allow"],
    },
  });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ action: result.action, allow: result.content?.allow }),
    }],
  };
});

await server.connect(new StdioServerTransport());
