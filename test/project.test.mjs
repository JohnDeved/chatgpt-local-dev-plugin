import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveProject } from "../dist/core/project.js";
import { CoreRuntime } from "../dist/core/runtime.js";
import { isPathInside } from "../dist/path.js";

test("resolves renamed projects by package and Git remote names", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-project-"));
  const project = join(root, "worker-review");
  try {
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "chatgpt-local-dev-plugin" }), "utf8");
    await writeFile(join(project, ".git", "config"), '[remote "origin"]\n  url = git@github.com:JohnDeved/remote-project.git\n', "utf8");

    const canonical = await realpath(project);
    assert.deepEqual(await resolveProject("chatgpt-local-dev-plugin", [root]), [canonical]);
    assert.deepEqual(await resolveProject("remote-project", [root]), [canonical]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves metadata aliases when the configured root is the project", async () => {
  const project = await mkdtemp(join(tmpdir(), "local-dev-renamed-"));
  try {
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "configured-project" }), "utf8");
    assert.deepEqual(await resolveProject("configured-project", [project]), [await realpath(project)]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});


test("checks path containment without prefix collisions", () => {
  assert.equal(isPathInside("/work/project", "/work/project"), true);
  assert.equal(isPathInside("/work/project", "/work/project/packages/web"), true);
  assert.equal(isPathInside("/work/project", "/work/project-copy"), false);
  assert.equal(isPathInside("/work/project", "/work"), false);
});

test("keeps created projects and cleans temporary projects on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-runtime-"));
  const runtime = new CoreRuntime([root], []);
  try {
    const created = await runtime.openProject("durable", "create");
    assert.equal(created.structuredContent.data.kind, "created");
    const createdPath = created.structuredContent.data.path;
    await access(createdPath);

    const temporary = await runtime.openProject("scratch", "temporary");
    assert.equal(temporary.structuredContent.data.kind, "temporary");
    const temporaryPath = temporary.structuredContent.data.path;
    await access(temporaryPath);

    await runtime.close();
    await access(createdPath);
    await assert.rejects(access(temporaryPath));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
