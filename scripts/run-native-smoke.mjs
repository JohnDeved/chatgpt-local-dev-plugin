import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Cross-language integration: a native ActivityStore sends one fixture steering
// message through the real private IPC to an isolated stdio MCP server.
// No production tunnel, native app instance, or real approval settings are changed.
const home = await mkdtemp(join(tmpdir(), "local-dev-native-run-"));
const native = process.argv[2] ?? fileURLToPath(new URL("../build/menu-bar/Local Dev.app/Contents/MacOS/LocalDevMenu", import.meta.url));
let nativeProcess;
let nativeExit;
let nativeLog = "";
let serverLog = "";
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))], env: { ...process.env, HOME: home }, stderr: "pipe" });
transport.stderr?.on("data", (chunk) => { serverLog += chunk.toString(); });
const client = new Client({ name: "native-run-integration", version: "1.0.0" });
try {
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".local-dev"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "");
  await writeFile(join(home, ".local-dev", "config.json"), JSON.stringify({ version: 1, projectRoots: [home], selectedServers: [], projectOpenHooks: [] }));
  await client.connect(transport);
  const start = await client.callTool({ name: "run.start", arguments: {
    goal: "Verify the native steering UI model", title: "Native run integration", plan: "Exercise the native composer and verify its acknowledgement state.",
  } });
  assert.equal(start.isError, undefined);
  const runId = start.structuredContent.data.run.id;
  const plan = await client.callTool({ name: "run.update", arguments: { runId, summary: "Verify native steering", todos: [{ id: "verify", title: "Verify read-only native workflow", status: "in_progress" }] } });
  assert.notEqual(plan.isError, true);
  const directory = join(home, ".local-dev", "activity");
  const manifestFile = (await readdir(directory)).find((name) => name.endsWith(".json") && name !== "settings.json");
  const manifest = JSON.parse(await readFile(join(directory, manifestFile), "utf8"));
  const events = async () => (await readFile(manifest.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
  nativeProcess = spawn(native, ["--verify-run-workflow"], {
    shell: false, env: { ...process.env, LOCAL_DEV_RUN_TEST_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  nativeProcess.stdout.on("data", (chunk) => { nativeLog += chunk.toString(); });
  nativeProcess.stderr.on("data", (chunk) => { nativeLog += chunk.toString(); });
  nativeExit = new Promise((resolve) => {
    nativeProcess.once("error", (error) => resolve({ error }));
    nativeProcess.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 12_000;
  let queued;
  while (Date.now() < deadline) {
    queued = (await events()).find((event) => event.type === "steering.queued");
    if (queued) break;
    if (nativeProcess.exitCode !== null) throw new Error(`Native client exited before sending: ${nativeLog}`);
    await delay(80);
  }
  assert.ok(queued, `Native client did not queue steering: ${nativeLog}`);
  assert.equal(queued.detail.message.text, "Keep the native integration check read-only.");
  const blocked = await client.callTool({ name: "project.current", arguments: {} });
  assert.equal(blocked.structuredContent.error.code, "STEERING_PENDING");
  assert.match(blocked.content.at(-1).text, /Keep the native integration check read-only/u);
  const acknowledgement = await client.callTool({ name: "run.update", arguments: {
    runId, kind: "decision", summary: "I will only inspect current project state.", acknowledgedSteeringIds: [queued.detail.message.id],
  } });
  assert.notEqual(acknowledgement.isError, true);
  const status = await client.callTool({ name: "project.current", arguments: {} });
  assert.equal(status.structuredContent.ok, true);
  const resolved = await client.callTool({ name: "run.update", arguments: { runId, summary: "Read-only status checked.", todos: [{ id: "verify", status: "completed" }], steeringTasks: [{ id: queued.detail.message.id, status: "completed" }] } });
  assert.notEqual(resolved.isError, true);
  const finish = await client.callTool({ name: "run.finish", arguments: { runId, outcome: "completed", summary: "Native steering acknowledged; read-only status checked." } });
  assert.equal(finish.structuredContent.data.run.state, "completed");
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 10_000); });
  const exited = await Promise.race([nativeExit, timeout]);
  clearTimeout(timer);
  assert.equal(exited.code, 0, `Native end-state verification failed: ${JSON.stringify(exited)} ${nativeLog}`);
  const log = await events();
  for (const type of ["run.started", "steering.queued", "steering.returned", "steering.acknowledged", "run.ended"]) {
    assert.equal(log.filter((event) => event.type === type).length, 1, type);
  }
  assert.equal(log.some((event) => event.type === "policy.changed"), false);
  console.log(nativeLog.trim());
  console.log("Native ↔ IPC ↔ MCP workflow passed in an isolated temporary home; no production policy changes.");
} catch (error) {
  throw new Error(`Native run workflow failed. Server: ${serverLog} Native: ${nativeLog}`, { cause: error });
} finally {
  if (nativeProcess !== undefined && nativeProcess.exitCode === null) nativeProcess.kill("SIGTERM");
  if (nativeExit !== undefined) await Promise.race([nativeExit, delay(2000)]);
  await client.close();
  await rm(home, { recursive: true, force: true });
}
