import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./command.js";
import { removeFile, writeAtomic } from "./files.js";
import type { SetupPaths } from "./types.js";

const LABEL = "com.openai.local-dev-tunnel";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function launchAgentPlist(program: string, args: string[], paths: SetupPaths): string {
  const argumentsXml = [program, ...args].map((value) => `    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(paths.logDirectory, "launch-agent.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logDirectory, "launch-agent.err.log"))}</string>
</dict>
</plist>
`;
}

function domain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("UNSUPPORTED_PLATFORM");
  return `gui/${uid}`;
}

type Runner = typeof runCommand;

export async function installLaunchAgent(paths: SetupPaths, program: string, args: string[], runner: Runner = runCommand): Promise<void> {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_PLATFORM");
  await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
  await writeAtomic(paths.launchAgent, launchAgentPlist(program, args, paths));
  await runner("/bin/launchctl", ["bootout", domain(), paths.launchAgent]).catch(() => undefined);
  const loaded = await runner("/bin/launchctl", ["bootstrap", domain(), paths.launchAgent]);
  if (loaded.code !== 0) {
    await removeFile(paths.launchAgent);
    throw new Error("SERVICE_INSTALL_FAILED");
  }
  await runner("/bin/launchctl", ["enable", `${domain()}/${LABEL}`]);
}

export async function removeLaunchAgent(paths: SetupPaths, runner: Runner = runCommand): Promise<void> {
  if (process.platform === "darwin") {
    await runner("/bin/launchctl", ["bootout", domain(), paths.launchAgent]).catch(() => undefined);
  }
  await removeFile(paths.launchAgent);
}

export async function launchAgentLoaded(runner: Runner = runCommand): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const result = await runner("/bin/launchctl", ["print", `${domain()}/${LABEL}`]).catch(() => ({ code: 1 }));
  return result.code === 0;
}

export async function openUrl(url: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await runCommand("/usr/bin/open", [url]).catch(() => undefined);
}
