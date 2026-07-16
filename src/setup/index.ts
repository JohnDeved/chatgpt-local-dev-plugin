import { constants } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseCodexConfig, parseLocalDevConfig } from "../config/parse.js";
import type { LocalDevConfig, McpServer, SelectedServer } from "../config/types.js";
import { runCommand, runJson } from "./command.js";
import { exists, readOptional, removeDirectory, restoreAtomic, writeAtomic } from "./files.js";
import { installTunnelClient } from "./install.js";
import { setupPaths } from "./paths.js";
import { installLaunchAgent, launchAgentLoaded, openUrl, removeLaunchAgent } from "./platform.js";
import { smokeServer } from "./smoke.js";
import type { RuntimeStatus, SetupOptions, SetupResult, SetupState } from "./types.js";

const TUNNEL_ID = /^tunnel_[A-Za-z0-9_-]+$/u;
const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/u;
const KEY_REFERENCE = /^(?:env:[A-Z_][A-Z0-9_]*|file:\/[^\n]+)$/u;
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const CHATGPT_URL = "https://chatgpt.com/#settings/Connectors";

export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface Reporter {
  line(message: string): void;
}

function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function mcpCommand(): { command: string; serverPath: string } {
  const serverPath = fileURLToPath(new URL("../server.js", import.meta.url));
  return { command: [process.execPath, serverPath].map(quoteArgument).join(" "), serverPath };
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findHints(directory: string, depth = 0): Promise<string[]> {
  if (depth > 7) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const hints: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === ".tunnel-client-bin") {
      const value = (await readOptional(path))?.trim();
      if (value !== undefined && isAbsolute(value)) hints.push(value);
    } else if (entry.isDirectory()) {
      hints.push(...(await findHints(path, depth + 1)));
    }
  }
  return hints;
}

async function readState(path: string): Promise<SetupState | undefined> {
  const source = await readOptional(path);
  if (source === undefined) return undefined;
  try {
    const state = JSON.parse(source) as Partial<SetupState>;
    if (state.version !== 1 || typeof state.alias !== "string" || typeof state.binaryPath !== "string" ||
      typeof state.tunnelId !== "string" || typeof state.runtimeKeyRef !== "string" || typeof state.mcpCommand !== "string") return undefined;
    return {
      version: 1,
      alias: state.alias,
      binaryPath: state.binaryPath,
      tunnelId: state.tunnelId,
      runtimeKeyRef: state.runtimeKeyRef,
      mcpCommand: state.mcpCommand,
      launchAgentPath: typeof state.launchAgentPath === "string" ? state.launchAgentPath : null,
      configuredAt: typeof state.configuredAt === "string" ? state.configuredAt : "unknown",
    };
  } catch {
    return undefined;
  }
}

async function selectBinary(home: string, options: SetupOptions, previous: SetupState | undefined, prompter: Prompter, reporter: Reporter): Promise<string> {
  const candidates = [
    options.tunnelClientBin,
    process.env.TUNNEL_CLIENT_BIN,
    previous?.binaryPath,
    ...(await findHints(join(home, ".codex", "plugins", "cache"))),
    join(home, ".local", "bin", "tunnel-client"),
    "/usr/local/bin/tunnel-client",
    "/opt/homebrew/bin/tunnel-client",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return await realpath(candidate);
  }
  reporter.line("[ ] tunnel-client is missing; setup can install the pinned public v0.0.10 release after checksum verification.");
  if (!options.yes && !(await prompter.confirm("Install tunnel-client v0.0.10 in ~/.local/bin?"))) throw new Error("TUNNEL_CLIENT_REQUIRED");
  return await installTunnelClient(home);
}

function recommendedServers(servers: McpServer[]): SelectedServer[] {
  const used = new Set<string>();
  const selections: SelectedServer[] = [];
  for (const server of servers) {
    if (server.enabledTools === undefined || server.enabledTools.length === 0) continue;
    if (server.transport === "http" && !server.independentlyUsable) continue;
    const base = server.id.toLowerCase().replace(/[^a-z0-9_-]/gu, "-").replace(/^[^a-z]+/u, "") || "mcp";
    let alias = base.slice(0, 64);
    let suffix = 2;
    while (used.has(alias)) alias = `${base.slice(0, 60)}-${suffix++}`;
    used.add(alias);
    selections.push({ id: server.id, alias });
  }
  return selections;
}

