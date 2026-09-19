import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LeaseStorage } from "../dist/lease-storage.js";
import { ProjectLeases } from "../dist/project-leases.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdev-provider-")));
  const registry = join(root, "registry"), source = join(root, "source"), evidence = join(root, "evidence");
  await mkdir(source); await mkdir(evidence); await writeFile(join(source, "receipt.json"), '{"head":"fixture"}');
  const clients = [], calls = [];
  t.after(async () => {
    for (const c of clients) if (!c.exited()) { await c.call("close"); await c.exit; }
    if (process.env.OWNERSHIP_TEST_RECEIPTS) {
      await mkdir(process.env.OWNERSHIP_TEST_RECEIPTS, { recursive: true });
      await writeFile(join(process.env.OWNERSHIP_TEST_RECEIPTS, t.name.replace(/[^a-z0-9]+/giu, "-") + ".json"), JSON.stringify({ test: t.name, pids: clients.map(c => c.pid), calls, allExited: clients.every(c => c.exited()) }, null, 2) + "\n");
    }
    await rm(root, { recursive: true, force: true });
  });
  async function client(name) {
    const child = fork(new URL("./lease-client-fixture.mjs", import.meta.url), [registry], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const exit = once(child, "exit");
    assert.equal((await once(child, "message"))[0].ready, true); let sequence = 0;
    const api = { pid: child.pid, exit, exited: () => child.exitCode !== null || child.signalCode !== null,
      async call(action, args = {}) {
        const id = ++sequence;
        const result = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("CLIENT_TIMEOUT")), 10000);
          const listener = response => { if (response.sequence !== id) return; clearTimeout(timeout); child.off("message", listener); resolve(response); };
          child.on("message", listener);
        });
        child.send({ sequence: id, action, session: name, ...args }); const response = await result;
        calls.push({ client: name, pid: child.pid, action, args, response }); return response;
      } };
    clients.push(api); return api;
  }
  return { root, registry, source, evidence, client };
}
const open = (client, path, mode = "read", extra = {}) => client.call("open", { path, options: { mode, ...extra } });

test("provider real independent readers exclude a writer and release independently", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.client("reader-a"), b = await f.client("reader-b"), c = await f.client("writer");
  const [x, y] = await Promise.all([open(a, f.source), open(b, f.source)]);
  assert.equal(x.ok, true, JSON.stringify(x)); assert.equal(y.ok, true, JSON.stringify(y));
  assert.equal((await open(c, f.source, "write")).code, "PROJECT_IN_USE");
  assert.equal((await a.call("access", { generation: x.value.lease.generation, write: true })).code, "PROJECT_READ_ONLY");
  for (const [client, result] of [[a, x], [b, y]]) {
    const access = await client.call("access", { generation: result.value.lease.generation, write: false });
    assert.equal(access.ok, true);
    assert.equal(await readFile(join(f.source, "receipt.json"), "utf8"), '{"head":"fixture"}');
    await client.call("complete", { generation: result.value.lease.generation, operation: access.value });
  }
  await a.call("release", { generation: x.value.lease.generation });
  assert.equal((await open(c, f.source, "write")).code, "PROJECT_IN_USE");
  await b.call("release", { generation: y.value.lease.generation });
  assert.equal((await open(c, f.source, "write")).ok, true);
});

test("provider source-evidence switch yields only independent-acquisition release proof", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.client("worker"), b = await f.client("reviewer");
  const x = await open(a, f.source, "write"); assert.equal(x.ok, true);
  const y = await a.call("open", { path: f.evidence, options: { mode: "read" }, previous: x.value.lease.generation });
  assert.equal(y.ok, true, JSON.stringify(y)); const ticket = y.value.previousRelease.handoffId;
  assert.equal((await a.call("handoff", { id: ticket })).value.released, false);
  const acquired = await open(b, f.source, "read", { handoffId: ticket }); assert.equal(acquired.ok, true, JSON.stringify(acquired));
  const proof = (await a.call("handoff", { id: ticket })).value;
  assert.equal(proof.released, true); assert.equal(proof.receipt.from.pid, a.pid); assert.equal(proof.receipt.to.pid, b.pid);
  assert.notEqual(proof.receipt.from.runtime, proof.receipt.to.runtime);
});

test("provider reconciles a real dead idle process and preserves exclusive writers", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.client("dead"), b = await f.client("successor"), c = await f.client("racer");
  assert.equal((await open(a, f.source, "write")).ok, true); await a.call("exit-with-lease"); await a.exit;
  const choices = await Promise.all([open(b, f.source, "write"), open(c, f.source, "write")]);
  assert.equal(choices.filter(x => x.ok).length, 1, JSON.stringify(choices));
  assert.equal(choices.filter(x => x.code === "PROJECT_IN_USE").length, 1);
});

