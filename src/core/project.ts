import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_LISTED_PROJECTS = 200;
const PROJECT_MARKERS = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

export interface ProjectSummary {
  path: string;
  name: string;
  aliases: string[];
  root: string;
}

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

async function boundedText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function remoteName(url: string): string | undefined {
  const normalized = url.trim().replace(/\/+$/u, "").replace(/\.git$/iu, "");
  const name = normalized.split(/[/:]/u).at(-1)?.trim();
  return name && name !== "." ? name : undefined;
}

async function projectNames(path: string, entries?: Dirent[]): Promise<string[]> {
  const names = new Set<string>([basename(path)]);
  const hasPackage = entries === undefined || entries.some((entry) => entry.name === "package.json" && entry.isFile());
  const hasGit = entries === undefined || entries.some((entry) => entry.name === ".git" && entry.isDirectory());
  if (hasPackage) {
    const source = await boundedText(resolve(path, "package.json"));
    if (source !== undefined) {
      try {
        const name = (JSON.parse(source) as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      } catch {
        // Invalid package metadata does not prevent directory-name discovery.
      }
    }
  }
  if (hasGit) {
    const source = await boundedText(resolve(path, ".git", "config"));
    for (const match of source?.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gmu) ?? []) {
      const name = remoteName(match[1] ?? "");
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
}

function projectLike(entries: Dirent[], depth: number): boolean {
  if (depth === 0) return true;
  return entries.some((entry) => entry.name === ".git" || PROJECT_MARKERS.has(entry.name));
}

export async function listProjects(roots: string[]): Promise<ProjectSummary[]> {
  const projects = new Map<string, ProjectSummary>();
  let visited = 0;
  for (const configuredRoot of roots) {
    const root = await validatedDirectory(configuredRoot, configuredRoot);
    if (root === undefined) continue;
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (queue.length > 0 && visited < MAX_VISITED && projects.size < MAX_LISTED_PROJECTS) {
      const current = queue.shift();
      if (current === undefined) break;
      visited += 1;
      let entries: Dirent[];
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch {
        entries = [];
      }
      if (projectLike(entries, current.depth)) {
        const aliases = await projectNames(current.path, entries);
        projects.set(current.path, {
          path: current.path,
          name: aliases[1] ?? aliases[0] ?? basename(current.path),
          aliases,
          root,
        });
      }
      if (current.depth >= MAX_DEPTH) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
        queue.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
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
      let entries: Dirent[];
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch {
        entries = [];
      }
      const names = await projectNames(current.path, entries);
      if (names.some((name) => name.toLowerCase().includes(needle))) matches.add(current.path);
      if (current.depth >= MAX_DEPTH) continue;
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
