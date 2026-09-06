import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, ElicitRequest, ElicitResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { RunTracker } from "./runs.js";

export interface ActivityEvent {
  version: 1;
  runtimeId: string;
  sequence: number;
  timestamp: string;
  type: string;
  operationId?: string;
  parentId?: string;
  runId?: string;
  detail: unknown;
}

interface Operation {
  id: string;
  tool: string;
  title: string;
  arguments: Record<string, unknown>;
  startedAt: string;
  state: "waiting" | "running" | "stopping";
  controller: AbortController;
  parentId?: string;
  runId?: string;
}

interface PendingApproval {
  resolve: (approved: boolean, source: "user" | "auto-approve-all") => void;
  operation: Operation;
}

export interface AskOption { id: string; label: string; description?: string | undefined; }
export interface AskRequest { question: string; header?: string | undefined; options: AskOption[]; recommended: string; allowOther: boolean; }
export interface AskAnswer { askId: string; optionId?: string | undefined; label?: string | undefined; text?: string | undefined; source: "user" | "auto-recommended"; waitedMs: number; }
export interface AskItem extends AskRequest { id: string; operationId?: string | undefined; runId?: string | undefined; createdAt: string; expiresAt?: string | undefined; }
interface PendingAsk {
  item: AskItem;
  resolve: (answer: AskAnswer) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout> | undefined;
  abort?: (() => void) | undefined;
}

interface OwnedProcess {
  id: string;
  operationId: string;
  runId?: string;
  pid: number;
  argv: string[];
  cwd: string;
  startedAt: string;
  stop: () => void;
}

interface ActivityScope {
  hub: ActivityHub;
  operationId: string;
  runId?: string;
  signal: AbortSignal;
}

const scope = new AsyncLocalStorage<ActivityScope>();
const APPROVAL_TIMEOUT_MS = 110_000;
export const ASK_AUTO_TIMEOUT_MS = 90_000;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_LIVE_BACKLOG = 4 * 1024 * 1024;

export function currentActivity(): ActivityScope | undefined {
  return scope.getStore();
}

export function activityEvent(type: string, detail: unknown): void {
  const current = scope.getStore();
  current?.hub.record(type, detail, current.operationId);
}

export function activityFailure(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause === undefined ? undefined : String(error.cause) }
    : { value: String(error) };
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new Error("UNSAFE_ACTIVITY_DIRECTORY");
  }
  chmodSync(path, 0o700);
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Renamed successfully or never created. */ }
  }
}