test("provider idle expiration fences old generations; force-release is scoped and audited", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.client("old"), b = await f.client("new");
  const old = await open(a, f.source, "read", { leaseMs: 1000 }); assert.equal(old.ok, true);
  const generation = old.value.lease.generation;
  assert.equal((await b.call("force", { path: f.source, generation, reason: "cannot revoke active owner" })).code, "LEASE_NOT_RECLAIMABLE");
  await delay(1200);
  const force = await b.call("force", { path: f.source, generation, reason: "expired idle lease" }); assert.equal(force.ok, true, JSON.stringify(force));
  assert.equal((await a.call("access", { generation, write: false })).code, "PROJECT_BINDING_REVOKED");
  const replacement = await open(b, f.source, "write"); assert.equal(replacement.ok, true);
  assert.equal((await a.call("force", { path: f.source, generation, reason: "cannot revoke a replacement generation" })).code, "LEASE_GENERATION_MISMATCH");
  const envelope = JSON.parse(await readFile(join(f.registry, "state.json"), "utf8")), state = JSON.parse(envelope.payload);
  assert.ok(state.audit.some(x => x.action === "force-released" && x.generation === generation));
});

test("provider refuses to expire active writer operations or claimed background work", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.client("writer"), b = await f.client("reviewer");
  const x = await open(a, f.source, "write", { leaseMs: 1000 }); const generation = x.value.lease.generation;
  const active = await a.call("access", { generation, write: true }); await delay(1200);
  assert.equal((await open(b, f.source)).code, "PROJECT_IN_USE");
  assert.equal((await a.call("release", { generation })).code, "PROJECT_HAS_ACTIVE_WORK");
  await a.call("complete", { generation, operation: active.value, background: [a.pid] });
  assert.equal((await a.call("release", { generation })).code, "PROJECT_HAS_ACTIVE_WORK");
  await a.call("background-exited", { generation, operation: active.value, pid: a.pid });
  assert.equal((await a.call("release", { generation })).ok, true);
});

test("provider canonicalizes aliases and rejects wrong source heads without acquiring", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.client("a"), b = await f.client("b");
  const git = (...args) => execFileSync("git", ["-C", f.source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "test@example.com"); git("add", "."); git("commit", "-qm", "source");
  const head = git("rev-parse", "HEAD");
  assert.equal((await open(a, f.source, "write", { expectedHead: "a".repeat(40) })).code, "PROJECT_HEAD_MISMATCH");
  const x = await open(a, f.source, "write", { expectedHead: head }); assert.equal(x.ok, true);
  const alias = join(f.root, "alias"); await symlink(f.source, alias);
  assert.equal((await open(b, alias)).code, "PROJECT_IN_USE");
  const markerBefore = await stat(join(f.registry, "transaction.lock"));
  await a.call("release", { generation: x.value.lease.generation }); await open(b, alias);
  assert.equal((await stat(join(f.registry, "transaction.lock"))).ino, markerBefore.ino, "cooperative transitions never unlink the lock");
});

test("injected signed store rejects tampering and keeps private permissions", async t => {
  const f = await fixture(t), store = new LeaseStorage(f.registry, () => ({ n: 0 }), x => x);
  await store.transaction(async state => { state.n++; });
  const path = join(f.registry, "state.json"), envelope = JSON.parse(await readFile(path, "utf8"));
  envelope.payload = '{"n":999}'; await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(store.transaction(async state => state.n), { message: "REGISTRY_AUTHENTICATION_FAILED" });
  assert.equal((await stat(path)).mode & 0o077, 0);
});


test("pending leases cannot authorize work or mint receipts; commit is single-use", async t => {
  const f = await fixture(t), a = await f.client("worker");
  const pending = await a.call("reserve", { path: f.source, options: { mode: "write" } }); assert.equal(pending.ok, true);
  const generation = pending.value.generation;
  assert.equal((await a.call("access", { generation, write: true })).code, "LEASE_NOT_COMMITTED");
  assert.equal((await a.call("release", { generation })).code, "LEASE_NOT_COMMITTED");
  assert.equal((await a.call("commit", { generation, previous: "00000000-0000-4000-8000-000000000001" })).code, "RESERVATION_ARGUMENT_MISMATCH");
  assert.equal((await a.call("commit", { generation })).ok, true);
  assert.equal((await a.call("commit", { generation })).code, "LEASE_ALREADY_COMMITTED");
});

test("a pending generation cannot be used as the previous binding", async t => {
  const f = await fixture(t), a = await f.client("worker");
  const pending = await a.call("reserve", { path: f.source, options: { mode: "write" } });
  assert.equal(pending.ok, true);
  const next = await a.call("reserve", {
    path: f.evidence,
    options: { mode: "read" },
    previous: pending.value.generation,
  });
  assert.equal(next.code, "PREVIOUS_LEASE_NOT_COMMITTED");
});

