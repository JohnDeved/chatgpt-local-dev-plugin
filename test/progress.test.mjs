import assert from "node:assert/strict";
import test from "node:test";

import { commandLabel } from "../dist/core/command-label.js";
import { createToolProgress } from "../dist/progress.js";

test("formats command labels with every exact argument", () => {
  assert.equal(
    commandLabel(["/usr/local/bin/npm", "run", "check"]),
    "\"/usr/local/bin/npm\" \"run\" \"check\"",
  );
  assert.equal(
    commandLabel([process.execPath, "-e", "console.log('private inline source')"]),
    `${JSON.stringify(process.execPath)} "-e" "console.log('private inline source')"`,
  );
  assert.equal(
    commandLabel([
      "/usr/bin/curl",
      "--authorization",
      "Bearer private-value",
      "--api-key=another-private-value",
      "https://example.com/long/path",
    ]),
    "\"/usr/bin/curl\" \"--authorization\" \"Bearer private-value\" \"--api-key=another-private-value\" \"https://example.com/long/path\"",
  );
});

test("creates monotonic best-effort MCP progress notifications", async () => {
  const notifications = [];
  const progress = createToolProgress(
    { progressToken: "request-progress" },
    async (notification) => { notifications.push(notification); },
  );
  assert.ok(progress);

  await progress.report(" Starting   work… ", 0);
  await progress.report("Still working");
  await progress.report("A lower requested fraction still moves forward", 0.01);
  await progress.report("x".repeat(300), 1);

  assert.deepEqual(
    notifications.map(({ params }) => params.progress),
    [0, 1, 2, 3],
  );
  assert.equal(notifications.every(({ params }) => params.total === undefined), true);
  assert.equal(notifications.every(({ params }) => params.progressToken === "request-progress"), true);
  assert.equal(notifications[0].params.message, " Starting   work… ");
  assert.equal(notifications[3].params.message.length, 300);

  const absent = createToolProgress({}, async () => undefined);
  assert.equal(absent, undefined);

  const ignoredFailure = createToolProgress(
    { progressToken: 7 },
    async () => { throw new Error("client disconnected"); },
  );
  await ignoredFailure.report("This must not fail the tool", 0.5);
});
