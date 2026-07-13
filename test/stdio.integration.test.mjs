import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

class McpProcess {
  constructor(extraEnv = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.buffer = "";
    this.process = spawn(process.execPath, ["dist/server.js"], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.#onData(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        const message = JSON.parse(line);
        const waiter = this.pending.get(JSON.stringify(message.id));
        if (waiter) {
          this.pending.delete(JSON.stringify(message.id));
          waiter.resolve(message);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      message.params = params;
    }
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(JSON.stringify(id));
        reject(new Error(`timeout waiting for ${method}`));
      }, 3_000);
      this.pending.set(JSON.stringify(id), {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    return response;
  }

  notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    this.process.stdin.end();
    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
    }
  }
}

async function initialize(client) {
  const response = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "phase-1-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  return response;
}

test("stdio server initializes, lists tools, and handles a four-call chain", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-integration-home-"));
  const client = new McpProcess({ HOME: home });
  try {
    const initialized = await initialize(client);
    assert.deepEqual(initialized.result.serverInfo, {
      name: "local-dev-compatibility-gate",
      version: "0.1.0",
    });
    assert.equal(initialized.result.protocolVersion, "2025-06-18");

    const listed = await client.request("tools/list", {});
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "compat_ping",
        "compat_echo",
        "compat_sleep",
        "compat_sequence_increment",
        "compat_sequence_read",
        "compat_write_marker",
      ],
    );
    for (const tool of listed.result.tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
      assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.ok(tool.outputSchema);
    }

    const first = await client.request("tools/call", {
      name: "compat_sequence_increment",
      arguments: { by: 1 },
    });
    const second = await client.request("tools/call", {
      name: "compat_sequence_increment",
      arguments: { by: 2 },
    });
    const third = await client.request("tools/call", {
      name: "compat_sequence_increment",
      arguments: { by: 4 },
    });
    const fourth = await client.request("tools/call", {
      name: "compat_sequence_read",
      arguments: {},
    });
    assert.equal(first.result.structuredContent.data.value, 1);
    assert.equal(second.result.structuredContent.data.value, 3);
    assert.equal(third.result.structuredContent.data.value, 7);
    assert.equal(fourth.result.structuredContent.data.value, 7);
    assert.equal(client.stderr, "");
  } finally {
    await client.close();
  }
});

test("stdio errors are machine-readable and do not expose stack traces", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-integration-home-"));
  const client = new McpProcess({ HOME: home });
  try {
    await initialize(client);
    const tooLarge = await client.request("tools/call", {
      name: "compat_echo",
      arguments: { value: "x", repeat: 16_385 },
    });
    assert.equal(tooLarge.result.isError, true);
    assert.equal(
      tooLarge.result.structuredContent.error.code,
      "OUTPUT_TOO_LARGE",
    );
    assert.doesNotMatch(JSON.stringify(tooLarge.result), /\bat\s+\S+\.js:/u);

    const unknown = await client.request("tools/call", {
      name: "compat_missing",
      arguments: {},
    });
    assert.equal(unknown.result.structuredContent.error.code, "UNKNOWN_TOOL");
  } finally {
    await client.close();
  }
});

test("optional refresh probe changes the discovered tool list only when enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-refresh-home-"));
  const client = new McpProcess({
    HOME: home,
    LOCAL_DEV_COMPAT_ENABLE_REFRESH_PROBE: "1",
  });
  try {
    await initialize(client);
    const listed = await client.request("tools/list", {});
    assert.equal(listed.result.tools.at(-1).name, "compat_refresh_probe");
    const called = await client.request("tools/call", {
      name: "compat_refresh_probe",
      arguments: {},
    });
    assert.deepEqual(called.result.structuredContent.data, {
      token: "refresh-v2",
    });
  } finally {
    await client.close();
  }
});
