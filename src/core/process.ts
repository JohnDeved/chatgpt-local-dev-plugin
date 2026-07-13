import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_OUTPUT_CHARS = 65_536;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOOPBACK_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?/giu;

export interface ProcessSnapshot {
  state: "idle" | "running" | "exited";
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  truncated: boolean;
  urls: string[];
}

interface TrackedProcess {
  child: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exited: Promise<void>;
  started: Promise<boolean>;
  spawnError: boolean;
}

function append(tracked: TrackedProcess, chunk: Buffer): void {
  tracked.output += chunk.toString("utf8");
  if (tracked.output.length > MAX_OUTPUT_CHARS) {
    tracked.output = tracked.output.slice(-MAX_OUTPUT_CHARS);
    tracked.truncated = true;
  }
}

function snapshot(tracked: TrackedProcess | undefined): ProcessSnapshot {
  if (tracked === undefined) {
    return { state: "idle", pid: null, exitCode: null, signal: null, outputTail: "", truncated: false, urls: [] };
  }
  return {
    state: tracked.exitCode === null && tracked.signal === null ? "running" : "exited",
    pid: tracked.child.pid ?? null,
    exitCode: tracked.exitCode,
    signal: tracked.signal,
    outputTail: tracked.output,
    truncated: tracked.truncated,
    urls: [...new Set(tracked.output.match(LOOPBACK_URL) ?? [])].slice(0, 16),
  };
}

function start(argv: string[], cwd: string): TrackedProcess {
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let resolveExit: () => void = () => undefined;
  let resolveStarted: (started: boolean) => void = () => undefined;
  const tracked: TrackedProcess = {
    child,
    output: "",
    truncated: false,
    exitCode: null,
    signal: null,
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
    started: new Promise((resolve) => {
      resolveStarted = resolve;
    }),
    spawnError: false,
  };
  child.stdout.on("data", (chunk: Buffer) => append(tracked, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(tracked, chunk));
  child.on("error", (error) => {
    tracked.spawnError = true;
    append(tracked, Buffer.from(`Process failed to start: ${error.message}\n`));
    resolveStarted(false);
  });
  child.on("spawn", () => resolveStarted(true));
  child.on("close", (code, signal) => {
    tracked.exitCode = code;
    tracked.signal = signal;
    resolveExit();
  });
  return tracked;
}

export class ProcessManager {
  private background: TrackedProcess | undefined;

  hasRunningBackground(): boolean {
    return this.background !== undefined && snapshot(this.background).state === "running";
  }

  async run(argv: string[], cwd: string, background: boolean, timeoutMs?: number): Promise<ProcessSnapshot> {
    if (argv.length === 0 || argv.some((part) => part.length === 0)) {
      throw new Error("INVALID_ARGV");
    }
    if (background) {
      if (this.hasRunningBackground()) throw new Error("BACKGROUND_BUSY");
      this.background = start(argv, cwd);
      if (!(await this.background.started)) {
        await this.background.exited;
        this.background = undefined;
        throw new Error("COMMAND_FAILED");
      }
      return snapshot(this.background);
    }
    const tracked = start(argv, cwd);
    if (!(await tracked.started)) {
      await tracked.exited;
      throw new Error("COMMAND_FAILED");
    }
    const boundedTimeout = Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundedTimeout);
    });
    const result = await Promise.race([tracked.exited.then(() => "exit" as const), timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "timeout") {
      tracked.child.kill("SIGTERM");
      await Promise.race([tracked.exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (tracked.exitCode === null && tracked.signal === null) tracked.child.kill("SIGKILL");
      throw Object.assign(new Error("COMMAND_TIMEOUT"), { snapshot: snapshot(tracked) });
    }
    if (tracked.spawnError) throw new Error("COMMAND_FAILED");
    return snapshot(tracked);
  }

  poll(): ProcessSnapshot {
    return snapshot(this.background);
  }

  async stop(): Promise<ProcessSnapshot> {
    const tracked = this.background;
    if (tracked === undefined) return snapshot(undefined);
    if (snapshot(tracked).state === "running") {
      tracked.child.kill("SIGTERM");
      await Promise.race([tracked.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (snapshot(tracked).state === "running") {
        tracked.child.kill("SIGKILL");
        await Promise.race([tracked.exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
    }
    const result = snapshot(tracked);
    this.background = undefined;
    return result;
  }
}
