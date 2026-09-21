import { basename } from "node:path";

export interface CommandAccessPlan {
  readOnly: boolean;
}

const VERSION_EXECUTABLES = new Set([
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "npm.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
]);

const VERSION_FLAGS = new Set(["-v", "--version"]);
const GIT_PREFIX_INSPECTIONS = new Set(["rev-parse", "ls-files", "ls-tree", "show-ref"]);
const GIT_EXACT_INSPECTIONS = new Set([
  "--version",
  "branch",
  "branch\0--show-current",
  "branch\0--list",
  "remote",
  "remote\0-v",
  "remote\0--verbose",
]);
const WORKTREE_LIST_FLAGS = new Set(["--porcelain", "-z", "--verbose"]);

function gitInspection(args: string[]): boolean {
  if (GIT_EXACT_INSPECTIONS.has(args.join("\0"))) return true;
  if (GIT_PREFIX_INSPECTIONS.has(args[0] ?? "")) return true;
  const [scope, action, ...flags] = args;
  return scope === "worktree"
    && action === "list"
    && flags.every((value) => WORKTREE_LIST_FLAGS.has(value));
}

/**
 * Classifies only commands whose behavior is intrinsically inspection-only.
 * Unknown commands stay write-capable so read leases fail closed.
 */
export function commandAccessPlan(argv: string[], background: boolean): CommandAccessPlan {
  if (background || argv.length === 0) return { readOnly: false };
  const executable = basename(argv[0] as string).toLowerCase();
  const args = argv.slice(1);
  if (VERSION_EXECUTABLES.has(executable)) {
    return { readOnly: args.length === 1 && VERSION_FLAGS.has((args[0] as string).toLowerCase()) };
  }
  if (executable === "git" || executable === "git.exe") {
    return { readOnly: gitInspection(args) };
  }
  return { readOnly: false };
}
