import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolRegistry } from "../dist/tools.js";

function call(tools, name, input, signal = new AbortController().signal) {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.handler(input, signal);
}

test("registry exposes the required bounded compatibility tools and annotations", () => {
  const tools = createToolRegistry();
  assert.deepEqual([...tools.keys()], [
    "compat_ping",
    "compat_echo",
    "compat_sleep",
    "compat_sequence_increment",
    "compat_sequence_read",
    "compat_write_marker",
  ]);

  for (const tool of tools.values()) {
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
  }
});

test("ping and structured echo return exact structured content", async () => {
  const tools = createToolRegistry();
  const ping = await call(tools, "compat_ping", { nonce: "gate-001" });
  assert.deepEqual(ping.structuredContent, {
    ok: true,
    tool: "compat_ping",
    data: { pong: true, nonce: "gate-001" },
    error: null,
  });
  assert.deepEqual(ping.content, [
    { type: "text", text: "compat_ping ok: pong nonce=gate-001" },
  ]);

  const value = { alpha: 1, beta: ["two", true], nested: { null: null } };
  const echo = await call(tools, "compat_echo", { value });
  assert.deepEqual(echo.structuredContent, {
    ok: true,
    tool: "compat_echo",
    data: { value, serializedBytes: 54 },
    error: null,
  });
});

test("sequence state chains deterministically and sleep is bounded", async () => {
  const tools = createToolRegistry();
  assert.deepEqual(
    (await call(tools, "compat_sequence_increment", { by: 2 })).structuredContent.data,
    { value: 2, incrementedBy: 2 },
  );
  assert.deepEqual(
    (await call(tools, "compat_sequence_increment", { by: 5 })).structuredContent.data,
    { value: 7, incrementedBy: 5 },
  );
  assert.deepEqual(
    (await call(tools, "compat_sequence_read", {})).structuredContent.data,
    { value: 7 },
  );

  const sleep = await call(tools, "compat_sleep", { durationMs: 5 });
  assert.deepEqual(sleep.structuredContent.data, {
    requestedMs: 5,
    completed: true,
  });

  const invalid = await call(tools, "compat_sleep", { durationMs: 120_001 });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "INVALID_ARGUMENT");
});

test("sleep supports MCP cancellation without leaking an exception", async () => {
  const tools = createToolRegistry();
  const controller = new AbortController();
  const pending = call(tools, "compat_sleep", { durationMs: 1_000 }, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: "CANCELLED",
    message: "Sleep was cancelled.",
  });
});

test("echo and marker writes enforce byte bounds", async () => {
  const tools = createToolRegistry();
  const echo = await call(tools, "compat_echo", { value: "x", repeat: 16_385 });
  assert.equal(echo.isError, true);
  assert.equal(echo.structuredContent.error.code, "OUTPUT_TOO_LARGE");

  const write = await call(tools, "compat_write_marker", {
    marker: "too-large",
    content: "😀".repeat(1_025),
    confirm: true,
  });
  assert.equal(write.isError, true);
  assert.equal(write.structuredContent.error.code, "OUTPUT_TOO_LARGE");
});

test("harmless write creates once under HOME and never overwrites", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const tools = createToolRegistry();
    const result = await call(tools, "compat_write_marker", {
      marker: "checkpoint-001",
      content: "phase-1-write-ok",
      confirm: true,
    });
    assert.deepEqual(result.structuredContent.data, {
      relativePath: ".local-dev/compatibility-writes/checkpoint-001.txt",
      bytes: 16,
      sha256: "12cb0cc4412b2ec38d00da1abef81e08a74db31a31b47f40473c04c43d845032",
      created: true,
    });
    assert.equal(
      await readFile(
        join(home, ".local-dev", "compatibility-writes", "checkpoint-001.txt"),
        "utf8",
      ),
      "phase-1-write-ok",
    );

    const duplicate = await call(tools, "compat_write_marker", {
      marker: "checkpoint-001",
      content: "replacement-not-allowed",
      confirm: true,
    });
    assert.equal(duplicate.isError, true);
    assert.equal(duplicate.structuredContent.error.code, "ALREADY_EXISTS");
    assert.doesNotMatch(duplicate.content[0].text, /\bat\s+\S+\.js:/u);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
