import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ProjectBinding, ProjectOpenHook } from "../config/types.js";
import { isPathInside } from "../path.js";
import { failure, success } from "../result.js";
import type { JsonObject, JsonValue, ToolCallResult } from "../types.js";
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
}

type ProjectBindingInvoker = (
  exposedToolName: string,
  arguments_: Record<string, unknown>,
) => Promise<CallToolResult | undefined>;

function processData(snapshot: ProcessSnapshot): JsonValue {
  return { ...snapshot } as unknown as JsonValue;
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

function resultFailure(result: CallToolResult): { failed: boolean; message?: string } {
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
  | { target: ActiveProject; error?: never }
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
): Promise<ToolCallResult | undefined> {
  for (const hook of hooks) {
    try {
      const result = await processes.run(hook.argv, project.path, false);
      if (result.exitCode === 0) continue;
      if (project.kind === "temporary") await rm(project.path, { recursive: true, force: true });
      return failure("project.open", "PROJECT_HOOK_FAILED", "A configured project-open hook exited unsuccessfully.", processData(result));
    } catch (error) {
      if (project.kind === "temporary") await rm(project.path, { recursive: true, force: true });
      const snapshot = errorSnapshot(error);
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
  for (const binding of bindings) {
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

export class CoreRuntime {
  private activeProject: ActiveProject | null = null;
  private readonly processes = new ProcessManager();
  private readonly temporaryProjects = new Set<string>();

  constructor(
    private readonly roots: string[],
    private readonly projectOpenHooks: ProjectOpenHook[],
    private readonly projectBindings: ProjectBinding[] = [],
    private readonly invokeBinding?: ProjectBindingInvoker,
  ) {}

  async openProject(query: string, onMissing: MissingProjectAction = "error"): Promise<ToolCallResult> {
    if (this.processes.hasRunningBackground()) {
      return failure("project.open", "BACKGROUND_RUNNING", "Stop the background process before switching projects.");
    }
    const resolved = await resolveProjectTarget(query, onMissing, this.roots);
    if (resolved.error !== undefined) return resolved.error;
    const project = resolved.target;
    const hooks = await matchingHooks(project.path, this.projectOpenHooks);
    const hookFailure = await runProjectHooks(project, hooks, this.processes);
    if (hookFailure !== undefined) return hookFailure;

    const bindings = await projectBindingResults(project.path, this.projectBindings, this.invokeBinding);
    const warnings = bindings.filter((binding) =>
      typeof binding === "object" && binding !== null && !Array.isArray(binding) && binding.status === "error").length;
    this.activeProject = project;
    if (project.kind === "temporary") this.temporaryProjects.add(project.path);
    return success(
      "project.open",
      { path: project.path, kind: project.kind, hooksRun: hooks.length, bindings, bindingWarnings: warnings },
      `active=${project.path} kind=${project.kind}${bindings.length === 0 ? "" : ` bindings=${bindings.length - warnings}/${bindings.length}`}`,
    );
  }

  currentProject(): ToolCallResult {
    return success(
      "project.current",
      { path: this.activeProject?.path ?? null, kind: this.activeProject?.kind ?? null },
      this.activeProject === null ? "no active project" : `active=${this.activeProject.path} kind=${this.activeProject.kind}`,
    );
  }

  async run(
    argv: string[],
    background: boolean,
    timeoutMs?: number,
    cwd?: string,
    allowNonZero = false,
  ): Promise<ToolCallResult> {
    if (this.activeProject === null) return failure("dev.run", "NO_ACTIVE_PROJECT", "Resolve a project before running a command.");
    try {
      const resolvedCwd = await commandCwd(this.activeProject.path, cwd);
      const result = await this.processes.run(argv, resolvedCwd, background, timeoutMs);
      if (!background && result.exitCode !== 0 && !allowNonZero) {
        return failure("dev.run", "COMMAND_EXIT_NONZERO", `Command exited with status ${result.exitCode}.`, processData(result));
      }
      return success("dev.run", processData(result), background ? `started pid=${result.pid}` : `exit=${result.exitCode}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "COMMAND_FAILED";
      const snapshot = errorSnapshot(error);
      if (code === "COMMAND_TIMEOUT") {
        return failure(
          "dev.run",
          code,
          "Command exceeded the bounded timeout and was stopped.",
          snapshot === undefined ? null : processData(snapshot),
        );
      }
      if (code === "BACKGROUND_BUSY") return failure("dev.run", code, "Only one background process may run at a time.");
      if (code === "INVALID_ARGV") return failure("dev.run", code, "argv must contain a command and non-empty arguments.");
      if (code === "INVALID_SHELL") return failure("dev.run", code, "Shell evaluation flags are not allowed; pass the executable and arguments directly.");
      if (code === "INVALID_CWD") return failure("dev.run", code, "cwd must be an existing relative directory inside the active project.");
      return failure("dev.run", "COMMAND_FAILED", "Command could not be started.");
    }
  }

  async batch(steps: BatchStep[], stopOnError: boolean): Promise<ToolCallResult> {
    const results: JsonValue[] = [];
    let firstFailure: number | null = null;
    for (const [index, step] of steps.entries()) {
      const command = await this.run(step.argv, false, step.timeoutMs, step.cwd, step.allowNonZero === true);
      const structured = command.structuredContent;
      results.push({
        index,
        argv: step.argv,
        ok: structured.ok,
        data: structured.data,
        error: structured.error === null ? null : { code: structured.error.code, message: structured.error.message },
      });
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
    return success("dev.batch", { steps: results }, `${results.length} steps completed`);
  }

  async poll(): Promise<ToolCallResult> {
    const result = await this.processes.poll();
    return success("dev.poll", processData(result), `state=${result.state}`);
  }

  async stop(): Promise<ToolCallResult> {
    const result = await this.processes.stop();
    return success("dev.stop", processData(result), `state=${result.state}`);
  }

  async diff(): Promise<ToolCallResult> {
    if (this.activeProject === null) return failure("dev.diff", "NO_ACTIVE_PROJECT", "Resolve a project before viewing changes.");
    const result = await finishDiff(await beginWorkingTreeDiff(this.activeProject.path));
    return success(
      "dev.diff",
      { changes: result.summary } as unknown as JsonValue,
      `${result.summary.fileCount} changed files`,
      result.details === undefined ? undefined : { localDevDiff: result.details },
    );
  }

  async close(): Promise<void> {
    await this.processes.stop();
    await Promise.allSettled([...this.temporaryProjects].map((path) => rm(path, { recursive: true, force: true })));
    this.temporaryProjects.clear();
  }
}
