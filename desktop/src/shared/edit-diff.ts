import { object, string } from "./contracts.ts";

export interface DiffLine {
  kind: "context" | "add" | "remove" | "meta";
  text: string;
  before?: number;
  after?: number;
}
export interface EditDiff {
  title: string;
  path: string;
  explanation: string;
  lines: DiffLine[];
  before?: string;
  after?: string;
}

/** Bounded LCS for small excerpts; large edits retain all lines using a linear block diff. */
export function compareLines(before: string, after: string): DiffLine[] {
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");
  const result: DiffLine[] = [];
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    result.push({ kind: "context", text: left[prefix], before: prefix + 1, after: prefix + 1 });
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const a = left.slice(prefix, left.length - suffix),
    b = right.slice(prefix, right.length - suffix);
  let x = 0,
    y = 0;
  if ((a.length + 1) * (b.length + 1) <= 250000) {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i][j] =
          a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    while (x < a.length || y < b.length) {
      if (x < a.length && y < b.length && a[x] === b[y]) {
        result.push({ kind: "context", text: a[x], before: prefix + x + 1, after: prefix + y + 1 });
        x++;
        y++;
      } else if (x < a.length && (y === b.length || table[x + 1][y] >= table[x][y + 1])) {
        result.push({ kind: "remove", text: a[x], before: prefix + x + 1 });
        x++;
      } else {
        result.push({ kind: "add", text: b[y], after: prefix + y + 1 });
        y++;
      }
    }
  } else {
    result.push(
      ...a.map((text, i): DiffLine => ({ kind: "remove", text, before: prefix + i + 1 })),
      ...b.map((text, i): DiffLine => ({ kind: "add", text, after: prefix + i + 1 })),
    );
  }
  for (let i = suffix; i > 0; i--)
    result.push({
      kind: "context",
      text: left[left.length - i],
      before: left.length - i + 1,
      after: right.length - i + 1,
    });
  return result;
}

function returnedPatch(value: unknown, depth = 0): string | undefined {
  if (depth > 7) return;
  if (typeof value === "string") {
    if (/^(diff --git |--- |@@ -\d)/m.test(value)) return value;
    if (/^\s*[\[{]/.test(value)) {
      try {
        return returnedPatch(JSON.parse(value), depth + 1);
      } catch {
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const patch = returnedPatch(item, depth + 1);
      if (patch) return patch;
    }
    return;
  }
  const data = object(value);
  for (const key of [
    "patch",
    "diff",
    "unifiedDiff",
    "changes",
    "files",
    "data",
    "structuredContent",
    "content",
    "text",
  ]) {
    if (key in data) {
      const patch = returnedPatch(data[key], depth + 1);
      if (patch) return patch;
    }
  }
}
export function readEditDiff(raw: string, operationId: string): EditDiff | undefined {
  const events = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)))
    .filter((event) => event.operationId === operationId);
  const request = events.find((event) => event.type === "tool.requested");
  const args = object(object(request?.detail).arguments);
  const path = string(args.relative_path ?? args.path ?? args.file_path, "Recorded edit");
  // Returned patches are shown as tool-reported evidence, not independently verified state.
  for (const event of events.filter((event) => event.type === "tool.result")) {
    const patch = returnedPatch(object(event.detail).result);
    if (patch)
      return {
        title: "Tool-reported diff",
        path,
        explanation:
          "This patch was returned by the tool. It has not been independently reconstructed from the filesystem.",
        lines: patch.split("\n").map((text): DiffLine => ({
          kind:
            text.startsWith("+++") ||
            text.startsWith("---") ||
            text.startsWith("@@") ||
            text.startsWith("diff ")
              ? "meta"
              : text.startsWith("+")
                ? "add"
                : text.startsWith("-")
                  ? "remove"
                  : "context",
          text,
        })),
      };
  }
  if (typeof args.needle === "string" && typeof args.repl === "string") {
    if (args.mode === "regex")
      return {
        title: "Requested pattern replacement",
        path,
        explanation:
          "The find value is a regular expression, not captured original text. No filesystem before/after is inferred.",
        before: args.needle,
        after: args.repl,
        lines: [],
      };
    return {
      title: "Requested text diff",
      path,
      explanation:
        "Compared from the recorded find/replacement text. Line numbers refer to the excerpt, not the file. This does not prove the edit was applied.",
      before: args.needle,
      after: args.repl,
      lines: compareLines(args.needle, args.repl),
    };
  }
  const content = args.content ?? args.body;
  if (typeof content === "string")
    return {
      title: "Requested file contents",
      path,
      explanation:
        "The original contents were not captured for this action. This shows the proposed text, not a verified before/after diff.",
      after: content,
      lines: [],
    };
  return;
}
