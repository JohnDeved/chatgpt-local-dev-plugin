import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

import { activityFailure, currentActivity } from "../activity.js";

export type SpawnedCommand = ChildProcessWithoutNullStreams;
interface Lifecycle {
  closed: boolean;
  stop?: Promise<boolean>;
  finished: Promise<void>;
}
const lifecycles = new WeakMap<SpawnedCommand, Lifecycle>();

function groupAlive(child: SpawnedCommand): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch { return false; }
}

function signalOwned(child: SpawnedCommand, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Signals only the process group created by this module, never an arbitrary PID. */
export async function terminateCommand(child: SpawnedCommand): Promise<boolean> {
  const life = lifecycles.get(child);
  if (life === undefined) throw new Error("UNOWNED_PROCESS");
  if (life.stop !== undefined) return life.stop;
  life.stop = (async () => {
    signalOwned(child, "SIGTERM");
    const deadline = Date.now() + 1500;
    while (groupAlive(child) && Date.now() < deadline) await delay(50);
    if (groupAlive(child)) signalOwned(child, "SIGKILL");
    await Promise.race([life.finished, delay(1500)]);
    const groupDeadline = Date.now() + 1000;
    while (groupAlive(child) && Date.now() < groupDeadline) await delay(50);
    return life.closed && !groupAlive(child);
  })();
  return life.stop;
}

export function spawnCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnedCommand {
  if (argv.length === 0 || argv.some((part) => part.length === 0)) throw new Error("INVALID_ARGV");
  const current = currentActivity();
  current?.signal.throwIfAborted();
  current?.hub.runs.assertCanProceed(current.runId);
  const processId = randomUUID();
  const detail = { processId, argv: [...argv], cwd, environment: { ...env } };
  // Persist the exact execution request before starting it. The archive is local only.
  current?.hub.record("process.requested", detail, current.operationId);
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let finish: () => void = () => undefined;
  const life: Lifecycle = { closed: false, finished: new Promise<void>((resolve) => { finish = resolve; }) };
  lifecycles.set(child, life);
  let untrack: () => void = () => undefined;
  const emit = (type: string, data: unknown): void => {
    try { current?.hub.record(type, data, current.operationId, undefined, current.runId); }
    catch { void terminateCommand(child).catch(() => undefined); }
  };
  const stop = async (): Promise<boolean> => {
    emit("process.stopRequested", { processId, pid: child.pid });
    try {
      const confirmed = await terminateCommand(child);
      emit(confirmed ? "process.stopped" : "process.stopUnconfirmed", { processId, pid: child.pid });
      if (confirmed) untrack();
      return confirmed;
    } catch (error) {
      emit("process.stopUnconfirmed", { processId, error: activityFailure(error) });
      return false;
    }
  };
  child.once("spawn", () => {
    emit("process.started", { processId, pid: child.pid, argv, cwd });
    if (child.pid !== undefined && current !== undefined) {
      untrack = current.hub.trackProcess({ id: processId, operationId: current.operationId, pid: child.pid, argv: [...argv], cwd, startedAt: new Date().toISOString(), stop });
    }
    if (current?.signal.aborted) stop();
  });
  for (const [stream, pipe] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
    const decoder = new StringDecoder("utf8");
    pipe.on("data", (chunk: Buffer) => emit("process.output", {
      processId, stream, bytes: chunk.length, text: decoder.write(chunk), bytesBase64: chunk.toString("base64"),
    }));
    pipe.on("end", () => {
      const text = decoder.end();
      if (text) emit("process.output", { processId, stream, bytes: 0, text });
    });
  }
  child.once("error", (error) => emit("process.failedToStart", { processId, error: activityFailure(error) }));
  child.once("close", (exitCode, signal) => {
    life.closed = true;
    finish();
    current?.signal.removeEventListener("abort", stop);
    emit("process.exited", { processId, pid: child.pid, exitCode, signal, groupStillRunning: groupAlive(child) });
    if (!groupAlive(child)) untrack();
  });
  current?.signal.addEventListener("abort", stop, { once: true });
  if (current?.signal.aborted) stop();
  return child;
}
