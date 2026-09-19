import { randomUUID } from "node:crypto";
import { realpath, stat, type FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { isPathInside } from "./path.js";
import { runCommand } from "./setup/command.js";
import { LeaseError, LeaseStorage } from "./lease-storage.js";

const uuid = z.string().uuid();
const ownerSchema = z.object({ runtime: uuid, session: z.string(), pid: z.number().int().positive(), processStart: z.number() }).strict();
const scopeSchema = z.object({ path: z.string(), device: z.string(), inode: z.string(), head: z.string().nullable(), writeDomain: z.string(), domainDevice: z.string(), domainInode: z.string() }).strict();
const leaseSchema = z.object({ generation: uuid, owner: ownerSchema, scope: scopeSchema, mode: z.enum(["read", "write"]), ttl: z.number(), expires: z.number(), pending: z.boolean(), previous: uuid.nullable(), handoffId: uuid.nullable(), operations: z.array(z.object({ id: uuid, write: z.boolean() }).strict()), background: z.array(z.object({ operation: uuid, pid: z.number().int().positive() }).strict()) }).strict();
const receiptSchema = z.object({ id: uuid, from: ownerSchema, fromGeneration: uuid, scope: scopeSchema, to: ownerSchema.nullable(), toGeneration: uuid.nullable(), expires: z.number(), at: z.string() }).strict();
const stateSchema = z.object({ version: z.literal(1), leases: z.array(leaseSchema).max(512), receipts: z.array(receiptSchema).max(2048), audit: z.array(z.record(z.string(), z.unknown())).max(4096) }).strict();
type State = z.infer<typeof stateSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type Lease = z.infer<typeof leaseSchema>;
export type ReleaseReceipt = z.infer<typeof receiptSchema>;
export interface OpenLeaseOptions { mode: "read" | "write"; leaseMs?: number; expectedHead?: string; handoffId?: string; }
const overlaps = (a: string, b: string): boolean => isPathInside(a, b) || isPathInside(b, a);
const same = (a: Owner, b: Owner): boolean => a.runtime === b.runtime && a.session === b.session;
const idle = (lease: Lease): boolean => lease.operations.length === 0 && lease.background.length === 0;

export async function projectScope(path: string): Promise<Scope> {
  const canonical = await realpath(path), info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new LeaseError("INVALID_PROJECT_PATH");
  const result = await runCommand("git", ["--no-optional-locks", "-C", canonical, "rev-parse", "--verify", "HEAD"], 3000);
  if (result.code !== 0 && result.code !== 128) throw new LeaseError("PROJECT_IDENTITY_UNVERIFIED");
  const head = result.code === 0 ? result.stdout.trim() : null;
  if (head !== null && !/^[a-f0-9]{40,64}$/u.test(head)) throw new LeaseError("PROJECT_IDENTITY_UNVERIFIED");
  const top = head === null ? null : await runCommand("git", ["--no-optional-locks", "-C", canonical, "rev-parse", "--show-toplevel"], 3000);
  if (top && top.code !== 0) throw new LeaseError("PROJECT_IDENTITY_UNVERIFIED");
  const writeDomain = top ? await realpath(top.stdout.trim()) : canonical, domain = await stat(writeDomain, { bigint: true });
  return { path: canonical, device: String(info.dev), inode: String(info.ino), head, writeDomain, domainDevice: String(domain.dev), domainInode: String(domain.ino) };
}
function matches(actual: Scope, expected: Scope, head: boolean): void {
  if (actual.path !== expected.path || actual.device !== expected.device || actual.inode !== expected.inode || actual.writeDomain !== expected.writeDomain || actual.domainDevice !== expected.domainDevice || actual.domainInode !== expected.domainInode) throw new LeaseError("PROJECT_REPLACED", { path: expected.path });
  if (head && actual.head !== expected.head) throw new LeaseError("PROJECT_HEAD_MISMATCH", { expected: expected.head, actual: actual.head });
}

/** Server-generated generations plus signed storage; no tool accepts an owner ID. */
export class ProjectLeases {
  readonly runtime = randomUUID();
  private readonly store: LeaseStorage<State>;
  private liveHandle: Promise<FileHandle> | undefined;
  private closed = false;
  private closeResult: Promise<void> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  constructor(readonly directory: string) {
    this.store = new LeaseStorage(directory, () => ({ version: 1, leases: [], receipts: [], audit: [] }), value => stateSchema.parse(value));
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LeaseError("PROVIDER_CLOSED"));
    const task = action(); this.tasks.add(task);
    return task.finally(() => { this.tasks.delete(task); });
  }
  reserve(session: string, path: string, options: OpenLeaseOptions, previous?: string): Promise<Lease> { return this.run(() => this.reserveOpen(session, path, options, previous)); }
  commit(session: string, generation: string, previous?: string, handoffId?: string): ReturnType<ProjectLeases["commitOpen"]> { return this.run(() => this.commitOpen(session, generation, previous, handoffId)); }
  abort(session: string, generation: string): Promise<void> { return this.run(() => this.abortOpen(session, generation)); }
  access(session: string, generation: string, write: boolean): Promise<string> { return this.run(() => this.accessOpen(session, generation, write)); }
  complete(session: string, generation: string, operation: string, background: number[] = []): Promise<void> { return this.run(() => this.completeOpen(session, generation, operation, background)); }
  backgroundExited(session: string, generation: string, operation: string, pid: number): Promise<void> { return this.run(() => this.backgroundExitedOpen(session, generation, operation, pid)); }
  release(session: string, generation: string): ReturnType<ProjectLeases["releaseOpen"]> { return this.run(() => this.releaseOpen(session, generation)); }
  forceRelease(session: string, path: string, generation: string, reason: string): ReturnType<ProjectLeases["forceReleaseOpen"]> { return this.run(() => this.forceReleaseOpen(session, path, generation, reason)); }
  handoff(id: string): ReturnType<ProjectLeases["handoffOpen"]> { return this.run(() => this.handoffOpen(id)); }
  private async owner(session: string): Promise<Owner> {
    if (!session || session.length > 256) throw new LeaseError("INVALID_SESSION_IDENTITY");
    this.liveHandle ??= this.store.marker(`runtime-${this.runtime}`).then(file => { if (!file) throw new LeaseError("RUNTIME_IDENTITY_CONFLICT"); return file; });
    await this.liveHandle;
    return { runtime: this.runtime, session, pid: process.pid, processStart: performance.timeOrigin };
  }
  private audit(state: State, action: string, owner: Owner | null, data: Record<string, unknown>): void {
    state.audit.push({ action, owner, ...data, at: new Date().toISOString() });
    if (state.audit.length > 4096) state.audit.splice(0, state.audit.length - 4096);
  }
  private async reconcile(state: State): Promise<void> {
    const alive = new Map<string, boolean>();
    for (const lease of state.leases) {
      if (!alive.has(lease.owner.runtime)) {
        const handle = await this.store.marker(`runtime-${lease.owner.runtime}`, true);
        alive.set(lease.owner.runtime, handle === null);
        if (handle) await handle.close();
      }
    }
    state.leases = state.leases.filter(lease => {
      const live = alive.get(lease.owner.runtime);
      // Unknown in-flight writers or retained background children are never
      // evicted on a timeout. Owner cleanup must confirm these first.
      const uncertainWrite = lease.operations.some(operation => operation.write);
      const reclaim = lease.background.length === 0 && !uncertainWrite && (!live || (lease.operations.length === 0 && lease.expires <= Date.now()));
      if (reclaim) this.audit(state, live ? "idle-expired" : "dead-owner", null, { generation: lease.generation, path: lease.scope.path });
      return !reclaim;
    });
    state.receipts = state.receipts.filter(receipt => receipt.expires > Date.now());
  }
  private owned(state: State, generation: string, owner: Owner): Lease {
    const lease = state.leases.find(value => value.generation === generation && same(value.owner, owner));
    if (!lease) throw new LeaseError("PROJECT_BINDING_REVOKED", { generation, recovery: "Explicitly reopen the exact worktree; the old generation is no longer authorized." });
    return lease;
  }
  private async reserveOpen(session: string, path: string, options: OpenLeaseOptions, previous?: string): Promise<Lease> {
    if (options.mode !== "read" && options.mode !== "write") throw new LeaseError("INVALID_LEASE_MODE");
    const owner = await this.owner(session), scope = await projectScope(path), ttl = options.leaseMs ?? 300000;
    if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 3600000) throw new LeaseError("INVALID_LEASE_DURATION");
    if (options.expectedHead !== undefined && options.expectedHead !== scope.head) throw new LeaseError("PROJECT_HEAD_MISMATCH", { expected: options.expectedHead, actual: scope.head });
    return await this.store.transaction(async state => {
      await this.reconcile(state);
      const old = previous ? this.owned(state, previous, owner) : undefined;
      if (old?.pending) throw new LeaseError("PREVIOUS_LEASE_NOT_COMMITTED");
      if (old && !idle(old)) throw new LeaseError("PROJECT_HAS_ACTIVE_WORK");
      const blockers = state.leases.filter(value => value !== old && overlaps(value.scope.writeDomain, scope.writeDomain) && (value.mode === "write" || options.mode === "write"));
      if (blockers.length) throw new LeaseError("PROJECT_IN_USE", { requested: { path: scope.path, mode: options.mode }, blockers, recovery: "Choose an independent worktree, wait for the writer, or use scoped release. Active writers/readers are not silently evicted." });
      if (options.handoffId) {
        const receipt = state.receipts.find(value => value.id === options.handoffId);
        if (!receipt || receipt.to) throw new LeaseError("HANDOFF_NOT_PENDING");
        if (receipt.from.runtime === owner.runtime) throw new LeaseError("HANDOFF_NOT_INDEPENDENT");
        matches(scope, receipt.scope, true);
      }
      if (state.leases.length >= 512) throw new LeaseError("LEASE_LIMIT");
      const lease: Lease = { generation: randomUUID(), owner, scope, mode: options.mode, ttl, expires: Date.now() + ttl, pending: true, previous: previous ?? null, handoffId: options.handoffId ?? null, operations: [], background: [] };
      state.leases.push(lease); this.audit(state, "reserved", owner, { generation: lease.generation, path: scope.path, mode: options.mode }); return structuredClone(lease);
    });
  }
  private remove(state: State, lease: Lease, scope: Scope): ReleaseReceipt {
    if (!idle(lease)) throw new LeaseError("PROJECT_HAS_ACTIVE_WORK", { generation: lease.generation });
    const receipt: ReleaseReceipt = { id: randomUUID(), from: lease.owner, fromGeneration: lease.generation, scope, to: null, toGeneration: null, expires: Date.now() + 300000, at: new Date().toISOString() };
    state.leases = state.leases.filter(value => value !== lease);
    if (state.receipts.length >= 2048) state.receipts.shift();
    state.receipts.push(receipt); this.audit(state, "relinquished", lease.owner, { generation: lease.generation, handoffId: receipt.id, path: scope.path }); return receipt;
  }
  private async commitOpen(session: string, generation: string, previous?: string, handoffId?: string): Promise<{ lease: Lease; previousRelease: { released: false; handoffId: string } | null }> {
    const owner = await this.owner(session);
    return await this.store.transaction(async state => {
      await this.reconcile(state);
      const next = this.owned(state, generation, owner);
      if (!next.pending) throw new LeaseError("LEASE_ALREADY_COMMITTED");
      if (next.previous !== (previous ?? null) || next.handoffId !== (handoffId ?? null)) throw new LeaseError("RESERVATION_ARGUMENT_MISMATCH");
      const scope = await projectScope(next.scope.path);
      matches(scope, next.scope, next.mode === "read");
      const old = previous ? this.owned(state, previous, owner) : undefined;
      if (old?.pending) throw new LeaseError("PREVIOUS_LEASE_NOT_COMMITTED");
      if (old && !idle(old)) throw new LeaseError("PROJECT_HAS_ACTIVE_WORK");
      const receipt = handoffId ? state.receipts.find(value => value.id === handoffId) : undefined;
      if (handoffId) {
        if (!receipt || receipt.to) throw new LeaseError("HANDOFF_NOT_PENDING");
        if (receipt.from.runtime === owner.runtime) throw new LeaseError("HANDOFF_NOT_INDEPENDENT");
        matches(scope, receipt.scope, true);
        if (state.leases.some(value => same(value.owner, receipt.from) && overlaps(value.scope.writeDomain, scope.writeDomain))) throw new LeaseError("SOURCE_REACQUIRED");
      }
      const oldScope = old ? await projectScope(old.scope.path) : null;
      if (old && oldScope) matches(oldScope, old.scope, old.mode === "read");
      // All validation precedes the atomic binding transition.
      const released = old && oldScope ? this.remove(state, old, oldScope) : null;
      if (receipt) { receipt.to = owner; receipt.toGeneration = next.generation; this.audit(state, "independent-acquisition", owner, { handoffId: receipt.id, generation }); }
      next.pending = false; next.expires = Date.now() + next.ttl;
      return { lease: structuredClone(next), previousRelease: released ? { released: false, handoffId: released.id } : null };
    });
  }
  private async abortOpen(session: string, generation: string): Promise<void> {
    const owner = await this.owner(session);
    await this.store.transaction(async state => { const lease = this.owned(state, generation, owner); if (!lease.pending || !idle(lease)) throw new LeaseError("PROJECT_HAS_ACTIVE_WORK"); state.leases = state.leases.filter(value => value !== lease); this.audit(state, "open-aborted", owner, { generation }); });
  }
  private async accessOpen(session: string, generation: string, write: boolean): Promise<string> {
    const owner = await this.owner(session);
    return await this.store.transaction(async state => {
      await this.reconcile(state); const lease = this.owned(state, generation, owner);
      if (lease.pending) throw new LeaseError("LEASE_NOT_COMMITTED");
      if (write && lease.mode !== "write") throw new LeaseError("PROJECT_READ_ONLY", { allowed: ["project.read", "project.files", "project.current", "project.release"], path: lease.scope.path });
      matches(await projectScope(lease.scope.path), lease.scope, lease.mode === "read");
      const operation = randomUUID(); lease.operations.push({ id: operation, write });
      lease.expires = Date.now() + lease.ttl; return operation;
    });
  }
  private async completeOpen(session: string, generation: string, operation: string, background: number[]): Promise<void> {
    const owner = await this.owner(session);
    if (background.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new LeaseError("INVALID_BACKGROUND_IDENTITY");
    await this.store.transaction(async state => {
      const lease = this.owned(state, generation, owner);
      if (!lease.operations.some(value => value.id === operation)) throw new LeaseError("LEASE_OPERATION_MISMATCH");
      lease.operations = lease.operations.filter(value => value.id !== operation);
      lease.background.push(...[...new Set(background)].map(pid => ({ operation, pid })));
      lease.expires = Date.now() + lease.ttl;
    });
  }
  // Internal observer API: only the authenticated process owner may report its
  // exact child operation's verified exit. Never expose a raw success Boolean.
  private async backgroundExitedOpen(session: string, generation: string, operation: string, pid: number): Promise<void> {
    const owner = await this.owner(session);
    await this.store.transaction(async state => {
      const lease = this.owned(state, generation, owner);
      if (!lease.background.some(value => value.operation === operation && value.pid === pid)) throw new LeaseError("BACKGROUND_OPERATION_MISMATCH");
      lease.background = lease.background.filter(value => value.operation !== operation || value.pid !== pid);
    });
  }
  private async releaseOpen(session: string, generation: string): Promise<{ released: false; relinquished: true; handoffId: string }> {
    const owner = await this.owner(session);
    return await this.store.transaction(async state => {
      const lease = this.owned(state, generation, owner);
      if (lease.pending) throw new LeaseError("LEASE_NOT_COMMITTED");
      const scope = await projectScope(lease.scope.path);
      matches(scope, lease.scope, lease.mode === "read"); const receipt = this.remove(state, lease, scope);
      return { relinquished: true, released: false, handoffId: receipt.id };
    });
  }
  private async forceReleaseOpen(session: string, path: string, generation: string, reason: string): Promise<{ relinquished: true; released: false }> {
    if (!reason.trim() || reason.length > 1000) throw new LeaseError("FORCE_RELEASE_REASON_REQUIRED");
    const owner = await this.owner(session), canonical = await realpath(path);
    return await this.store.transaction(async state => {
      const lease = state.leases.find(value => value.generation === generation && value.scope.path === canonical);
      this.audit(state, "force-release-request", owner, { path: canonical, generation, reason });
      if (!lease) throw new LeaseError("LEASE_GENERATION_MISMATCH");
      const live = await this.store.marker(`runtime-${lease.owner.runtime}`, true);
      const dead = live !== null; if (live) await live.close();
      if (lease.operations.some(operation => operation.write) || lease.background.length || (!dead && (lease.operations.length || lease.expires > Date.now()))) throw new LeaseError("LEASE_NOT_RECLAIMABLE", { owner: lease.owner, generation, reason: "Live work is not evicted; use the owning session's cooperative lifecycle." });
      state.leases = state.leases.filter(value => value !== lease); this.audit(state, "force-released", owner, { path: canonical, generation, reason });
      return { relinquished: true, released: false };
    });
  }
  private async handoffOpen(id: string): Promise<{ released: boolean; receipt: ReleaseReceipt; reason: string | null }> {
    return await this.store.transaction(async state => {
      await this.reconcile(state); const receipt = state.receipts.find(value => value.id === id);
      if (!receipt) throw new LeaseError("HANDOFF_NOT_FOUND_OR_EXPIRED");
      matches(await projectScope(receipt.scope.path), receipt.scope, true);
      const reason = !receipt.to ? "INDEPENDENT_ACQUISITION_PENDING" : state.leases.some(value => same(value.owner, receipt.from) && overlaps(value.scope.writeDomain, receipt.scope.writeDomain)) ? "SOURCE_REACQUIRED" : null;
      return { released: reason === null, receipt: structuredClone(receipt), reason };
    });
  }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closed = true;
    this.closeResult = (async () => {
      await Promise.allSettled([...this.tasks]);
      if (this.liveHandle) await (await this.liveHandle).close();
    })();
    return this.closeResult;
  }
}
