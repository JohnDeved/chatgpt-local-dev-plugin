import { homedir } from "node:os";
import { join } from "node:path";

import type { SetupPaths } from "./types.js";

export function setupPaths(home = homedir()): SetupPaths {
  return {
    home,
    codexConfig: join(home, ".codex", "config.toml"),
    localConfig: join(home, ".local-dev", "config.json"),
    state: join(home, ".local-dev", "setup.json"),
    launchAgent: join(home, "Library", "LaunchAgents", "com.openai.local-dev-tunnel.plist"),
    logDirectory: join(home, ".local-dev", "logs"),
  };
}
