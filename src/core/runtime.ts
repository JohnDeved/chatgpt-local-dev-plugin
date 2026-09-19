import type { CallToolResult as McpCallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { currentActivity } from "../activity.js";
import type { ProjectBinding, ProjectOpenHook } from "../config/types.js";
import { isPathInside } from "../path.js";
import type { ToolProgress } from "../progress.js";
import { LeaseError } from "../lease-storage.js";
import { ProjectLeases, type OpenLeaseOptions } from "../project-leases.js";
import { failure, success } from "../result.js";
import type { JsonObject, JsonValue, ToolCallResult } from "../types.js";
import { commandLabel } from "./command-label.js";
import { beginWorkingTreeDiff, finishDiff } from "./diff.js";
import { ProcessManager, type ProcessSnapshot } from "./process.js";
import { resolveProject } from "./project.js";

export interface BatchStep {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  allowNonZero?: boolean;
}

export type MissingProjectAction = "error" | "create" | "temporary";
type ProjectKind = "existing" | "created" | "temporary";

interface ActiveProject {
  path: string;
  kind: ProjectKind;
  generation?: string;
  mode: "read" | "write";
}

type ProjectBindingInvoker = (
  exposedToolName: string,
  arguments_: Record<string, unknown>,
) => Promise<McpCallToolResult | undefined>;

function processData(snapshot: ProcessSnapshot): JsonValue {
  return { ...snapshot } as unknown as JsonValue;
}

function leaseFailure(tool: string, error: unknown): ToolCallResult {
  if (!(error instanceof LeaseError)) throw error;
  const blockers = Array.isArray(error.detail.blockers) ? error.detail.blockers.slice(0, 4).map((value) => {
    const blocker = value as { generation?: unknown; mode?: unknown; scope?: { path?: unknown } };
    return { generation: blocker.generation, mode: blocker.mode, path: blocker.scope?.path };
  }) : undefined;
  const data = {
    ...(typeof error.detail.recovery === "string" ? { recovery: error.detail.recovery } : {}),
    ...(error.detail.requested === undefined ? {} : { requested: error.detail.requested }),
    ...(blockers === undefined ? {} : { blockers, blockerCount: (error.detail.blockers as unknown[]).length }),
    ...(["path", "generation", "expected", "actual"].reduce<Record<string, unknown>>((result, key) => {
      if (error.detail[key] !== undefined) result[key] = error.detail[key];
      return result;
    }, {})),
  } as JsonValue;
  return failure(tool, error.code, error.code.replaceAll("_", " ").toLowerCase(), data);
}

async function projectEntry(project: string, requested: string): Promise<string> {
  if (isAbsolute(requested)) throw new Error("INVALID_PROJECT_PATH");
  const candidate = await realpath(resolve(project, requested)).catch(() => { throw new Error("PROJECT_ENTRY_NOT_FOUND"); });
  if (!isPathInside(project, candidate)) throw new Error("INVALID_PROJECT_PATH");
  return candidate;
}

async function commandCwd(project: string, requested?: string): Promise<string> {
  if (requested === undefined) return project;
  if (isAbsolute(requested)) throw new Error("INVALID_CWD");
  const candidate = await realpath(resolve(project, requested)).catch(() => { throw new Error("INVALID_CWD"); });
  if (!isPathInside(project, candidate) || !(await stat(candidate)).isDirectory()) throw new Error("INVALID_CWD");
  return candidate;
}

function substituted(value: JsonValue, projectPath: string): JsonValue {
  if (typeof value === "string") return value.replaceAll("${projectPath}", projectPath);
  if (Array.isArray(value)) return value.map((item) => substituted(item, projectPath));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituted(item, projectPath)]));
  }
  return value;
}

function resultFailure(result: McpCallToolResult): { failed: boolean; message?: string } {
  const text = result.content.find((block) => block.type === "text")?.text?.slice(0, 500);
  const structured = result.structuredContent as { ok?: unknown; error?: unknown } | undefined;
  const failed = result.isError === true || structured?.ok === false;
  if (!failed) return { failed: false, ...(text === undefined ? {} : { message: text }) };
  const error = structured?.error;
  const message = typeof error === "object" && error !== null && "message" in error
    ? String(error.message).slice(0, 500)
    : text;
  return { failed: true, ...(message === undefined ? {} : { message }) };
}

function errorSnapshot(error: unknown): ProcessSnapshot | undefined {
  if (typeof error !== "object" || error === null || !("snapshot" in error)) return undefined;
  return error.snapshot as ProcessSnapshot;
}

function temporaryPrefix(query: string): string {
  const source = basename(query.trim()).toLowerCase();
  const slug = source.replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
  return slug || "project";
}

async function createPersistentProject(query: string, roots: string[]): Promise<string> {
  const realRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => undefined))))
    .filter((root): root is string => root !== undefined);
  if (realRoots.length === 0) throw new Error("NO_PROJECT_ROOT");
  const normalized = query.trim();
  let root = realRoots[0] as string;
  let candidate: string;
  if (isAbsolute(normalized)) {
    const matchingRoot = realRoots.find((entry) => isPathInside(entry, normalized));
    if (matchingRoot === undefined) throw new Error("INVALID_PROJECT_PATH");
    root = matchingRoot;
    candidate = normalized;
  } else {
    candidate = resolve(root, normalized);
  }
  if (!isPathInside(root, candidate)) throw new Error("INVALID_PROJECT_PATH");
  await mkdir(candidate, { recursive: true });
  const project = await realpath(candidate);
  if (!isPathInside(root, project)) throw new Error("INVALID_PROJECT_PATH");
  return project;
}

