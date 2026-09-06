import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { RunTracker, runOwner } from "../dist/runs.js";
import { runTools } from "../dist/run-tools.js";
import { ActivityHub } from "../dist/activity.js";
import { ProcessManager } from "../dist/core/process.js";

const result = () => ({ content: [{ type: "text", text: "original result" }], structuredContent: { value: 42 } });
function trackerFixture() {
  const events = [];
  const tracker = new RunTracker((type, detail, runId) => events.push({ type, detail: structuredClone(detail), runId }));
  return { tracker, events };
}

async function localControl(path) {
  const socket = connect(path);
  socket.setEncoding("utf8");
  const pending = new Map();
  let buffer = "";
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.kind === "ack") pending.get(message.id)?.(message);
    }
  });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return {
    send(action, fields = {}) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("CONTROL_TIMEOUT")); }, 3000);
        pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
        socket.write(JSON.stringify({ id, action, ...fields }) + "\n");
      });
    },
    close() { socket.destroy(); },
  };
}

test("run boundaries are explicit and goals promote observed activity without duplicate starts", () => {
  const { tracker, events } = trackerFixture();
  const observed = tracker.ensure("runtime");
  assert.equal(observed.goal, null);
  assert.equal(observed.origin, "observed");
  const declared = tracker.start("runtime", "Improve the UI", "UI improvement");
  assert.equal(declared.id, observed.id);
  assert.equal(declared.goal, "Improve the UI");
  assert.equal(tracker.start("runtime", "Improve the UI").id, declared.id);
  assert.equal(events.filter((event) => event.type === "run.started").length, 1);
  assert.throws(() => tracker.start("runtime", "Different goal"), /ACTIVE_RUN_EXISTS/u);
  tracker.update("runtime", declared.id, "I will preserve the original records.", "plan");
  assert.equal(tracker.snapshot()[0].state, "running");
  tracker.update("runtime", declared.id, "UI checks finished", "progress", [], undefined, [], [{ id: "verify", title: "Verify UI", status: "completed" }]);
  tracker.finish("runtime", declared.id, "completed", "UI checked", 1);
  assert.equal(tracker.snapshot().length, 0);
  assert.equal(events.at(-1).detail.backgroundProcesses, 1);
  assert.equal(events.at(-1).detail.source, "assistant_report");
  assert.equal(tracker.finish("runtime", declared.id, "completed", "UI checked").state, "completed");
  const next = tracker.ensure("runtime");
  assert.notEqual(next.id, declared.id);
});

test("native structured envelopes carry steering while arbitrary downstream schemas stay intact", () => {
  const { tracker } = trackerFixture();
  const goal = "A".repeat(180) + "\nThe complete goal remains available.";
  const run = tracker.start("one", goal);
  assert.equal(run.title.length, 120);
  assert.equal(run.goal, goal);
  const messageId = randomUUID();
  tracker.queue(run.id, "Keep the change read-only", messageId);
  const native = { isError: true, content: [], structuredContent: { ok: false, tool: "project.current", data: null, error: { code: "STEERING_PENDING" } } };
  const attached = tracker.attach(run.id, native);
  assert.equal(attached.structuredContent.localDevRun.steering[0].id, messageId);
  assert.equal(attached.structuredContent.localDevRun.steering[0].text, "Keep the change read-only");
  assert.equal(attached.structuredContent.error, native.structuredContent.error);
  assert.equal(native.structuredContent.localDevRun, undefined);
  const downstream = { content: [], structuredContent: { ok: true, tool: "external.custom", exact: "schema" } };
  assert.equal(tracker.attach(run.id, downstream).structuredContent, downstream.structuredContent);
});

test("run cannot finish while operations are active, and interruption is not success", () => {
  const { tracker, events } = trackerFixture();
  const run = tracker.start("one", "Check build");
  const leave = tracker.enter(run.id);
  assert.throws(() => tracker.finish("one", run.id, "completed", "Done"), /RUN_OPERATIONS_ACTIVE/u);
  leave();
  tracker.interrupt();
  assert.equal(run.state, "interrupted");
  assert.equal(events.some((event) => event.type === "run.ended"), false);
  assert.throws(() => tracker.queue(run.id, "Change direction", randomUUID()), /RUN_ALREADY_ENDED/u);
});

