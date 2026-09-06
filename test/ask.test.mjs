import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { ActivityHub } from "../dist/activity.js";
import { askTool } from "../dist/ask-tool.js";

const readOnly = { name: "ask", title: "Ask the user", annotations: { readOnlyHint: true } };
const question = {
  question: "Which approach should I use?",
  header: "Implementation choice",
  options: [
    { id: "safe", label: "Safer change", description: "Keep compatibility." },
    { id: "fast", label: "Faster change", description: "Prefer speed." },
  ],
  recommended: "safe",
  allowOther: true,
};

async function viewer(path) {
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
      for (const waiter of [...waiters]) if (waiter.predicate(message)) {
        waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message);
      }
    }
  });
  const wait = (predicate, timeout = 3000) => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("viewer timeout")); }, timeout),
      };
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
async function fixture(t, askTimeout = 90_000) {
  const home = await mkdtemp(join(tmpdir(), "local-dev-ask-"));
  const hub = new ActivityHub(home, 1000, askTimeout);
  await hub.start();
  const ui = await viewer(hub.socketPath);
  t.after(async () => { ui.close(); await hub.close(); await rm(home, { recursive: true, force: true }); });
  return { hub, ui };
}
async function log(hub) {
  return (await readFile(hub.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
}
async function setAuto(ui, value) {
  const result = await ui.request("policy", { autoApprove: value, remember: false, ...(value ? { confirmed: true } : {}) });
  assert.equal(result.ok, true);
}
async function pendingAsk(ui) {
  const snapshot = await ui.wait((message) => message.kind === "snapshot" && message.asks?.length);
  return snapshot.asks[0];
}
function executeAsk(hub, signal) {
  return hub.execute(readOnly, question, () => hub.ask(question, signal), signal);
}

test("manual Ask answer is returned and journaled separately from approvals", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 120);
  const answer = executeAsk(hub);
  const pending = await pendingAsk(ui);
  assert.equal(pending.question, question.question);
  assert.equal(pending.expiresAt, undefined);
  assert.equal(ui.state.operations.find((operation) => operation.id === pending.operationId)?.state, "running");
  assert.equal((await ui.request("answerAsk", { askId: pending.id, optionId: "fast" })).ok, true);
  const resolved = await answer;
  assert.deepEqual({ ...resolved, waitedMs: 0 }, { askId: pending.id, optionId: "fast", label: "Faster change", source: "user", waitedMs: 0 });
  assert.ok(resolved.waitedMs >= 0);
  const events = await log(hub);
  assert.equal(events.find((event) => event.type === "ask.requested").detail.ask.question, question.question);
  assert.equal(events.find((event) => event.type === "ask.answered").detail.answer.source, "user");
  assert.equal(events.some((event) => event.type === "approval.requested"), false);
});

test("auto-approve gives the user a countdown, then selects only the explicit recommendation", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 90);
  await setAuto(ui, true);
  const answerPromise = executeAsk(hub);
  const pending = await pendingAsk(ui);
  assert.ok(Date.parse(pending.expiresAt) - Date.now() <= 110);
  assert.ok(Date.parse(pending.expiresAt) - Date.now() > 0);
  const answer = await answerPromise;
  assert.equal(answer.optionId, "safe");
  assert.equal(answer.label, "Safer change");
  assert.equal(answer.source, "auto-recommended");
  const events = await log(hub);
  assert.equal(events.find((event) => event.type === "ask.answered").detail.answer.source, "auto-recommended");
});

test("turning auto-approve off cancels fallback without losing the pending question", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 80);
  await setAuto(ui, true);
  const answerPromise = executeAsk(hub);
  const pending = await pendingAsk(ui);
  await setAuto(ui, false);
  await ui.wait((message) => message.kind === "snapshot" && message.asks?.[0]?.id === pending.id && message.asks[0].expiresAt === undefined);
  assert.equal(await Promise.race([answerPromise.then(() => "answered"), delay(130, "pending")]), "pending");
  await ui.request("answerAsk", { askId: pending.id, optionId: "fast" });
  assert.equal((await answerPromise).source, "user");
});

test("pause removes the auto-answer deadline but still allows an explicit user answer", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 80);
  await setAuto(ui, true);
  const answerPromise = executeAsk(hub);
  const pending = await pendingAsk(ui);
  await ui.request("pause", { paused: true });
  await ui.wait((message) => message.kind === "snapshot" && message.asks?.[0]?.id === pending.id && message.asks[0].expiresAt === undefined);
  assert.equal(await Promise.race([answerPromise.then(() => "answered"), delay(130, "pending")]), "pending");
  assert.equal((await ui.request("answerAsk", { askId: pending.id, optionId: "safe" })).ok, true);
  assert.equal((await answerPromise).source, "user");
});

