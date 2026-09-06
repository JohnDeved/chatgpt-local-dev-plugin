import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { RunTracker } from "../dist/runs.js";
import { runTools } from "../dist/run-tools.js";

function fixture() {
  const events = [];
  const tracker = new RunTracker((type, detail, runId) => events.push({ type, detail: structuredClone(detail), runId }));
  const run = tracker.start("owner", "Verify work tracking");
  const update = (todos = [], steeringTasks = [], acknowledgements = []) => tracker.update("owner", run.id, "Explicit test outcome", "progress", acknowledgements, undefined, steeringTasks, todos);
  return { tracker, run, events, update };
}
const reply = () => ({ content: [{ type: "text", text: "original" }], structuredContent: { tool: "project.current", ok: true, data: {}, error: null } });

test("a nonempty declared to-do list is required before work and before successful finish", () => {
  const { tracker, run, update } = fixture();
  assert.throws(() => tracker.requireTodoList(run.id), /RUN_TODO_LIST_REQUIRED/u);
  assert.throws(() => tracker.finish("owner", run.id, "completed", "Done"), /RUN_TODO_LIST_REQUIRED/u);
  update([{ id: "check", title: "Run the checks", status: "queued" }]);
  tracker.requireTodoList(run.id);
  assert.throws(() => tracker.finish("owner", run.id, "completed", "Done"), /RUN_TODOS_UNFINISHED/u);
  update([{ id: "check", status: "completed", note: "Checks passed" }]);
  assert.equal(tracker.finish("owner", run.id, "completed", "Checks passed").state, "completed");
});

test("steering delivery and implementation are independent through every work status", () => {
  const { tracker, run, events, update } = fixture();
  const id = randomUUID();
  const message = tracker.queue(run.id, "Change the UI only", id);
  assert.equal(message.taskStatus, "queued");
  assert.throws(() => update([], [{ id, status: "in_progress" }]), /STEERING_NOT_ACKNOWLEDGED/u);
  tracker.attach(run.id, reply());
  update([{ id: "ui", title: "UI work", status: "queued", steeringId: id }], [], [id]);
  assert.equal(message.state, "acknowledged");
  assert.equal(message.taskStatus, "queued", "Acknowledgement cannot imply implementation");
  for (const status of ["in_progress", "paused", "queued", "in_progress", "completed"]) {
    update([{ id: "ui", status }], [{ id, status, note: `Reported ${status}` }]);
    assert.equal(message.taskStatus, status);
    assert.equal(run.todos[0].status, status);
    assert.equal(run.todos[0].steeringId, id);
    if (status !== "completed") {
      const result = tracker.attach(run.id, reply());
      assert.equal(result.structuredContent.localDevRun.steeringTasks[0].status, status);
      assert.equal(result.structuredContent.localDevRun.todos[0].status, status);
      assert.match(result.content.at(-1).text, /Change the UI only/u);
      assert.throws(() => tracker.finish("owner", run.id, "completed", "Done"), /STEERING_TASKS_UNFINISHED/u);
    }
  }
  tracker.finish("owner", run.id, "completed", "UI verified");
  assert.equal(events.filter((event) => event.type === "steering.acknowledged").length, 1);
  assert.equal(events.filter((event) => event.type === "steering.taskUpdated").length, 5);
});

test("paused work survives unrelated steering and is repeated without losing its stable identity", () => {
  const { tracker, run, update } = fixture();
  update([{ id: "original", title: "Original task", status: "paused", note: "Waiting while handling user direction" }]);
  const id = randomUUID(); tracker.queue(run.id, "New direction", id); tracker.attach(run.id, reply());
  update([{ id: "new", title: "Handle new direction", status: "in_progress", steeringId: id }], [{ id, status: "in_progress" }], [id]);
  const attached = tracker.attach(run.id, reply());
  assert.deepEqual(attached.structuredContent.localDevRun.todos.map((todo) => todo.id), ["original", "new"]);
  assert.match(attached.content.at(-1).text, /Original task/u);
  update([{ id: "new", status: "completed" }], [{ id, status: "completed" }]);
  assert.throws(() => tracker.finish("owner", run.id, "completed", "Only second task done"), /RUN_TODOS_UNFINISHED/u);
  assert.equal(tracker.finish("owner", run.id, "failed", "Original task remains paused").todos[0].status, "paused");
});

