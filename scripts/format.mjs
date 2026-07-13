import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkOnly = process.argv.includes("--check");
const supportedExtensions = new Set([".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);

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
    if (supportedExtensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function normalize(path, source) {
  let formatted = source.replace(/\r\n?/g, "\n");
  if (extname(path) === ".json") {
    formatted = `${JSON.stringify(JSON.parse(formatted), null, 2)}\n`;
  } else {
    formatted = `${formatted
      .split("\n")
      .map((line) => line.replace(/[\t ]+$/u, ""))
      .join("\n")
      .replace(/\n*$/u, "")}\n`;
  }
  return formatted;
}

const changed = [];
for (const path of (await collect(root)).sort()) {
  const source = await readFile(path, "utf8");
  const formatted = normalize(path, source);
  if (source !== formatted) {
    changed.push(relative(root, path));
    if (!checkOnly) {
      await writeFile(path, formatted, "utf8");
    }
  }
}

if (changed.length > 0 && checkOnly) {
  console.error(`Formatting differs in:\n${changed.map((path) => `- ${path}`).join("\n")}`);
  process.exitCode = 1;
} else if (!checkOnly && changed.length > 0) {
  console.log(`Formatted ${changed.length} file(s).`);
}