test("handoff reservation predates commit and demands an independent runtime", async t => {
  const f = await fixture(t), a = await f.client("worker"), b = await f.client("reviewer");
  const original = await open(a, f.source);
  const preexisting = await b.call("reserve", { path: f.source, options: { mode: "read" } });
  const released = await a.call("release", { generation: original.value.lease.generation });
  const handoffId = released.value.handoffId, generation = preexisting.value.generation;
  assert.equal((await b.call("commit", { generation, handoffId })).code, "RESERVATION_ARGUMENT_MISMATCH");
  assert.equal((await a.call("open", { session: "different-session-same-runtime", path: f.source, options: { mode: "read", handoffId } })).code, "HANDOFF_NOT_INDEPENDENT");
  assert.equal((await a.call("handoff", { id: handoffId })).value.released, false);
  await b.call("abort", { generation });
  assert.equal((await open(b, f.source, "read", { handoffId })).ok, true);
  assert.equal((await a.call("handoff", { id: handoffId })).value.released, true);
});

test("operation tokens reject duplicate completion and preserve each background owner", async t => {
  const f = await fixture(t), a = await f.client("writer"), b = await f.client("reader");
  const opened = await open(a, f.source, "write"), generation = opened.value.lease.generation;
  const first = await a.call("access", { generation, write: true }), second = await a.call("access", { generation, write: true });
  assert.notEqual(first.value, second.value);
  assert.equal((await a.call("complete", { generation, operation: first.value, background: [a.pid] })).ok, true);
  assert.equal((await a.call("complete", { generation, operation: first.value })).code, "LEASE_OPERATION_MISMATCH");
  assert.equal((await a.call("release", { generation })).code, "PROJECT_HAS_ACTIVE_WORK");
  assert.equal((await a.call("complete", { generation, operation: second.value, background: [a.pid] })).ok, true);
  await a.call("background-exited", { generation, operation: first.value, pid: a.pid });
  assert.equal((await a.call("release", { generation })).code, "PROJECT_HAS_ACTIVE_WORK");
  assert.equal((await open(b, f.source)).code, "PROJECT_IN_USE");
  assert.equal((await a.call("background-exited", { generation, operation: first.value, pid: a.pid })).code, "BACKGROUND_OPERATION_MISMATCH");
  await a.call("background-exited", { generation, operation: second.value, pid: a.pid });
  assert.equal((await a.call("release", { generation })).ok, true);
});

test("missing initialized signed state fails closed without resetting generations", async t => {
  const f = await fixture(t), store = new LeaseStorage(f.registry, () => ({ n: 0 }), x => x);
  await store.transaction(async state => { state.n = 1; });
  const lock = await stat(join(f.registry, "transaction.lock"));
  await rm(join(f.registry, "state.json")); // Test data loss, not deletion of a lock.
  await assert.rejects(store.transaction(async state => state.n), { message: "REGISTRY_STATE_MISSING" });
  assert.equal((await stat(join(f.registry, "transaction.lock"))).ino, lock.ino);
});

test("sibling directories share a Git write domain while separate worktrees do not", async t => {
  const f = await fixture(t); const git = (...args) => execFileSync("git", ["-C", f.source, ...args], { encoding: "utf8" }).trim();
  await mkdir(join(f.source, "a")); await mkdir(join(f.source, "b"));
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "test@example.com"); git("add", "."); git("commit", "-qm", "root");
  const other = join(f.root, "other-worktree"); git("worktree", "add", "--detach", other, "HEAD");
  const a = await f.client("writer-a"), b = await f.client("writer-b");
  const first = await open(a, join(f.source, "a"), "write"); assert.equal(first.ok, true);
  assert.equal(first.value.lease.scope.writeDomain, f.source);
  assert.equal((await open(b, join(f.source, "b"), "write")).code, "PROJECT_IN_USE");
  assert.equal((await open(b, other, "write")).ok, true);
});

test("uncommitted idle reservation from a voluntarily exited process is reclaimable", async t => {
  const f = await fixture(t), a = await f.client("pending"), b = await f.client("successor");
  const pending = await a.call("reserve", { path: f.source, options: { mode: "write" } }); assert.equal(pending.ok, true);
  await a.call("exit-with-lease"); await a.exit;
  assert.equal((await open(b, f.source, "write")).ok, true);
});

test("provider close is terminal before first use and after an active generation", async t => {
  const f = await fixture(t), fresh = new ProjectLeases(join(f.root, "unused-registry"));
  await fresh.close();
  await assert.rejects(fresh.reserve("s", f.source, { mode: "read" }), { message: "PROVIDER_CLOSED" });
  await assert.rejects(stat(join(f.root, "unused-registry")), { code: "ENOENT" });
  const a = await f.client("closing"), b = await f.client("new");
  const lease = await open(a, f.source, "write"); await a.call("close-provider");
  assert.equal((await a.call("access", { generation: lease.value.lease.generation, write: true })).code, "PROVIDER_CLOSED");
  assert.equal((await open(a, f.source)).code, "PROVIDER_CLOSED");
  assert.equal((await open(b, f.source, "write")).ok, true);
});
