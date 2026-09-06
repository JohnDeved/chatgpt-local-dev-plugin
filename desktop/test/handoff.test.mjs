import assert from "node:assert/strict";
import test from "node:test";
import { companionProcesses, stopInstalledCompanion } from "../scripts/companion-handoff.mjs";

const bundle = "/Users/fixture/Applications/Local Dev.app";
const line = (pid, name, uid = 501, state = "S") =>
  `${pid} 1 ${uid} ${state} ${bundle}/Contents/MacOS/${name}`;

test("companion matching excludes backend processes, other bundles, other users, and zombies", () => {
  const table = [
    line(100, "launcher"),
    line(101, "bun"),
    line(102, "LocalDevMenu"),
    line(103, "node"),
    line(104, "bun", 502),
    line(105, "bun", 501, "Z"),
    "106 1 501 S /Users/fixture/.nvm/bin/node",
    "107 1 501 S /tmp/Local Dev.app/Contents/MacOS/bun",
    "108 1 501 S /Users/fixture/Applications/Local Dev.app.bad/Contents/MacOS/bun",
  ].join("\n");
  assert.deepEqual(
    companionProcesses(table, bundle, 501).map((item) => item.pid),
    [100, 101, 102],
  );
});

test("handoff escalates only verified companion processes when graceful close is refused", async () => {
  let alive = [100, 101];
  const signals = [];
  const stopped = await stopInstalledCompanion(bundle, {
    uid: 501,
    list: async () =>
      alive
        .map((pid) => line(pid, pid === 100 ? "launcher" : "bun"))
        .concat("999 1 501 S /usr/local/bin/node")
        .join("\n"),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive = alive.filter((id) => id !== pid);
    },
    sleep: async () => {},
  });
  assert.deepEqual(stopped, [100, 101]);
  assert.deepEqual(signals, [
    [101, "SIGTERM"],
    [100, "SIGTERM"],
    [101, "SIGKILL"],
    [100, "SIGKILL"],
  ]);
});

test("handoff does not signal a PID whose executable identity changed", async () => {
  let calls = 0;
  const signals = [];
  await stopInstalledCompanion(bundle, {
    uid: 501,
    list: async () => (++calls === 1 ? line(100, "launcher") : "100 1 501 S /usr/local/bin/node"),
    signal: (pid, value) => signals.push([pid, value]),
    sleep: async () => {},
  });
  assert.deepEqual(signals, []);
});

test("handoff fails rather than declaring an unstoppable process terminated", async () => {
  await assert.rejects(
    stopInstalledCompanion(bundle, {
      uid: 501,
      list: async () => line(100, "launcher"),
      signal: () => {},
      sleep: async () => {},
    }),
    /termination not confirmed/,
  );
});
