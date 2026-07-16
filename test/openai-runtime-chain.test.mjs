import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const launcher = new URL(
  "../scripts/openai-runtime-chain.mjs",
  import.meta.url,
).pathname;

test("trusted runtime chain preserves stdio and exit status", () => {
  const result = spawnSync(
    process.execPath,
    [
      launcher,
      "1",
      process.execPath,
      "-e",
      "process.stdin.pipe(process.stdout)",
    ],
    {
      encoding: "utf8",
      input: "through the chain",
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "through the chain");
  assert.equal(result.stderr, "");
});

test("trusted runtime chain rejects invalid arguments", () => {
  const result = spawnSync(process.execPath, [launcher], {
    encoding: "utf8",
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage: openai-runtime-chain/);
});
