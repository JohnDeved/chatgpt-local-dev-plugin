import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ProcessManager } from "../dist/core/process.js";
import { CoreRuntime } from "../dist/core/runtime.js";
import { ProjectLeases } from "../dist/project-leases.js";

async function environment(t, options = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-reader-leases-")));
  for (const path of [".codex", ".local-dev/activity", "projects/source", "projects/evidence"]) await mkdir(join(home, path), { recursive: true, mode: 0o700 });
  await writeFile(join(home, ".codex/config.toml"), "# isolated test registry\n");
  await writeFile(join(home, ".local-dev/config.json"), JSON.stringify({
    version: 1,
    projectRoots: [join(home, "projects")],
    selectedServers: [],
    projectBindings: [],
    projectOpenHooks: options.failingEvidenceHook
      ? [{ projectRoot: join(home, "projects/evidence"), argv: [process.execPath, "-e", "process.exit(7)"] }]
      : [],
  }));
  // Only this disposable test HOME changes approval settings; production never does.
  await writeFile(join(home, ".local-dev/activity/settings.json"), JSON.stringify({ autoApprove: true, remember: true }), { mode: 0o600 });
  await writeFile(join(home, "projects/source/receipt.txt"), "reviewable source receipt\n");
  await writeFile(join(home, "projects/evidence/raw.json"), '{"raw":true}');
  const clients = [], calls = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    if (process.env.OWNERSHIP_TEST_RECEIPTS) {
      await mkdir(process.env.OWNERSHIP_TEST_RECEIPTS, { recursive: true });
      await writeFile(join(process.env.OWNERSHIP_TEST_RECEIPTS, t.name.replace(/[^a-z0-9]+/giu, "-") + ".json"), JSON.stringify({ test: t.name, pids: clients.map(c => c.pid), calls, allExited: clients.every(c => c.exited) }, null, 2) + "\n");
    }
    await rm(home, { recursive: true, force: true });
  });
  async function client(label) {
    const child = spawn(process.execPath, ["dist/cli.js"], { cwd: new URL("../", import.meta.url), env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let sequence = 0, buffer = "", stderr = "";
    const pending = new Map();
    child.stderr.on("data", x => { stderr += x; });
    child.stdout.on("data", x => {
      buffer += x;
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
        const message = JSON.parse(line), resolve = pending.get(message.id);
        if (resolve) { pending.delete(message.id); resolve(message); }
      }
    });
    const request = async (method, params) => {
      const id = ++sequence;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC_TIMEOUT ${method}: ${stderr}`)), 10000);
        pending.set(id, response => { clearTimeout(timer); resolve(response); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return await reply;
    };
    let closed = false;
    const api = {
      pid: child.pid,
      get exited() { return child.exitCode !== null || child.signalCode !== null; },
      async close() {
        if (closed) return; closed = true;
        if (api.exited) return;
        const exit = once(child, "exit"); child.stdin.end();
        // Cooperative transport close only; never kill a test or other process.
        let timer;
        try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("COOPERATIVE_SHUTDOWN_FAILED")), 10000); })]); }
        finally { clearTimeout(timer); }
      },
      async call(session, name, args = {}) {
        const reply = await request("tools/call", { name, arguments: args, _meta: { "openai/session": session } });
        const value = reply.result?.structuredContent;
        calls.push({ client: label, pid: child.pid, session, name, args, reply });
        assert.ok(value, JSON.stringify(reply)); return value;
      },
      async ready(session) {
        const start = await api.call(session, "run.start", { goal: "Exercise isolated ownership lifecycle" });
        assert.equal(start.ok, true);
        assert.equal((await api.call(session, "run.update", { runId: start.data.run.id, summary: "Run ownership assertions", todos: [{ id: "proof", title: "Prove ownership", status: "in_progress" }] })).ok, true);
      },
    };
    clients.push(api);
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: label, version: "1" } });
    assert.ok(init.result); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    return api;
  }
  return { home, source: join(home, "projects/source"), evidence: join(home, "projects/evidence"), client, calls };
}

test("live independent readers share a project while a writer is excluded", { timeout: 40000 }, async t => {
  const f = await environment(t), a = await f.client("reader-a"), b = await f.client("reader-b"), c = await f.client("writer");
  await a.ready("a"); await b.ready("b"); await c.ready("c");
  const [ra, rb] = await Promise.all([a.call("a", "project.open", { query: f.source, mode: "read" }), b.call("b", "project.open", { query: f.source, mode: "read" })]);
  assert.equal(ra.ok, true, JSON.stringify(ra)); assert.equal(rb.ok, true, JSON.stringify(rb));
  const reads = await Promise.all([a.call("a", "project.read", { path: "receipt.txt" }), b.call("b", "project.read", { path: "receipt.txt" })]);
  assert.equal(reads[0].data.text, "reviewable source receipt\n"); assert.equal(reads[1].data.text, reads[0].data.text);
  assert.equal((await c.call("c", "project.open", { query: f.source, mode: "write" })).error.code, "PROJECT_IN_USE");
  assert.equal((await a.call("a", "dev.run", { argv: [process.execPath, "--version"] })).ok, true);
  assert.equal((await a.call("a", "dev.batch", {
    steps: [{ argv: [process.execPath, "--version"] }, { argv: [process.execPath, "--version"] }],
  })).ok, true);
  assert.equal((await a.call("a", "dev.run", { argv: [process.execPath, "-e", "process.stdout.write('must not run')"] })).error.code, "PROJECT_READ_ONLY");
  await a.call("a", "project.release", { generation: ra.data.generation });
  assert.equal((await c.call("c", "project.open", { query: f.source, mode: "write" })).error.code, "PROJECT_IN_USE");
  await b.call("b", "project.release", { generation: rb.data.generation });
  assert.equal((await c.call("c", "project.open", { query: f.source, mode: "write" })).ok, true);
});

test("switching source to evidence relinquishes old lease and proves independent handoff", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("worker"), b = await f.client("reviewer");
  await a.ready("worker"); await b.ready("reviewer");
  assert.equal((await a.call("worker", "project.open", { query: f.source, mode: "write" })).ok, true);
  const switched = await a.call("worker", "project.open", { query: f.evidence, mode: "read" });
  assert.equal(switched.ok, true); assert.equal(switched.data.previousRelease.released, false);
  const ticket = switched.data.previousRelease.handoffId;
  assert.equal((await a.call("worker", "project.handoff", { id: ticket })).data.released, false);
  const acquired = await b.call("reviewer", "project.open", { query: f.source, mode: "read", handoffId: ticket });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  const verified = await a.call("worker", "project.handoff", { id: ticket });
  assert.equal(verified.data.released, true); assert.notEqual(verified.data.receipt.from.runtime, verified.data.receipt.to.runtime);
  assert.equal((await a.call("worker", "project.read", { path: "raw.json" })).data.text, '{"raw":true}');
});

test("same-transport sessions isolate binding and guard stale generations", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("multiplex");
  await a.ready("one"); await a.ready("two");
  const first = await a.call("one", "project.open", { query: f.source, mode: "write" }); assert.equal(first.ok, true);
  assert.equal((await a.call("two", "project.current")).data.path, null);
  assert.equal((await a.call("two", "project.open", { query: f.source, mode: "write" })).error.code, "PROJECT_IN_USE");
  const wrong = await a.call("one", "project.release", { generation: "00000000-0000-4000-8000-000000000001" });
  assert.equal(wrong.error.code, "LEASE_GENERATION_MISMATCH");
  assert.equal((await a.call("one", "project.current")).data.path, f.source);
  const done = await a.call("one", "project.release", { generation: first.data.generation }); assert.equal(done.ok, true); assert.equal(done.data.released, false);
  const next = await a.call("two", "project.open", { query: f.source, mode: "write" }); assert.equal(next.ok, true);
  assert.notEqual(next.data.generation, first.data.generation);
});

test("expired idle owner is fenced and force-release cannot evict a live generation", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("idle"), b = await f.client("successor");
  await a.ready("idle"); await b.ready("successor");
  const lease = await a.call("idle", "project.open", { query: f.source, mode: "read", leaseMs: 1000 }); assert.equal(lease.ok, true);
  const blocked = await b.call("successor", "project.forceRelease", { path: f.source, generation: lease.data.generation, reason: "test must not evict active owner" });
  assert.equal(blocked.error.code, "LEASE_NOT_RECLAIMABLE");
  await delay(1200);
  const writer = await b.call("successor", "project.open", { query: f.source, mode: "write" }); assert.equal(writer.ok, true);
  assert.equal((await a.call("idle", "project.read", { path: "receipt.txt" })).error.code, "PROJECT_BINDING_REVOKED");
  assert.equal((await b.call("successor", "project.forceRelease", { path: f.source, generation: lease.data.generation, reason: "stale generation must not affect successor" })).error.code, "LEASE_GENERATION_MISMATCH");
  assert.equal((await b.call("successor", "project.release", { generation: writer.data.generation })).ok, true);
  const reopened = await a.call("idle", "project.open", { query: f.source, mode: "read" });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.notEqual(reopened.data.generation, lease.data.generation);
});

test("background work pins its generation and retained snapshot to one session", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("worker");
  await a.ready("worker");
  await a.ready("peer");
  const lease = await a.call("worker", "project.open", { query: f.source, mode: "write" });
  assert.equal(lease.ok, true);
  const childPidFile = join(f.source, "child.pid");
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));setInterval(() => {}, 1000)`;
  const leaderScript = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});child.unref();setTimeout(() => process.exit(0), 500)`;
  const starting = a.call("worker", "dev.run", {
    argv: [process.execPath, "-e", leaderScript],
    background: true,
  });
  assert.equal((await a.call("peer", "dev.stop")).error.code, "BACKGROUND_NOT_OWNED");
  assert.equal((await starting).ok, true);
  assert.equal((await a.call("worker", "project.release", { generation: lease.data.generation })).error.code, "PROJECT_HAS_ACTIVE_WORK");
  await delay(700);
  assert.equal((await a.call("peer", "dev.poll")).error.code, "BACKGROUND_NOT_OWNED");
  assert.equal((await a.call("worker", "dev.poll", { waitMs: 5000 })).data.state, "exited");
  const childPid = Number(await readFile(childPidFile, "utf8"));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  assert.equal((await a.call("worker", "project.release", { generation: lease.data.generation })).ok, true);
});

test("concurrent replacement claims cannot stop the winning background process", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("multiplex");
  await a.ready("one"); await a.ready("two");
  assert.equal((await a.call("one", "project.open", { query: f.source, mode: "write" })).ok, true);
  assert.equal((await a.call("two", "project.open", { query: f.evidence, mode: "write" })).ok, true);
  assert.equal((await a.call("one", "dev.run", {
    argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 100)"],
    background: true,
  })).ok, true);
  await delay(300);
  const starts = await Promise.all([
    a.call("one", "dev.run", { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], background: true }),
    a.call("two", "dev.run", { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], background: true }),
  ]);
  const winners = starts.map((value, index) => ({ value, session: index === 0 ? "one" : "two" })).filter(entry => entry.value.ok);
  assert.equal(winners.length, 1, JSON.stringify(starts));
  const loser = starts.find(value => !value.ok);
  assert.ok(["BACKGROUND_BUSY", "BACKGROUND_NOT_OWNED"].includes(loser.error.code), JSON.stringify(loser));
  const winner = winners[0];
  assert.equal((await a.call(winner.session, "dev.poll")).data.state, "running");
  assert.equal((await a.call(winner.session, "dev.stop")).data.state, "exited");
});

test("same-path reopen revalidates explicit lease constraints", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("worker");
  await a.ready("worker");
  const first = await a.call("worker", "project.open", { query: f.source, mode: "write" });
  assert.equal(first.ok, true);
  const renewed = await a.call("worker", "project.open", { query: f.source, mode: "write", leaseMs: 1000 });
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  assert.notEqual(renewed.data.generation, first.data.generation);
  assert.equal((await a.call("worker", "project.open", {
    query: f.source,
    mode: "write",
    expectedHead: "0000000000000000000000000000000000000000",
  })).error.code, "PROJECT_HEAD_MISMATCH");
  assert.equal((await a.call("worker", "project.current")).data.generation, renewed.data.generation);
});

test("concurrent opens in one session serialize without stranding a generation", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-open-race-")));
  const source = join(home, "projects/source");
  const evidence = join(home, "projects/evidence");
  const registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const runtime = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await successor.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    runtime.openProject(source, "error", undefined, "worker", { mode: "write" }),
    runtime.openProject(evidence, "error", undefined, "worker", { mode: "write" }),
  ]);
  assert.equal(first.structuredContent.ok, true, JSON.stringify(first.structuredContent));
  assert.equal(second.structuredContent.ok, true, JSON.stringify(second.structuredContent));
  assert.equal(runtime.currentProject("worker").structuredContent.data.path, evidence);
  const acquired = await successor.openProject(source, "error", undefined, "successor", { mode: "write" });
  assert.equal(acquired.structuredContent.ok, true, JSON.stringify(acquired.structuredContent));
  const blocked = await successor.openProject(evidence, "error", undefined, "successor", { mode: "write" });
  assert.equal(blocked.structuredContent.error.code, "PROJECT_IN_USE");
});

test("concurrent release and open serialize without stranding the replacement", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-release-open-race-")));
  const source = join(home, "projects/source"), evidence = join(home, "projects/evidence"), registry = join(home, "registry");
  await mkdir(source, { recursive: true }); await mkdir(evidence, { recursive: true });
  const leases = new ProjectLeases(registry);
  const runtime = new CoreRuntime([join(home, "projects")], [], [], undefined, leases);
  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  t.after(async () => {
    await runtime.close().catch(() => undefined); await successor.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(source, "error", undefined, "worker", { mode: "write" });
  assert.equal(opened.structuredContent.ok, true);
  const generation = opened.structuredContent.data.generation;
  const originalRelease = leases.release.bind(leases);
  let releaseEntered, allowRelease;
  const entered = new Promise(resolve => { releaseEntered = resolve; });
  const gate = new Promise(resolve => { allowRelease = resolve; });
  leases.release = async (...args) => { releaseEntered(); await gate; return await originalRelease(...args); };

  const releasing = runtime.releaseProject(generation, "worker");
  await entered;
  const opening = runtime.openProject(evidence, "error", undefined, "worker", { mode: "write" });
  await delay(50);
  assert.equal(runtime.currentProject("worker").structuredContent.data.path, source);
  allowRelease();
  assert.equal((await releasing).structuredContent.ok, true);
  assert.equal((await opening).structuredContent.ok, true);
  assert.equal(runtime.currentProject("worker").structuredContent.data.path, evidence);
  assert.equal((await successor.openProject(source, "error", undefined, "successor", { mode: "write" })).structuredContent.ok, true);
  assert.equal((await successor.openProject(evidence, "error", undefined, "successor", { mode: "write" })).structuredContent.error.code, "PROJECT_IN_USE");
});

test("unconfirmed foreground groups keep ownership pinned until cooperative retry", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-unconfirmed-foreground-")));
  const source = join(home, "projects/source"), registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  let terminationConfirmed = false;
  const processes = new ProcessManager(async () => terminationConfirmed);
  const runtime = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry), processes);
  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  t.after(async () => {
    terminationConfirmed = true;
    await runtime.close().catch(() => undefined); await successor.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(source, "error", undefined, "worker", { mode: "write" });
  assert.equal(opened.structuredContent.ok, true);
  const generation = opened.structuredContent.data.generation;
  const run = await runtime.run([process.execPath, "-e", "process.exit(0)"], false, undefined, undefined, false, undefined, "worker");
  assert.equal(run.structuredContent.error.code, "COMMAND_STOP_UNCONFIRMED");
  assert.equal((await runtime.releaseProject(generation, "worker")).structuredContent.error.code, "PROJECT_HAS_ACTIVE_WORK");
  assert.equal((await successor.openProject(source, "error", undefined, "successor", { mode: "write" })).structuredContent.error.code, "PROJECT_IN_USE");
  terminationConfirmed = true;
  await runtime.close();
  assert.equal((await successor.openProject(source, "error", undefined, "successor", { mode: "write" })).structuredContent.ok, true);
});

test("unconfirmed project-hook groups retain the candidate lease until cooperative retry", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-unconfirmed-hook-")));
  const source = join(home, "projects/source"), registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  let terminationConfirmed = false;
  const processes = new ProcessManager(async () => terminationConfirmed);
  const marker = join(source, "hook.started");
  const hookScript = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");setTimeout(() => process.exit(0), 500)`;
  const hooks = [{ projectRoot: source, argv: [process.execPath, "-e", hookScript] }];
  const leases = new ProjectLeases(registry);
  const runtime = new CoreRuntime([join(home, "projects")], hooks, [], undefined, leases, processes);
  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  t.after(async () => {
    terminationConfirmed = true;
    await runtime.close().catch(() => undefined); await successor.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const opening = runtime.openProject(source, "error", undefined, "worker", { mode: "write" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(marker, "utf8").catch(() => undefined) === "started") break;
    await delay(10);
  }
  assert.equal(await readFile(marker, "utf8"), "started");
  await assert.rejects(runtime.close(), { message: "COMMAND_STOP_UNCONFIRMED" });
  const opened = await opening;
  assert.equal(opened.structuredContent.error.code, "PROJECT_HOOK_FAILED");
  assert.equal((await successor.openProject(source, "error", undefined, "successor", { mode: "write" })).structuredContent.error.code, "PROJECT_IN_USE");
  const originalRelease = leases.release.bind(leases);
  let failCleanup = true;
  leases.release = async (...args) => {
    if (failCleanup) { failCleanup = false; throw new Error("TEST_PIN_RELEASE_FAILURE"); }
    return await originalRelease(...args);
  };
  terminationConfirmed = true;
  await assert.rejects(runtime.close(), { message: "TEST_PIN_RELEASE_FAILURE" });
  await runtime.close();
  assert.equal((await successor.openProject(source, "error", undefined, "successor", { mode: "write" })).structuredContent.ok, true);
});

test("multi-session shutdown retries only leases that remain active", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-close-retry-")));
  const source = join(home, "projects/source"), evidence = join(home, "projects/evidence"), registry = join(home, "registry");
  await mkdir(source, { recursive: true }); await mkdir(evidence, { recursive: true });
  const leases = new ProjectLeases(registry);
  const runtime = new CoreRuntime([join(home, "projects")], [], [], undefined, leases);
  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  t.after(async () => {
    await runtime.close().catch(() => undefined); await successor.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  assert.equal((await runtime.openProject(source, "error", undefined, "one", { mode: "write" })).structuredContent.ok, true);
  assert.equal((await runtime.openProject(evidence, "error", undefined, "two", { mode: "write" })).structuredContent.ok, true);
  const originalRelease = leases.release.bind(leases), calls = new Map();
  let failSecond = true;
  leases.release = async (session, ...args) => {
    calls.set(session, (calls.get(session) ?? 0) + 1);
    if (session === "two" && failSecond) { failSecond = false; throw new Error("TEST_RELEASE_FAILURE"); }
    return await originalRelease(session, ...args);
  };
  await assert.rejects(runtime.close(), { message: "TEST_RELEASE_FAILURE" });
  assert.equal(runtime.currentProject("one").structuredContent.data.path, null);
  assert.equal(runtime.currentProject("two").structuredContent.data.path, evidence);
  await runtime.close();
  assert.deepEqual(Object.fromEntries(calls), { one: 1, two: 2 });
  assert.equal((await successor.openProject(source, "error", undefined, "successor-one", { mode: "write" })).structuredContent.ok, true);
  assert.equal((await successor.openProject(evidence, "error", undefined, "successor-two", { mode: "write" })).structuredContent.ok, true);
});

test("shutdown waits for foreground operation completion before releasing the lease", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-foreground-close-race-")));
  const source = join(home, "projects/source");
  const registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  const leases = new ProjectLeases(registry);
  const runtime = new CoreRuntime([join(home, "projects")], [], [], undefined, leases);
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(source, "error", undefined, "worker", { mode: "write" });
  assert.equal(opened.structuredContent.ok, true, JSON.stringify(opened.structuredContent));

  const originalComplete = leases.complete.bind(leases);
  let completionEntered;
  const entered = new Promise(resolve => { completionEntered = resolve; });
  let allowCompletion;
  const completionGate = new Promise(resolve => { allowCompletion = resolve; });
  leases.complete = async (...args) => {
    if (!Array.isArray(args[3]) || args[3].length === 0) {
      completionEntered();
      await completionGate;
    }
    return await originalComplete(...args);
  };

  const running = runtime.run([process.execPath, "-e", "process.exit(0)"], false, undefined, undefined, false, undefined, "worker");
  await entered;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await delay(50);
  assert.equal(closed, false);
  allowCompletion();
  assert.equal((await running).structuredContent.ok, true);
  await closing;
  assert.equal(closed, true);

  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  const acquired = await successor.openProject(source, "error", undefined, "successor", { mode: "write" });
  assert.equal(acquired.structuredContent.ok, true, JSON.stringify(acquired.structuredContent));
  await successor.close();
});

test("shutdown waits for project-open hook completion before closing the provider", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-hook-close-race-")));
  const source = join(home, "projects/source");
  const registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  const leases = new ProjectLeases(registry);
  const hooks = [{ projectRoot: source, argv: [process.execPath, "-e", "process.exit(0)"] }];
  const runtime = new CoreRuntime([join(home, "projects")], hooks, [], undefined, leases);
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  const originalComplete = leases.complete.bind(leases);
  let completionEntered;
  const entered = new Promise(resolve => { completionEntered = resolve; });
  let allowCompletion;
  const completionGate = new Promise(resolve => { allowCompletion = resolve; });
  leases.complete = async (...args) => {
    if (!Array.isArray(args[3]) || args[3].length === 0) {
      completionEntered();
      await completionGate;
    }
    return await originalComplete(...args);
  };

  const opening = runtime.openProject(source, "error", undefined, "worker", { mode: "write" });
  await entered;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await delay(50);
  assert.equal(closed, false);
  allowCompletion();
  assert.equal((await opening).structuredContent.ok, true);
  await closing;
  assert.equal(closed, true);

  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  const acquired = await successor.openProject(source, "error", undefined, "successor", { mode: "write" });
  assert.equal(acquired.structuredContent.ok, true, JSON.stringify(acquired.structuredContent));
  await successor.close();
});

