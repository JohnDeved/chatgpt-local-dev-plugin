import assert from "node:assert/strict";
import test from "node:test";

import { prepareStdioLaunch } from "../dist/trusted-runtime.js";

function server(overrides = {}) {
  return {
    id: "node_repl",
    transport: "stdio",
    command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    args: ["--example"],
    cwd: undefined,
    env: {},
    envVars: [],
    experimentalEnvironment: "local",
    required: true,
    startupTimeoutMs: 30_000,
    toolTimeoutMs: 30_000,
    disabledTools: [],
    tools: {},
    ...overrides,
  };
}

test("wraps the bundled node_repl in two trusted OpenAI Node ancestors", () => {
  const launch = prepareStdioLaunch(server());

  assert.equal(
    launch.command,
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
  );
  assert.match(
    launch.args[0],
    /scripts\/openai-runtime-chain\.mjs$/u,
  );
  assert.deepEqual(launch.args.slice(1), [
    "1",
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    "--example",
  ]);
});

test("leaves unrelated and already wrapped stdio servers unchanged", () => {
  const unrelated = server({ id: "other", command: "/usr/local/bin/node_repl" });
  assert.deepEqual(prepareStdioLaunch(unrelated), {
    command: unrelated.command,
    args: unrelated.args,
  });

  const wrapped = server({
    command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    args: ["launcher.mjs", "1", "node_repl"],
  });
  assert.deepEqual(prepareStdioLaunch(wrapped), {
    command: wrapped.command,
    args: wrapped.args,
  });
});
