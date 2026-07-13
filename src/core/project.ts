import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const IGNORED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "Library",
]);
const MAX_VISITED = 4096;
const MAX_DEPTH = 4;

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function validatedDirectory(root: string, candidate: string): Promise<string | undefined> {
  try {
    const rootReal = await realpath(root);
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    const candidateReal = await realpath(candidate);
    return inside(rootReal, candidateReal) ? candidateReal : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveProject(query: string, roots: string[]): Promise<string[]> {
  const normalized = query.trim();
  if (normalized.length === 0) return [];
  const directMatches: string[] = [];
  for (const root of roots) {
    const candidate = isAbsolute(normalized) ? normalized : resolve(root, normalized);
    const match = await validatedDirectory(root, candidate);
    if (match !== undefined) directMatches.push(match);
  }
  if (directMatches.length > 0) return [...new Set(directMatches)].sort();

  const needle = normalized.toLowerCase();
  const matches = new Set<string>();
  let visited = 0;
  for (const configuredRoot of roots) {
    const root = await validatedDirectory(configuredRoot, configuredRoot);
    if (root === undefined) continue;
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (queue.length > 0 && visited < MAX_VISITED) {
      const current = queue.shift();
      if (current === undefined) break;
      visited += 1;
      if (basename(current.path).toLowerCase().includes(needle)) matches.add(current.path);
      if (current.depth >= MAX_DEPTH) continue;
      let entries;
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
        queue.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return [...matches].sort();
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