test("shutdown waits for pre-pin background registration before releasing the lease", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-shutdown-race-")));
  const source = join(home, "projects/source");
  const registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  const leases = new ProjectLeases(registry);
  const runtime = new CoreRuntime([join(home, "projects")], [], [], undefined, leases);
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(source, "error", undefined, "worker", { mode: "write" });
  assert.equal(opened.structuredContent.ok, true, JSON.stringify(opened.structuredContent));

  const originalComplete = leases.complete.bind(leases);
  let registerEntered;
  const entered = new Promise(resolve => { registerEntered = resolve; });
  let allowRegister;
  const registrationGate = new Promise(resolve => { allowRegister = resolve; });
  leases.complete = async (...args) => {
    if (Array.isArray(args[3]) && args[3].length > 0) {
      registerEntered();
      await registrationGate;
    }
    return await originalComplete(...args);
  };

  const starting = runtime.run([process.execPath, "-e", "setInterval(() => {}, 1000)"], true, undefined, undefined, false, undefined, "worker");
  await entered;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await delay(50);
  assert.equal(closed, false);
  allowRegister();
  assert.equal((await starting).structuredContent.ok, true);
  await closing;
  assert.equal(closed, true);

  const successor = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  const acquired = await successor.openProject(source, "error", undefined, "successor", { mode: "write" });
  assert.equal(acquired.structuredContent.ok, true, JSON.stringify(acquired.structuredContent));
  await successor.close();
});

