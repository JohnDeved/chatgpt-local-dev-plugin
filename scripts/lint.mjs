import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([".astro", ".git", "dist", "node_modules"]);
const sourceExtensions = new Set([".mjs", ".ts"]);
const violations = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collect(join(directory, entry.name))));
      }
      continue;
    }
    if (sourceExtensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function report(path, rule, detail) {
  violations.push(`${relative(root, path)}: ${rule}: ${detail}`);
}

for (const path of await collect(root)) {
  const source = await readFile(path, "utf8");
  if (source.includes("\t")) {
    report(path, "no-tabs", "tabs are not allowed");
  }
  if (/\b(?:eval|Function)\s*\(/u.test(source)) {
    report(path, "no-dynamic-code", "dynamic code evaluation is prohibited");
  }

  if (relative(root, path).startsWith("src/")) {
    const prohibitedModules = [
      "node:dgram",
      "node:https",
      "node:net",
      "node:tls",
      "node:worker_threads",
    ];
    for (const moduleName of prohibitedModules) {
      if (source.includes(`\"${moduleName}\"`) || source.includes(`'${moduleName}'`)) {
        report(path, "no-prohibited-runtime", `import of ${moduleName}`);
      }
    }
    if (
      source.includes('"node:http"') &&
      relative(root, path) !== "src/dashboard.ts"
    ) {
      report(path, "http-boundary", "node:http is restricted to the loopback dashboard");
    }
    if (
      relative(root, path) === "src/dashboard.ts" &&
      (!source.includes('server.listen(0, "127.0.0.1"') || !source.includes("randomBytes(24)"))
    ) {
      report(path, "loopback-dashboard", "dashboard must bind an ephemeral loopback port behind a random URL token");
    }
    if (
      source.includes('"node:child_process"') &&
      !["src/core/process.ts", "src/setup/command.ts"].includes(relative(root, path))
    ) {
      report(path, "child-process-boundary", "child_process is restricted to core/process.ts");
    }
    if (
      ["src/core/process.ts", "src/setup/command.ts"].includes(relative(root, path)) &&
      (!source.includes("shell: false") || !source.includes("spawn("))
    ) {
      report(path, "no-shell-strings", "process execution must use spawn with shell: false");
    }
    if (/\.stack\b/u.test(source)) {
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
const expectedDevDependencies = { "@types/node": "22.20.1", typescript: "5.8.3" };
if (JSON.stringify(packageJson.devDependencies) !== JSON.stringify(expectedDevDependencies)) {
  violations.push("package.json: dev-dependencies: dependency set or exact versions changed");
}
if (packageJson.engines?.node !== ">=22.16.0 <23.0.0") {
  violations.push("package.json: node-range: expected >=22.16.0 <23.0.0");
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
