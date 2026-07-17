#!/usr/bin/env node

import { runWatchdog } from "./setup/watchdog.js";

runWatchdog().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  process.stderr.write(`[watchdog] ${message}\n`);
  process.exitCode = 1;
});
