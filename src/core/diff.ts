import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { spawnCommand } from "./command.js";

const MAX_FILES = 50;
const MAX_PATCH_CHARS = 256 * 1024;
const MAX_FILE_PATCH_CHARS = 64 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$/iu;

export type DiffStatus = "added" | "copied" | "deleted" | "modified" | "renamed" | "type-changed" | "unmerged" | "unknown";

export interface DiffFileSummary {
  path: string;
  previousPath?: string;
  status: DiffStatus;
  binary: boolean;
  sensitive: boolean;
  patchAvailable: boolean;
  truncated: boolean;
}

export interface DiffSummary {
  state: "pending" | "ready" | "unavailable";
  reason?: string;
  repositoryRoot?: string;
  fileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  files: DiffFileSummary[];
}

export interface DiffFileDetails extends DiffFileSummary {
  patch?: string;
}

export interface DiffDetails {
  files: DiffFileDetails[];
}

export interface DiffResult {
  summary: DiffSummary;
  details?: DiffDetails;
}

export interface DiffCapture {
  state: "active" | "unavailable";
  reason?: string;
  repositoryRoot?: string;
  pathspec?: string;
  indexPath?: string;
  temporaryDirectory?: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface RawChange {
  status: DiffStatus;
  path: string;
  previousPath?: string;
}

function unavailable(reason: string): DiffCapture {
  return { state: "unavailable", reason };
}

export function unavailableDiff(reason: string): DiffResult {
  return {
    summary: {
      state: "unavailable",
      reason,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      truncated: false,
      files: [],
    },
  };
}

export function pendingDiff(capture: DiffCapture): DiffResult {
  if (capture.state === "unavailable") return unavailableDiff(capture.reason ?? "DIFF_UNAVAILABLE");
  return {
    summary: {
      state: "pending",
      ...(capture.repositoryRoot === undefined ? {} : { repositoryRoot: capture.repositoryRoot }),
      fileCount: 0,
      additions: 0,
      deletions: 0,
      truncated: false,
      files: [],
    },
  };
}

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  maxOutputChars = 1024 * 1024,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawnCommand(["git", ...args], cwd, env);
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let finished = false;
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGTERM");
    }, GIT_TIMEOUT_MS);
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const value = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length < maxOutputChars) stdout += value.slice(0, maxOutputChars - stdout.length);
        if (stdout.length >= maxOutputChars && value.length > 0) truncated = true;
      } else {
        if (stderr.length < 16_384) stderr += value.slice(0, 16_384 - stderr.length);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, truncated });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, truncated });
    });
  });
}

async function prepareCapture(cwd: string, baseline: "working-tree" | "head"): Promise<DiffCapture> {
  const rootResult = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (rootResult.code !== 0) return unavailable("NOT_A_GIT_REPOSITORY");
  const reportedRoot = rootResult.stdout.trim();
  if (reportedRoot.length === 0) return unavailable("NOT_A_GIT_REPOSITORY");
  const repositoryRoot = await realpath(reportedRoot).catch(() => reportedRoot);
  const projectRoot = await realpath(cwd).catch(() => cwd);
  const projectRelative = relative(repositoryRoot, projectRoot);
  if (projectRelative.startsWith("..")) return unavailable("PROJECT_OUTSIDE_GIT_ROOT");
  const pathspec = projectRelative === "" ? "." : projectRelative;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "local-dev-diff-"));
  const indexPath = join(temporaryDirectory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  let read = await runGit(["read-tree", "HEAD"], repositoryRoot, env);
  if (read.code !== 0) read = await runGit(["read-tree", "--empty"], repositoryRoot, env);
  if (read.code !== 0) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    return unavailable("GIT_BASELINE_FAILED");
  }
  if (baseline === "working-tree") {
    const staged = await runGit(["add", "-A", "--", pathspec], repositoryRoot, env);
    if (staged.code !== 0) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      return unavailable("GIT_BASELINE_FAILED");
    }
  }
  return { state: "active", repositoryRoot, pathspec, indexPath, temporaryDirectory };
}

export function beginCommandDiff(cwd: string): Promise<DiffCapture> {
  return prepareCapture(cwd, "working-tree");
}

export function beginWorkingTreeDiff(cwd: string): Promise<DiffCapture> {
  return prepareCapture(cwd, "head");
}

