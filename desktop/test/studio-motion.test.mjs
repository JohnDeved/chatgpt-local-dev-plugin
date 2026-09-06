import assert from "node:assert/strict";
import test from "node:test";
import { nextActivityFrame } from "../src/shared/activity-motion.ts";
import {
  initialExpansion,
  revealExpansion,
  reconcileExpansion,
} from "../src/shared/timeline-expansion.ts";
const step = (id, second, state = "running") => ({
  id: `runtime:${id}`,
  operationId: id,
  startedAt: `2026-09-05T17:00:${String(second).padStart(2, "0")}.000Z`,
  state,
});

test("first render does not animate historical rows or celebrate completed work", () => {
  const result = nextActivityFrame(undefined, [step("first", 1, "completed"), step("second", 2)]);
  assert.deepEqual(result.transitions, []);
});
test("only genuinely new, recent identities receive arrival motion", () => {
  const a = step("a", 2),
    b = step("b", 3);
  const initial = nextActivityFrame(undefined, [a]).frame;
  const next = nextActivityFrame(initial, [step("older", 1), a, b]);
  assert.deepEqual(next.transitions, [{ id: b.id, kind: "arrive" }]);
  assert.deepEqual(nextActivityFrame(next.frame, [b, a, step("older", 1)]).transitions, []);
});
test("output updates and repeated completion cannot replay status acknowledgements", () => {
  const a = step("a", 1);
  const initial = nextActivityFrame(undefined, [a]).frame;
  const completed = nextActivityFrame(initial, [{ ...a, state: "completed" }]);
  assert.deepEqual(completed.transitions, [{ id: a.id, kind: "complete" }]);
  const refresh = nextActivityFrame(completed.frame, [
    { ...a, state: "completed", output: "more text", eventCount: 200 },
  ]);
  assert.deepEqual(refresh.transitions, []);
});
test("failed transitions are explicit, while a batch is capped to eight acknowledgements", () => {
  const initial = nextActivityFrame(undefined, [step("a", 1)]).frame;
  assert.deepEqual(nextActivityFrame(initial, [step("a", 1, "failed")]).transitions, [
    { id: "runtime:a", kind: "fail" },
  ]);
  const batch = Array.from({ length: 20 }, (_, i) => step(`new-${i}`, i + 2));
  assert.equal(nextActivityFrame(initial, batch).transitions.length, 8);
});
test("explicit index navigation reveals the correct ancestry without rewriting the newest identity", () => {
  const root = step("root", 1),
    child = { ...step("child", 2), parentId: "root" },
    latest = step("latest", 3);
  const initial = initialExpansion([root, child, latest], true);
  const revealed = revealExpansion(initial, [root, child, latest], child.id);
  assert.ok(revealed.open.has(root.id) && revealed.open.has(child.id));
  assert.equal(revealed.newestId, latest.id);
  const newArrival = step("incoming", 4);
  assert.deepEqual(
    [...reconcileExpansion(revealed, [root, child, latest, newArrival], true).open],
    [newArrival.id],
  );
});
