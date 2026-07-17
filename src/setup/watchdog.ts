import { setTimeout as delay } from "node:timers/promises";

import { runCommand, runJson } from "./command.js";
import { readOptional } from "./files.js";
import { setupPaths } from "./paths.js";
import { parseSetupState } from "./state.js";
import type { RuntimeStatus, SetupState } from "./types.js";

const CHECK_INTERVAL_MS = 30_000;
const WAKE_GAP_MS = 90_000;

interface WatchdogDependencies {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  command: typeof runCommand;
  json: typeof runJson;
}

const dependencies: WatchdogDependencies = {
  now: Date.now,
  sleep: async (milliseconds) => { await delay(milliseconds); },
  command: runCommand,
  json: runJson,
};

async function loadState(home: string): Promise<SetupState> {
  const source = await readOptional(setupPaths(home).state);
  if (source === undefined) throw new Error("WATCHDOG_STATE_MISSING");
  const state = parseSetupState(source);
  if (state === undefined) throw new Error("WATCHDOG_STATE_INVALID");
  return state;
}

function connectArguments(state: SetupState): string[] {
  return [
    "runtimes", "connect",
    "--alias", state.alias,
    "--tunnel-id", state.tunnelId,
    "--runtime-api-key", state.runtimeKeyRef,
    "--mcp-command", state.mcpCommand,
    "--json",
  ];
}

function ready(status: RuntimeStatus): boolean {
  return status.process_running === true && status.healthy === true && status.ready === true;
}

export function sleepGapDetected(previousCheck: number, currentCheck: number): boolean {
  return currentCheck - previousCheck > WAKE_GAP_MS;
}

export async function watchdogCycle(
  state: SetupState,
  forceRecycle: boolean,
  runner: Pick<WatchdogDependencies, "command" | "json"> = dependencies,
): Promise<"healthy" | "connected" | "recycled"> {
  const status = await runner.json(state.binaryPath, ["runtimes", "status", state.alias, "--json"])
    .then((value) => value as RuntimeStatus)
    .catch(() => undefined);
  if (!forceRecycle && status !== undefined && ready(status)) return "healthy";

  if (forceRecycle || status?.process_running === true) {
    await runner.command(state.binaryPath, ["runtimes", "stop", state.alias, "--json"]).catch(() => undefined);
  }
  const connected = await runner.command(state.binaryPath, connectArguments(state));
  if (connected.code !== 0) throw new Error("WATCHDOG_CONNECT_FAILED");
  return forceRecycle ? "recycled" : "connected";
}

export async function runWatchdog(home = setupPaths().home, runner: WatchdogDependencies = dependencies): Promise<never> {
  const state = await loadState(home);
  let previousCheck = runner.now();
  for (;;) {
    const currentCheck = runner.now();
    const result = await watchdogCycle(state, sleepGapDetected(previousCheck, currentCheck), runner);
    previousCheck = runner.now();
    if (result !== "healthy") process.stdout.write(`[watchdog] tunnel runtime ${result}\n`);
    await runner.sleep(CHECK_INTERVAL_MS);
  }
}
