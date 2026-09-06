import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ActivityHub } from "../../dist/activity.js";

if (process.platform !== "darwin") {
  console.log("Native webview check SKIPPED: this check currently requires macOS.");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "build/stable-macos-arm64/Local Dev.app");
const home = await mkdtemp(join(tmpdir(), "local-dev-web-test-"));
const hub = new ActivityHub(home);
let child,
  log = "",
  exit;
try {
  await hub.start();
  const run = hub.runs.start(
    "native-test",
    "Verify the web-based tray companion",
    "Web desktop verification",
  );
  hub.runs.update(
    "native-test",
    run.id,
    "Connect the actual native webview to an isolated Local Dev runtime.",
    "plan",
  );
  child = spawn(join(bundle, "Contents/MacOS/launcher"), [], {
    cwd: bundle,
    shell: false,
    env: { ...process.env, LOCAL_DEV_WEB_TEST_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: String(error) }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  const stopped = await Promise.race([
    exit,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), 30000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(
    stopped.code,
    0,
    `Native app did not exit successfully: ${JSON.stringify(stopped)}\n${log}`,
  );
  const marker = JSON.parse(await readFile(join(home, "native-webview-ready.json"), "utf8"));
  assert.equal(marker.renderer, "native");
  assert.equal(marker.domCommitted, true);
  assert.equal(marker.rpc, true);
  assert.equal(marker.runtimeConnected, true);
  const events = (await readFile(hub.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(
    events.some(
      (event) =>
        event.type === "viewer.connected" && event.detail.client === "Local Dev web desktop",
    ),
  );
  assert.equal(
    events.some((event) => event.type === "policy.changed"),
    false,
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        ...marker,
        approvalPolicyChanged: false,
        scope:
          "Packaged Electrobun native webview loads the production React bundle and exchanges typed RPC with a real isolated Local Dev runtime.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  throw new Error(`Native desktop check failed. ${log}`, { cause: error });
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (exit) await Promise.race([exit, delay(2000)]);
  await hub.close();
  await rm(home, { recursive: true, force: true });
}
