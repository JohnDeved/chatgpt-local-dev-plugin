import { failure, success } from "../result.js";
import type { JsonValue, ToolCallResult } from "../types.js";
import { realpath } from "node:fs/promises";

import type { ProjectOpenHook } from "../config/types.js";
import { beginWorkingTreeDiff, finishDiff } from "./diff.js";
import { ProcessManager, type ProcessSnapshot } from "./process.js";
import { listProjects, resolveProject } from "./project.js";

function processData(snapshot: ProcessSnapshot): JsonValue {
  return { ...snapshot } as unknown as JsonValue;
}

export class CoreRuntime {
  private activeProject: string | null = null;
  private readonly processes = new ProcessManager();

  constructor(
    private readonly roots: string[],
    private readonly projectOpenHooks: ProjectOpenHook[],
  ) {}

  async openProject(query: string): Promise<ToolCallResult> {
    if (this.processes.hasRunningBackground()) {
      return failure("project.open", "BACKGROUND_RUNNING", "Stop the background process before switching projects.");
    }
    const matches = await resolveProject(query, this.roots);
    if (matches.length === 0) return failure("project.open", "PROJECT_NOT_FOUND", "No configured project matched the query.");
    if (matches.length > 1) return failure("project.open", "AMBIGUOUS_PROJECT", `Project query matched ${matches.length} configured directories.`);
    const project = matches[0] as string;
    const hooks: ProjectOpenHook[] = [];
    for (const hook of this.projectOpenHooks) {
      try {
        if (await realpath(hook.projectRoot) === project) hooks.push(hook);
      } catch {
        // A missing configured hook root cannot match the resolved project.
      }
    }
    for (const hook of hooks) {
      try {
        const hookResult = await this.processes.run(hook.argv, project, false);
        if (hookResult.exitCode !== 0) {
          return failure("project.open", "PROJECT_HOOK_FAILED", "A configured project-open hook exited unsuccessfully.");
        }
      } catch {
        return failure("project.open", "PROJECT_HOOK_FAILED", "A configured project-open hook could not be completed.");
      }
    }
    this.activeProject = project;
    return success("project.open", { path: this.activeProject, hooksRun: hooks.length }, `active=${this.activeProject}`);
  }

  currentProject(): ToolCallResult {
    return success("project.current", { path: this.activeProject }, this.activeProject === null ? "no active project" : `active=${this.activeProject}`);
  }

  async projects(): Promise<ToolCallResult> {
    const projects = await listProjects(this.roots);
    return success(
      "project.list",
      { activePath: this.activeProject, projects } as unknown as JsonValue,
      `${projects.length} projects`,
    );
  }

  async run(argv: string[], background: boolean, timeoutMs?: number): Promise<ToolCallResult> {
    if (this.activeProject === null) return failure("dev.run", "NO_ACTIVE_PROJECT", "Open a project before running a command.");
    try {
      const result = await this.processes.run(argv, this.activeProject, background, timeoutMs);
      return success("dev.run", processData(result), background ? `started pid=${result.pid}` : `exit=${result.exitCode}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "COMMAND_FAILED";
      if (code === "COMMAND_TIMEOUT") return failure("dev.run", code, "Command exceeded the bounded timeout and was stopped.");
      if (code === "BACKGROUND_BUSY") return failure("dev.run", code, "Only one background process may run at a time.");
      if (code === "INVALID_ARGV") return failure("dev.run", code, "argv must contain a command and non-empty arguments.");
      return failure("dev.run", "COMMAND_FAILED", "Command could not be started.");
    }
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
    if (this.activeProject === null) return failure("dev.diff", "NO_ACTIVE_PROJECT", "Open a project before viewing changes.");
    const result = await finishDiff(await beginWorkingTreeDiff(this.activeProject));
    return success(
      "dev.diff",
      { changes: result.summary } as unknown as JsonValue,
      `${result.summary.fileCount} changed files`,
      result.details === undefined ? undefined : { localDevDiff: result.details },
    );
  }

  async close(): Promise<void> {
    await this.processes.stop();
  }
}
