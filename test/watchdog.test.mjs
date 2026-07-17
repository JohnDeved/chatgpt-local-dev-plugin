import assert from "node:assert/strict";
import test from "node:test";

import { sleepGapDetected, watchdogCycle } from "../dist/setup/watchdog.js";

const state = {
  version: 1,
  alias: "local-dev",
  binaryPath: "/tmp/tunnel-client",
  tunnelId: "tunnel_fixture",
  runtimeKeyRef: "file:/tmp/runtime-key",
  mcpCommand: "'/tmp/node' '/tmp/server.js'",
  launchAgentPath: null,
  configuredAt: "2026-07-17T00:00:00.000Z",
};

test("sleep gap detection distinguishes normal checks from wake recovery", () => {
  assert.equal(sleepGapDetected(0, 30_000), false);
  assert.equal(sleepGapDetected(0, 90_000), false);
  assert.equal(sleepGapDetected(0, 90_001), true);
});

test("watchdog leaves a healthy runtime untouched", async () => {
  const calls = [];
  const runner = {
    json: async (program, args) => {
      calls.push(["json", program, ...args]);
      return { process_running: true, healthy: true, ready: true };
    },
    command: async (program, args) => {
      calls.push(["command", program, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  assert.equal(await watchdogCycle(state, false, runner), "healthy");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "json");
});

test("watchdog force-recycles a locally healthy runtime after wake", async () => {
  const calls = [];
  const runner = {
    json: async (program, args) => {
      calls.push(["json", program, ...args]);
      return { process_running: true, healthy: true, ready: true };
    },
    command: async (program, args) => {
      calls.push(["command", program, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  assert.equal(await watchdogCycle(state, true, runner), "recycled");
  assert.deepEqual(calls[1], ["command", state.binaryPath, "runtimes", "stop", state.alias, "--json"]);
  assert.deepEqual(calls[2], [
    "command",
    state.binaryPath,
    "runtimes",
    "connect",
    "--alias",
    state.alias,
    "--tunnel-id",
    state.tunnelId,
    "--runtime-api-key",
    state.runtimeKeyRef,
    "--mcp-command",
    state.mcpCommand,
    "--json",
  ]);
});