test("enabling auto-approve on an existing manual question starts a fresh timeout", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 80);
  const answerPromise = executeAsk(hub);
  const pending = await pendingAsk(ui);
  assert.equal(pending.expiresAt, undefined);
  await setAuto(ui, true);
  const timed = await ui.wait((message) => message.kind === "snapshot" && message.asks?.[0]?.expiresAt);
  assert.equal(timed.asks[0].id, pending.id);
  assert.equal((await answerPromise).source, "auto-recommended");
});

test("custom answers require allowOther and are bounded", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t);
  const promise = executeAsk(hub);
  const pending = await pendingAsk(ui);
  assert.equal((await ui.request("answerAsk", { askId: pending.id, text: "Use a hybrid approach" })).ok, true);
  assert.equal((await promise).text, "Use a hybrid approach");

  const lockedQuestion = { ...question, question: "Which locked approach should I use?", allowOther: false };
  const locked = hub.execute(readOnly, lockedQuestion, () => hub.ask(lockedQuestion));
  const pendingLocked = await ui.wait((message) => message.kind === "snapshot" && message.asks?.some((ask) => ask.question === lockedQuestion.question));
  const ask = pendingLocked.asks.find((item) => item.question === lockedQuestion.question);
  assert.equal((await ui.request("answerAsk", { askId: ask.id, text: "Not allowed" })).ok, false);
  await ui.request("answerAsk", { askId: ask.id, optionId: "safe" });
  await locked;
});

test("Ask input schema requires unique options and a real recommended option", async (t) => {
  const { hub } = await fixture(t);
  const entry = askTool(hub);
  const bad = await entry.call({ question: "Choose", options: [{
     id: "a", label: "A" }, { id: "a", label: "Again" }], recommended: "missing" });
  assert.equal(bad.structuredContent.error.code, "INVALID_ARGUMENTS");
  assert.equal(entry.tool.annotations.readOnlyHint, true);
  assert.match(entry.tool.description, /90 seconds/u);
});

test("aborting an Ask removes it and never falls back later", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 60);
  await setAuto(ui, true);
  const controller = new AbortController();
  const promise = executeAsk(hub, controller.signal);
  const pending = await pendingAsk(ui);
  controller.abort();
  await assert.rejects(promise, /OPERATION_CANCELLED/u);
  await ui.wait((message) => message.kind === "snapshot" && !message.asks?.some((ask) => ask.id === pending.id));
  await delay(100);
  assert.equal((await log(hub)).some((event) => event.type === "ask.answered" && event.detail.askId === pending.id), false);
});


test("concurrent Ask questions keep independent auto-answer deadlines", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 100);
  await setAuto(ui, true);
  const first = executeAsk(hub);
  const firstAsk = await pendingAsk(ui);
  await delay(45);
  const secondQuestion = { ...question, question: "Which second approach?" };
  const second = hub.execute(readOnly, secondQuestion, () => hub.ask(secondQuestion));
  const both = await ui.wait((message) => message.kind === "snapshot" && message.asks?.length === 2);
  const secondAsk = both.asks.find((ask) => ask.id !== firstAsk.id);
  assert.ok(Date.parse(secondAsk.expiresAt) > Date.parse(firstAsk.expiresAt));
  const firstAnswer = await first;
  assert.equal(firstAnswer.source, "auto-recommended");
  assert.equal((await Promise.race([second.then(() => "answered"), delay(20, "pending")])), "pending");
  assert.equal((await second).source, "auto-recommended");
});


test("changing Remember while auto-answer stays active does not restart the countdown", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 180);
  await setAuto(ui, true);
  const promise = executeAsk(hub);
  const pending = await pendingAsk(ui);
  const deadline = pending.expiresAt;
  await delay(30);
  const policy = await ui.request("policy", { autoApprove: true, remember: true, confirmed: true });
  assert.equal(policy.ok, true);
  const after = await ui.wait((message) => message.kind === "snapshot" && message.asks?.[0]?.id === pending.id && message.policy?.remember === true);
  assert.equal(after.asks[0].expiresAt, deadline);
  await ui.request("answerAsk", { askId: pending.id, optionId: "fast" });
  assert.equal((await promise).source, "user");
});

test("auto-recommended answer continues even when no viewer window remains connected", { timeout: 5000 }, async (t) => {
  const { hub, ui } = await fixture(t, 80);
  await setAuto(ui, true);
  const promise = executeAsk(hub);
  await pendingAsk(ui);
  ui.close();
  const answer = await promise;
  assert.equal(answer.optionId, "safe");
  assert.equal(answer.source, "auto-recommended");
  assert.equal((await log(hub)).some((event) => event.type === "ask.answered" && event.detail.answer.source === "auto-recommended"), true);
});
