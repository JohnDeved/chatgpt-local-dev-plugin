import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

export async function collectFiles(directory, ignoredDirectories, extensions) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...(await collectFiles(join(directory, entry.name), ignoredDirectories, extensions)));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

// Generated applications are independent workspaces, not part of this plugin's checks.
const ownedDirectories = new Set([".github", "desktop", "docs", "examples", "native", "scripts", "src", "test"]);
export async function collectRepositoryFiles(root, ignoredDirectories, extensions) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ownedDirectories.has(entry.name) && !ignoredDirectories.has(entry.name)) {
      files.push(...await collectFiles(join(root, entry.name), ignoredDirectories, extensions));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(join(root, entry.name));
    }
  }
  return files;
}
