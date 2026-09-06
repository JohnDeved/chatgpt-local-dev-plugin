import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub } from "../dist/activity.js";
import { ProcessManager } from "../dist/core/process.js";
import { CoreRuntime } from "../dist/core/runtime.js";
import { createToolProgress } from "../dist/progress.js";

const mutable = { name: "fixture.write", title: "Fixture mutation", annotations: { readOnlyHint: false } };
const readOnly = { name: "fixture.read", annotations: { readOnlyHint: true } };

async function owner(path) {
  const socket = connect(path);
  socket.setEncoding("utf8");
  const messages = [];
  const waiters = new Set();
  let buffer = "";
  let state;
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      messages.push(message);
      if (message.kind === "snapshot") state = message;
      for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.delete(waiter); waiter.resolve(message); }
    }
  });
  socket.on("error", () => undefined);
  const wait = (predicate, timeout = 5000) => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } };
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("Local activity message timed out")); }, timeout);
      waiters.add(waiter);
    });
  };
  await wait((message) => message.kind === "snapshot");
  return {
    wait,
    get state() { return state; },
    async request(action, fields = {}) {
      const id = randomUUID();
      socket.write(`${JSON.stringify({ id, action, ...fields })}\n`);
      return await wait((message) => message.kind === "ack" && message.id === id);
    },
    close() { socket.destroy(); },
  };
}

async function fixture(t, timeout = 1000) {
  const home = await mkdtemp(join(tmpdir(), "local-dev-activity-"));
  const hub = new ActivityHub(home, timeout);
  await hub.start();
  const ui = await owner(hub.socketPath);
  t.after(async () => { ui.close(); await hub.close(); await rm(home, { recursive: true, force: true }); });
  return { home, hub, ui };
}

async function events(hub) {
  return (await readFile(hub.journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function auto(ui, remember = false) {
  assert.equal((await ui.request("policy", { autoApprove: true, remember, confirmed: true })).ok, true);
}

function waiting(ui, title = mutable.title) {
  return ui.wait((message) => message.kind === "snapshot" && message.operations.some((operation) => operation.title === title && operation.state === "waiting"))
    .then((message) => message.operations.find((operation) => operation.title === title && operation.state === "waiting"));
}

test("local capture works without an MCP progress token and preserves exact inputs and results", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  assert.equal(ui.state.policy.autoApprove, false);
  const args = { argv: ["/bin/echo", "unmasked-secret", "🔐"] };
  const result = { content: [{ type: "text", text: "private full output" }] };
  assert.deepEqual(await hub.execute(readOnly, args, async () => result), result);
  const log = await events(hub);
  assert.deepEqual(log.find((event) => event.type === "tool.requested").detail.arguments, args);
  assert.deepEqual(log.find((event) => event.type === "tool.result").detail.result, result);
  assert.equal(log.some((event) => event.type === "tool.completed"), true);
  assert.equal((await stat(hub.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(hub.journalPath)).mode & 0o777, 0o600);
  assert.equal((await stat(hub.socketPath)).mode & 0o777, 0o600);
});

test("mutations wait for a local decision; approval runs exactly once", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  let calls = 0;
  const execution = hub.execute(mutable, { exact: "arguments" }, async () => ++calls);
  const pending = await waiting(ui);
  assert.equal(calls, 0);
  assert.equal((await ui.request("approve", { operationId: pending.id })).ok, true);
  assert.equal(await execution, 1);
  assert.equal((await ui.request("approve", { operationId: pending.id })).ok, false);
  const log = await events(hub);
  assert.equal(log.find((event) => event.type === "approval.accepted").detail.source, "user");
});

test("denial and expiry never dispatch the operation", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t, 150);
  let calls = 0;
  const denied = hub.execute(mutable, {}, async () => ++calls);
  const rejected = assert.rejects(denied, /APPROVAL_DENIED/u);
  const pending = await waiting(ui);
  await ui.request("deny", { operationId: pending.id });
  await rejected;
  await assert.rejects(hub.execute(mutable, {}, async () => ++calls), /APPROVAL_TIMED_OUT/u);
  assert.equal(calls, 0);
});

test("auto-approve requires explicit confirmation and still records each acceptance", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  assert.equal((await ui.request("policy", { autoApprove: true, remember: false })).ok, false);
  assert.equal(ui.state.policy.autoApprove, false);
  await auto(ui);
  assert.equal(await hub.execute(mutable, {}, async () => "executed"), "executed");
  assert.equal((await events(hub)).some((event) => event.type === "approval.accepted" && event.detail.source === "auto-approve-all"), true);
  await ui.request("policy", { autoApprove: false, remember: false });
  const blocked = hub.execute({ ...mutable, title: "Second mutation" }, {}, async () => true);
  const rejected = assert.rejects(blocked, /APPROVAL_DENIED/u);
  const pending = await waiting(ui, "Second mutation");
  await ui.request("deny", { operationId: pending.id });
  await rejected;
});

test("pause overrides auto-approval, including queued approvals", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  let calls = 0;
  const execution = hub.execute(mutable, {}, async () => ++calls);
  const pending = await waiting(ui);
  await ui.request("pause", { paused: true });
  await auto(ui);
  assert.equal((await ui.request("approve", { operationId: pending.id })).ok, false);
  await assert.rejects(hub.execute(readOnly, {}, async () => ++calls), /ADMISSION_PAUSED/u);
  assert.equal(calls, 0);
  await ui.request("pause", { paused: false });
  assert.equal(await execution, 1);
});

