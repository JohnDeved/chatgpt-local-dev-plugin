import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { stopInstalledCompanion } from "./companion-handoff.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--install", "--open", "--check"].includes(arg)) throw new Error(`Unknown flag: ${arg}`);
const platform =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
function run(executable, argv, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd: root,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "",
      error = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${executable} exited ${code}: ${error}`)),
    );
  });
}
await run(process.execPath, [join(root, "scripts/assets.mjs")]);
await run(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build"]);
await run(process.execPath, [
  join(root, "node_modules/electrobun/bin/electrobun.cjs"),
  "build",
  "--env=stable",
]);
if (process.platform !== "darwin") {
  if (args.has("--install"))
    throw new Error(
      "Automatic installation currently supports macOS only. The host build was produced, but installation was not attempted.",
    );
  console.log(
    `Desktop host built for ${platform}-${process.arch}; platform installation and native integration are unverified.`,
  );
  process.exit(0);
}
// Stable builds are self-extracting installers. Test/copy their real payload
// without launching that installer or writing to the user's application-support tree.
const artifactName = (await readdir(join(root, "artifacts"))).find(
  (name) => name === `stable-macos-${process.arch}-LocalDev.app.tar.zst`,
);
if (!artifactName) throw new Error("The stable application archive was not produced.");
const payload = join(root, "build", `payload-macos-${process.arch}`);
await rm(payload, { recursive: true, force: true });
await mkdir(payload, { recursive: true });
const tar = join(payload, "application.tar");
await pipeline(
  createReadStream(join(root, "artifacts", artifactName)),
  createZstdDecompress(),
  createWriteStream(tar, { mode: 0o600 }),
);
const entries = await run("/usr/bin/tar", ["-tf", tar], true);
for (const entry of entries.trim().split("\n")) {
  const normalized = entry.replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    !(normalized === "Local Dev.app" || normalized.startsWith("Local Dev.app/"))
  )
    throw new Error("Unexpected path in locally built application archive.");
}
await run("/usr/bin/tar", ["-xf", tar, "-C", payload]);
await unlink(tar);
const bundle = join(payload, "Local Dev.app");
const plist = join(bundle, "Contents", "Info.plist");
await run("/usr/libexec/PlistBuddy", ["-c", "Add :LSUIElement bool true", plist]);
await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
await run(process.execPath, [join(root, "scripts/native-smoke.mjs"), bundle]);
let installed = bundle;
if (args.has("--install")) {
  const applications = join(homedir(), "Applications");
  await mkdir(applications, { recursive: true });
  installed = join(applications, "Local Dev.app");
  let existing = false;
  try {
    const info = await lstat(installed);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Refusing to replace an unexpected application path.");
    const text = await readFile(join(installed, "Contents/Info.plist"), "utf8");
    if (!text.includes("local.dev.menubar") && !text.includes("local.dev.web"))
      throw new Error("Refusing to replace an unrelated application.");
    existing = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = join(applications, `Local Dev.install-${randomUUID()}.app`);
  await cp(bundle, stage, { recursive: true, force: false, errorOnExist: true });
  try {
    const stopped = await stopInstalledCompanion(installed);
    if (stopped.length) console.log(`Replaced companion processes: ${stopped.join(", ")}`);
    if (existing) {
      const backup = join(applications, `Local Dev.previous-native-${Date.now()}.app`);
      await rename(installed, backup);
      console.log(`Previous companion retained at ${backup}`);
    }
    await rename(stage, installed);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(`Installed web-technology companion: ${installed}`);
}
if (args.has("--open")) {
  const launchedAt = Date.now();
  await run("/usr/bin/open", ["-n", installed]);
  if (args.has("--install")) {
    let ready;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const marker = JSON.parse(
          await readFile(join(homedir(), ".local-dev/activity/desktop-ready.json"), "utf8"),
        );
        if (marker.domCommitted === true && Date.parse(marker.timestamp) >= launchedAt - 1000) {
          process.kill(marker.pid, 0);
          ready = marker;
          break;
        }
      } catch {
        /* The new UI may still be initializing. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready)
      throw new Error(
        "Installed app did not confirm a rendered UI. The previous companion backup remains available.",
      );
    console.log("Installed React UI confirmed ready in process " + ready.pid);
  }
}
console.log(`Verified desktop app: ${installed}`);
