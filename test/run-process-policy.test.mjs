import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub } from "../dist/activity.js";
import { runTools } from "../dist/run-tools.js";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "local-dev-run-process-policy-"));
  const hub = new ActivityHub(home);
  await hub.start();
  t.after(async () => {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  });
  const tools = runTools(
    hub.runs,
    (id) => hub.backgroundCount(id),
    async (id) => await hub.stopProcessesForRun(id),
  );
  return {
    hub,
    home,
    start: tools.find((entry) => entry.tool.name === "run.start"),
    update: tools.find((entry) => entry.tool.name === "run.update"),
    finish: tools.find((entry) => entry.tool.name === "run.finish"),
  };
}

async function completedTodo(update, runId, backgroundProcessPolicy) {
  return await update.call(
    {
      runId,
      summary: "Tracked work is complete.",
      todos: [{ id: "work", title: "Finish work", status: "completed" }],
      ...(backgroundProcessPolicy ? { backgroundProcessPolicy } : {}),
    },
    { runOwner: "owner" },
  );
}

function fakeProcess(hub, runId, id, stop) {
  let untrack = () => undefined;
  untrack = hub.trackProcess({
    id,
    operationId: `operation-${id}`,
    runId,
    pid: 9000,
    argv: ["node", "server.js"],
    cwd: "/project",
    startedAt: new Date().toISOString(),
    stop: async () => await stop(untrack),
  });
  return untrack;
}

test("completed runs clean up their owned background processes by default", async (t) => {
  const { hub, start, update, finish } = await fixture(t);
  const started = await start.call({ goal: "Build and verify the feature" }, { runOwner: "owner" });
  const runId = started.structuredContent.data.run.id;
  assert.equal(started.structuredContent.data.run.backgroundProcessPolicy, "cleanup");
  await completedTodo(update, runId);
  let stops = 0;
  fakeProcess(hub, runId, "cleanup", async (untrack) => {
    stops++;
    untrack();
    return true;
  });
  assert.equal(hub.backgroundCount(runId), 1);
  const result = await finish.call(
    { runId, outcome: "completed", summary: "Feature verified." },
    { runOwner: "owner" },
  );
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.run.state, "completed");
  assert.equal(stops, 1);
  assert.equal(hub.backgroundCount(runId), 0);
  const events = (await readFile(hub.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
  const cleanup = events.find((event) => event.type === "run.processCleanup");
  assert.deepEqual(cleanup.detail, { requested: 1, stopped: 1, remaining: 0, source: "run_finish" });
  assert.equal(events.find((event) => event.type === "run.ended").detail.backgroundProcesses, 0);
});

test("keep policy is an explicit escape hatch for intentional persistent services", async (t) => {
  const { hub, start, update, finish } = await fixture(t);
  const started = await start.call(
    { goal: "Start a preview server for the user", backgroundProcessPolicy: "keep" },
    { runOwner: "owner" },
  );
  const runId = started.structuredContent.data.run.id;
  assert.equal(started.structuredContent.data.run.backgroundProcessPolicy, "keep");
  await completedTodo(update, runId);
  let stops = 0;
  const untrack = fakeProcess(hub, runId, "keep", async () => {
    stops++;
    return true;
  });
  const result = await finish.call(
    { runId, outcome: "completed", summary: "Preview server is ready and intentionally left running." },
    { runOwner: "owner" },
  );
  assert.equal(result.structuredContent.ok, true);
  assert.equal(stops, 0);
  assert.equal(hub.backgroundCount(runId), 1);
  const events = (await readFile(hub.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.some((event) => event.type === "run.processCleanup"), false);
  assert.equal(events.find((event) => event.type === "run.ended").detail.backgroundProcesses, 1);
  untrack();
});

test("cleanup must be confirmed before a completed outcome is recorded", async (t) => {
  const { hub, start, update, finish } = await fixture(t);
  const started = await start.call({ goal: "Run a temporary server during verification" }, { runOwner: "owner" });
  const runId = started.structuredContent.data.run.id;
  await completedTodo(update, runId);
  const untrack = fakeProcess(hub, runId, "stuck", async () => false);
  const result = await finish.call(
    { runId, outcome: "completed", summary: "Attempted completion." },
    { runOwner: "owner" },
  );
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, "RUN_PROCESS_CLEANUP_UNCONFIRMED");
  assert.equal(hub.runs.activeFor("owner").state, "running");
  assert.equal(hub.backgroundCount(runId), 1);
  untrack();
});

test("run.update can change process policy without changing the goal", async (t) => {
  const { start, update } = await fixture(t);
  const started = await start.call({ goal: "Prepare a service" }, { runOwner: "owner" });
  const runId = started.structuredContent.data.run.id;
  const changed = await update.call(
    {
      runId,
      summary: "The service should remain available after completion.",
      backgroundProcessPolicy: "keep",
      todos: [{ id: "service", title: "Prepare service", status: "in_progress" }],
    },
    { runOwner: "owner" },
  );
  assert.equal(changed.structuredContent.data.run.backgroundProcessPolicy, "keep");
});

test("run tool schemas advertise cleanup and keep policies", async (t) => {
  const { start, update } = await fixture(t);
  assert.deepEqual(start.tool.inputSchema.properties.backgroundProcessPolicy.enum, ["cleanup", "keep"]);
  assert.equal(start.tool.inputSchema.properties.backgroundProcessPolicy.default, "cleanup");
  assert.deepEqual(update.tool.inputSchema.properties.backgroundProcessPolicy.enum, ["cleanup", "keep"]);
});
