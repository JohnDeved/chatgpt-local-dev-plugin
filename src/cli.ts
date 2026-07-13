#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";

import { runServer } from "./server.js";
import { readSetupStatus, runSetup, setupPaths, uninstall, type SetupOptions } from "./setup/index.js";
import { openUrl } from "./setup/platform.js";

function help(): void {
  process.stdout.write(`Local Dev

Usage:
  local-dev setup [advanced options]
  local-dev status [--json]
  local-dev dashboard [--json]
  local-dev uninstall [--yes]

The no-argument form starts the stdio MCP server for tunnel-client.

Advanced setup options:
  --yes
  --project-root <absolute path>   repeatable
  --server <codex-id:alias>       repeatable
  --alias <runtime alias>
  --tunnel-id <tunnel_...>
  --runtime-key-ref <env:NAME|file:/absolute/path>
  --tunnel-client-bin <absolute path>
  --no-browser
  --no-service
`);
}

function value(args: string[], index: number, name: string): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) throw new Error(`MISSING_VALUE:${name}`);
  return next;
}

function setupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--yes") options.yes = true;
    else if (argument === "--no-browser") options.openBrowser = false;
    else if (argument === "--no-service") options.installService = false;
    else if (argument === "--project-root") {
      options.projectRoots ??= [];
      options.projectRoots.push(value(args, index, argument));
      index += 1;
    } else if (argument === "--server") {
      const selection = value(args, index, argument);
      const separator = selection.lastIndexOf(":");
      if (separator <= 0 || separator === selection.length - 1) throw new Error("INVALID_SERVER_SELECTION");
      options.selectedServers ??= [];
      options.selectedServers.push({ id: selection.slice(0, separator), alias: selection.slice(separator + 1) });
      index += 1;
    } else if (["--alias", "--tunnel-id", "--runtime-key-ref", "--tunnel-client-bin"].includes(argument)) {
      const next = value(args, index, argument);
      if (argument === "--alias") options.alias = next;
      else if (argument === "--tunnel-id") options.tunnelId = next;
      else if (argument === "--runtime-key-ref") options.runtimeKeyRef = next;
      else options.tunnelClientBin = next;
      index += 1;
    } else {
      throw new Error(`UNKNOWN_OPTION:${argument}`);
    }
  }
  return options;
}

function message(error: unknown): string {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const messages: Record<string, string> = {
    SETUP_CANCELLED: "Setup cancelled; no configuration was changed.",
    TUNNEL_CLIENT_REQUIRED: "tunnel-client is required. Rerun setup and approve its verified installation.",
    TUNNEL_CONNECT_FAILED: "The tunnel could not connect. Check the tunnel id and runtime key reference, then rerun setup.",
    TUNNEL_NOT_READY: "The tunnel started but is not healthy and ready. Run local-dev status for the current repair action.",
    INVALID_TUNNEL_CONFIGURATION: "Use a tunnel_... id and an env:NAME or file:/absolute/path runtime key reference.",
    UNSUPPORTED_PLATFORM: "This release supports macOS only; no service changes were applied.",
    PROJECT_ROOT_NOT_FOUND: "A selected project root does not exist.",
    PROJECT_ROOT_NOT_ABSOLUTE: "Project roots must be absolute paths.",
    DASHBOARD_UNAVAILABLE: "The dashboard is unavailable. Confirm the tunnel runtime is running, then retry.",
  };
  if (code.startsWith("UNKNOWN_OPTION:") || code.startsWith("MISSING_VALUE:")) return `Invalid command: ${code.replace(":", " ")}`;
  return messages[code] ?? "Local Dev could not complete the operation. No credential values or raw stack traces were printed.";
}

async function dashboardUrl(): Promise<string> {
  const source = await readFile(setupPaths().dashboardUrl, "utf8").catch(() => { throw new Error("DASHBOARD_UNAVAILABLE"); });
  let url: URL;
  try {
    url = new URL(source.trim());
  } catch {
    throw new Error("DASHBOARD_UNAVAILABLE");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^\/[a-f0-9]{48}\/$/u.test(url.pathname)) {
    throw new Error("DASHBOARD_UNAVAILABLE");
  }
  const response = await fetch(new URL("api/calls", url), { signal: AbortSignal.timeout(2_000) })
    .catch(() => { throw new Error("DASHBOARD_UNAVAILABLE"); });
  if (!response.ok) throw new Error("DASHBOARD_UNAVAILABLE");
  return url.toString();
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    await runServer();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    help();
    return;
  }
  if (command === "setup") {
    const options = setupOptions(args);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const prompter = {
        ask: async (question: string, defaultValue?: string) => {
          const suffix = defaultValue === undefined ? " " : ` [${defaultValue}] `;
          const answer = (await terminal.question(`${question}${suffix}`)).trim();
          return answer || defaultValue || "";
        },
        confirm: async (question: string) => (await terminal.question(`${question} [y/N] `)).trim().toLowerCase() === "y",
      };
      await runSetup(options, prompter, { line: (line) => process.stdout.write(`${line}\n`) });
    } finally {
      terminal.close();
    }
    return;
  }
  if (command === "status") {
    if (args.some((argument) => argument !== "--json")) throw new Error("UNKNOWN_OPTION");
    const status = await readSetupStatus();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else {
      process.stdout.write(`Configuration: ${status.configured ? "ready" : "missing"}\n`);
      process.stdout.write(`Login service: ${status.serviceInstalled ? "installed" : "missing"}\n`);
      process.stdout.write(`Tunnel runtime: ${status.runtime?.runtime_state ?? "unavailable"}\n`);
      process.stdout.write(`Control-plane polling: ${status.runtime?.control_plane_poll_health?.state ?? "unknown"}\n`);
      for (const fix of status.fixes) process.stdout.write(`Fix: ${fix}\n`);
      if (status.ready) process.stdout.write("Local Dev is ready\n");
    }
    if (!status.ready) process.exitCode = 1;
    return;
  }
  if (command === "dashboard") {
    if (args.some((argument) => argument !== "--json")) throw new Error("UNKNOWN_OPTION");
    const url = await dashboardUrl();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ url })}\n`);
    else {
      await openUrl(url);
      process.stdout.write("Local Dev dashboard opened in your browser.\n");
    }
    return;
  }
  if (command === "uninstall") {
    if (args.some((argument) => argument !== "--yes")) throw new Error("UNKNOWN_OPTION");
    let confirmed = args.includes("--yes");
    if (!confirmed) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        confirmed = (await terminal.question("Remove the Local Dev service and state? Shared Codex MCP entries will remain. [y/N] ")).trim().toLowerCase() === "y";
      } finally {
        terminal.close();
      }
    }
    if (!confirmed) throw new Error("SETUP_CANCELLED");
    await uninstall();
    process.stdout.write("Local Dev service and state removed. Shared Codex MCP entries were not changed.\n");
    return;
  }
  throw new Error(`UNKNOWN_OPTION:${command}`);
}

main().catch((error) => {
  process.stderr.write(`local-dev: ${message(error)}\n`);
  process.exitCode = 1;
});