async function projectRoots(values: string[] | undefined, existing: LocalDevConfig | undefined, cwd: string): Promise<string[]> {
  const requested = values ?? (existing?.projectRoots.length ? existing.projectRoots : [cwd]);
  const roots: string[] = [];
  for (const value of requested) {
    if (!isAbsolute(value)) throw new Error("PROJECT_ROOT_NOT_ABSOLUTE");
    const root = await realpath(resolve(value)).catch(() => { throw new Error("PROJECT_ROOT_NOT_FOUND"); });
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

function localConfigSource(config: LocalDevConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function hookInsideRoots(projectRoot: string, roots: string[]): boolean {
  return roots.some((root) => projectRoot === root || projectRoot.startsWith(`${root}/`));
}

function asRuntimeStatus(value: Record<string, unknown>): RuntimeStatus {
  return value as RuntimeStatus;
}

function safeRuntimeStatus(status: RuntimeStatus): RuntimeStatus {
  return {
    ...(status.alias === undefined ? {} : { alias: status.alias }),
    ...(status.tunnel_id === undefined ? {} : { tunnel_id: status.tunnel_id }),
    ...(status.process_running === undefined ? {} : { process_running: status.process_running }),
    ...(status.healthy === undefined ? {} : { healthy: status.healthy }),
    ...(status.ready === undefined ? {} : { ready: status.ready }),
    ...(status.runtime_state === undefined ? {} : { runtime_state: status.runtime_state }),
    ...(status.ui_url === undefined ? {} : { ui_url: status.ui_url }),
    ...(status.control_plane_poll_health === undefined ? {} : { control_plane_poll_health: status.control_plane_poll_health }),
    ...(status.repair_actions === undefined ? {} : { repair_actions: status.repair_actions }),
  };
}

function aliasFromList(value: Record<string, unknown>, alias: string): Record<string, unknown> | undefined {
  if (!Array.isArray(value.aliases)) return undefined;
  return value.aliases.find((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.alias === alias);
}

function connectArguments(alias: string, tunnelId: string, runtimeKeyRef: string, command: string): string[] {
  return [
    "runtimes", "connect",
    "--alias", alias,
    "--tunnel-id", tunnelId,
    "--runtime-api-key", runtimeKeyRef,
    "--mcp-command", command,
    "--json",
  ];
}

function ready(status: RuntimeStatus): boolean {
  return status.process_running === true && status.healthy === true && status.ready === true;
}

export async function runSetup(
  options: SetupOptions,
  prompter: Prompter,
  reporter: Reporter,
  home = setupPaths().home,
  cwd = process.cwd(),
): Promise<SetupResult> {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_PLATFORM");
  const paths = setupPaths(home);
  const previous = await readState(paths.state);
  reporter.line("[✓] preflight: Node runtime and macOS detected");
  const binaryPath = await selectBinary(home, options, previous, prompter, reporter);
  const version = await runCommand(binaryPath, ["--version"]);
  if (version.code !== 0) throw new Error("TUNNEL_CLIENT_INVALID");
  reporter.line("[✓] tunnel-client detected");

  const codexSource = await readOptional(paths.codexConfig);
  const parsedCodex = parseCodexConfig(codexSource ?? "", paths.codexConfig);
  const existingLocalSource = await readOptional(paths.localConfig);
  const existingLocal = existingLocalSource === undefined ? undefined : parseLocalDevConfig(existingLocalSource, paths.localConfig);
  const roots = await projectRoots(options.projectRoots, existingLocal, cwd);
  const selections = options.selectedServers ?? existingLocal?.selectedServers ?? recommendedServers(parsedCodex.servers);
  const configuration: LocalDevConfig = {
    version: 1,
    projectRoots: roots,
    selectedServers: selections,
    projectOpenHooks: existingLocal?.projectOpenHooks.filter(({ projectRoot }) => hookInsideRoots(projectRoot, roots)) ?? [],
    projectBindings: existingLocal?.projectBindings.filter(({ server }) => selections.some(({ alias }) => alias === server)) ?? [],
  };
  parseLocalDevConfig(localConfigSource(configuration), paths.localConfig);
  reporter.line(`[ ] configure project roots: ${roots.join(", ")}`);
  reporter.line(`[ ] select MCP servers: ${selections.length === 0 ? "none (safe default)" : selections.map(({ id, alias }) => `${id} as ${alias}`).join(", ")}`);
  reporter.line(`[ ] write ${paths.localConfig}${codexSource === undefined ? ` and create ${paths.codexConfig}` : ""}`);
  if (!options.yes && !(await prompter.confirm("Apply this reversible configuration?"))) throw new Error("SETUP_CANCELLED");

  let codexBackup: string | undefined;
  let localBackup: string | undefined;
  let serviceInstalled = false;
  let connectedAlias: string | undefined;
  let connectedWasNew = false;
  try {
    if (codexSource === undefined) codexBackup = await writeAtomic(paths.codexConfig, "# Created by local-dev setup; add MCP servers with the Codex CLI.\n");
    localBackup = await writeAtomic(paths.localConfig, localConfigSource(configuration));
    reporter.line("[✓] configuration written atomically; prior files were backed up");

    const { command, serverPath } = mcpCommand();
    await smokeServer(home, process.execPath, serverPath);
    reporter.line("[✓] local MCP smoke test passed");

    const alias = options.alias ?? previous?.alias ?? "local-dev";
    if (!ALIAS.test(alias)) throw new Error("INVALID_ALIAS");
    const listed = await runJson(binaryPath, ["runtimes", "list", "--json"]);
    const existingAlias = aliasFromList(listed, alias);
    let existingStatus: RuntimeStatus = {};
    if (existingAlias !== undefined) {
      existingStatus = asRuntimeStatus(await runJson(binaryPath, ["runtimes", "status", alias, "--json"]).catch(() => ({})));
    }
    let tunnelId = options.tunnelId ?? previous?.tunnelId ??
      (typeof existingAlias?.tunnel_id === "string" ? existingAlias.tunnel_id : undefined) ?? existingStatus.tunnel_id;
    let runtimeKeyRef = options.runtimeKeyRef ?? previous?.runtimeKeyRef ?? existingStatus.remote_lookup_auth_ref;
    if (tunnelId === undefined || runtimeKeyRef === undefined) {
      if (options.openBrowser !== false) {
        await openUrl(TUNNELS_URL);
        await openUrl(KEYS_URL);
      }
      reporter.line("[ ] OpenAI authorization: select/create a tunnel and a scoped runtime key.");
      if (tunnelId === undefined) tunnelId = await prompter.ask("Tunnel id (tunnel_...):");
      if (runtimeKeyRef === undefined) runtimeKeyRef = await prompter.ask("Runtime key reference (env:NAME or file:/absolute/path):");
    }
    if (!TUNNEL_ID.test(tunnelId) || !KEY_REFERENCE.test(runtimeKeyRef)) throw new Error("INVALID_TUNNEL_CONFIGURATION");
    const connectArgs = connectArguments(alias, tunnelId, runtimeKeyRef, command);
    const connected = await runCommand(binaryPath, connectArgs, 120_000);
    if (connected.code !== 0) throw new Error("TUNNEL_CONNECT_FAILED");
    connectedAlias = alias;
    connectedWasNew = existingAlias === undefined;
    const status = asRuntimeStatus(await runJson(binaryPath, ["runtimes", "status", alias, "--json"], 30_000));
    if (!ready(status)) throw new Error("TUNNEL_NOT_READY");
    reporter.line("[✓] tunnel runtime is running, healthy, and ready");
    reporter.line(`[${status.control_plane_poll_health?.state === "failed" ? "!" : "✓"}] control-plane polling: ${status.control_plane_poll_health?.state ?? "not separately reported"}`);

    if (options.installService !== false) {
      await installLaunchAgent(paths, binaryPath, connectArgs);
      serviceInstalled = true;
      reporter.line("[✓] macOS login auto-start installed");
    }
    const state: SetupState = {
      version: 1,
      alias,
      binaryPath,
      tunnelId,
      runtimeKeyRef,
      mcpCommand: command,
      launchAgentPath: options.installService === false ? null : paths.launchAgent,
      configuredAt: new Date().toISOString(),
    };
    await writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
    if (options.openBrowser !== false) await openUrl(CHATGPT_URL);
    const checklist = [
      "Open ChatGPT Settings → Connectors and enable Developer Mode.",
      `Create a private connector using Tunnel and select ${tunnelId}.`,
      "Refresh tools after changing MCP configuration.",
    ];
    for (const item of checklist) reporter.line(`[ ] ChatGPT: ${item}`);
    reporter.line("Local Dev is ready");
    return { ready: true, configuration, state, checklist };
  } catch (error) {
    if (serviceInstalled) await removeLaunchAgent(paths).catch(() => undefined);
    if (connectedAlias !== undefined && connectedWasNew) await runCommand(binaryPath, ["runtimes", "stop", connectedAlias, "--json"]).catch(() => undefined);
    if (localBackup !== undefined || await exists(paths.localConfig)) await restoreAtomic(paths.localConfig, localBackup).catch(() => undefined);
    if (codexSource === undefined) await restoreAtomic(paths.codexConfig, codexBackup).catch(() => undefined);
    throw error;
  }
}

export async function readSetupStatus(home = setupPaths().home): Promise<{
  configured: boolean;
  serviceInstalled: boolean;
  runtime: RuntimeStatus | null;
  ready: boolean;
  fixes: string[];
}> {
  const paths = setupPaths(home);
  const state = await readState(paths.state);
  if (state === undefined) return { configured: false, serviceInstalled: false, runtime: null, ready: false, fixes: ["Run local-dev setup."] };
  const fixes: string[] = [];
  const serviceInstalled = state.launchAgentPath !== null && await exists(state.launchAgentPath) && await launchAgentLoaded();
  if (!serviceInstalled) fixes.push("Run local-dev setup to restore login auto-start.");
  let runtime: RuntimeStatus | null = null;
  try {
    runtime = asRuntimeStatus(await runJson(state.binaryPath, ["runtimes", "status", state.alias, "--json"]));
  } catch {
    fixes.push("Run local-dev setup to repair the tunnel runtime.");
  }
  if (runtime !== null && !ready(runtime)) {
    const actions = runtime.repair_actions?.map(({ reason }) => reason).filter((value): value is string => value !== undefined) ?? [];
    fixes.push(...(actions.length ? actions : ["Run local-dev setup to reconnect the tunnel runtime."]));
  }
  if (runtime?.control_plane_poll_health?.state === "failed") fixes.push(`Control-plane polling failed: ${runtime.control_plane_poll_health.reason ?? "inspect tunnel status"}`);
  let smokeReady = true;
  try {
    const current = mcpCommand();
    await smokeServer(home, process.execPath, current.serverPath);
  } catch {
    smokeReady = false;
    fixes.push("The local MCP server smoke test failed; rerun local-dev setup after checking configuration.");
  }
  return {
    configured: true,
    serviceInstalled,
    runtime: runtime === null ? null : safeRuntimeStatus(runtime),
    ready: smokeReady && serviceInstalled && runtime !== null && ready(runtime),
    fixes,
  };
}

export async function uninstall(home = setupPaths().home): Promise<void> {
  const paths = setupPaths(home);
  const state = await readState(paths.state);
  await removeLaunchAgent(paths).catch(() => undefined);
  if (state !== undefined && await executable(state.binaryPath)) {
    await runCommand(state.binaryPath, ["runtimes", "stop", state.alias, "--json"]).catch(() => undefined);
    await runCommand(state.binaryPath, ["runtimes", "rm", state.alias, "--json"]).catch(() => undefined);
  }
  await removeDirectory(dirname(paths.state));
}

export { setupPaths } from "./paths.js";
export type { SetupOptions, SetupResult } from "./types.js";
