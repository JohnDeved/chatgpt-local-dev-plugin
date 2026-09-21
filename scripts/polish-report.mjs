import { spawnSync } from "node:child_process";

const reports = [
  ["dead-code", []],
  ["dupes", []],
  ["health", ["--score", "--targets", "--report-only"]],
];

let failed = false;

for (const [command, args] of reports) {
  const result = spawnSync("fallow", [command, ...args], {
    env: process.env,
    shell: false,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    console.error(`fallow ${command} could not be started: ${result.error.message}`);
    failed = true;
    continue;
  }
  if (result.signal !== null) {
    console.error(`fallow ${command} terminated by ${result.signal}`);
    failed = true;
    continue;
  }
  // Fallow uses exit 1 when a report contains findings. The audit step has already
  // enforced changed-file regressions, so the report tail should stay informational.
  if (result.status !== 0 && result.status !== 1) {
    console.error(`fallow ${command} failed with exit code ${result.status ?? "unknown"}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
