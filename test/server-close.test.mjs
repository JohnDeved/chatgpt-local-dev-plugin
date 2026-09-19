import assert from "node:assert/strict";
import test from "node:test";
import { retryableClose } from "../dist/server.js";

test("server close shares an active attempt and retries after failure", async () => {
  let attempts = 0;
  const close = retryableClose(async () => {
    attempts++;
    if (attempts === 1) throw new Error("CLOSE_NOT_CONFIRMED");
  });
  const first = await Promise.allSettled([close(), close()]);
  assert.deepEqual(first.map(result => result.status), ["rejected", "rejected"]);
  assert.equal(attempts, 1);
  await close();
  await close();
  assert.equal(attempts, 2);
});
