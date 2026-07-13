import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ProxyManager } from "../dist/proxy.js";

const common = {
  required: false,
  startupTimeoutMs: 1_000,
  toolTimeoutMs: 1_000,
  disabledTools: [],
  tools: {},
};

test("connects and forwards over Streamable HTTP with environment-backed headers", async () => {
  const requests = [];
  const createDownstream = () => {
    const downstream = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    downstream.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: "read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    }));
    downstream.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "http-ok" }] }));
    return downstream;
  };
  const http = createServer((request, response) => {
    requests.push({ method: request.method, headers: request.headers });
    if (request.headers.authorization !== "Bearer fixture-token" || request.headers["x-fixture"] !== "header-value") {
      response.writeHead(401).end();
      return;
    }
    void (async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const downstream = createDownstream();
      await downstream.connect(transport);
      response.on("close", () => void downstream.close());
      await transport.handleRequest(request, response);
    })();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const previousToken = process.env.LOCAL_DEV_TEST_BEARER;
  const previousHeader = process.env.LOCAL_DEV_TEST_HEADER;
  process.env.LOCAL_DEV_TEST_BEARER = "fixture-token";
  process.env.LOCAL_DEV_TEST_HEADER = "header-value";
  const proxy = new ProxyManager();
  try {
    const entries = await proxy.connect([{
      alias: "http",
      server: {
        ...common,
        id: "http-fixture",
        transport: "http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        bearerTokenEnvVar: "LOCAL_DEV_TEST_BEARER",
        httpHeaders: {},
        envHttpHeaders: { "X-Fixture": "LOCAL_DEV_TEST_HEADER" },
        scopes: [],
        independentlyUsable: true,
      },
    }]);
    assert.deepEqual(entries.map(({ tool }) => tool.name), ["http.read"]);
    const result = await entries[0].call({});
    assert.equal(result.content[0].text, "http-ok");
  } finally {
    await proxy.close();
    await new Promise((resolve) => http.close(resolve));
    if (previousToken === undefined) delete process.env.LOCAL_DEV_TEST_BEARER;
    else process.env.LOCAL_DEV_TEST_BEARER = previousToken;
    if (previousHeader === undefined) delete process.env.LOCAL_DEV_TEST_HEADER;
    else process.env.LOCAL_DEV_TEST_HEADER = previousHeader;
  }
});

test("skips optional unavailable servers and fails required unavailable servers", async () => {
  const server = {
    ...common,
    id: "missing",
    transport: "stdio",
    command: "/definitely/not/a/command",
    args: [],
    env: {},
    envVars: [],
    experimentalEnvironment: "local",
  };
  const optional = new ProxyManager();
  assert.deepEqual(await optional.connect([{ alias: "optional", server }]), []);
  const required = new ProxyManager();
  await assert.rejects(
    required.connect([{ alias: "required", server: { ...server, required: true } }]),
    /REQUIRED_SERVER_UNAVAILABLE:required/u,
  );
});
