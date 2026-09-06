import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--check", "--install", "--open", "--login", "--request-reconnect"].includes(flag)) throw new Error(`Unknown flag: ${flag}`);
}
if (process.platform !== "darwin") {
  if (flags.has("--check")) {
    console.log("Native menu-bar checks SKIPPED: macOS and the Swift toolchain are required.");
    process.exit(0);
  }
  throw new Error("The native menu-bar app requires macOS.");
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, shell: false, stdio: "inherit", env: { ...process.env, LOCAL_DEV_TEST_NODE: process.execPath, LOCAL_DEV_NATIVE_PREVIEW_DIR: join(root, "build", "menu-bar", "previews") } });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable} failed: ${code ?? signal}`)));
  });
}

const bundle = join(root, "build", "menu-bar", "Local Dev.app");
const contents = join(bundle, "Contents");
const executable = join(contents, "MacOS", "LocalDevMenu");
await mkdir(join(contents, "MacOS"), { recursive: true });
await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.dev.menubar</string>
<key>CFBundleName</key><string>Local Dev</string>
<key>CFBundleDisplayName</key><string>Local Dev</string>
<key>CFBundleExecutable</key><string>LocalDevMenu</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.3.0</string>
<key>CFBundleVersion</key><string>4</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
const sources = (await readdir(join(root, "native"))).filter((name) => name.endsWith(".swift")).sort().map((name) => join(root, "native", name));
console.log("Building the native Local Dev menu-bar app…");
await run("/usr/bin/xcrun", [
  "swiftc", "-swift-version", "5", "-parse-as-library", flags.has("--check") ? "-Onone" : "-O", "-module-name", "LocalDevMenu",
  "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
  "-framework", "AppKit", "-framework", "SwiftUI", "-framework", "ServiceManagement",
  ...sources, "-o", executable,
]);
await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "local.dev.menubar", bundle]);
if (flags.has("--check") || flags.has("--install")) {
  await run(executable, ["--self-test"]);
  await run(process.execPath, [join(root, "scripts", "run-native-smoke.mjs"), executable]);
}
let target = bundle;
if (flags.has("--install")) {
  const applications = join(homedir(), "Applications");
  await mkdir(applications, { recursive: true });
  target = join(applications, "Local Dev.app");
  let existing;
  try { existing = await readFile(join(target, "Contents", "Info.plist"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined) {
    if (!existing.includes("local.dev.menubar")) throw new Error("Refusing to replace an unrelated Local Dev.app");
    const backup = join(applications, `Local Dev.previous-${Date.now()}.app`);
    await rename(target, backup);
    console.log(`Previous app retained at ${backup}`);
  }
  await cp(bundle, target, { recursive: true, errorOnExist: true, force: false });
  console.log(`Installed ${target}`);
}
if (flags.has("--login")) await run(join(target, "Contents", "MacOS", "LocalDevMenu"), ["--register-login"]);
if (flags.has("--open")) await run("/usr/bin/open", ["-n", target, "--args", "--replace-running", ...(flags.has("--request-reconnect") ? ["--request-reconnect"] : [])]);
console.log(`Menu-bar app: ${target}`);
