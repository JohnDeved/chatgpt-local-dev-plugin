import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, relative } from "node:path";

import { collectRepositoryFiles as collectFiles } from "./files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkOnly = process.argv.includes("--check");
const supportedExtensions = new Set([".json", ".md", ".mjs", ".ts", ".tsx", ".css", ".html", ".swift", ".yaml", ".yml"]);
const ignoredDirectories = new Set([".astro", ".git", ".tmp-comment-check", "dist", "node_modules", ".hutch", "build", "artifacts", "test-results", "playwright-report"]);

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
for (const path of (await collectFiles(root, ignoredDirectories, supportedExtensions)).sort()) {
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