test("steering is queued, included in a response, then explicitly acknowledged", () => {
  const { tracker, events } = trackerFixture();
  const run = tracker.start("one", "Improve timeline");
  const messageID = randomUUID();
  const queued = tracker.queue(run.id, "Only change the local UI", messageID);
  assert.equal(queued.state, "queued");
  assert.throws(() => tracker.assertCanProceed(run.id), /STEERING_PENDING/u);
  assert.throws(() => tracker.update("one", run.id, "Received", "progress", [messageID]), /STEERING_NOT_RETURNED/u);
  const original = result();
  const response = tracker.attach(run.id, original);
  assert.equal(response.structuredContent, original.structuredContent);
  assert.equal(response.content[0], original.content[0]);
  assert.match(response.content.at(-1).text, /Only change the local UI/u);
  assert.equal(queued.state, "returned");
  assert.throws(() => tracker.assertCanProceed(run.id), /STEERING_PENDING/u);
  assert.throws(() => tracker.finish("one", run.id, "completed", "Finished"), /STEERING_PENDING/u);
  tracker.update("one", run.id, "I will limit edits to the UI.", "decision", [messageID], "Improve only the local UI");
  tracker.assertCanProceed(run.id);
  assert.equal(queued.state, "acknowledged");
  assert.equal(run.goal, "Improve only the local UI");
  assert.equal(events.filter((event) => event.type === "run.note").length, 1);
  assert.throws(() => tracker.finish("one", run.id, "completed", "Not finished"), /STEERING_TASKS_UNFINISHED/u);
  tracker.update("one", run.id, "UI-only changes verified.", "progress", [], undefined, [{ id: messageID, status: "completed" }]);
  tracker.update("one", run.id, "Complete requested scope", "progress", [], undefined, [], [{ id: "ui", title: "UI only", status: "completed" }]);
  tracker.finish("one", run.id, "completed", "UI-only changes complete");
});

test("steering retries are idempotent and acknowledgement validation is atomic", () => {
  const { tracker, events } = trackerFixture();
  const run = tracker.start("one", "Work");
  const id = randomUUID();
  tracker.queue(run.id, "Keep tests", id);
  tracker.queue(run.id, "Keep tests", id);
  assert.equal(run.steering.length, 1);
  assert.throws(() => tracker.queue(run.id, "Different text", id), /STEERING_ID_CONFLICT/u);
  tracker.attach(run.id, result()); tracker.attach(run.id, result());
  assert.equal(events.filter((event) => event.type === "steering.returned").length, 1);
  const count = events.length;
  assert.throws(() => tracker.update("one", run.id, "Ack", "progress", [id, "unknown"]), /STEERING_NOT_RETURNED/u);
  assert.equal(events.length, count);
  assert.equal(run.steering[0].state, "returned");
  tracker.update("one", run.id, "Keep the tests", "decision", [id]);
  tracker.update("one", run.id, "Still keeping the tests", "progress", [id]);
  assert.equal(events.filter((event) => event.type === "steering.acknowledged").length, 1);
});

test("supplied sessions isolate runs and steering without storing raw session values", () => {
  const { tracker } = trackerFixture();
  const a = runOwner({ "openai/session": "private-session-A" });
  const b = runOwner({ "openai/session": "private-session-B" });
  assert.notEqual(a, b);
  assert.equal(a.includes("private-session"), false);
  assert.equal(runOwner(), "runtime");
  const first = tracker.start(a, "First task");
  const second = tracker.start(b, "Second task");
  tracker.queue(first.id, "Private steering for A", randomUUID());
  assert.throws(() => tracker.update(b, first.id, "Hijack", "progress"), /RUN_NOT_FOUND/u);
  assert.equal(tracker.attach(second.id, result()).content.at(-1).text.includes("Private steering"), false);
  tracker.assertCanProceed(second.id);
});

test("steering limits reject oversize or empty input without claiming it was queued", () => {
  const { tracker } = trackerFixture();
  const run = tracker.start("one", "Task");
  assert.throws(() => tracker.queue(run.id, " ", randomUUID()), /INVALID_STEERING/u);
  assert.throws(() => tracker.queue(run.id, "x".repeat(4001), randomUUID()), /INVALID_STEERING/u);
  for (let n = 0; n < 20; n++) tracker.queue(run.id, `Message ${n}`, randomUUID());
  assert.throws(() => tracker.queue(run.id, "Overflow", randomUUID()), /STEERING_QUEUE_FULL/u);
  assert.equal(run.steering.length, 20);
});

test("run report tools validate input and expose only public summary fields", async () => {
  const { tracker, events } = trackerFixture();
  const tools = runTools(tracker, () => 0);
  const start = tools.find((entry) => entry.tool.name === "run.start");
  const update = tools.find((entry) => entry.tool.name === "run.update");
  assert.equal((await start.call({ goal: "" })).isError, true);
  const started = await start.call({ goal: "Implement readable runs", plan: "Inspect, implement, then test." }, { runOwner: "one" });
  const id = started.structuredContent.data.run.id;
  assert.equal((await update.call({ runId: id, summary: "Public decision", kind: "private_thinking" }, { runOwner: "one" })).isError, true);
  assert.equal(events.filter((event) => event.type === "run.note").length, 1);
  assert.equal(events.find((event) => event.type === "run.note").detail.source, "assistant_summary");
});