test("remembered policy and pause survive restart; session-only auto-approval does not", { timeout: 8000 }, async (t) => {
  const { home, hub, ui } = await fixture(t);
  await auto(ui, true);
  await ui.request("pause", { paused: true });
  const next = new ActivityHub(home);
  try {
    await next.start();
    await assert.rejects(next.execute(mutable, {}, async () => true), /ADMISSION_PAUSED/u);
    const log = await events(next);
    assert.equal(log[0].detail.autoApprove, true);
  } finally { await next.close(); }
  await ui.request("pause", { paused: false });
  await auto(ui, false);
  const settings = JSON.parse(await readFile(join(hub.directory, "settings.json"), "utf8"));
  assert.equal(settings.autoApprove, false);
  assert.equal(settings.remember, false);
});

test("returned tool errors are recorded as failures, never successful completion", { timeout: 8000 }, async (t) => {
  const { hub } = await fixture(t);
  await hub.execute(readOnly, {}, async () => ({ isError: true, content: [{ type: "text", text: "failed" }] }));
  const log = await events(hub);
  assert.equal(log.some((event) => event.type === "tool.failed"), true);
  assert.equal(log.some((event) => event.type === "tool.completed"), false);
});

test("full stdout and stderr remain available beyond the bounded MCP output tail", { timeout: 8000 }, async (t) => {
  const { hub, ui, home } = await fixture(t);
  await auto(ui);
  const manager = new ProcessManager();
  const payload = "unredacted-" + "x".repeat(90_000) + "🔐";
  const argv = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(payload)});process.stderr.write('separate-stderr')`];
  const result = await hub.execute(mutable, { argv }, async () => await manager.run(argv, home, false));
  assert.equal(result.truncated, true);
  const log = await events(hub);
  const output = log.filter((event) => event.type === "process.output");
  const original = Buffer.concat(output.filter((event) => event.detail.stream === "stdout" && event.detail.bytesBase64).map((event) => Buffer.from(event.detail.bytesBase64, "base64"))).toString("utf8");
  assert.equal(original, payload);
  assert.equal(output.filter((event) => event.detail.stream === "stderr").map((event) => event.detail.text).join(""), "separate-stderr");
  await manager.close();
});

test("stopping a foreground operation terminates its owned process group", { timeout: 15000 }, async (t) => {
  const { hub, ui, home } = await fixture(t);
  await auto(ui);
  const manager = new ProcessManager();
  t.after(() => manager.close());
  const argv = [process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"];
  const execution = hub.execute(mutable, { argv }, async () => await manager.run(argv, home, false, 10_000));
  const rejected = assert.rejects(execution, /OPERATION_CANCELLED/u);
  await ui.wait((message) => message.kind === "event" && message.event.type === "process.output");
  const operation = ui.state.operations.find((item) => item.state === "running");
  assert.ok(operation);
  await ui.request("stop", { operationId: operation.id });
  await rejected;
  const log = await events(hub);
  assert.equal(log.some((event) => event.type === "tool.cancelled"), true);
  const pid = log.find((event) => event.type === "process.started").detail.pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("cancelling a batch prevents later steps even with stopOnError false", { timeout: 15000 }, async (t) => {
  const { home, hub, ui } = await fixture(t);
  await auto(ui);
  const runtime = new CoreRuntime([home], []);
  await runtime.openProject(home);
  t.after(() => runtime.close());
  const marker = join(home, "must-not-exist");
  const steps = [
    { argv: [process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"] },
    { argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`] },
  ];
  const execution = hub.execute(mutable, { steps }, async () => await runtime.batch(steps, false));
  const rejected = assert.rejects(execution, /OPERATION_CANCELLED/u);
  await ui.wait((message) => message.kind === "event" && message.event.type === "process.output");
  await ui.request("stop", { operationId: ui.state.operations[0].id });
  await rejected;
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("local auto-approval handles approval forms but never invents information answers", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  await auto(ui);
  const approval = await hub.elicit({ mode: "form", message: "Allow?", requestedSchema: { type: "object", properties: { allow: { type: "boolean" } } } }, async () => { throw new Error("should not forward"); });
  assert.deepEqual(approval, { action: "accept", content: { allow: true } });
  let forwarded = false;
  const information = await hub.elicit({ mode: "form", message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }, async () => { forwarded = true; return { action: "cancel" }; });
  assert.equal(forwarded, true);
  assert.deepEqual(information, { action: "cancel" });
});

test("capture failure blocks dispatch and is visible in the local state", { timeout: 8000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  await unlink(hub.journalPath);
  let dispatched = false;
  await assert.rejects(hub.execute(readOnly, {}, async () => { dispatched = true; }), /ACTIVITY_CAPTURE_UNAVAILABLE/u);
  assert.equal(dispatched, false);
  await ui.request("snapshot");
  assert.equal(ui.state.policy.paused, true);
  assert.ok(ui.state.fault);
});

test("the local control channel does not expose arbitrary command execution", { timeout: 8000 }, async (t) => {
  const { ui } = await fixture(t);
  assert.equal((await ui.request("run", { argv: ["/bin/echo", "not allowed"] })).ok, false);
});

test("hundreds of progress notifications stay strictly increasing without invented totals", async () => {
  const values = [];
  const progress = createToolProgress({ progressToken: "long" }, async ({ params }) => values.push(params));
  for (let index = 0; index < 250; index += 1) await progress.report("Still running", index % 2 ? 0.1 : 0.9);
  assert.equal(values.length, 250);
  assert.equal(values.every((value, index) => value.progress === index && value.total === undefined), true);
});