test("cancellation is explicit, interruption retains unfinished statuses, and legacy delivery is not success", () => {
  const { tracker, run, update } = fixture();
  const id = randomUUID(); const message = tracker.queue(run.id, "Direction", id); tracker.attach(run.id, reply());
  update([{ id: "work", title: "Task", status: "queued" }], [{ id, status: "cancelled", note: "User changed scope" }], [id]);
  assert.equal(message.state, "acknowledged"); assert.equal(message.taskStatus, "cancelled");
  tracker.interrupt(); assert.equal(run.state, "interrupted"); assert.equal(run.todos[0].status, "queued");
  assert.equal(message.taskStatus, "cancelled");
  const old = fixture(); const legacy = old.tracker.queue(old.run.id, "Old direction", randomUUID());
  delete legacy.taskStatus;
  old.tracker.attach(old.run.id, reply()); old.update([], [], [legacy.id]);
  assert.equal(legacy.taskStatus, undefined, "Legacy records must not be silently marked complete");
});

test("work updates validate atomically, isolate owners, and reject invalid links and duplicate IDs", () => {
  const { tracker, run, events, update } = fixture();
  update([{ id: "work", title: "Keep task", status: "queued" }]);
  const before = JSON.stringify(run), count = events.length;
  assert.throws(() => update([{ id: "work", status: "completed" }, { id: "bad", status: "queued" }]), /INVALID_TODO_UPDATE/u);
  assert.throws(() => update([{ id: "new", title: "Invalid link", status: "queued", steeringId: "unknown" }]), /STEERING_NOT_FOUND/u);
  assert.throws(() => update([{ id: "work", status: "completed" }, { id: "work", status: "paused" }]), /INVALID_TODO_UPDATE/u);
  assert.throws(() => tracker.update("other-owner", run.id, "Hijack", "progress", [], undefined, [], [{ id: "work", status: "completed" }]), /RUN_NOT_FOUND/u);
  assert.equal(JSON.stringify(run), before); assert.equal(events.length, count);
});

test("idempotent work updates do not duplicate task events and arbitrary downstream schemas remain intact", () => {
  const { tracker, run, events, update } = fixture();
  const todos = [{ id: "work", title: "Task", status: "paused" }];
  update(todos); update(todos);
  assert.equal(events.filter((event) => event.type === "run.todoUpdated").length, 1);
  const downstream = { content: [{ type: "text", text: "unchanged" }], structuredContent: { strict: "schema" } };
  const attached = tracker.attach(run.id, downstream);
  assert.equal(attached.structuredContent, downstream.structuredContent);
  assert.equal(attached.content[0], downstream.content[0]);
  assert.match(attached.content.at(-1).text, /Task/u);
});

test("reporting tool schema exposes todos and steering states without accepting arbitrary properties", async () => {
  const { tracker, run } = fixture(); const update = runTools(tracker, () => 0).find((entry) => entry.tool.name === "run.update");
  assert.ok(update.tool.inputSchema.properties.todos); assert.ok(update.tool.inputSchema.properties.steeringTasks);
  const good = await update.call({ runId: run.id, summary: "Planning", todos: [{ id: "a", title: "Verify output", status: "queued" }] }, { runOwner: "owner" });
  assert.notEqual(good.isError, true);
  for (const invalid of [ { status: "done" }, { status: "in_progress", shell: "do things" } ]) {
    const bad = await update.call({ runId: run.id, summary: "Bad", todos: [{ id: "a", ...invalid }] }, { runOwner: "owner" });
    assert.equal(bad.structuredContent.error.code, "INVALID_ARGUMENTS");
  }
});