test("activity scope stamps nested tools and late background output with the same run", { timeout: 10000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "run-scope-"));
  const hub = new ActivityHub(home);
  const manager = new ProcessManager();
  try {
    await hub.start();
    const run = hub.runs.start("one", "Read-only fixture");
    const readOnly = { name: "fixture", annotations: { readOnlyHint: true } };
    await hub.execute(readOnly, {}, async () => {
      return await hub.execute(readOnly, {}, async () => await manager.run([process.execPath, "-e", "setTimeout(()=>process.stdout.write('later'),80)"], home, true));
    }, undefined, undefined, run.id);
    await delay(200);
    await manager.close();
    const events = (await readFile(hub.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
    for (const event of events.filter((event) => event.type.startsWith("tool.") || event.type === "process.output")) assert.equal(event.runId, run.id);
    assert.equal(events.filter((event) => event.type === "tool.requested").length, 2);
  } finally { await manager.close(); await hub.close(); await rm(home, { recursive: true, force: true }); }
});

test("new steering between commands blocks the next process without undoing finished work", { timeout: 10000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "run-boundary-"));
  const hub = new ActivityHub(home);
  const manager = new ProcessManager();
  try {
    await hub.start();
    const run = hub.runs.start("one", "Run two checks");
    await assert.rejects(hub.execute({ name: "fixture", annotations: { readOnlyHint: true } }, {}, async () => {
      await manager.run([process.execPath, "--version"], home, false);
      hub.runs.queue(run.id, "Do not start the second command", randomUUID());
      return await manager.run([process.execPath, "--version"], home, false);
    }, undefined, undefined, run.id), /STEERING_PENDING/u);
    const events = (await readFile(hub.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "process.started").length, 1);
  } finally { await manager.close(); await hub.close(); await rm(home, { recursive: true, force: true }); }
});

test("real stdio client receives locally queued steering, acknowledges, and finishes the run", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "run-stdio-"));
  let control;
  const entry = new URL("../dist/server.js", import.meta.url).href;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--input-type=module", "-e", `import { runServer } from ${JSON.stringify(entry)}; runServer().catch(error => { console.error(error); process.exitCode = 1; });`],
    env: { ...process.env, HOME: home }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "run-test", version: "1.0" });
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".local-dev"), { recursive: true });
    await writeFile(join(home, ".codex/config.toml"), "");
    await writeFile(join(home, ".local-dev/config.json"), JSON.stringify({ version: 1, projectRoots: [home], selectedServers: [], projectOpenHooks: [] }));
    await client.connect(transport);
    const start = await client.callTool({ name: "run.start", arguments: { goal: "Verify local steering", plan: "Test a read-only status call." } });
    const id = start.structuredContent.data.run.id;
    const beforePlan = await client.callTool({ name: "dev.run", arguments: { argv: [process.execPath, "--version"] } });
    assert.equal(beforePlan.structuredContent.error.code, "RUN_TODO_LIST_REQUIRED");
    const plan = await client.callTool({ name: "run.update", arguments: { runId: id, summary: "Publish work before dispatch", todos: [{ id: "status", title: "Inspect status", status: "in_progress" }] } });
    assert.notEqual(plan.isError, true);
    const directory = join(home, ".local-dev/activity");
    const manifestFile = (await readdir(directory)).find((name) => name.endsWith(".json") && name !== "settings.json");
    const manifest = JSON.parse(await readFile(join(directory, manifestFile), "utf8"));
    control = await localControl(manifest.socketPath);
    const messageID = randomUUID();
    assert.equal((await control.send("steer", { runId: id, text: "Only inspect status", messageId: messageID })).ok, true);
    const blocked = await client.callTool({ name: "project.current", arguments: {} });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.error.code, "STEERING_PENDING");
    assert.match(blocked.content.at(-1).text, /Only inspect status/u);
    const ack = await client.callTool({ name: "run.update", arguments: { runId: id, summary: "I will inspect status only.", acknowledgedSteeringIds: [messageID] } });
    assert.notEqual(ack.isError, true);
    const check = await client.callTool({ name: "project.current", arguments: {} });
    assert.equal(check.structuredContent.ok, true);
    const resolved = await client.callTool({ name: "run.update", arguments: { runId: id, summary: "Status inspected, no files changed.", todos: [{ id: "status", status: "completed" }], steeringTasks: [{ id: messageID, status: "completed", note: "Read-only status check passed." }] } });
    assert.notEqual(resolved.isError, true);
    const finish = await client.callTool({ name: "run.finish", arguments: { runId: id, outcome: "completed", summary: "Status inspected; no files changed." } });
    assert.equal(finish.structuredContent.data.run.state, "completed");
    const log = (await readFile(manifest.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(log.filter((event) => event.type === "run.started").length, 1);
    assert.equal(log.filter((event) => event.type === "run.ended").length, 1);
    assert.equal(log.filter((event) => event.type === "steering.acknowledged").length, 1);
    assert.equal(log.some((event) => event.type === "policy.changed"), false);
  } catch (error) {
    throw new Error(`Run integration failed. Child diagnostics: ${stderr}`, { cause: error });
  } finally { control?.close(); await client.close(); await rm(home, { recursive: true, force: true }); }
});