async function createTemporaryProject(query: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), `local-dev-${temporaryPrefix(query)}-`)));
}


type ProjectResolution =
  | { target: Omit<ActiveProject, "generation" | "mode">; error?: never }
  | { target?: never; error: ToolCallResult };

async function resolveProjectTarget(
  query: string,
  onMissing: MissingProjectAction,
  roots: string[],
): Promise<ProjectResolution> {
  const matches = await resolveProject(query, roots);
  if (matches.length > 1) {
    return {
      error: failure(
        "project.open",
        "AMBIGUOUS_PROJECT",
        `Project query matched ${matches.length} configured directories. Choose the best candidate and retry with its exact path.`,
        { candidates: matches.map((path) => ({ name: basename(path), path })) },
      ),
    };
  }
  if (matches[0] !== undefined) return { target: { path: matches[0], kind: "existing" } };
  if (onMissing === "error") {
    return {
      error: failure(
        "project.open",
        "PROJECT_NOT_FOUND",
        "No configured project matched the query. Retry with onMissing=create for durable work or onMissing=temporary for disposable work.",
      ),
    };
  }
  try {
    const temporary = onMissing === "temporary";
    const project = temporary
      ? await createTemporaryProject(query)
      : await createPersistentProject(query, roots);
    return { target: { path: project, kind: temporary ? "temporary" : "created" } };
  } catch (error) {
    const code = error instanceof Error ? error.message : "PROJECT_CREATE_FAILED";
    if (code === "NO_PROJECT_ROOT") {
      return { error: failure("project.open", code, "A persistent project cannot be created because no configured project root exists. Use a temporary project or configure a root.") };
    }
    if (code === "INVALID_PROJECT_PATH") {
      return { error: failure("project.open", code, "A persistent project path must stay inside a configured project root.") };
    }
    return { error: failure("project.open", "PROJECT_CREATE_FAILED", "The requested project directory could not be created.") };
  }
}

async function matchingHooks(project: string, hooks: ProjectOpenHook[]): Promise<ProjectOpenHook[]> {
  const matches = await Promise.all(hooks.map(async (hook) =>
    await realpath(hook.projectRoot).catch(() => undefined) === project ? hook : undefined));
  return matches.filter((hook): hook is ProjectOpenHook => hook !== undefined);
}

async function runProjectHooks(
  project: ActiveProject,
  hooks: ProjectOpenHook[],
  processes: ProcessManager,
  progress?: ToolProgress,
): Promise<ToolCallResult | undefined> {
  for (const [index, hook] of hooks.entries()) {
    await progress?.report(
      `Project hook ${index + 1}/${hooks.length}: ${commandLabel(hook.argv)}`,
      0.35 + (index / Math.max(hooks.length, 1)) * 0.2,
    );
    try {
      const current = currentActivity();
      current?.signal.throwIfAborted();
      const runHook = async (): Promise<ProcessSnapshot> => await processes.run(hook.argv, project.path, false);
      const result = current === undefined ? await runHook() : await current.hub.execute(
        { name: "project.hook", title: `Project hook ${index + 1}` },
        { argv: hook.argv, cwd: project.path }, runHook,
      );
      if (result.exitCode === 0) continue;
      if (project.kind === "temporary") await rm(project.path, { recursive: true, force: true });
      return failure("project.open", "PROJECT_HOOK_FAILED", "A configured project-open hook exited unsuccessfully.", processData(result));
    } catch (error) {
      if (project.kind === "temporary") await rm(project.path, { recursive: true, force: true });
      const snapshot = errorSnapshot(error);
      if (error instanceof Error && error.message === "COMMAND_STOP_UNCONFIRMED") throw error;
      return failure(
        "project.open",
        "PROJECT_HOOK_FAILED",
        "A configured project-open hook could not be completed.",
        snapshot === undefined ? null : processData(snapshot),
      );
    }
  }
  return undefined;
}

async function projectBindingResults(
  project: string,
  bindings: ProjectBinding[],
  invokeBinding?: ProjectBindingInvoker,
  progress?: ToolProgress,
): Promise<JsonValue[]> {
  if (invokeBinding === undefined) {
    return bindings.map((binding) => ({
      server: binding.server,
      tool: binding.tool,
      status: "error",
      message: "No downstream binding executor is available.",
    }));
  }
  const results: JsonValue[] = [];
  for (const [index, binding] of bindings.entries()) {
    await progress?.report(
      `Synchronizing ${binding.server}.${binding.tool}…`,
      0.65 + (index / Math.max(bindings.length, 1)) * 0.25,
    );
    try {
      const result = await invokeBinding(
        `${binding.server}.${binding.tool}`,
        substituted(binding.arguments, project) as JsonObject,
      );
      if (result === undefined) {
        results.push({ server: binding.server, tool: binding.tool, status: "error", message: "The configured downstream tool is not exposed." });
        continue;
      }
      const failed = resultFailure(result);
      results.push({
        server: binding.server,
        tool: binding.tool,
        status: failed.failed ? "error" : "ok",
        ...(failed.message === undefined ? {} : { message: failed.message }),
      });
    } catch {
      results.push({ server: binding.server, tool: binding.tool, status: "error", message: "The downstream project binding could not be completed." });
    }
  }
  return results;
}

const COMMAND_PROGRESS_INTERVAL_MS = 5_000;

function commandHeartbeat(progress: ToolProgress | undefined, label: string): () => void {
  if (progress === undefined) return () => undefined;
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    void progress.report(`Still running ${label} (${elapsedSeconds}s elapsed)…`);
  }, COMMAND_PROGRESS_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

