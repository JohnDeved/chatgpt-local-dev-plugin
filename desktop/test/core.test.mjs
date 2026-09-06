import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  commandDisplay,
  commandText,
  OutputDecoder,
  TimelineIndex,
} from "../src/shared/presentation.ts";
import { validateAction, validateDetail } from "../src/shared/contracts.ts";
import { ActivityArchive } from "../src/main/archive.ts";
import { DesktopService } from "../src/main/service.ts";
import { ActivityHub } from "../../dist/activity.js";

const stamp = "2026-09-05T17:00:00.000Z";
function event(type, detail, sequence = 1, extra = {}) {
  return { version: 1, runtimeId: "fixture", sequence, timestamp: stamp, type, detail, ...extra };
}
async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Condition was not observed");
}

test("exact commands and inline source remain intact", () => {
  const argv = [
    "/opt/node/bin/node",
    "-e",
    "console.log('visible 🔐')",
    "argument with spaces",
    "",
  ];
  const view = commandDisplay(argv);
  assert.equal(view.script, argv[2]);
  assert.match(view.invocation, /inline script/);
  assert.match(commandText(argv), /visible 🔐/);
  assert.equal(commandText(["/bin/echo", "a'b", ""]), "/bin/echo 'a'\\''b' ''");
  assert.equal(commandDisplay(["/bin/echo", "-e", "text"]).script, undefined);
});

test("display decoding handles split ANSI/OSC and CRLF without executing terminal controls", () => {
  const decoder = new OutputDecoder();
  const text =
    decoder.append("\x1b[3") +
    decoder.append("2mhello\x1b[0m\r") +
    decoder.append("\nworld\x1b]8;;https://invalid.test\x1b") +
    decoder.append("\\ link\x1b]8;;\x07");
  assert.equal(text, "hello\nworld link");
  assert.equal(new OutputDecoder().append("10%\r20%\r\nDone"), "10%\n20%\nDone");
});

test("one run and one command collect their lifecycle without guessed completion", () => {
  const index = new TimelineIndex();
  index.accept(
    event(
      "run.started",
      {
        run: {
          id: "run-1",
          title: "A task",
          goal: "Keep records visible",
          origin: "assistant",
          state: "running",
          startedAt: stamp,
        },
      },
      1,
      { runId: "run-1" },
    ),
  );
  const meta = { runId: "run-1", operationId: "op-1" };
  index.accept(
    event(
      "tool.requested",
      { tool: "dev.run", arguments: { argv: ["/bin/echo", "hello"] } },
      2,
      meta,
    ),
  );
  index.accept(
    event(
      "process.requested",
      { processId: "p1", argv: ["/bin/echo", "hello"], cwd: "/project" },
      3,
      meta,
    ),
  );
  index.accept(
    event("process.output", { processId: "p1", stream: "stdout", text: "hel", bytes: 3 }, 4, meta),
  );
  index.accept(
    event("process.output", { processId: "p1", stream: "stdout", text: "lo\n", bytes: 3 }, 5, meta),
  );
  index.accept(
    event(
      "process.output",
      { processId: "p1", stream: "stderr", text: "notice\n", bytes: 7 },
      6,
      meta,
    ),
  );
  index.accept(event("process.exited", { processId: "p1", exitCode: 0 }, 7, meta));
  assert.equal(index.calls.size, 1);
  assert.equal(index.runs.size, 1);
  const call = index.calls.get("fixture:op-1");
  assert.equal(call.commands[0].output.stdout, "hello\n");
  assert.equal(call.commands[0].output.stderr, "notice\n");
  assert.equal(call.commands[0].exitCode, 0);
  assert.equal(index.runs.get("fixture:run-1").state, "running");
  assert.equal(index.runs.get("fixture:run-1").backgroundProcessPolicy, "cleanup");
  index.accept(
    event("run.processPolicy", { backgroundProcessPolicy: "keep", source: "assistant_report" }, 8, {
      runId: "run-1",
    }),
  );
  assert.equal(index.runs.get("fixture:run-1").backgroundProcessPolicy, "keep");
  index.accept(
    event(
      "run.ended",
      {
        state: "completed",
        summary: "Verified",
        backgroundProcesses: 1,
        backgroundProcessPolicy: "keep",
      },
      9,
      { runId: "run-1" },
    ),
  );
  index.accept(event("runtime.closed", {}, 10));
  assert.equal(index.runs.get("fixture:run-1").state, "completed");
  assert.equal(index.runs.get("fixture:run-1").backgroundProcesses, 1);
  assert.equal(index.runs.get("fixture:run-1").backgroundProcessPolicy, "keep");
});

