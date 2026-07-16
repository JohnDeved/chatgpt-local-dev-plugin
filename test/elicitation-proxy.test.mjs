import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ProxyManager } from "../dist/proxy.js";

const fixture = fileURLToPath(new URL("./elicitation-fixture.mjs", import.meta.url));

test("forwards downstream form elicitation to the upstream client", async () => {
  let requested;
  const proxy = new ProxyManager(async (params) => {
    requested = params;
    return { action: "accept", content: { allow: true } };
  });

  try {
    const entries = await proxy.connect([{
      alias: "fixture",
      server: {
        id: "elicitation-fixture",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {},
        envVars: [],
        experimentalEnvironment: "local",
        required: true,
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
        disabledTools: [],
        tools: {},
      },
    }]);

    const result = await entries[0].call({});
    assert.equal(result.content[0].text, JSON.stringify({ action: "accept", allow: true }));
    assert.equal(requested.message, "Allow the fixture action?");
    assert.deepEqual(requested.requestedSchema.required, ["allow"]);
  } finally {
    await proxy.close();
  }
});
