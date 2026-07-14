import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { beginCommandDiff, beginWorkingTreeDiff, finishDiff } from "../dist/core/diff.js";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  await exec("git", args, { cwd });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "local-dev-diff-test-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Local Dev Test");
  await git(root, "config", "user.email", "local-dev@example.invalid");
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-qm", "initial");
  return root;
}

test("captures only command-induced changes from an already dirty worktree", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "tracked.txt"), "preexisting\n", "utf8");
    await writeFile(join(root, "preexisting.txt"), "before\n", "utf8");
    const capture = await beginCommandDiff(root);

    await writeFile(join(root, "tracked.txt"), "after\n", "utf8");
    await unlink(join(root, "preexisting.txt"));
    await writeFile(join(root, "created.txt"), "created\n", "utf8");
    await writeFile(join(root, "credentials.json"), "SECRET=value\n", "utf8");

    const result = await finishDiff(capture);
    assert.equal(result.summary.state, "ready");
    assert.equal(result.summary.fileCount, 4);
    const files = new Map(result.summary.files.map((file) => [file.path, file]));
    assert.equal(files.get("tracked.txt").status, "modified");
    assert.equal(files.get("preexisting.txt").status, "deleted");
    assert.equal(files.get("created.txt").status, "added");
    assert.equal(files.get("credentials.json").status, "added");
    assert.equal(files.get("credentials.json").sensitive, true);
    assert.equal(files.get("credentials.json").patchAvailable, false);

    const details = new Map(result.details.files.map((file) => [file.path, file]));
    assert.match(details.get("tracked.txt").patch, /-preexisting/u);
    assert.match(details.get("tracked.txt").patch, /\+after/u);
    assert.match(details.get("created.txt").patch, /\+created/u);
    assert.equal(details.get("credentials.json").patch, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captures the cumulative working-tree diff relative to HEAD", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "created.txt"), "created\n", "utf8");
    const result = await finishDiff(await beginWorkingTreeDiff(root));
    assert.equal(result.summary.state, "ready");
    assert.equal(result.summary.fileCount, 2);
    assert.deepEqual(
      result.summary.files.map(({ path, status }) => ({ path, status })).sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: "created.txt", status: "added" },
        { path: "tracked.txt", status: "modified" },
      ],
    );
    assert.equal(result.summary.additions, 2);
    assert.equal(result.summary.deletions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
