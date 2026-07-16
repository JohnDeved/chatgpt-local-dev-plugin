import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

export async function collectFiles(directory, ignoredDirectories, extensions) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectFiles(join(directory, entry.name), ignoredDirectories, extensions)));
      }
    } else if (extensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}
