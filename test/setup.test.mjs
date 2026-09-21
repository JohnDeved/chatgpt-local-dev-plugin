import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSetupStatus, runSetup, setupPaths, uninstall, watchdogCommand } from "../dist/setup/index.js";
import { installLaunchAgent, launchAgentPlist, removeLaunchAgent } from "../dist/setup/platform.js";

const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_TUNNEL_LOG) appendFileSync(process.env.FAKE_TUNNEL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") console.log("0.0.10-test");
else if (args[0] === "runtimes" && args[1] === "list") console.log(JSON.stringify({ aliases: [{ alias: "local-dev", tunnel_id: "tunnel_fixture" }] }));
else if (args[0] === "runtimes" && args[1] === "status") console.log(JSON.stringify({ alias: "local-dev", tunnel_id: "tunnel_fixture", process_running: true, healthy: true, ready: true, runtime_state: "ready", remote_lookup_auth_ref: "file:/tmp/runtime-key", control_plane_poll_health: { state: "healthy" }, local: { log: { tail: "sensitive diagnostic" } } }));
else if (args[0] === "runtimes" && args[1] === "connect" && process.env.FAKE_CONNECT_FAIL === "1") process.exitCode = 1;
else console.log(JSON.stringify({ ok: true }));
`;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "local-dev-setup-"));
  const project = join(home, "project");
  const binary = join(home, "tunnel-client");
  const log = join(home, "tunnel.log");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(project);
  await writeFile(binary, fakeSource, { mode: 0o700 });
  await chmod(binary, 0o700);
  const fakeServer = new URL("./fake-mcp-server.mjs", import.meta.url).pathname;
  const codex = `[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fakeServer)}]\nenabled_tools = ["echo"]\n`;
  await writeFile(join(home, ".codex", "config.toml"), codex);
  return { binary, codex, home, log, project };
}

const prompter = {
  ask: async () => { throw new Error("unexpected prompt"); },
  confirm: async () => true,
};
const reporter = { line: () => undefined };

test("setup detects safe selections, is resumable, and uninstall preserves Codex config", async () => {
  const { binary, codex, home, log, project } = await fixture();
  const previousLog = process.env.FAKE_TUNNEL_LOG;
  process.env.FAKE_TUNNEL_LOG = log;
  try {
    const options = { yes: true, tunnelClientBin: binary, openBrowser: false, installService: false };
    const first = await runSetup(options, prompter, reporter, home, project);
    assert.equal(first.ready, true);
    assert.deepEqual(first.configuration.projectRoots, [await import("node:fs/promises").then(({ realpath }) => realpath(project))]);
    assert.deepEqual(first.configuration.selectedServers, [{ id: "fixture", alias: "fixture" }]);
    assert.equal(first.state.runtimeKeyRef, "file:/tmp/runtime-key");
    assert.equal((await readFile(setupPaths(home).state, "utf8")).includes("fixture-token"), false);
    const second = await runSetup(options, prompter, reporter, home, project);
    assert.equal(second.ready, true);
    const localFiles = await import("node:fs/promises").then(({ readdir }) => readdir(join(home, ".local-dev")));
    assert.ok(localFiles.some((name) => name.startsWith("config.json.backup.")));
    const status = await readSetupStatus(home);
    assert.equal(status.configured, true);
    assert.equal(status.runtime?.ready, true);
    assert.equal(JSON.stringify(status).includes("sensitive diagnostic"), false);
    assert.equal(status.ready, false);
    assert.ok(status.fixes.some((fix) => fix.includes("auto-start")));
    await uninstall(home);
    await assert.rejects(access(join(home, ".local-dev")));
    assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), codex);
    const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(commands.some((args) => args[0] === "runtimes" && args[1] === "connect"));
    assert.ok(commands.some((args) => args[0] === "runtimes" && args[1] === "stop"));
    assert.ok(commands.some((args) => args[0] === "runtimes" && args[1] === "rm"));
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_TUNNEL_LOG;
    else process.env.FAKE_TUNNEL_LOG = previousLog;
    await rm(home, { recursive: true, force: true });
  }
});

test("setup rolls configuration back when tunnel connection fails", async () => {
  const { binary, home, project } = await fixture();
  const paths = setupPaths(home);
  await mkdir(join(home, ".local-dev"), { recursive: true });
  const original = `${JSON.stringify({ version: 1, projectRoots: [project], selectedServers: [], projectOpenHooks: [] }, null, 2)}\n`;
  await writeFile(paths.localConfig, original);
  const previous = process.env.FAKE_CONNECT_FAIL;
  process.env.FAKE_CONNECT_FAIL = "1";
  try {
    await assert.rejects(
      runSetup({ yes: true, tunnelClientBin: binary, openBrowser: false, installService: false }, prompter, reporter, home, project),
      /TUNNEL_CONNECT_FAILED/u,
    );
    assert.equal(await readFile(paths.localConfig, "utf8"), original);
    await assert.rejects(access(paths.state));
  } finally {
    if (previous === undefined) delete process.env.FAKE_CONNECT_FAIL;
    else process.env.FAKE_CONNECT_FAIL = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("launch agent is escaped, loaded idempotently, and removable", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-service-"));
  const paths = setupPaths(home);
  const calls = [];
  const runner = async (program, args) => {
    calls.push([program, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const source = launchAgentPlist("/tmp/tunnel&client", ["runtimes", "connect", "--runtime-api-key", "file:/tmp/key"], paths);
    assert.match(source, /tunnel&amp;client/u);
    assert.match(source, /<key>RunAtLoad<\/key><true\/>/u);
    assert.match(source, /<key>KeepAlive<\/key><true\/>/u);
    assert.match(source, /<key>ThrottleInterval<\/key><integer>10<\/integer>/u);
    assert.doesNotMatch(source, /StartInterval/u);
    await installLaunchAgent(paths, "/tmp/tunnel-client", ["runtimes", "connect"], runner);
    await installLaunchAgent(paths, "/tmp/tunnel-client", ["runtimes", "connect"], runner);
    assert.ok(calls.some((call) => call.includes("bootstrap")));
    assert.ok(calls.some((call) => call.includes("bootout")));
    await removeLaunchAgent(paths, runner);
    await assert.rejects(access(paths.launchAgent));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("watchdog prevents idle system sleep on AC and battery", () => {
  const command = watchdogCommand();
  assert.equal(command.program, "/usr/bin/caffeinate");
  assert.equal(command.args[0], "-i");
  assert.equal(command.args.includes("-s"), false);
  assert.equal(command.args.includes(process.execPath), true);
});
