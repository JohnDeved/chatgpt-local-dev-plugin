import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

import { collectRepositoryFiles as collectFiles } from "./files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([".astro", ".git", "dist", "node_modules", ".hutch", "build", "artifacts", "test-results", "playwright-report"]);
const sourceExtensions = new Set([".mjs", ".ts", ".tsx"]);
const violations = [];

function report(path, rule, detail) {
  violations.push(`${relative(root, path)}: ${rule}: ${detail}`);
}

for (const path of await collectFiles(root, ignoredDirectories, sourceExtensions)) {
  const source = await readFile(path, "utf8");
  if (source.includes("\t")) {
    report(path, "no-tabs", "tabs are not allowed");
  }
  if (/\b(?:eval|Function)\s*\(/u.test(source)) {
    report(path, "no-dynamic-code", "dynamic code evaluation is prohibited");
  }

  if (relative(root, path).startsWith("desktop/src/renderer/")) {
    if (/from\s+["'](?:node:|bun|\.\.\/main\/)/u.test(source)) report(path, "renderer-boundary", "renderer code may not import platform or privileged host modules");
    if (source.includes("dangerouslySetInnerHTML")) report(path, "untrusted-output", "render tool output as text, not HTML");
  }
  if (relative(root, path).startsWith("desktop/src/main/")) {
    if (/from\s+["']node:(?:http|https|dgram|tls)["']/u.test(source)) report(path, "no-desktop-server", "no application network server belongs in the desktop host");
    if (source.includes('"node:net"') && relative(root, path) !== "desktop/src/main/service.ts") report(path, "desktop-socket-boundary", "local socket clients belong in the service boundary");
  }
  if (relative(root, path).startsWith("src/")) {
    const prohibitedModules = [
      "node:dgram",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:worker_threads",
    ];
    for (const moduleName of prohibitedModules) {
      // The activity bridge is the sole owner-only Unix socket; no TCP listener is allowed.
      if (moduleName === "node:net" && relative(root, path) === "src/activity.ts") continue;
      if (source.includes(`\"${moduleName}\"`) || source.includes(`'${moduleName}'`)) {
        report(path, "no-prohibited-runtime", `import of ${moduleName}`);
      }
    }
    if (
      source.includes('"node:child_process"') &&
      !["src/core/command.ts", "src/setup/command.ts"].includes(relative(root, path))
    ) {
      report(path, "child-process-boundary", "child_process is restricted to command boundary modules");
    }
    if (
      ["src/core/command.ts", "src/setup/command.ts"].includes(relative(root, path)) &&
      (!source.includes("shell: false") || !source.includes("spawn("))
    ) {
      report(path, "no-shell-strings", "process execution must use spawn with shell: false");
    }
    if (/\.stack\b/u.test(source) && relative(root, path) !== "src/activity.ts") {
      report(path, "no-stack-leak", "raw stack access is prohibited");
    }
    if (/console\.log\s*\(/u.test(source)) {
      report(path, "stdout-reserved", "stdout is reserved for MCP JSON-RPC");
    }
  }
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedDependencies = {
  "@modelcontextprotocol/sdk": "1.29.0",
  "smol-toml": "1.7.0",
  "zod": "4.4.3",
};
if (JSON.stringify(packageJson.dependencies) !== JSON.stringify(expectedDependencies)) {
  violations.push("package.json: runtime-dependencies: dependency set or exact versions changed");
}
const expectedDevDependencies = { "@types/node": "24.13.3", fallow: "3.6.0", typescript: "5.8.3" };
if (JSON.stringify(packageJson.devDependencies) !== JSON.stringify(expectedDevDependencies)) {
  violations.push("package.json: dev-dependencies: dependency set or exact versions changed");
}
if (packageJson.engines?.node !== ">=24.18.0 <25.0.0") {
  violations.push("package.json: node-range: expected >=24.18.0 <25.0.0");
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