interface BackgroundOwnership {
  session: string;
  token: number;
  starting: boolean;
  settled: Promise<void>;
  settle: () => void;
}

export class CoreRuntime {
  private readonly activeProjects = new Map<string, ActiveProject>();
  private readonly temporaryProjects = new Set<string>();
  private backgroundOwnership: BackgroundOwnership | undefined;
  private backgroundPin: { session: string; generation: string; operation: string; pid: number } | undefined;
  private backgroundCleanup: Promise<void> | undefined;
  private readonly foregroundPins = new Map<number, {
    session: string;
    generation: string;
    operation: string;
    phase: "operation" | "background" | "idle";
    releaseAfterExit: boolean;
  }>();
  private backgroundQueue: Promise<void> = Promise.resolve();
  private backgroundSequence = 0;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private readonly projectQueues = new Map<string, Promise<void>>();
  private readonly runningTasks = new Set<Promise<void>>();
  private downstreamQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly roots: string[],
    private readonly projectOpenHooks: ProjectOpenHook[],
    private readonly projectBindings: ProjectBinding[] = [],
    private readonly invokeBinding?: ProjectBindingInvoker,
    private readonly leases?: ProjectLeases,
    private readonly processes: ProcessManager = new ProcessManager(),
  ) {}

  private async serializeBackground<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.backgroundQueue;
    let release: () => void = () => undefined;
    this.backgroundQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); }
    finally { release(); }
  }

  private async serializeDownstream<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.downstreamQueue;
    let release: () => void = () => undefined;
    this.downstreamQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); }
    finally { release(); }
  }

  private async serializeProject<T>(session: string, action: () => Promise<T>): Promise<T> {
    const previous = this.projectQueues.get(session) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.projectQueues.set(session, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.projectQueues.get(session) === current) this.projectQueues.delete(session);
    }
  }

  private trackRuntimeTask(): () => void {
    let release: () => void = () => undefined;
    const task = new Promise<void>((resolve) => { release = resolve; });
    this.runningTasks.add(task);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      release();
      this.runningTasks.delete(task);
    };
  }

  private bindingsForTool(tool: string): ProjectBinding[] {
    return this.projectBindings.filter((binding) => tool.startsWith(`${binding.server}.`));
  }

  isProjectBoundTool(tool: string): boolean {
    return this.bindingsForTool(tool).length > 0;
  }

  async callProjectBoundTool(
    session: string,
    tool: string,
    write: boolean,
    action: () => Promise<McpCallToolResult>,
  ): Promise<McpCallToolResult | ToolCallResult> {
    if (this.closing) return failure(tool, "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
    const project = this.activeProjects.get(session);
    if (project === undefined) return failure(tool, "NO_ACTIVE_PROJECT", "Resolve a project before using this tool.");
    const bindings = this.bindingsForTool(tool);
    if (bindings.some((binding) => `${binding.server}.${binding.tool}` === tool)) {
      return failure(tool, "PROJECT_BINDING_MANAGED", "Configured project binding tools are managed by Local Dev.");
    }
    const finish = this.trackRuntimeTask();
    try {
      try {
        return await this.withOperation(session, project, write, async () => await this.serializeDownstream(async () => {
          const results = await projectBindingResults(project.path, bindings, this.invokeBinding);
          if (results.some((result) => typeof result === "object" && result !== null && !Array.isArray(result) && result.status === "error")) {
            return failure(tool, "PROJECT_BINDING_FAILED", "The downstream server could not be bound to the authenticated project.");
          }
          return await action();
        }));
      } catch (error) {
        if (error instanceof LeaseError && error.code === "PROJECT_BINDING_REVOKED" && this.activeProjects.get(session)?.generation === project.generation) {
          this.activeProjects.delete(session);
        }
        return leaseFailure(tool, error);
      }
    } finally { finish(); }
  }

  async openProject(
    query: string,
    onMissing: MissingProjectAction = "error",
    progress?: ToolProgress,
    session = "runtime",
    options: OpenLeaseOptions = { mode: "write" },
  ): Promise<ToolCallResult> {
    if (this.closing) return failure("project.open", "RUNTIME_CLOSING", "The runtime is closing and cannot open a project.");
    const finish = this.trackRuntimeTask();
    try { return await this.serializeProject(session, async () => await this.openProjectTransition(query, onMissing, progress, session, options)); }
    finally { finish(); }
  }

  private async openProjectTransition(
    query: string,
    onMissing: MissingProjectAction = "error",
    progress?: ToolProgress,
    session = "runtime",
    options: OpenLeaseOptions = { mode: "write" },
  ): Promise<ToolCallResult> {
    if (this.closing) return failure("project.open", "RUNTIME_CLOSING", "The runtime is closing and cannot open a project.");
    if (this.processes.hasRunningBackground()) {
      return failure("project.open", "BACKGROUND_RUNNING", "Stop the background process before switching projects.");
    }
    const queryLabel = basename(query.trim()) || "requested project";
    await progress?.report(`Searching configured projects for ${queryLabel}…`, 0.1);
    const resolved = await resolveProjectTarget(query, onMissing, this.roots);
    if (resolved.error !== undefined) return resolved.error;
    let project: ActiveProject = { ...resolved.target, mode: options.mode };
    await progress?.report(`Resolved ${basename(project.path)}; checking project setup…`, 0.25);
    let previous = this.activeProjects.get(session);
    let previousRelease: JsonValue = null;
    let bindings: JsonValue[] = [];
    let warnings = 0;
    let hooksRun = 0;
    let candidateGeneration: string | undefined;
    let candidateCommitted = false;
    try {
      if (this.leases !== undefined) {
        if (previous?.generation !== undefined) {
          try {
            await this.withOperation(session, previous, false, async () => undefined);
          } catch (error) {
            if (!(error instanceof LeaseError) || error.code !== "PROJECT_BINDING_REVOKED") throw error;
            if (this.activeProjects.get(session)?.generation === previous.generation) this.activeProjects.delete(session);
            previous = undefined;
          }
        }
        const constrained = options.leaseMs !== undefined || options.expectedHead !== undefined || options.handoffId !== undefined;
        if (previous?.path === project.path && previous.mode === options.mode && previous.generation !== undefined && !constrained) {
          return success("project.open", {
            path: previous.path, kind: previous.kind, mode: previous.mode, generation: previous.generation,
            hooksRun: 0, bindings: [], bindingWarnings: 0, previousRelease: null,
          }, `active=${previous.path} kind=${previous.kind} mode=${previous.mode}`);
        }
        if (previous?.path === project.path && previous.generation !== undefined) {
          const reserved = await this.leases.reserve(session, project.path, options, previous.generation);
          candidateGeneration = reserved.generation;
          const committed = await this.leases.commit(session, reserved.generation, previous.generation, options.handoffId);
          candidateCommitted = true;
          project = { ...project, path: committed.lease.scope.path, generation: committed.lease.generation };
          previousRelease = committed.previousRelease as unknown as JsonValue;
          this.activeProjects.set(session, project);
          candidateGeneration = undefined;
          return success("project.open", {
            path: project.path, kind: project.kind, mode: project.mode, generation: project.generation ?? null,
            hooksRun: 0, bindings: [], bindingWarnings: 0, previousRelease,
          }, `active=${project.path} kind=${project.kind} mode=${project.mode}`);
        }

        const reserved = await this.leases.reserve(session, project.path, options);
        candidateGeneration = reserved.generation;
        const committed = await this.leases.commit(session, reserved.generation, undefined, options.handoffId);
        candidateCommitted = true;
        project = { ...project, path: committed.lease.scope.path, generation: committed.lease.generation };
        const hooks = await matchingHooks(project.path, this.projectOpenHooks);
        hooksRun = hooks.length;
        if (hooks.length > 0 && project.mode === "read") throw new LeaseError("PROJECT_READ_ONLY", { path: project.path });
        if (hooks.length === 0) await progress?.report("No project hooks configured; activating project…", 0.45);
        const setup = await this.withOperation(session, project, hooks.length > 0, async () => {
          const hookFailure = await runProjectHooks(project, hooks, this.processes, progress);
          if (hookFailure !== undefined) return { hookFailure, bindings: [] as JsonValue[] };
          if (this.projectBindings.length === 0) await progress?.report("No downstream project bindings; activating project…", 0.75);
          return { bindings: await this.serializeDownstream(async () => await projectBindingResults(project.path, this.projectBindings, this.invokeBinding, progress)) };
        }, true);
        if (setup.hookFailure !== undefined) {
          await this.leases.release(session, committed.lease.generation);
          candidateGeneration = undefined;
          if (project.kind === "temporary") await rm(project.path, { recursive: true, force: true });
          return setup.hookFailure;
        }
        bindings = setup.bindings;
        warnings = bindings.filter((binding) =>
          typeof binding === "object" && binding !== null && !Array.isArray(binding) && binding.status === "error").length;
        if (previous?.generation !== undefined) {
          try { previousRelease = await this.leases.release(session, previous.generation) as unknown as JsonValue; }
          catch (error) {
            await this.leases.release(session, committed.lease.generation);
            candidateGeneration = undefined;
            throw error;
          }
        }
      } else {
        const hooks = await matchingHooks(project.path, this.projectOpenHooks);
        hooksRun = hooks.length;
        if (hooks.length === 0) await progress?.report("No project hooks configured; activating project…", 0.45);
        const hookFailure = await runProjectHooks(project, hooks, this.processes, progress);
        if (hookFailure !== undefined) return hookFailure;
        if (this.projectBindings.length === 0) await progress?.report("No downstream project bindings; activating project…", 0.75);
        bindings = await this.serializeDownstream(async () => await projectBindingResults(project.path, this.projectBindings, this.invokeBinding, progress));
        warnings = bindings.filter((binding) =>
          typeof binding === "object" && binding !== null && !Array.isArray(binding) && binding.status === "error").length;
      }
    } catch (error) {
      if (this.leases !== undefined && candidateGeneration !== undefined) {
        await (candidateCommitted
          ? this.leases.release(session, candidateGeneration)
          : this.leases.abort(session, candidateGeneration)).catch(() => undefined);
      }
      if (project.kind === "temporary" && this.activeProjects.get(session)?.path !== project.path) {
        await rm(project.path, { recursive: true, force: true });
      }
      if (error instanceof Error && error.message === "COMMAND_STOP_UNCONFIRMED") {
        const snapshot = errorSnapshot(error);
        return failure(
          "project.open",
          "PROJECT_HOOK_FAILED",
          "A configured project-open hook left process-group cleanup unconfirmed.",
          snapshot === undefined ? null : processData(snapshot),
        );
      }
      return leaseFailure("project.open", error);
    }
    candidateGeneration = undefined;
    this.activeProjects.set(session, project);
    if (project.kind === "temporary") this.temporaryProjects.add(project.path);
    await progress?.report(`Project ${basename(project.path)} is active`, 0.95);
    return success(
      "project.open",
      { path: project.path, kind: project.kind, mode: project.mode, generation: project.generation ?? null, hooksRun, bindings, bindingWarnings: warnings, previousRelease },
      `active=${project.path} kind=${project.kind} mode=${project.mode}${bindings.length === 0 ? "" : ` bindings=${bindings.length - warnings}/${bindings.length}`}`,
    );
  }

  currentProject(session = "runtime"): ToolCallResult {
    const activeProject = this.activeProjects.get(session);
    return success(
      "project.current",
      {
        path: activeProject?.path ?? null,
        kind: activeProject?.kind ?? null,
        mode: activeProject?.mode ?? null,
        generation: activeProject?.generation ?? null,
      },
      activeProject === undefined ? "no active project" : `active=${activeProject.path} kind=${activeProject.kind} mode=${activeProject.mode}`,
    );
  }

  private async retainForegroundOperation(
    session: string,
    generation: string,
    operation: string,
    error: unknown,
    releaseAfterExit: boolean,
  ): Promise<boolean> {
    const snapshot = errorSnapshot(error);
    if (!(error instanceof Error) || error.message !== "COMMAND_STOP_UNCONFIRMED" || snapshot?.pid === null || snapshot?.pid === undefined || this.leases === undefined) return false;
    const pin = { session, generation, operation, phase: "operation" as "operation" | "background" | "idle", releaseAfterExit };
    this.foregroundPins.set(snapshot.pid, pin);
    await this.leases.complete(session, generation, operation, [snapshot.pid]).then(() => {
      pin.phase = "background";
    }).catch(() => undefined);
    return true;
  }

  private async withOperation<T>(
    session: string,
    project: ActiveProject,
    write: boolean,
    action: () => Promise<T>,
    releaseAfterUnconfirmed = false,
  ): Promise<T> {
    if (this.leases === undefined || project.generation === undefined) return await action();
    const operation = await this.leases.access(session, project.generation, write);
    let retained = false;
    try { return await action(); }
    catch (error) {
      retained = await this.retainForegroundOperation(session, project.generation, operation, error, releaseAfterUnconfirmed);
      throw error;
    } finally {
      if (!retained) await this.leases.complete(session, project.generation, operation);
    }
  }

  private async clearBackgroundPin(snapshot: ProcessSnapshot): Promise<void> {
    const pin = this.backgroundPin;
    if (pin === undefined || snapshot.state === "running" || snapshot.pid !== pin.pid || this.leases === undefined) return;
    if (this.backgroundCleanup !== undefined) return await this.backgroundCleanup;
    const cleanup = this.leases.backgroundExited(pin.session, pin.generation, pin.operation, pin.pid);
    this.backgroundCleanup = cleanup;
    try {
      await cleanup;
      if (this.backgroundPin === pin) this.backgroundPin = undefined;
    } finally {
      if (this.backgroundCleanup === cleanup) this.backgroundCleanup = undefined;
    }
  }

  private async clearForegroundPins(snapshots: ProcessSnapshot[]): Promise<void> {
    if (this.leases === undefined) return;
    for (const foreground of snapshots) {
      if (foreground.state === "running" || foreground.pid === null) continue;
      const pin = this.foregroundPins.get(foreground.pid);
      if (pin === undefined) continue;
      if (pin.phase === "background") {
        await this.leases.backgroundExited(pin.session, pin.generation, pin.operation, foreground.pid);
        pin.phase = "idle";
      } else if (pin.phase === "operation") {
        await this.leases.complete(pin.session, pin.generation, pin.operation);
        pin.phase = "idle";
      }
      if (pin.releaseAfterExit) await this.leases.release(pin.session, pin.generation);
      this.foregroundPins.delete(foreground.pid);
    }
  }

  private async claimBackground(session: string): Promise<number | ToolCallResult> {
    return await this.serializeBackground(async () => {
      if (this.closing) return failure("dev.run", "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
      const snapshot = this.processes.poll();
      const ownership = this.backgroundOwnership;
      if (snapshot.state === "running") {
        return failure("dev.run", ownership?.session === session ? "BACKGROUND_BUSY" : "BACKGROUND_NOT_OWNED", ownership?.session === session
          ? "Only one background process may run at a time."
          : "The tracked background process belongs to another authenticated session.");
      }
      if (ownership?.starting === true) {
        return failure("dev.run", "BACKGROUND_BUSY", "A background start is already in progress.");
      }
      if (snapshot.state === "exited") {
        try { await this.clearBackgroundPin(snapshot); }
        catch (error) { return leaseFailure("dev.run", error); }
        if (this.backgroundPin !== undefined) return failure("dev.run", "BACKGROUND_CLEANUP_PENDING", "The previous background operation has not completed durable cleanup.");
        this.processes.discardBackground(snapshot.pid);
        this.backgroundOwnership = undefined;
      } else if (ownership !== undefined) {
        return failure("dev.run", "BACKGROUND_BUSY", "A background transition is already in progress.");
      }
      if (this.closing) return failure("dev.run", "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
      const token = ++this.backgroundSequence;
      let settle: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      this.backgroundOwnership = { session, token, starting: true, settled, settle };
      return token;
    });
  }

  async guarded(
    session: string,
    tool: string,
    write: boolean,
    action: () => Promise<ToolCallResult>,
  ): Promise<ToolCallResult> {
    if (this.closing) return failure(tool, "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
    const project = this.activeProjects.get(session);
    if (project === undefined) return failure(tool, "NO_ACTIVE_PROJECT", "Resolve a project before using this tool.");
    const finish = this.trackRuntimeTask();
    try {
      try { return await this.withOperation(session, project, write, action); }
      catch (error) {
        if (error instanceof LeaseError && error.code === "PROJECT_BINDING_REVOKED" && this.activeProjects.get(session)?.generation === project.generation) {
          this.activeProjects.delete(session);
        }
        return leaseFailure(tool, error);
      }
    } finally { finish(); }
  }

  async readProject(path: string, session = "runtime"): Promise<ToolCallResult> {
    return await this.guarded(session, "project.read", false, async () => {
      const project = this.activeProjects.get(session) as ActiveProject;
      try {
        const candidate = await projectEntry(project.path, path);
        const info = await stat(candidate);
        if (!info.isFile() || info.size > 1_048_576) return failure("project.read", "PROJECT_FILE_UNREADABLE", "The project file is not a readable bounded regular file.");
        const text = await readFile(candidate, "utf8");
        return success("project.read", { path, text }, `${text.length} characters`);
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "PROJECT_FILE_UNREADABLE";
        return failure("project.read", code, "The requested project file could not be read.");
      }
    });
  }

  async listProject(path = ".", session = "runtime"): Promise<ToolCallResult> {
    return await this.guarded(session, "project.files", false, async () => {
      const project = this.activeProjects.get(session) as ActiveProject;
      try {
        const candidate = await projectEntry(project.path, path);
        const entries = (await readdir(candidate, { withFileTypes: true }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 500)
          .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
        return success("project.files", { path, entries }, `${entries.length} entries`);
      } catch {
        return failure("project.files", "PROJECT_DIRECTORY_UNREADABLE", "The requested project directory could not be read.");
      }
    });
  }

  async releaseProject(generation: string, session = "runtime"): Promise<ToolCallResult> {
    if (this.closing) return failure("project.release", "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
    const finish = this.trackRuntimeTask();
    try {
      return await this.serializeProject(session, async () => {
        if (this.leases === undefined) return failure("project.release", "LEASES_UNAVAILABLE", "Project leasing is not configured.");
        const project = this.activeProjects.get(session);
        if (project === undefined) return failure("project.release", "NO_ACTIVE_PROJECT", "The authenticated session has no active project lease.");
        if (project.generation !== generation) {
          return failure("project.release", "LEASE_GENERATION_MISMATCH", "The supplied generation does not match the authenticated session's active lease.", {
            expected: project.generation ?? null,
            actual: generation,
          });
        }
        try {
          const released = await this.leases.release(session, generation);
          if (this.activeProjects.get(session)?.generation === generation) this.activeProjects.delete(session);
          return success("project.release", released as unknown as JsonValue, `relinquished generation=${generation}`);
        } catch (error) { return leaseFailure("project.release", error); }
      });
    } finally { finish(); }
  }

  async forceReleaseProject(path: string, generation: string, reason: string, session = "runtime"): Promise<ToolCallResult> {
    if (this.closing) return failure("project.forceRelease", "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
    if (this.leases === undefined) return failure("project.forceRelease", "LEASES_UNAVAILABLE", "Project leasing is not configured.");
    const finish = this.trackRuntimeTask();
    try {
      try {
        const released = await this.leases.forceRelease(session, path, generation, reason);
        for (const [owner, project] of this.activeProjects) {
          if (project.generation === generation) this.activeProjects.delete(owner);
        }
        return success("project.forceRelease", released as unknown as JsonValue, `relinquished generation=${generation}`);
      } catch (error) { return leaseFailure("project.forceRelease", error); }
    } finally { finish(); }
  }

  async handoffProject(id: string): Promise<ToolCallResult> {
    if (this.closing) return failure("project.handoff", "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
    if (this.leases === undefined) return failure("project.handoff", "LEASES_UNAVAILABLE", "Project leasing is not configured.");
    const finish = this.trackRuntimeTask();
    try {
      try {
        const handoff = await this.leases.handoff(id);
        return success("project.handoff", handoff as unknown as JsonValue, handoff.released ? "independent acquisition verified" : "independent acquisition pending");
      } catch (error) { return leaseFailure("project.handoff", error); }
    } finally { finish(); }
  }

  async run(
    argv: string[],
    background: boolean,
    timeoutMs?: number,
    cwd?: string,
    allowNonZero = false,
    progress?: ToolProgress,
    session = "runtime",
  ): Promise<ToolCallResult> {
    if (this.closing) return failure("dev.run", "RUNTIME_CLOSING", "The runtime is closing and cannot start new work.");
    const activeProject = this.activeProjects.get(session);
    if (activeProject === undefined) return failure("dev.run", "NO_ACTIVE_PROJECT", "Resolve a project before running a command.");
    let backgroundToken: number | undefined;
    if (background) {
      const claimed = await this.claimBackground(session);
      if (typeof claimed !== "number") return claimed;
      backgroundToken = claimed;
    }
    const finish = this.trackRuntimeTask();
    const label = commandLabel(argv);
    const stopHeartbeat = background ? () => undefined : commandHeartbeat(progress, label);
    let operation: string | undefined;
    let backgroundRetained = false;
    let unconfirmedForeground: ProcessSnapshot | undefined;
    try {
      await progress?.report(background ? `Starting ${label} in the background…` : `Running ${label}…`, 0.1);
      if (this.leases !== undefined && activeProject.generation !== undefined) {
        operation = await this.leases.access(session, activeProject.generation, true);
      }
      const resolvedCwd = await commandCwd(activeProject.path, cwd);
      if (this.closing) throw new Error("RUNTIME_CLOSING");
      const result = await this.processes.run(argv, resolvedCwd, background, timeoutMs);
      if (background && operation !== undefined && this.leases !== undefined && activeProject.generation !== undefined) {
        if (result.pid === null) throw new LeaseError("INVALID_BACKGROUND_IDENTITY");
        await this.leases.complete(session, activeProject.generation, operation, [result.pid]);
        this.backgroundPin = { session, generation: activeProject.generation, operation, pid: result.pid };
        operation = undefined;
        const exited = this.processes.backgroundExit();
        if (exited !== undefined) void exited.then((snapshot) => this.clearBackgroundPin(snapshot)).catch(() => undefined);
      }
      if (background) backgroundRetained = true;
      if (!background && result.exitCode !== 0 && !allowNonZero) {
        await progress?.report(`${label} exited with status ${result.exitCode}`, 0.9);
        return failure("dev.run", "COMMAND_EXIT_NONZERO", `Command exited with status ${result.exitCode}.`, processData(result));
      }
      await progress?.report(
        background ? `Started ${label} as process ${result.pid}` : `Finished ${label} with exit code ${result.exitCode}`,
        0.9,
      );
      return success("dev.run", processData(result), background ? `started pid=${result.pid}` : `exit=${result.exitCode}`);
    } catch (error) {
      if (error instanceof LeaseError) return leaseFailure("dev.run", error);
      const code = error instanceof Error ? error.message : "COMMAND_FAILED";
      const snapshot = errorSnapshot(error);
      if (code === "COMMAND_STOP_UNCONFIRMED") unconfirmedForeground = snapshot;
      if (code === "COMMAND_TIMEOUT") {
        await progress?.report(`${label} timed out and was stopped`, 0.9);
        return failure(
          "dev.run",
          code,
          "Command exceeded the bounded timeout and was stopped.",
          snapshot === undefined ? null : processData(snapshot),
        );
      }
      if (code === "OPERATION_CANCELLED" || code === "COMMAND_STOP_UNCONFIRMED") {
        return failure("dev.run", code, code === "OPERATION_CANCELLED" ? "Command was cancelled." : "Termination could not be confirmed; inspect local process controls.", snapshot === undefined ? null : processData(snapshot));
      }
      if (code === "STEERING_PENDING") return failure("dev.run", code, "New local user steering must be acknowledged before starting another command.");
      if (code === "RUNTIME_CLOSING") return failure("dev.run", code, "The runtime is closing and cannot start new work.");
      if (code === "BACKGROUND_BUSY") return failure("dev.run", code, "Only one background process may run at a time.");
      if (code === "INVALID_ARGV") return failure("dev.run", code, "argv must contain a command and non-empty arguments.");
      if (code === "INVALID_SHELL") return failure("dev.run", code, "Shell evaluation flags are not allowed; pass the executable and arguments directly.");
      if (code === "INVALID_CWD") return failure("dev.run", code, "cwd must be an existing relative directory inside the active project.");
      await progress?.report(`${label} could not be started`, 0.9);
      return failure("dev.run", "COMMAND_FAILED", "Command could not be started.");
    } finally {
      const ownership = backgroundToken === undefined ? undefined : this.backgroundOwnership;
      const ownsBackground = ownership?.token === backgroundToken;
      const abandoned = ownsBackground && !backgroundRetained
        ? await this.processes.stop().catch(() => this.processes.poll())
        : undefined;
      if (abandoned?.state === "running" && operation !== undefined && this.leases !== undefined && activeProject.generation !== undefined && abandoned.pid !== null) {
        const generation = activeProject.generation;
        const retainedOperation = operation;
        const pid = abandoned.pid;
        await this.leases.complete(session, generation, retainedOperation, [pid]).then(() => {
          this.backgroundPin = { session, generation, operation: retainedOperation, pid };
          operation = undefined;
          backgroundRetained = true;
        }).catch(() => undefined);
      }
      if (unconfirmedForeground?.pid !== null && unconfirmedForeground?.pid !== undefined && operation !== undefined && this.leases !== undefined && activeProject.generation !== undefined) {
        const pid = unconfirmedForeground.pid;
        const retainedOperation = operation;
        const pin = {
          session,
          generation: activeProject.generation,
          operation: retainedOperation,
          phase: "operation" as "operation" | "background" | "idle",
          releaseAfterExit: false,
        };
        this.foregroundPins.set(pid, pin);
        await this.leases.complete(session, pin.generation, retainedOperation, [pid]).then(() => {
          pin.phase = "background";
          operation = undefined;
        }).catch(() => undefined);
      }
      const foregroundRetained = unconfirmedForeground?.pid !== null
        && unconfirmedForeground?.pid !== undefined
        && this.foregroundPins.has(unconfirmedForeground.pid);
      if (!foregroundRetained && operation !== undefined && this.leases !== undefined && activeProject.generation !== undefined) {
        await this.leases.complete(session, activeProject.generation, operation).catch(() => undefined);
      }
      if (ownsBackground && ownership !== undefined) {
        ownership.starting = false;
        if (!backgroundRetained && abandoned !== undefined && abandoned.state !== "running") {
          this.processes.discardBackground(abandoned.pid);
          if (this.backgroundOwnership === ownership) this.backgroundOwnership = undefined;
        }
        ownership.settle();
      }
      finish();
      stopHeartbeat();
    }
  }

  async batch(
    steps: BatchStep[],
    stopOnError: boolean,
    progress?: ToolProgress,
    session = "runtime",
  ): Promise<ToolCallResult> {
    const results: JsonValue[] = [];
    let firstFailure: number | null = null;
    await progress?.report(`Preparing ${steps.length} command steps…`, 0.05);
    for (const [index, step] of steps.entries()) {
      currentActivity()?.signal.throwIfAborted();
      const label = commandLabel(step.argv);
      await progress?.report(
        `Step ${index + 1}/${steps.length}: ${label}`,
        0.1 + (index / steps.length) * 0.75,
      );
      const command = await this.run(
        step.argv,
        false,
        step.timeoutMs,
        step.cwd,
        step.allowNonZero === true,
        progress,
        session,
      );
      const structured = command.structuredContent;
      results.push({
        index,
        argv: step.argv,
        ok: structured.ok,
        data: structured.data,
        error: structured.error === null ? null : { code: structured.error.code, message: structured.error.message },
      });
      await progress?.report(
        structured.ok
          ? `Completed step ${index + 1}/${steps.length}: ${label}`
          : `Step ${index + 1}/${steps.length} failed: ${label}`,
        0.1 + ((index + 1) / steps.length) * 0.75,
      );
      if (!structured.ok && firstFailure === null) firstFailure = index;
      if (!structured.ok && stopOnError) break;
    }
    if (firstFailure !== null) {
      return failure(
        "dev.batch",
        "BATCH_STEP_FAILED",
        `Batch step ${firstFailure + 1} failed.`,
        { steps: results, failedStep: firstFailure },
      );
    }
    await progress?.report(`Completed all ${results.length} command steps`, 0.95);
    return success("dev.batch", { steps: results }, `${results.length} steps completed`);
  }

  async poll(waitMs = 0, session = "runtime"): Promise<ToolCallResult> {
    const ownership = this.backgroundOwnership;
    if (ownership !== undefined && ownership.session !== session) {
      return failure("dev.poll", "BACKGROUND_NOT_OWNED", "The tracked background process belongs to another authenticated session.");
    }
    if (ownership?.starting === true) {
      return failure("dev.poll", "BACKGROUND_STARTING", "The background process is still being registered.");
    }
    const result = waitMs > 0 ? await this.processes.wait(waitMs) : this.processes.poll();
    try { await this.clearBackgroundPin(result); }
    catch (error) { return leaseFailure("dev.poll", error); }
    return success("dev.poll", processData(result), `state=${result.state}`);
  }

  async stop(progress?: ToolProgress, session = "runtime"): Promise<ToolCallResult> {
    return await this.serializeBackground(async () => {
      const ownership = this.backgroundOwnership;
      if (ownership !== undefined && ownership.session !== session) {
        return failure("dev.stop", "BACKGROUND_NOT_OWNED", "The tracked background process belongs to another authenticated session.");
      }
      if (ownership?.starting === true) {
        return failure("dev.stop", "BACKGROUND_STARTING", "The background process is still being registered.");
      }
      await progress?.report("Sending the background process a stop signal…", 0.25);
      const result = await this.processes.stop();
      try { await this.clearBackgroundPin(result); }
      catch (error) { return leaseFailure("dev.stop", error); }
      if (result.state !== "running") {
        this.processes.discardBackground(result.pid);
        if (this.backgroundOwnership === ownership) this.backgroundOwnership = undefined;
      }
      await progress?.report(`Background process is ${result.state}`, 0.9);
      return success("dev.stop", processData(result), `state=${result.state}`);
    });
  }

  async diff(progress?: ToolProgress, session = "runtime"): Promise<ToolCallResult> {
    return await this.guarded(session, "dev.diff", false, async () => {
      const activeProject = this.activeProjects.get(session) as ActiveProject;
      await progress?.report("Reading Git working-tree changes…", 0.2);
      const baseline = await beginWorkingTreeDiff(activeProject.path);
      await progress?.report("Building the bounded project diff…", 0.6);
      const result = await finishDiff(baseline);
      await progress?.report(`Found ${result.summary.fileCount} changed files`, 0.9);
      return success(
        "dev.diff",
        { changes: result.summary } as unknown as JsonValue,
        `${result.summary.fileCount} changed files`,
        result.details === undefined ? undefined : { localDevDiff: result.details },
      );
    });
  }

  async close(): Promise<void> {
    if (this.closeTask !== undefined) return await this.closeTask;
    this.closing = true;
    const closeTask = this.serializeBackground(async () => {
      const ownership = this.backgroundOwnership;
      if (ownership?.starting === true) await ownership.settled;
      let processes = await this.processes.close();
      const background = processes.background;
      await this.clearBackgroundPin(background);
      if (background.state !== "running") {
        this.processes.discardBackground(background.pid);
        this.backgroundOwnership = undefined;
      }
      await this.clearForegroundPins(processes.foreground);
      await Promise.all([...this.runningTasks]);
      processes = await this.processes.close();
      await this.clearForegroundPins(processes.foreground);
      if (this.foregroundPins.size > 0) throw new Error("COMMAND_STOP_UNCONFIRMED");
      if (this.leases !== undefined) {
        for (const [session, project] of [...this.activeProjects]) {
          if (project.generation !== undefined) await this.leases.release(session, project.generation);
          if (this.activeProjects.get(session)?.generation === project.generation) this.activeProjects.delete(session);
        }
        await this.leases.close();
      }
      await Promise.all([...this.temporaryProjects].map((path) => rm(path, { recursive: true, force: true })));
      this.temporaryProjects.clear();
    });
    this.closeTask = closeTask;
    try { return await closeTask; }
    catch (error) {
      if (this.closeTask === closeTask) this.closeTask = undefined;
      throw error;
    }
  }
}