test("preview limits are explicit and command streams stay separate", () => {
  const index = new TimelineIndex();
  const meta = { operationId: "op" };
  index.accept(event("tool.requested", { tool: "dev.batch", arguments: {} }, 1, meta));
  for (const id of ["p1", "p2"])
    index.accept(
      event("process.requested", { processId: id, argv: ["node"], cwd: "/project" }, 2, meta),
    );
  index.accept(
    event(
      "process.output",
      { processId: "p1", stream: "stdout", text: "x".repeat(20000), bytes: 20000 },
      3,
      meta,
    ),
  );
  index.accept(
    event(
      "process.output",
      { processId: "p2", stream: "stdout", text: "other", bytes: 5 },
      4,
      meta,
    ),
  );
  const [first, second] = index.calls.get("fixture:op").commands;
  assert.equal(first.previewLimited, true);
  assert.equal(first.output.all.length, 16000);
  assert.equal(first.bytes.all, 20000);
  assert.equal(second.output.all, "other");
  assert.equal(second.previewLimited, false);
});

test("the bridge rejects arbitrary commands, paths, and oversized steering", () => {
  assert.throws(() => validateAction({ type: "execute", argv: ["rm", "-rf"] }));
  assert.throws(() => validateDetail({ runtimeId: "../secret", operationId: "op", mode: "raw" }));
  assert.throws(() =>
    validateAction({
      type: "steer",
      runtimeId: "run",
      runId: "run",
      messageId: "id",
      text: "x".repeat(4001),
    }),
  );
  assert.throws(() =>
    validateAction({ type: "steer", runtimeId: "run", runId: "run", messageId: "id", text: " " }),
  );
  assert.equal(validateAction({ type: "pause", paused: true }).paused, true);
});

