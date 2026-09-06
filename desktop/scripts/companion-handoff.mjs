import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

export function companionProcesses(table, bundle, uid) {
  const base = resolve(bundle);
  const executables = new Set(
    ["launcher", "bun", "LocalDevMenu"].map((name) => join(base, "Contents", "MacOS", name)),
  );
  return table.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const [, pid, parent, owner, state, executable] = match;
    if (Number(owner) !== uid || state.startsWith("Z") || !executables.has(executable)) return [];
    return [{ pid: Number(pid), parent: Number(parent), executable }];
  });
}

/** Update only the validated app's exact binaries, never its MCP backend or arbitrary descendants. */
export async function stopInstalledCompanion(bundle, dependencies = {}) {
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined)
    throw new Error("Companion replacement currently requires macOS process ownership.");
  const list =
    dependencies.list ??
    (async () => (await execute("/bin/ps", ["-axo", "pid=,ppid=,uid=,stat=,comm="])).stdout);
  const signal = dependencies.signal ?? ((pid, value) => process.kill(pid, value));
  const sleep = dependencies.sleep ?? delay;
  const initial = companionProcesses(await list(), bundle, uid);
  const targets = new Map(initial.map((item) => [item.pid, item.executable]));
  const remaining = async () =>
    companionProcesses(await list(), bundle, uid).filter(
      (item) => targets.get(item.pid) === item.executable,
    );
  for (const value of ["SIGTERM", "SIGKILL"]) {
    // Re-read identities before each signal round so a reused PID is not targeted.
    const active = await remaining();
    if (active.length === 0) break;
    for (const item of active.sort((a, b) => b.pid - a.pid)) {
      try {
        signal(item.pid, value);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    for (let check = 0; check < 20; check++) {
      if ((await remaining()).length === 0) break;
      await sleep(50);
    }
  }
  const alive = await remaining();
  if (alive.length)
    throw new Error(
      `Companion termination not confirmed for ${alive.map((item) => item.pid).join(", ")}. Installation was not changed.`,
    );
  // New app processes appearing during handoff are not silently killed or overwritten.
  if (companionProcesses(await list(), bundle, uid).length)
    throw new Error("Another companion instance started during installation. Close it and retry.");
  return initial.map((item) => item.pid);
}