test("cooperative shutdown clears a confirmed-stopped background lease", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("worker"), b = await f.client("successor");
  await a.ready("worker");
  await b.ready("successor");
  assert.equal((await a.call("worker", "project.open", { query: f.source, mode: "write" })).ok, true);
  assert.equal((await a.call("worker", "dev.run", {
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    background: true,
  })).ok, true);
  await a.close();
  const acquired = await b.call("successor", "project.open", { query: f.source, mode: "write" });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
});

test("failed project setup preserves the previous authenticated binding", { timeout: 30000 }, async t => {
  const f = await environment(t, { failingEvidenceHook: true }), a = await f.client("worker"), b = await f.client("peer");
  await a.ready("worker"); await b.ready("peer");
  assert.equal((await a.call("worker", "project.open", { query: f.source, mode: "write" })).ok, true);
  assert.equal((await a.call("worker", "project.open", { query: f.evidence, mode: "write" })).error.code, "PROJECT_HOOK_FAILED");
  assert.equal((await a.call("worker", "project.current")).data.path, f.source);
  assert.equal((await b.call("peer", "project.open", { query: f.source, mode: "write" })).error.code, "PROJECT_IN_USE");
});

test("shutdown accepts an independently force-released generation", { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdev-force-release-close-")));
  const source = join(home, "projects/source"), registry = join(home, "registry");
  await mkdir(source, { recursive: true });
  const ownerLeases = new ProjectLeases(registry);
  const owner = new CoreRuntime([join(home, "projects")], [], [], undefined, ownerLeases);
  const reclaimer = new CoreRuntime([join(home, "projects")], [], [], undefined, new ProjectLeases(registry));
  t.after(async () => {
    await owner.close().catch(() => undefined);
    await reclaimer.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  const opened = await owner.openProject(source, "error", undefined, "owner", { mode: "read", leaseMs: 1000 });
  assert.equal(opened.structuredContent.ok, true, JSON.stringify(opened.structuredContent));
  const generation = opened.structuredContent.data.generation;
  await delay(1100);
  const forced = await reclaimer.forceReleaseProject(source, generation, "reclaim exact expired generation", "reclaimer");
  assert.equal(forced.structuredContent.ok, true, JSON.stringify(forced.structuredContent));

  const originalRelease = ownerLeases.release.bind(ownerLeases);
  let failWithGenericError = true;
  ownerLeases.release = async (...args) => {
    if (failWithGenericError) { failWithGenericError = false; throw new Error("PROJECT_BINDING_REVOKED"); }
    return await originalRelease(...args);
  };
  await assert.rejects(owner.close(), error => error?.constructor === Error && error.message === "PROJECT_BINDING_REVOKED");
  await owner.close();
  const acquired = await reclaimer.openProject(source, "error", undefined, "reclaimer", { mode: "write" });
  assert.equal(acquired.structuredContent.ok, true, JSON.stringify(acquired.structuredContent));
});
