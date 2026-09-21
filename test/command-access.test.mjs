import assert from "node:assert/strict";
import test from "node:test";

import { commandAccessPlan } from "../dist/core/command-access.js";

const read = (argv, background = false) => commandAccessPlan(argv, background).readOnly;

test("classifies only intrinsic inspection commands as read-only", () => {
  assert.equal(read(["node", "--version"]), true);
  assert.equal(read(["npm", "-v"]), true);
  assert.equal(read(["python3", "--version"]), true);
  assert.equal(read(["git", "--version"]), true);
  assert.equal(read(["git", "rev-parse", "--short", "HEAD"]), true);
  assert.equal(read(["git", "branch", "--show-current"]), true);
  assert.equal(read(["git", "remote", "-v"]), true);
  assert.equal(read(["git", "worktree", "list", "--porcelain"]), true);
  assert.equal(read(["git", "ls-files"]), true);

  assert.equal(read(["node", "-e", "process.exit(0)"]), false);
  assert.equal(read(["npm", "test"]), false);
  assert.equal(read(["git", "status", "--short"]), false);
  assert.equal(read(["git", "diff"]), false);
  assert.equal(read(["git", "branch", "-D", "topic"]), false);
  assert.equal(read(["git", "remote", "set-url", "origin", "example"]), false);
  assert.equal(read(["node", "--version"], true), false);
});
