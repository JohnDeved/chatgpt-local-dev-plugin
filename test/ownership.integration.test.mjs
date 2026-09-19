import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

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
});

test("background work pins its generation until observed process exit", { timeout: 30000 }, async t => {
  const f = await environment(t), a = await f.client("worker");
  await a.ready("worker");
  const lease = await a.call("worker", "project.open", { query: f.source, mode: "write" });
  assert.equal(lease.ok, true);
  const started = await a.call("worker", "dev.run", {
    argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 1000)"],
    background: true,
  });
  assert.equal(started.ok, true);
  assert.equal((await a.call("worker", "project.release", { generation: lease.data.generation })).error.code, "PROJECT_HAS_ACTIVE_WORK");
  assert.equal((await a.call("worker", "dev.poll", { waitMs: 5000 })).data.state, "exited");
  assert.equal((await a.call("worker", "project.release", { generation: lease.data.generation })).ok, true);
});

test("failed project setup preserves the previous authenticated binding", { timeout: 30000 }, async t => {
  const f = await environment(t, { failingEvidenceHook: true }), a = await f.client("worker"), b = await f.client("peer");
  await a.ready("worker"); await b.ready("peer");
  assert.equal((await a.call("worker", "project.open", { query: f.source, mode: "write" })).ok, true);
  assert.equal((await a.call("worker", "project.open", { query: f.evidence, mode: "write" })).error.code, "PROJECT_HOOK_FAILED");
  assert.equal((await a.call("worker", "project.current")).data.path, f.source);
  assert.equal((await b.call("peer", "project.open", { query: f.source, mode: "write" })).error.code, "PROJECT_IN_USE");
});
