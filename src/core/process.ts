import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { currentActivity } from "../activity.js";
import { spawnCommand, terminateCommand, type SpawnedCommand } from "./command.js";

const MAX_OUTPUT_CHARS = 65_536;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOOPBACK_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?/giu;

export interface ProcessSnapshot {
  state: "idle" | "running" | "exited";
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  argv: string[];
  cwd: string | null;
  background: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  outputTail: string;
  truncated: boolean;
  urls: string[];
}

interface TrackedProcess {
  child: SpawnedCommand;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  argv: string[];
  cwd: string;
  background: boolean;
  startedAt: string;
  finishedAt: string | null;
  exited: Promise<void>;
  started: Promise<boolean>;
  spawnError: boolean;
}

function append(tracked: TrackedProcess, text: string): void {
  tracked.output += text;
  if (tracked.output.length > MAX_OUTPUT_CHARS) {
    tracked.output = tracked.output.slice(-MAX_OUTPUT_CHARS);
    tracked.truncated = true;
  }
}

function snapshot(tracked: TrackedProcess | undefined): ProcessSnapshot {
  if (tracked === undefined) {
    return { state: "idle", pid: null, exitCode: null, signal: null, argv: [], cwd: null, background: false, startedAt: null, finishedAt: null, outputTail: "", truncated: false, urls: [] };
  }
  return {
    state: tracked.finishedAt === null ? "running" : "exited",
    pid: tracked.child.pid ?? null, exitCode: tracked.exitCode, signal: tracked.signal,
    argv: [...tracked.argv], cwd: tracked.cwd, background: tracked.background,
    startedAt: tracked.startedAt, finishedAt: tracked.finishedAt,
    outputTail: tracked.output, truncated: tracked.truncated,
    urls: [...new Set(tracked.output.match(LOOPBACK_URL) ?? [])].slice(0, 16),
  };
}

function start(argv: string[], cwd: string, background: boolean): TrackedProcess {
  const child = spawnCommand(argv, cwd);
  let resolveExit: () => void = () => undefined;
  let resolveStarted: (started: boolean) => void = () => undefined;
  const tracked: TrackedProcess = {
    child, output: "", truncated: false, exitCode: null, signal: null, argv: [...argv], cwd, background,
    startedAt: new Date().toISOString(), finishedAt: null,
    exited: new Promise((resolve) => { resolveExit = resolve; }),
    started: new Promise((resolve) => { resolveStarted = resolve; }), spawnError: false,
  };
  for (const pipe of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    pipe.on("data", (chunk: Buffer) => append(tracked, decoder.write(chunk)));
    pipe.on("end", () => append(tracked, decoder.end()));
  }
  child.on("error", (error) => {
    tracked.spawnError = true;
    append(tracked, `Process failed to start: ${error.message}\n`);
    resolveStarted(false);
  });
  child.on("spawn", () => resolveStarted(true));
  child.on("close", (code, signal) => {
    tracked.exitCode = code; tracked.signal = signal;
    tracked.finishedAt = new Date().toISOString(); resolveExit();
  });
  return tracked;
}

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const SHELL_EVALUATION_FLAGS = new Set(["-c", "-lc", "/c", "-command", "-encodedcommand"]);
function validateArgv(argv: string[]): void {
  if (argv.length === 0 || argv.some((part) => part.length === 0)) throw new Error("INVALID_ARGV");
  if (SHELL_EXECUTABLES.has(basename(argv[0] as string).toLowerCase()) && argv.slice(1).some((part) => SHELL_EVALUATION_FLAGS.has(part.toLowerCase()))) throw new Error("INVALID_SHELL");
}

export class ProcessManager {
  private background: TrackedProcess | undefined;
  private readonly foreground = new Set<TrackedProcess>();

  hasRunningBackground(): boolean {
    return this.background !== undefined && snapshot(this.background).state === "running";
  }

  async run(argv: string[], cwd: string, background: boolean, timeoutMs?: number): Promise<ProcessSnapshot> {
    validateArgv(argv);
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    if (background) {
      if (this.hasRunningBackground()) throw new Error("BACKGROUND_BUSY");
      this.background = start(argv, cwd, true);
      if (!(await this.background.started)) {
        await this.background.exited;
        this.background = undefined;
        throw new Error("COMMAND_FAILED");
      }
      return snapshot(this.background);
    }
    const tracked = start(argv, cwd, false);
    this.foreground.add(tracked);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => undefined;
    try {
      if (!(await tracked.started)) { await tracked.exited; throw new Error("COMMAND_FAILED"); }
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS));
      });
      const cancelled = new Promise<"cancelled">((resolve) => {
        abort = () => resolve("cancelled");
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      const result = await Promise.race([tracked.exited.then(() => "exit" as const), timeout, cancelled]);
      if (result !== "exit" || signal?.aborted) {
        const confirmed = await terminateCommand(tracked.child);
        const code = !confirmed ? "COMMAND_STOP_UNCONFIRMED" : result === "timeout" ? "COMMAND_TIMEOUT" : "OPERATION_CANCELLED";
        throw Object.assign(new Error(code), { snapshot: snapshot(tracked) });
      }
      if (tracked.spawnError) throw new Error("COMMAND_FAILED");
      return snapshot(tracked);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (tracked.finishedAt !== null) this.foreground.delete(tracked);
    }
  }

  poll(): ProcessSnapshot { return snapshot(this.background); }

  async wait(waitMs: number): Promise<ProcessSnapshot> {
    const tracked = this.background;
    if (tracked === undefined || tracked.finishedAt !== null || waitMs <= 0) return snapshot(tracked);
    const signal = currentActivity()?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => undefined;
    try {
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(Math.max(waitMs, 1), MAX_TIMEOUT_MS));
      });
      const cancelled = new Promise<void>((resolve) => {
        abort = resolve;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      await Promise.race([tracked.exited, timeout, cancelled]);
      return snapshot(tracked);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async stop(): Promise<ProcessSnapshot> {
    const tracked = this.background;
    if (tracked === undefined) return snapshot(undefined);
    const confirmed = await terminateCommand(tracked.child);
    const result = snapshot(tracked);
    if (confirmed) this.background = undefined;
    return result;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.foreground].map((tracked) => terminateCommand(tracked.child)));
    await this.stop();
  }
}
