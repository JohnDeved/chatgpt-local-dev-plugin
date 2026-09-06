import assert from "node:assert/strict";
import test from "node:test";
import {
  initialExpansion,
  reconcileExpansion,
  toggleExpansion,
} from "../src/shared/timeline-expansion.ts";
import { compareLines, readEditDiff } from "../src/shared/edit-diff.ts";

function step(id, second, parentId) {
  return {
    id: `runtime:${id}`,
    operationId: id,
    parentId,
    startedAt: `2026-09-05T18:00:${String(second).padStart(2, "0")}.000Z`,
  };
}
const a = step("a", 1),
  b = step("b", 2),
  c = step("c", 3);

test("newest activity opens by default and a newer call closes its predecessor", () => {
  const first = initialExpansion([a, b], true);
  assert.deepEqual([...first.open], [b.id]);
  const next = reconcileExpansion(first, [a, b, c], true);
  assert.deepEqual([...next.open], [c.id]);
  assert.equal(next.newestId, c.id);
});

test("output/status updates do not reopen manually collapsed steps", () => {
  const closed = toggleExpansion(initialExpansion([a, b], true), b.id);
  assert.equal(closed.open.size, 0);
  const update = reconcileExpansion(
    closed,
    [a, { ...b, state: "completed", output: "more output" }],
    true,
  );
  assert.equal(update, closed);
  assert.equal(update.open.size, 0);
});

test("manual mode does not auto-expand arrivals; enabling again follows the latest", () => {
  let value = initialExpansion([a, b], false);
  assert.equal(value.open.size, 0);
  value = toggleExpansion(value, a.id);
  value = reconcileExpansion(value, [a, b, c], false);
  assert.deepEqual([...value.open], [a.id]);
  value = reconcileExpansion(value, [a, b, c], true);
  assert.deepEqual([...value.open], [c.id]);
  value = reconcileExpansion(value, [a, b, c], false);
  assert.deepEqual(
    [...value.open],
    [c.id],
    "Disabling should not abruptly close what the user was reading",
  );
});

test("older history and same-ID reordering do not steal focus", () => {
  let value = toggleExpansion(initialExpansion([a, b], true), b.id);
  value = reconcileExpansion(value, [step("old", 0), a, b], true);
  assert.equal(value.open.size, 0);
  assert.equal(value.newestId, b.id);
  value = reconcileExpansion(value, [b, a], true);
  assert.equal(value.open.size, 0);
  const tie = step("tie", 2);
  value = reconcileExpansion(value, [a, b, tie], true);
  assert.deepEqual([...value.open], [tie.id]);
  value = toggleExpansion(value, tie.id);
  value = reconcileExpansion(value, [tie, a, b], true);
  assert.equal(value.open.size, 0);
  assert.equal(value.newestId, tie.id);
});

test("nested latest calls expand their ancestors and retire the old automatic chain", () => {
  const child = step("child", 4, "a"),
    grandchild = step("grandchild", 5, "child");
  let value = initialExpansion([a, b, child, grandchild], true);
  assert.deepEqual([...value.open], [grandchild.id, child.id, a.id]);
  value = reconcileExpansion(value, [a, b, child, grandchild, step("next", 6)], true);
  assert.deepEqual([...value.open], ["runtime:next"]);
  const cyclic = initialExpansion([step("a", 1, "b"), step("b", 2, "a")], true);
  assert.equal(cyclic.open.size, 2, "Malformed ancestry must not loop forever");
});

test("an empty view starts following once its first real call arrives", () => {
  const value = reconcileExpansion(initialExpansion([], true), [a], true);
  assert.deepEqual([...value.open], [a.id]);
  assert.equal(initialExpansion([], true).newestId, null);
});

const raw = (args, result) =>
  [
    {
      type: "tool.requested",
      operationId: "edit",
      detail: { tool: "serena.replace_content", arguments: args },
    },
    ...(result ? [{ type: "tool.result", operationId: "edit", detail: { result } }] : []),
  ]
    .map(JSON.stringify)
    .join("\n");

test("line diffs preserve exact before and after text, including trailing newlines", () => {
  for (const [before, after] of [
    ["before\nshared\n", "after\nshared\n"],
    ["", "new"],
    ["old", ""],
    ["same", "same"],
    ["🔐\n a'b", "🔐\n changed"],
    ["a\nb\nc", "a\nx\nb\nc"],
    ["A\n".repeat(600), "B\n".repeat(600)],
  ]) {
    const lines = compareLines(before, after);
    assert.equal(
      lines
        .filter((line) => line.kind !== "add")
        .map((line) => line.text)
        .join("\n"),
      before,
    );
    assert.equal(
      lines
        .filter((line) => line.kind !== "remove")
        .map((line) => line.text)
        .join("\n"),
      after,
    );
  }
});

test("literal replacement is labeled requested, not a verified applied diff", () => {
  const diff = readEditDiff(
    raw({ relative_path: "file.ts", mode: "literal", needle: "old", repl: "new" }),
    "edit",
  );
  assert.equal(diff.title, "Requested text diff");
  assert.match(diff.explanation, /does not prove/);
  assert.deepEqual(
    diff.lines.map((line) => line.kind),
    ["remove", "add"],
  );
  assert.equal(diff.path, "file.ts");
});

test("regex patterns and writes without originals are not misrepresented as filesystem before states", () => {
  const pattern = readEditDiff(raw({ mode: "regex", needle: "a.*b", repl: "c" }), "edit");
  assert.equal(pattern.title, "Requested pattern replacement");
  assert.equal(pattern.lines.length, 0);
  assert.equal(pattern.before, "a.*b");
  const file = readEditDiff(
    raw({ relative_path: "file.ts", content: "proposed contents" }),
    "edit",
  );
  assert.equal(file.before, undefined);
  assert.match(file.explanation, /original contents were not captured/);
});

test("tool-returned patches and absent records retain explicit provenance", () => {
  const patch = "--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new\n";
  const diff = readEditDiff(raw({}, { structuredContent: { data: { patch } } }), "edit");
  assert.equal(diff.title, "Tool-reported diff");
  assert.equal(diff.lines.map((line) => line.text).join("\n"), patch);
  assert.equal(readEditDiff(raw({ needle: "a", repl: "b" }), "another-operation"), undefined);
  assert.equal(readEditDiff(raw({ query: "unrelated" }), "edit"), undefined);
  assert.throws(() => readEditDiff("invalid json", "edit"));
});

test("reading suspension is not a preference toggle and cannot reopen a manual collapse", () => {
  const initial = initialExpansion([a, b], true);
  const closed = toggleExpansion(initial, b.id);
  const paused = reconcileExpansion(closed, [a, b], true, true);
  const resumed = reconcileExpansion(paused, [a, b], true, false);
  assert.equal(resumed.open.size, 0);
  const arrivedWhileReading = reconcileExpansion(resumed, [a, b, c], true, true);
  assert.equal(arrivedWhileReading.open.size, 0);
  assert.equal(arrivedWhileReading.newestId, c.id);
  const returnedToView = reconcileExpansion(arrivedWhileReading, [a, b, c], true, false);
  assert.equal(
    returnedToView.open.size,
    0,
    "Returning to the viewport is not an instruction to reopen an action",
  );
  const next = step("next", 4);
  assert.deepEqual(
    [...reconcileExpansion(returnedToView, [a, b, c, next], true, false).open],
    [next.id],
  );
});