function visibleOperation(operation: Operation): Omit<Operation, "controller"> {
  const { controller: _controller, ...visible } = operation;
  return visible;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Local-only user controls. Never exposed as MCP tools or HTTP endpoints. */
export class ActivityHub {
  readonly runtimeId = randomUUID().slice(0, 12);
  readonly runs = new RunTracker((type, detail, runId) => this.record(type, detail, undefined, undefined, runId), () => this.broadcastState());
  readonly directory: string;
  readonly journalPath: string;
  readonly socketPath: string;
  private readonly manifestPath: string;
  private readonly settingsPath: string;
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  private readonly operations = new Map<string, Operation>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly asks = new Map<string, PendingAsk>();
  private readonly processes = new Map<string, OwnedProcess>();
  private readonly recent: ActivityEvent[] = [];
  private journal: number;
  private sequence = 0;
  private autoApprove = false;
  private remember = false;
  private paused = false;
  private closed = false;
  private fault: string | null = null;
  private readonly startedAt = new Date().toISOString();

  constructor(home = homedir(), private readonly approvalTimeoutMs = APPROVAL_TIMEOUT_MS, private readonly askTimeoutMs = ASK_AUTO_TIMEOUT_MS) {
    this.directory = join(home, ".local-dev", "activity");
    privateDirectory(join(home, ".local-dev"));
    privateDirectory(this.directory);
    // Short socket paths also work with long macOS temporary HOME paths in tests.
    const socketDirectory = join("/tmp", `local-dev-${process.getuid?.() ?? "user"}`);
    privateDirectory(socketDirectory);
    this.socketPath = join(socketDirectory, `${this.runtimeId}.sock`);
    this.journalPath = join(this.directory, `${this.runtimeId}.jsonl`);
    this.manifestPath = join(this.directory, `${this.runtimeId}.json`);
    this.settingsPath = join(this.directory, "settings.json");
    try {
      const info = lstatSync(this.settingsPath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error("UNSAFE_APPROVAL_SETTINGS");
      const settings: unknown = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      if (isRecord(settings)) this.paused = settings.paused === true;
      if (isRecord(settings) && settings.remember === true) {
        this.remember = true;
        this.autoApprove = settings.autoApprove === true;
      }
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) throw error;
    }
    this.journal = openSync(this.journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, 0o600);
    this.server = createServer((client) => this.connect(client));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    this.server.on("error", (error) => this.failCapture(error));
    chmodSync(this.socketPath, 0o600);
    this.record("runtime.started", { pid: process.pid, executable: process.execPath, autoApprove: this.autoApprove, remember: this.remember });
    atomicJson(this.manifestPath, {
      version: 1, runtimeId: this.runtimeId, pid: process.pid, socketPath: this.socketPath,
      journalPath: this.journalPath, startedAt: this.startedAt,
    });
  }

  record(type: string, detail: unknown, operationId?: string, parentId?: string, suppliedRunId?: string): ActivityEvent {
    if (this.closed || this.fault !== null) throw new Error("ACTIVITY_CAPTURE_UNAVAILABLE");
    const runId = suppliedRunId ?? (operationId === undefined ? undefined : this.operations.get(operationId)?.runId) ?? currentActivity()?.runId;
    const event: ActivityEvent = {
      version: 1, runtimeId: this.runtimeId, sequence: ++this.sequence,
      timestamp: new Date().toISOString(), type, detail,
      ...(operationId === undefined ? {} : { operationId }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(runId === undefined ? {} : { runId }),
    };
    try {
      // Disk is the full-fidelity archive. Nothing is masked or truncated here.
      if (fstatSync(this.journal).nlink === 0) throw new Error("ACTIVITY_ARCHIVE_REMOVED");
      appendFileSync(this.journal, `${JSON.stringify(event)}\n`);
      if (type === "tool.started" || type.startsWith("approval.") || type.startsWith("ask.") || type.startsWith("run.") || type.startsWith("steering.") || type === "policy.changed") fsyncSync(this.journal);
    } catch (error) {
      this.failCapture(error);
      throw new Error("ACTIVITY_CAPTURE_UNAVAILABLE");
    }
    // A bounded navigation index is not the archive; raw records stay on disk.
    const indexEvent = { ...event, detail: this.indexDetail(type, detail) };
    this.recent.push(indexEvent);
    if (this.recent.length > 300) this.recent.shift();
    for (const client of this.clients) this.send(client, { kind: "event", event: indexEvent });
    return event;
  }

  private indexDetail(type: string, detail: unknown): unknown {
    if (!isRecord(detail)) return {};
    if (type === "process.output") return { processId: detail.processId, stream: detail.stream, bytes: detail.bytes };
    if (type === "tool.result") return { failed: detail.failed };
    if (type === "tool.requested") return { tool: detail.tool, title: detail.title };
    if (type === "downstream.result") return { tool: detail.tool };
    if (type === "downstream.stderr") return { server: detail.server, bytes: detail.bytes };
    return detail;
  }

  private send(client: Socket, value: unknown): void {
    if (client.destroyed) return;
    // A lagging viewer reconnects and recovers from its local journal cursor.
    if (client.writableLength > MAX_LIVE_BACKLOG) { client.destroy(); return; }
    client.write(`${JSON.stringify(value)}\n`);
  }

  private snapshot(): Record<string, unknown> {
    return {
      kind: "snapshot", runtimeId: this.runtimeId, pid: process.pid, startedAt: this.startedAt,
      journalPath: this.journalPath, sequence: this.sequence,
      policy: { autoApprove: this.autoApprove, remember: this.remember, paused: this.paused },
      fault: this.fault,
      capabilities: { workerRuns: true, workTracking: 1, ask: 1, askAutoTimeoutMs: this.askTimeoutMs, requiresTodoList: true, steering: "next_tool_response", publicSummaries: true },
      asks: [...this.asks.values()].map(({ item }) => item),
      runs: this.runs.snapshot(),
      operations: [...this.operations.values()].map(visibleOperation),
      processes: [...this.processes.values()].map(({ stop: _stop, ...visible }) => visible),
      recent: this.recent,
    };
  }

  private broadcastState(): void {
    for (const client of this.clients) this.send(client, this.snapshot());
  }

  private connect(client: Socket): void {
    this.clients.add(client);
    client.setEncoding("utf8");
    client.on("error", () => undefined);
    client.on("close", () => this.clients.delete(client));
    this.send(client, this.snapshot());
    let buffer = "";
    client.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_BYTES) { client.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: unknown;
        try {
          request = JSON.parse(line);
          if (!isRecord(request)) throw new Error("INVALID_CONTROL");
          this.control(request);
          this.send(client, { kind: "ack", id: request.id, ok: true });
        } catch (error) {
          this.send(client, { kind: "ack", id: isRecord(request) ? request.id : undefined, ok: false, error: String(error) });
        }
      }
    });
  }

  private control(request: Record<string, unknown>): void {
    switch (request.action) {
      case "steer":
        if (typeof request.runId !== "string" || typeof request.text !== "string" || typeof request.messageId !== "string") throw new Error("INVALID_STEERING");
        this.runs.queue(request.runId, request.text, request.messageId);
        break;
      case "policy": {
        const autoAskWasActive = this.autoApprove && !this.paused;
        if (typeof request.autoApprove !== "boolean" || typeof request.remember !== "boolean") throw new Error("INVALID_POLICY");
        if (request.autoApprove && request.confirmed !== true) throw new Error("CONFIRMATION_REQUIRED");
        // Record and persist before changing the policy used at admission.
        this.record("policy.changed", { autoApprove: request.autoApprove, remember: request.remember, source: "local-control" });
        atomicJson(this.settingsPath, { version: 1, autoApprove: request.autoApprove && request.remember, remember: request.remember, paused: this.paused });
        this.autoApprove = request.autoApprove;
        this.remember = request.remember;
        if (this.autoApprove && !this.paused) {
          for (const pending of this.approvals.values()) pending.resolve(true, "auto-approve-all");
        }
        if (autoAskWasActive !== (this.autoApprove && !this.paused)) this.refreshAskTimers();
        break;
      }
      case "pause": {
        const autoAskWasActive = this.autoApprove && !this.paused;
        if (typeof request.paused !== "boolean") throw new Error("INVALID_PAUSE");
        this.record("admission.changed", { paused: request.paused });
        atomicJson(this.settingsPath, { version: 1, autoApprove: this.autoApprove && this.remember, remember: this.remember, paused: request.paused });
        this.paused = request.paused;
        if (!this.paused && this.autoApprove) for (const pending of this.approvals.values()) pending.resolve(true, "auto-approve-all");
        if (autoAskWasActive !== (this.autoApprove && !this.paused)) this.refreshAskTimers();
        // Pending approvals are rechecked at admission; pause always wins.
        break;
      }
      case "answerAsk": {
        if (typeof request.askId !== "string") throw new Error("INVALID_ASK");
        const pending = this.asks.get(request.askId);
        if (!pending) throw new Error("ASK_EXPIRED");
        if (typeof request.optionId === "string") {
          const option = pending.item.options.find((item) => item.id === request.optionId);
          if (!option) throw new Error("INVALID_ASK_OPTION");
          this.finishAsk(pending, { askId: pending.item.id, optionId: option.id, label: option.label, source: "user", waitedMs: Date.now() - Date.parse(pending.item.createdAt) });
        } else if (typeof request.text === "string" && pending.item.allowOther && request.text.trim() && request.text.length <= 2000) {
          this.finishAsk(pending, { askId: pending.item.id, text: request.text.trim(), source: "user", waitedMs: Date.now() - Date.parse(pending.item.createdAt) });
        } else throw new Error("INVALID_ASK_ANSWER");
        break;
      }
      case "approve":
      case "deny": {
        if (typeof request.operationId !== "string") throw new Error("INVALID_OPERATION");
        const pending = this.approvals.get(request.operationId);
        if (pending === undefined) throw new Error("APPROVAL_EXPIRED");
        if (request.action === "approve" && this.paused) throw new Error("ADMISSION_PAUSED");
        pending.resolve(request.action === "approve", "user");
        break;
      }
      case "stop": {
        if (typeof request.operationId !== "string") throw new Error("INVALID_OPERATION");
        const operation = this.operations.get(request.operationId);
        if (operation === undefined) throw new Error("OPERATION_NOT_RUNNING");
        this.record("operation.stopRequested", {}, operation.id);
        operation.state = "stopping";
        operation.controller.abort(new Error("OPERATION_CANCELLED"));
        break;
      }
      case "stopProcess": {
        if (typeof request.processId !== "string") throw new Error("INVALID_PROCESS");
        const owned = this.processes.get(request.processId);
        if (owned === undefined) throw new Error("PROCESS_NOT_RUNNING");
        this.record("process.stopRequested", { processId: owned.id, pid: owned.pid }, owned.operationId);
        owned.stop();
        break;
      }
      case "stopAll":
        this.record("admission.changed", { paused: true, stopAll: true });
        atomicJson(this.settingsPath, { version: 1, autoApprove: this.autoApprove && this.remember, remember: this.remember, paused: true });
        this.paused = true;
        this.refreshAskTimers();
        for (const operation of this.operations.values()) {
          operation.state = "stopping";
          operation.controller.abort(new Error("OPERATION_CANCELLED"));
        }
        for (const owned of this.processes.values()) owned.stop();
        break;
      case "hello":
        this.record("viewer.connected", { client: request.client, pid: request.pid });
        break;
      case "snapshot": break;
      default: throw new Error("UNKNOWN_CONTROL");
    }
    this.broadcastState();
  }

  private scheduleAskTimer(pending: PendingAsk): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.item.expiresAt = undefined;
    if (!this.autoApprove || this.paused) return;
    const deadline = Date.now() + this.askTimeoutMs;
    pending.item.expiresAt = new Date(deadline).toISOString();
    pending.timer = setTimeout(() => {
        if (!this.autoApprove || this.paused || !this.asks.has(pending.item.id)) return;
        const option = pending.item.options.find((item) => item.id === pending.item.recommended);
        if (!option) {
          if (pending.abort) pending.abort();
          this.asks.delete(pending.item.id);
          this.record("ask.cancelled", { askId: pending.item.id, reason: "recommendation-missing" }, pending.item.operationId, undefined, pending.item.runId);
          pending.reject(new Error("ASK_RECOMMENDATION_MISSING"));
          this.broadcastState();
          return;
        }
        this.finishAsk(pending, { askId: pending.item.id, optionId: option.id, label: option.label, source: "auto-recommended", waitedMs: Date.now() - Date.parse(pending.item.createdAt) });
    }, this.askTimeoutMs);
  }

  private refreshAskTimers(): void {
    for (const pending of this.asks.values()) this.scheduleAskTimer(pending);
  }

  private finishAsk(pending: PendingAsk, answer: AskAnswer): void {
    if (!this.asks.has(pending.item.id)) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort) pending.abort();
    this.asks.delete(pending.item.id);
    this.record("ask.answered", { askId: pending.item.id, answer }, pending.item.operationId, undefined, pending.item.runId);
    pending.resolve(answer);
    this.broadcastState();
  }

  async ask(request: AskRequest, signal?: AbortSignal): Promise<AskAnswer> {
    const current = currentActivity();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const item: AskItem = { ...request, id, createdAt, ...(current?.operationId ? { operationId: current.operationId } : {}), ...(current?.runId ? { runId: current.runId } : {}) };
    this.record("ask.requested", { ask: item, autoApprove: this.autoApprove, timeoutMs: this.askTimeoutMs }, item.operationId, undefined, item.runId);
    return await new Promise<AskAnswer>((resolve, reject) => {
      const pending: PendingAsk = { item, resolve, reject };
      const aborted = () => {
        if (!this.asks.has(id)) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.asks.delete(id);
        if (!this.closed && this.fault === null) this.record("ask.cancelled", { askId: id, reason: "operation-aborted" }, item.operationId, undefined, item.runId);
        reject(new Error("OPERATION_CANCELLED"));
        this.broadcastState();
      };
      pending.abort = () => signal?.removeEventListener("abort", aborted);
      this.asks.set(id, pending);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      this.scheduleAskTimer(pending);
      this.broadcastState();
    });
  }

  private failCapture(error: unknown): void {
    if (this.fault !== null) return;
    this.fault = String(error);
    this.paused = true;
    for (const pending of this.asks.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.abort) pending.abort();
      pending.reject(new Error("ACTIVITY_CAPTURE_UNAVAILABLE"));
    }
    this.asks.clear();
    for (const operation of this.operations.values()) operation.controller.abort(new Error("ACTIVITY_CAPTURE_UNAVAILABLE"));
    for (const owned of this.processes.values()) { try { owned.stop(); } catch { /* Remain faulted. */ } }
    this.broadcastState();
  }

  private async approve(operation: Operation, signal: AbortSignal, required: boolean): Promise<void> {
    if (this.paused) throw new Error("ADMISSION_PAUSED");
    signal.throwIfAborted();
    if (!required || this.autoApprove) {
      this.record("approval.accepted", { source: this.autoApprove ? "auto-approve-all" : "read-only", required }, operation.id);
      return;
    }
    this.record("approval.requested", { tool: operation.tool, arguments: operation.arguments, expiresInMs: this.approvalTimeoutMs }, operation.id);
    const decision = await new Promise<{ accepted: boolean; source: string }>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, approved = false, source = "user"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.approvals.delete(operation.id);
        if (error !== undefined) reject(error); else resolve({ accepted: approved, source });
      };
      const aborted = (): void => finish(new Error("OPERATION_CANCELLED"));
      const timer = setTimeout(() => finish(new Error("APPROVAL_TIMED_OUT")), this.approvalTimeoutMs);
      this.approvals.set(operation.id, { operation, resolve: (approved, source) => finish(undefined, approved, source) });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      this.broadcastState();
    });
    if (this.paused) throw new Error("ADMISSION_PAUSED");
    signal.throwIfAborted();
    this.record(decision.accepted ? "approval.accepted" : "approval.denied", { source: decision.source }, operation.id);
    if (!decision.accepted) throw new Error("APPROVAL_DENIED");
  }

  async execute<T>(
    tool: Pick<Tool, "name" | "title" | "annotations">,
    arguments_: Record<string, unknown>,
    invoke: (signal: AbortSignal) => Promise<T>,
    upstreamSignal?: AbortSignal,
    metadata?: unknown,
    suppliedRunId?: string,
  ): Promise<T> {
    if (this.fault !== null || this.closed) throw new Error("ACTIVITY_CAPTURE_UNAVAILABLE");
    const parent = currentActivity();
    const runId = parent?.runId ?? suppliedRunId;
    const leaveRun = runId === undefined ? () => undefined : this.runs.enter(runId);
    const operation: Operation = {
      id: randomUUID(), tool: tool.name, title: tool.title ?? tool.name,
      arguments: arguments_, startedAt: new Date().toISOString(), state: "waiting", controller: new AbortController(),
      ...(parent === undefined ? {} : { parentId: parent.operationId }),
      ...(runId === undefined ? {} : { runId }),
    };
    const signals = [operation.controller.signal, ...(upstreamSignal === undefined ? [] : [upstreamSignal]), ...(parent === undefined ? [] : [parent.signal])];
    const signal = AbortSignal.any(signals);
    this.operations.set(operation.id, operation);
    try {
      this.record("tool.requested", { tool: tool.name, title: operation.title, arguments: arguments_, metadata }, operation.id, operation.parentId);
      this.runs.assertCanProceed(runId);
      await this.approve(operation, signal, tool.annotations?.readOnlyHint !== true);
      signal.throwIfAborted();
      // No await between the last policy check and dispatch.
      if (this.paused) throw new Error("ADMISSION_PAUSED");
      this.runs.assertCanProceed(runId);
      operation.state = "running";
      this.record("tool.started", { tool: tool.name }, operation.id);
      this.broadcastState();
      const result = await scope.run({ hub: this, operationId: operation.id, signal, ...(runId === undefined ? {} : { runId }) }, () => invoke(signal));
      const candidate = result as CallToolResult | undefined;
      const failed = candidate?.isError === true || candidate?.structuredContent?.ok === false;
      this.record("tool.result", { result, failed }, operation.id);
      const resultError = candidate?.structuredContent?.error;
      const cancelled = signal.aborted && failed && isRecord(resultError) && resultError.code === "OPERATION_CANCELLED";
      this.record(cancelled ? "tool.cancelled" : failed ? "tool.failed" : "tool.completed", { tool: tool.name, cancellationRequested: signal.aborted }, operation.id);
      return result;
    } catch (error) {
      if (this.fault === null && !this.closed) {
        const cancelled = signal.aborted && error instanceof Error && error.message === "OPERATION_CANCELLED";
        this.record(cancelled ? "tool.cancelled" : "tool.failed", { tool: tool.name, error: activityFailure(error), cancellationRequested: signal.aborted }, operation.id);
      }
      throw error;
    } finally {
      leaveRun();
      this.operations.delete(operation.id);
      this.approvals.delete(operation.id);
      this.broadcastState();
    }
  }

  trackProcess(owned: OwnedProcess): () => void {
    const runId = this.operations.get(owned.operationId)?.runId ?? currentActivity()?.runId;
    this.processes.set(owned.id, { ...owned, ...(runId === undefined ? {} : { runId }) });
    this.broadcastState();
    return () => { this.processes.delete(owned.id); this.broadcastState(); };
  }

  backgroundCount(runId: string): number {
    return [...this.processes.values()].filter((owned) => owned.runId === runId).length;
  }

  async elicit(params: ElicitRequest["params"], fallback: () => Promise<ElicitResult>): Promise<ElicitResult> {
    const schema = "requestedSchema" in params ? params.requestedSchema : undefined;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
    // Only synthesize actual approval decisions, never arbitrary form answers.
    const entries = Object.entries(properties ?? {});
    const pureApproval = params.mode === "form" && properties !== undefined && entries.every(([name, value]) =>
      /^(allow|approve|approved|confirm|confirmed)$/u.test(name) && isRecord(value) && value.type === "boolean");
    if (!pureApproval) {
      activityEvent("information.requested", params);
      const result = await fallback();
      activityEvent("information.result", result);
      return result;
    }
    try {
      return await this.execute({ name: "downstream.approval", title: params.message }, params as Record<string, unknown>, async () => ({
        action: "accept" as const, content: Object.fromEntries(entries.map(([name]) => [name, true])),
      }));
    } catch (error) {
      if (error instanceof Error && ["APPROVAL_DENIED", "APPROVAL_TIMED_OUT", "ADMISSION_PAUSED"].includes(error.message)) return { action: "decline" };
      return { action: "cancel" };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const pending of this.asks.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.abort) pending.abort();
      if (this.fault === null) this.record("ask.cancelled", { askId: pending.item.id, reason: "runtime-closed" }, pending.item.operationId, undefined, pending.item.runId);
      pending.reject(new Error("ASK_RUNTIME_CLOSED"));
    }
    this.asks.clear();
    for (const operation of this.operations.values()) operation.controller.abort(new Error("RUNTIME_CLOSED"));
    for (const owned of this.processes.values()) owned.stop();
    if (this.fault === null) {
      this.runs.interrupt();
      this.record("runtime.closed", { remainingProcesses: this.processes.size });
    }
    this.closed = true;
    for (const client of this.clients) client.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    closeSync(this.journal);
    for (const path of [this.manifestPath, this.socketPath]) { try { unlinkSync(path); } catch { /* Already removed. */ } }
  }
}