function statusFromCode(code: string): DiffStatus {
  switch (code[0]) {
    case "A": return "added";
    case "C": return "copied";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "T": return "type-changed";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

function parseNameStatus(value: string): RawChange[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? "";
    const status = statusFromCode(code);
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath !== undefined && path !== undefined) changes.push({ status, path, previousPath });
    } else {
      const path = fields[index++];
      if (path !== undefined) changes.push({ status, path });
    }
  }
  return changes;
}

function parseTotals(value: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of value.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t/u.exec(line);
    if (match === null) continue;
    if (match[1] !== "-") additions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  return { additions, deletions };
}

function summaryFile(change: RawChange, patch: string | undefined, truncated: boolean): DiffFileDetails {
  const sensitive = SENSITIVE_PATH.test(change.path) || (change.previousPath !== undefined && SENSITIVE_PATH.test(change.previousPath));
  const binary = patch !== undefined && /^(?:Binary files .* differ|GIT binary patch)$/mu.test(patch);
  const patchAvailable = patch !== undefined && !binary && !sensitive;
  return {
    path: change.path,
    ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
    status: change.status,
    binary,
    sensitive,
    patchAvailable,
    truncated,
    ...(patchAvailable ? { patch } : {}),
  };
}

async function filePatch(capture: Required<Pick<DiffCapture, "repositoryRoot" | "pathspec" | "indexPath">>, change: RawChange): Promise<{ patch?: string; truncated: boolean }> {
  if (SENSITIVE_PATH.test(change.path) || (change.previousPath !== undefined && SENSITIVE_PATH.test(change.previousPath))) {
    return { truncated: false };
  }
  const paths = change.previousPath === undefined ? [change.path] : [change.previousPath, change.path];
  const result = await runGit(
    ["diff", "--no-ext-diff", "--no-color", "--find-renames=50%", "--find-copies=50%", "--unified=3", "--", ...paths],
    capture.repositoryRoot,
    { ...process.env, GIT_INDEX_FILE: capture.indexPath },
    MAX_FILE_PATCH_CHARS,
  );
  return { patch: result.stdout, truncated: result.truncated };
}

export async function finishDiff(capture: DiffCapture): Promise<DiffResult> {
  if (capture.state === "unavailable") return unavailableDiff(capture.reason ?? "DIFF_UNAVAILABLE");
  const repositoryRoot = capture.repositoryRoot as string;
  const pathspec = capture.pathspec as string;
  const indexPath = capture.indexPath as string;
  const temporaryDirectory = capture.temporaryDirectory as string;
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const untracked = await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec],
      repositoryRoot,
      env,
    );
    const newFiles = untracked.stdout.split("\0").filter((path) => path.length > 0);
    for (let index = 0; index < newFiles.length; index += 200) {
      await runGit(["add", "-N", "--", ...newFiles.slice(index, index + 200)], repositoryRoot, env);
    }
    const names = await runGit(
      ["diff", "--name-status", "-z", "--find-renames=50%", "--find-copies=50%", "--", pathspec],
      repositoryRoot,
      env,
    );
    if (names.code !== 0) return unavailableDiff("GIT_DIFF_FAILED");
    const changes = parseNameStatus(names.stdout);
    const totalsResult = await runGit(["diff", "--numstat", "--", pathspec], repositoryRoot, env);
    const totals = parseTotals(totalsResult.stdout);
    const selected = changes.slice(0, MAX_FILES);
    const details: DiffFileDetails[] = [];
    let remaining = MAX_PATCH_CHARS;
    let truncated = names.truncated || changes.length > selected.length;
    for (const change of selected) {
      if (remaining <= 0) {
        details.push(summaryFile(change, undefined, true));
        truncated = true;
        continue;
      }
      const generated = await filePatch({ repositoryRoot, pathspec, indexPath }, change);
      let patch = generated.patch;
      let fileTruncated = generated.truncated;
      if (patch !== undefined && patch.length > remaining) {
        patch = patch.slice(0, remaining);
        fileTruncated = true;
      }
      remaining -= patch?.length ?? 0;
      if (fileTruncated) truncated = true;
      details.push(summaryFile(change, patch, fileTruncated));
    }
    const files = details.map(({ patch: _patch, ...file }) => file);
    return {
      summary: {
        state: "ready",
        repositoryRoot,
        fileCount: changes.length,
        additions: totals.additions,
        deletions: totals.deletions,
        truncated,
        files,
      },
      details: { files: details },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
