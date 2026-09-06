import { localeClock, readSystemClock } from "./system-clock.ts";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ActivityArchive, type Manifest } from "./archive.ts";
import { parseRun, titleFor } from "../shared/presentation.ts";
import {
  object,
  string,
  validateAction,
  type ActionResult,
  type CallItem,
  type ControlAction,
  type Dict,
  type RuntimeItem,
  type UiSnapshot,
} from "../shared/contracts.ts";

interface Connection {
  socket: Socket;
  state: RuntimeItem;
  pending: Map<
    string,
    {
      resolve: (value: Dict) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  appliedPreference?: number;
}
export interface HostActions {
  confirm(kind: "autoApprove" | "stopAll" | "reconnect" | "quit"): Promise<boolean>;
  openArchive(path: string): void;
  openLoginSettings(): void;
  quit(): void;
}
const noopHost: HostActions = {
  confirm: async () => false,
  openArchive: () => undefined,
  openLoginSettings: () => undefined,
  quit: () => undefined,
};
export class DesktopService {
  readonly home: string;
  readonly archive: ActivityArchive;
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<(value: UiSnapshot) => void>();
  private readonly errors = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  private revision = 0;
  private limit = 100;
  private preference = { autoApprove: false, remember: false, paused: false, pending: false };
  private desired?: { autoApprove: boolean; remember: boolean; revision: number };
  private health: UiSnapshot["connection"] = {
    status: "checking",
    configured: false,
    message: "Looking for a local runtime…",
    diagnostics: "",
  };
  private checking = false;
  private lastCheck = 0;
  private systemClock = localeClock();
  private clockReadAt = 0;
  private clockRead?: Promise<void>;
  async refreshClock(): Promise<void> {
    if (this.clockRead) return this.clockRead;
    if (Date.now() - this.clockReadAt < 1000) return;
    this.clockRead = readSystemClock()
      .then((value) => {
        const changed = JSON.stringify(this.systemClock) !== JSON.stringify(value);
        this.systemClock = value;
        this.clockReadAt = Date.now();
        if (changed) this.publish();
      })
      .finally(() => {
        this.clockRead = undefined;
      });
    return this.clockRead;
  }
  constructor(
    home = homedir(),
    private host: HostActions = noopHost,
  ) {
    this.home = home;
    this.archive = new ActivityArchive(join(home, ".local-dev", "activity"));
  }
  async start(): Promise<void> {
    await mkdir(this.archive.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.archive.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Activity directory is not owned by this user.");
    await chmod(this.archive.directory, 0o700);
    try {
      const file = join(this.archive.directory, "settings.json");
      const stat = await lstat(file);
      if (
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.mode & 0o077
      )
        throw new Error("Unsafe approval settings permissions");
      const settings = object(JSON.parse(await readFile(file, "utf8")));
      this.preference = {
        autoApprove: settings.remember === true && settings.autoApprove === true,
        remember: settings.remember === true,
        paused: settings.paused === true,
        pending: false,
      };
    } catch (error) {
      if (object(error).code !== "ENOENT") this.errors.add(String(error));
    }
    await this.refreshClock();
    await this.scan();
    this.timer = setInterval(() => void this.scan(), 750);
    void this.checkConnection();
  }
  subscribe(listener: (value: UiSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(): void {
    if (this.closed) return;
    this.revision++;
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
  snapshot(limit?: number): UiSnapshot {
    if (limit !== undefined && Number.isInteger(limit) && limit >= 20 && limit <= 5000)
      this.limit = limit;
    const runtimes = [...this.connections.values()].map(({ state }) => state);
    const connected = runtimes.filter((runtime) => runtime.connected);
    const runs = new Map(
      [...this.archive.index.runs].map(([id, run]) => [
        id,
        { ...run, connected: connected.some((runtime) => runtime.id === run.runtimeId) },
      ]),
    );
    for (const runtime of connected)
      for (const live of runtime.runs) {
        const old = runs.get(live.id);
        runs.set(live.id, {
          ...live,
          connected: true,
          notes: old?.notes ?? [],
          steering: live.steering.map((message) => ({
            ...message,
            response: old?.steering.find((item) => item.id === message.id)?.response,
          })),
        });
      }
    const calls = new Map<string, CallItem>(
      [...this.archive.index.calls].map(([id, call]) => [id, { ...call }]),
    );
    for (const runtime of connected)
      for (const active of runtime.operations) {
        const key = `${runtime.id}:${active.id}`;
        const current = calls.get(key);
        if (current) current.state = active.state;
        else
          calls.set(key, {
            id: key,
            runtimeId: runtime.id,
            operationId: active.id,
            runId: active.runId,
            tool: active.tool,
            ...titleFor(active.tool, active.arguments),
            state: active.state,
            startedAt: active.startedAt,
            summary: "",
            inputPreview: "Indexing original record…",
            inputLimited: true,
            commands: [],
            eventCount: 0,
          });
      }
    for (const call of calls.values())
      if (
        ["requested", "waiting", "running", "stopping"].includes(call.state) &&
        !connected.some((runtime) => runtime.id === call.runtimeId)
      )
        call.state = "interrupted";
    const sortedRuns = [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const recentRunIds = new Set(sortedRuns.slice(-this.limit).map((run) => run.id));
    const shownRuns = sortedRuns.filter(
      (run) => recentRunIds.has(run.id) || (run.connected && run.state === "running"),
    );
    const chosen = new Set(shownRuns.map((run) => `${run.runtimeId}:${run.runId}`));
    const sortedCalls = [...calls.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const selectedCalls = sortedCalls.filter(
      (call) => call.runId && chosen.has(`${call.runtimeId}:${call.runId}`),
    );
    const orphaned = sortedCalls.filter((call) => !call.runId).slice(-this.limit);
    const policy = connected.length
      ? {
          autoApprove: connected.every((runtime) => runtime.policy.autoApprove),
          remember: connected.every((runtime) => runtime.policy.remember),
          paused: connected.every((runtime) => runtime.policy.paused),
          pending: false,
        }
      : this.preference;
    const preference = this.desired
      ? {
          ...policy,
          autoApprove: this.desired.autoApprove,
          remember: this.desired.remember,
          pending:
            !connected.length ||
            connected.some(
              (runtime) =>
                runtime.policy.autoApprove !== this.desired!.autoApprove ||
                runtime.policy.remember !== this.desired!.remember,
            ),
        }
      : policy;
    return {
      revision: this.revision,
      runs: shownRuns,
      calls: [...orphaned, ...selectedCalls],
      runtimes,
      archive: {
        directory: this.archive.directory,
        bytes: this.archive.bytes,
        events: this.archive.index.events,
        calls: calls.size,
        runs: runs.size,
        shown: this.limit,
        loading: this.archive.loading,
      },
      errors: [...this.errors, ...this.archive.errors],
      preference,
      connection: connected.length
        ? {
            ...this.health,
            status: "connected",
            message: `${connected.length} local runtime${connected.length === 1 ? "" : "s"} connected`,
          }
        : this.health,
      platform: process.platform,
      version: "0.7.0",
      systemClock: this.systemClock,
    };
  }
  private async scan(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    const count = this.archive.index.events;
    try {
      if (Date.now() - this.clockReadAt > 30000) void this.refreshClock();
      const manifests = await this.archive.scan();
      const present = new Set(manifests.map((manifest) => manifest.runtimeId));
      for (const [id, connection] of this.connections)
        if (!present.has(id)) {
          connection.socket.destroy();
          connection.state.connected = false;
        }
      for (const manifest of manifests)
        if (
          !this.connections.get(manifest.runtimeId)?.state.connected &&
          !this.connections.get(manifest.runtimeId)?.socket.connecting
        )
          await this.connect(manifest);
      if (!this.live().length && Date.now() - this.lastCheck > 15000 && !this.checking)
        void this.checkConnection();
      if (count !== this.archive.index.events || this.archive.loading) this.publish();
    } catch (error) {
      this.errors.add(String(error));
      this.publish();
    } finally {
      this.busy = false;
    }
  }
  private live(): Connection[] {
    return [...this.connections.values()].filter(({ state }) => state.connected);
  }
  private async connect(manifest: Manifest): Promise<void> {
    if (!Number.isInteger(manifest.pid) || manifest.pid <= 0) return;
    try {
      process.kill(manifest.pid, 0);
    } catch {
      return;
    }
    const prefix =
      process.platform === "win32"
        ? "\\\\.\\pipe\\local-dev-"
        : `/tmp/local-dev-${process.getuid?.() ?? "user"}/`;
    if (!manifest.socketPath.startsWith(prefix)) {
      this.errors.add("Refusing an unexpected runtime socket path.");
      return;
    }
    if (process.platform !== "win32") {
      try {
        const stat = await lstat(manifest.socketPath);
        if (
          !stat.isSocket() ||
          (process.getuid && stat.uid !== process.getuid()) ||
          stat.mode & 0o077
        )
          throw new Error("Socket is not private");
      } catch {
        return;
      }
    }
    const socket = connect(manifest.socketPath);
    socket.setEncoding("utf8");
    const connection: Connection = {
      socket,
      pending: new Map(),
      state: {
        id: manifest.runtimeId,
        pid: manifest.pid,
        connected: false,
        supportsRuns: false,
        supportsAsk: false,
        asks: [],
        policy: { autoApprove: false, remember: false, paused: false },
        operations: [],
        processes: [],
        runs: [],
      },
    };
    this.connections.set(manifest.runtimeId, connection);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = object(JSON.parse(line));
          if (message.kind === "snapshot" && message.runtimeId === manifest.runtimeId) {
            const policy = object(message.policy);
            connection.state = {
              ...connection.state,
              connected: true,
              supportsRuns: object(message.capabilities).workerRuns === true,
              workTracking: object(message.capabilities).workTracking === 1,
              supportsAsk: object(message.capabilities).ask === 1,
              askAutoTimeoutMs: Number(object(message.capabilities).askAutoTimeoutMs) || undefined,
              fault: typeof message.fault === "string" ? message.fault : undefined,
              policy: {
                autoApprove: policy.autoApprove === true,
                remember: policy.remember === true,
                paused: policy.paused === true,
              },
              asks: Array.isArray(message.asks) ? (message.asks as RuntimeItem["asks"]) : [],
              operations: Array.isArray(message.operations)
                ? (message.operations as RuntimeItem["operations"])
                : [],
              processes: Array.isArray(message.processes)
                ? (message.processes as RuntimeItem["processes"])
                : [],
              runs: Array.isArray(message.runs)
                ? message.runs
                    .map((run) => parseRun(run, manifest.runtimeId))
                    .filter((run): run is NonNullable<typeof run> => !!run)
                : [],
            };
            if (!this.desired) this.preference = { ...connection.state.policy, pending: false };
            void this.applyPreference(connection).catch((error) => {
              this.errors.add(String(error));
              this.publish();
            });
            this.publish();
          } else if (message.kind === "ack" && typeof message.id === "string") {
            const pending = connection.pending.get(message.id);
            if (pending) {
              clearTimeout(pending.timer);
              connection.pending.delete(message.id);
              if (message.ok) pending.resolve(message);
              else pending.reject(new Error(string(message.error, "Local control rejected")));
            }
          }
        } catch (error) {
          this.errors.add("Local message could not be read: " + String(error));
        }
      }
    });
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: randomUUID(),
          action: "hello",
          client: "Local Dev web desktop",
          pid: process.pid,
        }) + "\n",
      ),
    );
    socket.on("error", () => undefined);
    socket.on("close", () => {
      connection.state.connected = false;
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Runtime disconnected before confirming the action."));
      }
      connection.pending.clear();
      this.publish();
    });
  }
  private send(connection: Connection, action: string, values: Dict = {}): Promise<Dict> {
    if (!connection.state.connected || connection.socket.destroyed)
      return Promise.reject(new Error("No connected runtime can receive this action."));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new Error("No confirmation received. Check the timeline before retrying."));
      }, 5000);
      connection.pending.set(id, { resolve, reject, timer });
      connection.socket.write(JSON.stringify({ ...values, action, id }) + "\n");
    });
  }
  private async applyPreference(connection: Connection): Promise<void> {
    const desired = this.desired;
    if (!desired || connection.appliedPreference === desired.revision) return;
    connection.appliedPreference = desired.revision;
    if (
      connection.state.policy.autoApprove !== desired.autoApprove ||
      connection.state.policy.remember !== desired.remember
    )
      await this.send(connection, "policy", {
        autoApprove: desired.autoApprove,
        remember: desired.remember,
        confirmed: desired.autoApprove,
      });
  }
  private async persist(autoApprove: boolean, remember: boolean, paused: boolean): Promise<void> {
    const file = join(this.archive.directory, "settings.json");
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temp,
        JSON.stringify({ version: 1, autoApprove: autoApprove && remember, remember, paused }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    this.preference = { autoApprove, remember, paused, pending: false };
  }
  async act(input: unknown): Promise<ActionResult> {
    try {
      const action = validateAction(input);
      if (action.type === "checkConnection") {
        await this.checkConnection();
        return { ok: true };
      }
      if (action.type === "openArchive") {
        this.host.openArchive(this.archive.directory);
        return { ok: true };
      }
      if (action.type === "openLoginSettings") {
        this.host.openLoginSettings();
        return { ok: true };
      }
      if (action.type === "reconnect") {
        if (!(await this.host.confirm("reconnect"))) return { ok: false, cancelled: true };
        await this.reconnect();
        return { ok: true, message: "Runtime connection requested." };
      }
      if (action.type === "policy") {
        if (
          action.autoApprove &&
          !this.snapshot().preference.autoApprove &&
          !(await this.host.confirm("autoApprove"))
        )
          return { ok: false, cancelled: true };
        await this.persist(action.autoApprove, action.remember, this.snapshot().preference.paused);
        this.desired = {
          autoApprove: action.autoApprove,
          remember: action.remember,
          revision: Date.now(),
        };
        await Promise.all(this.live().map((connection) => this.applyPreference(connection)));
        this.publish();
        return {
          ok: true,
          message: this.live().length
            ? "Approval preference applied."
            : "Preference saved for the next connection.",
        };
      }
      if (action.type === "pause" || action.type === "stopAll" || action.type === "quit") {
        if (action.type !== "pause" && !(await this.host.confirm(action.type)))
          return { ok: false, cancelled: true };
        const state = this.snapshot().preference;
        const paused = action.type === "pause" ? action.paused : true;
        await this.persist(state.autoApprove, state.remember, paused);
        await Promise.all(
          this.live().map((connection) =>
            this.send(connection, action.type === "stopAll" ? "stopAll" : "pause", { paused }),
          ),
        );
        this.publish();
        if (action.type === "quit") this.host.quit();
        return {
          ok: true,
          message:
            action.type === "stopAll"
              ? "Stop requested; inspect process states for confirmation."
              : paused
                ? "New actions paused."
                : "New actions resumed.",
        };
      }
      if (!("runtimeId" in action)) throw new Error("Unsupported desktop action.");
      await this.targeted(action);
      return {
        ok: true,
        message:
          action.type === "steer"
            ? "Queued for the next tool response. Not yet acknowledged."
            : action.type === "answerAsk"
              ? "Answer sent to ChatGPT."
              : "Action confirmed by the runtime.",
      };
    } catch (error) {
      return { ok: false, message: String(error instanceof Error ? error.message : error) };
    }
  }
  private async targeted(action: Extract<ControlAction, { runtimeId: string }>): Promise<void> {
    const connection = this.connections.get(action.runtimeId);
    if (!connection?.state.connected)
      throw new Error("This runtime is disconnected. Your instruction has not been sent.");
    if (action.type === "steer") {
      const run = connection.state.runs.find(
        (run) => run.runId === action.runId && run.state === "running",
      );
      if (!run || !connection.state.supportsRuns || run.origin !== "assistant")
        throw new Error(
          "Run reporting is not ready. Ask ChatGPT to call run.start before sending steering.",
        );
      if (connection.state.workTracking && !run.todos?.length)
        throw new Error(
          "Publish a to-do list with run.update.todos before sending steering. Refresh ChatGPT tools if that field is unavailable; your draft remains here.",
        );
      await this.send(connection, "steer", {
        runId: action.runId,
        text: action.text,
        messageId: action.messageId,
      });
      return;
    }
    if (action.type === "answerAsk") {
      const ask = connection.state.asks.find((item) => item.id === action.askId);
      if (!ask) throw new Error("This question is no longer waiting for an answer.");
      await this.send(connection, "answerAsk", {
        askId: action.askId,
        ...(action.optionId ? { optionId: action.optionId } : { text: action.text }),
      });
      return;
    }
    if (action.type === "stopProcess") {
      if (!connection.state.processes.some((process) => process.id === action.processId))
        throw new Error("This process is no longer tracked as running.");
      await this.send(connection, "stopProcess", { processId: action.processId });
      return;
    }
    const operation = connection.state.operations.find(
      (operation) => operation.id === action.operationId,
    );
    if (!operation) throw new Error("This action is no longer pending or running.");
    if (action.type !== "stop" && operation.state !== "waiting")
      throw new Error("This approval has already been resolved.");
    await this.send(connection, action.type, { operationId: action.operationId });
  }
  private async setup(): Promise<Dict> {
    const setup = object(
      JSON.parse(await readFile(join(this.home, ".local-dev", "setup.json"), "utf8")),
    );
    if (
      !string(setup.binaryPath).startsWith(process.platform === "win32" ? "" : "/") ||
      !string(setup.alias) ||
      !string(setup.tunnelId).startsWith("tunnel_") ||
      !/^(env:|file:)/.test(string(setup.runtimeKeyRef)) ||
      !string(setup.mcpCommand)
    )
      throw new Error("The saved tunnel configuration is incomplete.");
    return setup;
  }
  private async command(
    executable: string,
    args: string[],
  ): Promise<{ code: number; output: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        cwd: this.home,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Tunnel-management command timed out."));
      }, 45000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.health.diagnostics += `\n${executable} ${JSON.stringify(args)}\n${output}${error}\nExit ${code}\n`;
        resolve({ code: code ?? -1, output });
      });
    });
  }
  async checkConnection(): Promise<void> {
    if (this.checking || this.closed || this.live().length) return;
    this.checking = true;
    this.lastCheck = Date.now();
    try {
      const setup = await this.setup();
      this.health.diagnostics = "";
      const result = await this.command(string(setup.binaryPath), [
        "runtimes",
        "status",
        string(setup.alias),
        "--json",
      ]);
      const status = object(JSON.parse(result.output));
      const running = status.process_running === true;
      this.health = {
        ...this.health,
        configured: true,
        status: running ? "update" : "offline",
        message: running
          ? "The tunnel is running, but its activity stream is not connected. Reconnect to load the updated runtime."
          : "The saved tunnel is offline. Connect it to receive live activity.",
      };
    } catch (error) {
      this.health = {
        ...this.health,
        configured: false,
        status: "error",
        message: String(error instanceof Error ? error.message : error),
      };
    } finally {
      this.checking = false;
      this.publish();
    }
  }
  private async reconnect(): Promise<void> {
    const setup = await this.setup();
    this.checking = true;
    this.health = {
      ...this.health,
      status: "connecting",
      message: "Reconnecting the local runtime…",
      diagnostics: "",
    };
    this.publish();
    try {
      const exe = string(setup.binaryPath),
        alias = string(setup.alias);
      const status = await this.command(exe, ["runtimes", "status", alias, "--json"]);
      if (object(JSON.parse(status.output)).process_running === true) {
        const stopped = await this.command(exe, ["runtimes", "stop", alias, "--json"]);
        if (stopped.code !== 0) throw new Error("The previous runtime did not stop cleanly.");
      }
      const started = await this.command(exe, [
        "runtimes",
        "connect",
        "--alias",
        alias,
        "--tunnel-id",
        string(setup.tunnelId),
        "--runtime-api-key",
        string(setup.runtimeKeyRef),
        "--mcp-command",
        string(setup.mcpCommand),
        "--json",
      ]);
      if (started.code !== 0)
        throw new Error("Tunnel reconnect failed. Open connection details for the exact response.");
      this.health.status = "offline";
      this.health.message = "Tunnel command finished; waiting for the activity connection.";
    } finally {
      this.checking = false;
      this.publish();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const connection of this.connections.values()) connection.socket.destroy();
    this.connections.clear();
    this.listeners.clear();
  }
}
export function isolatedTestHome(path: string): boolean {
  const home = resolve(path);
  const temporary = resolve(tmpdir());
  return (
    home.startsWith(temporary + "/") &&
    home !== resolve(homedir()) &&
    /local-dev-web-test-[a-zA-Z0-9-]+$/.test(home)
  );
}
