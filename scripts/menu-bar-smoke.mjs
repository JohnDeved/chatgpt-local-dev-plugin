import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { ActivityHub } from "../dist/activity.js";
import { ProcessManager } from "../dist/core/process.js";

// Explicit local integration check: never changes the user's approval policy,
// restarts the tunnel, or stops any pre-existing process. The installed app must be open.
const hub = new ActivityHub(homedir());
const manager = new ProcessManager();
async function readEvents() {
  return (await readFile(hub.journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}
try {
  await hub.start();
  let viewer;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    viewer = (await readEvents()).find((event) => event.type === "viewer.connected" && event.detail.client === "Local Dev menu bar");
    if (viewer) break;
    await delay(100);
  }
  assert.ok(viewer, "Open the installed Local Dev menu-bar app before running this check.");
  for (const argv of [["/usr/bin/uname", "-s"], [process.execPath, "--version"]]) {
    const result = await hub.execute(
      { name: "local.verification", title: "Read-only menu-bar integration check", annotations: { readOnlyHint: true } },
      { argv }, async () => await manager.run(argv, homedir(), false, 10_000),
    );
    assert.equal(result.exitCode, 0);
  }
  await delay(1200);
  const log = await readEvents();
  assert.equal(log.filter((event) => event.type === "process.exited").length, 2);
  assert.equal(log.filter((event) => event.type === "tool.completed").length, 2);
  assert.equal(log.some((event) => event.type === "policy.changed"), false);
  console.log(JSON.stringify({
    status: "passed", nativeViewerPid: viewer.detail.pid,
    runtimeId: hub.runtimeId, processChecks: 2,
    autoApproveAtStartup: log.find((event) => event.type === "runtime.started").detail.autoApprove,
    journalPath: hub.journalPath,
    scope: "Native app IPC and real read-only subprocess capture; not a real-tunnel restart or approval-button interaction.",
  }, null, 2));
} finally {
  await manager.close();
  await hub.close();
}