test("archive reads partial records incrementally and original bytes are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-web-test-"));
  try {
    const archive = new ActivityArchive(root),
      path = join(root, "fixture.jsonl");
    const start = event(
      "tool.requested",
      { tool: "dev.run", arguments: { argv: ["echo", "unmasked-secret"] } },
      1,
      { operationId: "op" },
    );
    const bytes = JSON.stringify(start);
    await writeFile(path, bytes.slice(0, 40));
    await archive.scan();
    assert.equal(archive.index.events, 0);
    await appendFile(path, bytes.slice(40) + "\n");
    await archive.scan();
    assert.equal(archive.index.events, 1);
    await archive.scan();
    assert.equal(archive.index.events, 1);
    const output =
      [
        event("process.requested", { processId: "process", argv: ["echo"], cwd: root }, 2, {
          operationId: "op",
        }),
        event(
          "process.output",
          { processId: "process", stream: "stdout", text: "hel", bytes: 3 },
          3,
          { operationId: "op" },
        ),
        event(
          "process.output",
          { processId: "process", stream: "stdout", text: "lo", bytes: 2 },
          4,
          { operationId: "op" },
        ),
      ]
        .map(JSON.stringify)
        .join("\n") + "\n";
    await appendFile(path, output);
    await archive.scan();
    const result = await archive.details({
      runtimeId: "fixture",
      operationId: "op",
      processId: "process",
      mode: "output",
      channel: "stdout",
    });
    assert.equal(result.text, "hello");
    const raw = await archive.details({ runtimeId: "fixture", operationId: "op", mode: "raw" });
    assert.equal(raw.text, bytes + "\n" + output);
    assert.equal(await readFile(path, "utf8"), raw.text);
    await assert.rejects(
      archive.details({ runtimeId: "fixture", operationId: "missing", mode: "raw" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function connectedFixture(t) {
  const home = await mkdtemp(join(tmpdir(), "local-dev-web-test-"));
  const hub = new ActivityHub(home, 3000);
  await hub.start();
  let confirms = [];
  const service = new DesktopService(home, {
    confirm: async (kind) => {
      confirms.push(kind);
      return true;
    },
    openArchive: () => {},
    openLoginSettings: () => {},
    quit: () => {},
  });
  await service.start();
  await until(() => service.snapshot().runtimes.some((runtime) => runtime.connected));
  t.after(async () => {
    await service.close();
    await hub.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, hub, service, confirms };
}

test(
  "real desktop service sends steering, preserves attribution, and gates observed runs",
  { timeout: 10000 },
  async (t) => {
    const { hub, service } = await connectedFixture(t);
    const observed = hub.runs.ensure("fixture");
    await until(() => service.snapshot().runs.length === 1);
    const blocked = await service.act({
      type: "steer",
      runtimeId: hub.runtimeId,
      runId: observed.id,
      messageId: randomUUID(),
      text: "Change direction",
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /Run reporting is not ready/);
    const run = hub.runs.start("fixture", "Verify the web desktop service", "Web service check");
    hub.runs.update(
      "fixture",
      run.id,
      "Publish the fixture plan",
      "plan",
      [],
      undefined,
      [],
      [{ id: "status", title: "Status check", status: "in_progress" }],
    );
    await until(
      () =>
        service.snapshot().runs[0]?.origin === "assistant" &&
        service.snapshot().runs[0]?.todos?.some((todo) => todo.id === "status") === true,
    );
    const messageId = randomUUID();
    const action = {
      type: "steer",
      runtimeId: hub.runtimeId,
      runId: run.id,
      messageId,
      text: "Keep this read-only",
    };
    assert.equal((await service.act(action)).ok, true);
    assert.equal((await service.act(action)).ok, true);
    assert.equal(run.steering.length, 1);
    const result = hub.runs.attach(run.id, {
      content: [{ type: "text", text: "read-only result" }],
    });
    assert.match(result.content.at(-1).text, /Keep this read-only/);
    hub.runs.update("fixture", run.id, "I will inspect status only.", "decision", [messageId]);
    await until(() => service.snapshot().runs[0]?.steering[0]?.state === "acknowledged");
    hub.runs.update("fixture", run.id, "Read-only fixture completed.", "progress", [], undefined, [
      { id: messageId, status: "completed" },
    ]);
    hub.runs.update(
      "fixture",
      run.id,
      "Status verified",
      "progress",
      [],
      undefined,
      [],
      [{ id: "status", title: "Status check", status: "completed" }],
    );
    hub.runs.finish("fixture", run.id, "completed", "Status checked");
    await until(() => service.snapshot().runs.some((run) => run.state === "completed"));
    assert.equal((await service.act({ ...action, messageId: randomUUID() })).ok, false);
  },
);

test(
  "approval and pause controls go through live runtime admission",
  { timeout: 10000 },
  async (t) => {
    const { hub, service } = await connectedFixture(t);
    let executed = false;
    const call = hub.execute(
      { name: "fixture.mutate", annotations: { readOnlyHint: false } },
      { exact: "input" },
      async () => {
        executed = true;
        return { content: [] };
      },
    );
    await until(() =>
      service.snapshot().runtimes[0].operations.some((op) => op.state === "waiting"),
    );
    assert.equal(executed, false);
    const op = service.snapshot().runtimes[0].operations[0];
    assert.equal(
      (await service.act({ type: "approve", runtimeId: hub.runtimeId, operationId: op.id })).ok,
      true,
    );
    await call;
    assert.equal(executed, true);
    assert.equal(
      (await service.act({ type: "approve", runtimeId: hub.runtimeId, operationId: op.id })).ok,
      false,
    );
    assert.equal((await service.act({ type: "pause", paused: true })).ok, true);
    await assert.rejects(
      hub.execute({ name: "read", annotations: { readOnlyHint: true } }, {}, async () => 1),
      /ADMISSION_PAUSED/,
    );
  },
);

test(
  "auto-approve requires host confirmation and session intent is not persisted",
  { timeout: 10000 },
  async (t) => {
    const { home, service, confirms } = await connectedFixture(t);
    assert.equal(
      (await service.act({ type: "policy", autoApprove: true, remember: false })).ok,
      true,
    );
    assert.deepEqual(confirms, ["autoApprove"]);
    await until(
      () => service.snapshot().preference.autoApprove && !service.snapshot().preference.pending,
    );
    const settings = JSON.parse(
      await readFile(join(home, ".local-dev/activity/settings.json"), "utf8"),
    );
    assert.equal(settings.autoApprove, false);
    assert.equal(settings.remember, false);
  },
);

test("cancelled native confirmation cannot enable approvals while offline", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-web-test-"));
  const service = new DesktopService(home);
  try {
    await service.start();
    const result = await service.act({ type: "policy", autoApprove: true, remember: true });
    assert.equal(result.cancelled, true);
    assert.equal(service.snapshot().preference.autoApprove, false);
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("unsafe settings permissions are surfaced, not silently treated as approved", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-web-test-"));
  const service = new DesktopService(home);
  try {
    await service.start();
    await service.close();
    const file = join(home, ".local-dev/activity/settings.json");
    await writeFile(file, JSON.stringify({ autoApprove: true, remember: true }));
    await chmod(file, 0o644);
    const second = new DesktopService(home);
    try {
      await second.start();
      assert.equal(second.snapshot().preference.autoApprove, false);
      assert.ok(second.snapshot().errors.some((message) => message.includes("Unsafe approval")));
    } finally {
      await second.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
