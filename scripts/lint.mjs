import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
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
      "node:child_process",
      "node:dgram",
      "node:http",
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
    if (/\.stack\b/u.test(source)) {
      report(path, "no-stack-leak", "raw stack access is prohibited");
    }
    if (/\bfetch\s*\(/u.test(source)) {
      report(path, "no-network", "Phase 1 server must not make network calls");
    }
    if (/console\.log\s*\(/u.test(source)) {
      report(path, "stdout-reserved", "stdout is reserved for MCP JSON-RPC");
    }
  }
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
  violations.push("package.json: runtime-dependencies: Phase 1 must remain zero-runtime-dependency");
}
const expectedDevDependencies = { typescript: "5.8.3" };
if (JSON.stringify(packageJson.devDependencies) !== JSON.stringify(expectedDevDependencies)) {
  violations.push("package.json: dev-dependencies: expected only typescript@5.8.3");
}
if (packageJson.engines?.node !== ">=22.16.0 <23.0.0") {
  violations.push("package.json: node-range: expected >=22.16.0 <23.0.0");
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
