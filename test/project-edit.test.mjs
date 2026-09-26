import assert from "node:assert/strict";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreRuntime } from "../dist/core/runtime.js";
import { coreTools } from "../dist/core/tools.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-dev-edits-")));
  const runtime = new CoreRuntime([root], []);
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.openProject(root, "error");
  const tools = new Map(coreTools(runtime).map((entry) => [entry.tool.name, entry]));
  return { root, runtime, tools };
}

test("native editing tools exist without any optional downstream server", async (t) => {
  const { tools } = await fixture(t);
  for (const name of ["project.write", "project.edit"]) {
    const entry = tools.get(name);
    assert.ok(entry, `${name} must be advertised independently of Serena`);
    assert.equal(entry.tool.annotations.readOnlyHint, false);
    assert.equal(entry.tool.annotations.openWorldHint, false);
    assert.equal(entry.tool.inputSchema.additionalProperties, false);
  }
});

test("create, read and exact edit preserve source whitespace without executable snippets", async (t) => {
  const { root, tools } = await fixture(t);
  const write = tools.get("project.write"), edit = tools.get("project.edit"), read = tools.get("project.read");
  assert.ok(write && edit && read, "Native create/read/edit workflow is required");
  const source = '\uFEFFexport function greet() {\r\n  const text = "café 🟢";\r\n\r\n  return text;\r\n}\r\n';
  const created = await write.call({ path: "src/example.ts", content: source });
  assert.equal(created.structuredContent.ok, true, JSON.stringify(created));
  const loaded = await read.call({ path: "src/example.ts" });
  assert.equal(loaded.structuredContent.data.text, source);
  assert.match(loaded.structuredContent.data.sha256, /^[a-f0-9]{64}$/u);
  const edited = await edit.call({
    path: "src/example.ts", expectedSha256: loaded.structuredContent.data.sha256,
    edits: [{ oldText: '"café 🟢"', newText: '"hello 🟣"' }],
  });
  assert.equal(edited.structuredContent.ok, true, JSON.stringify(edited));
  assert.equal(await readFile(join(root, "src/example.ts"), "utf8"), source.replace('"café 🟢"', '"hello 🟣"'));
});

async function createFile(f, text = "const value = 1;\n") {
  const result = await f.tools.get("project.write").call({ path: "file.ts", content: text });
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
  return result.structuredContent.data;
}

const call = async (f, name, input, context) => (await f.tools.get(name).call(input, context)).structuredContent;
const change = (hash, edits, path = "file.ts") => ({ path, expectedSha256: hash, edits });

test("create-only writes do not clobber existing files; replacements require the read hash", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  assert.equal((await call(f, "project.write", { path: "file.ts", content: "overwrite" })).error.code, "PROJECT_FILE_EXISTS");
  assert.equal((await call(f, "project.write", { path: "file.ts", content: "overwrite", expectedSha256: "0".repeat(64) })).error.code, "PROJECT_FILE_CHANGED");
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "const value = 1;\n");
  const replaced = await call(f, "project.write", { path: "file.ts", content: "new content", expectedSha256: created.sha256 });
  assert.equal(replaced.ok, true); assert.equal(replaced.data.created, false);
  assert.equal(replaced.data.beforeSha256, created.sha256);
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "new content");
});

test("stale edits preserve an external writer's changes", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  await writeFile(join(f.root, "file.ts"), "changed by the developer\n");
  const result = await call(f, "project.edit", change(created.sha256, [{ oldText: "value", newText: "name" }]));
  assert.equal(result.error.code, "PROJECT_FILE_CHANGED");
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "changed by the developer\n");
});

test("a missing later match leaves the entire file unchanged", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  const result = await call(f, "project.edit", change(created.sha256, [
    { oldText: "value", newText: "renamed" }, { oldText: "does not exist", newText: "never written" },
  ]));
  assert.equal(result.error.code, "PROJECT_EDIT_NOT_FOUND"); assert.equal(result.data.edit, 2);
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "const value = 1;\n");
});

test("ambiguous and overlapping matches fail without replacing an arbitrary occurrence", async (t) => {
  const f = await fixture(t), created = await createFile(f, "aaa\nsame same\n");
  for (const oldText of ["aa", "same"]) {
    const result = await call(f, "project.edit", change(created.sha256, [{ oldText, newText: "new" }]));
    assert.equal(result.error.code, "PROJECT_EDIT_AMBIGUOUS");
  }
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "aaa\nsame same\n");
});

test("literal replacements do not interpret dollars, backslashes, shell syntax or regular expressions", async (t) => {
  const f = await fixture(t), created = await createFile(f, "MATCH\nDELETE\n");
  const literal = "$& $1 $` $' \\n $(touch do-not-run) `not code` .*";
  const result = await call(f, "project.edit", change(created.sha256, [
    { oldText: "MATCH", newText: literal }, { oldText: "DELETE\n", newText: "" },
  ]));
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), literal + "\n");
  await assert.rejects(access(join(f.root, "do-not-run")));
});

test("multiple replacements use the evolving text and a single final publication", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  const result = await call(f, "project.edit", change(created.sha256, [
    { oldText: "value", newText: "renamed" }, { oldText: "renamed = 1", newText: "renamed = 2" },
  ]));
  assert.equal(result.ok, true); assert.equal(result.data.editsApplied, 2);
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "const renamed = 2;\n");
});

test("empty files and final-newline choices are preserved; no-op edits retain the inode", async (t) => {
  const f = await fixture(t), created = await createFile(f, "no final newline");
  const old = await stat(join(f.root, "file.ts"));
  const same = await call(f, "project.edit", change(created.sha256, [{ oldText: "newline", newText: "newline" }]));
  assert.equal(same.ok, true); assert.equal(same.data.changed, false);
  assert.equal((await stat(join(f.root, "file.ts"))).ino, old.ino);
  const empty = await call(f, "project.write", { path: "empty.txt", content: "" });
  assert.equal(empty.ok, true); assert.equal(empty.data.bytes, 0);
  assert.equal((await call(f, "project.read", { path: "empty.txt" })).data.text, "");
});

test("publication preserves executable permissions and cleans temporary files", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  await chmod(join(f.root, "file.ts"), 0o751);
  const result = await call(f, "project.edit", change(created.sha256, [{ oldText: "1", newText: "2" }]));
  assert.equal(result.ok, true);
  assert.equal((await stat(join(f.root, "file.ts"))).mode & 0o777, 0o751);
  assert.equal((await readdir(f.root)).some((name) => name.startsWith(".local-dev-")), false);
});

test("parent creation is optional and writes remain project-relative", async (t) => {
  const f = await fixture(t);
  assert.equal((await call(f, "project.write", { path: "missing/file.ts", content: "x", createParents: false })).error.code, "PROJECT_DIRECTORY_MISSING");
  for (const path of ["../escape.txt", "new/../escape.txt", join(f.root, "absolute.txt"), ".git/config", ".GIT/config", "a/.git/config", "a\\b", ".", "nul\0file"]) {
    const result = await call(f, "project.write", { path, content: "x" });
    assert.equal(result.error.code, "INVALID_PROJECT_PATH", JSON.stringify({ path, result }));
  }
  assert.equal((await readdir(f.root)).length, 0);
  assert.equal((await call(f, "project.write", { path: "src/deep/module.ts", content: "x" })).ok, true);
});

test("symlink targets and parent directories cannot redirect writes", async (t) => {
  const f = await fixture(t), outside = await realpath(await mkdtemp(join(tmpdir(), "local-dev-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(outside, join(f.root, "escape"));
  await symlink(join(outside, "sentinel"), join(f.root, "target"));
  await symlink(join(outside, "not-created"), join(f.root, "dangling"));
  await mkdir(join(f.root, "real")); await symlink(join(f.root, "real"), join(f.root, "internal"));
  for (const path of ["escape/new.txt", "escape/new/child.txt", "target", "dangling", "internal/new.txt"]) {
    assert.equal((await call(f, "project.write", { path, content: "bad" })).error.code, "INVALID_PROJECT_PATH");
  }
  assert.deepEqual(await readdir(outside), ["sentinel"]);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
});

test("hard-linked and non-regular targets are refused", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  await link(join(f.root, "file.ts"), join(f.root, "alias.ts"));
  assert.equal((await call(f, "project.write", { path: "file.ts", content: "bad", expectedSha256: created.sha256 })).error.code, "PROJECT_FILE_UNWRITABLE");
  await mkdir(join(f.root, "directory"));
  assert.equal((await call(f, "project.write", { path: "directory", content: "bad" })).error.code, "PROJECT_FILE_UNWRITABLE");
  assert.equal(await readFile(join(f.root, "alias.ts"), "utf8"), "const value = 1;\n");
});

test("byte bounds and UTF-8 validation run before file creation", async (t) => {
  const f = await fixture(t);
  for (const content of ["nul\0byte", "bad\ud800"]) {
    assert.equal((await call(f, "project.write", { path: "not/created.txt", content })).error.code, "PROJECT_FILE_NOT_TEXT");
  }
  assert.equal((await call(f, "project.write", { path: "not/created.txt", content: "é".repeat(600_000) })).error.code, "PROJECT_FILE_TOO_LARGE");
  assert.deepEqual(await readdir(f.root), []);
  await writeFile(join(f.root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(f.root, "binary.txt"), Buffer.from([0, 1, 2]));
  await writeFile(join(f.root, "large.txt"), Buffer.alloc(1_048_577, 65));
  for (const path of ["invalid.txt", "binary.txt"]) assert.equal((await call(f, "project.read", { path })).error.code, "PROJECT_FILE_NOT_TEXT");
  assert.equal((await call(f, "project.read", { path: "large.txt" })).error.code, "PROJECT_FILE_TOO_LARGE");
});

test("invalid schemas, excessive edits and encoded wrappers are not executed", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  const examples = [
    ["project.write", { path: "x", content: 1 }],
    ["project.write", { path: "x", content: "x", overwrite: true }],
    ["project.write", { path: "x", content: "x", expectedSha256: "bad" }],
    ["project.write", { path: "x", content: "x", createParents: "true" }],
    ["project.edit", change(created.sha256, [])],
    ["project.edit", change(created.sha256, Array(101).fill({ oldText: "x", newText: "y" }))],
    ["project.edit", change(created.sha256, [{ oldText: "", newText: "x" }])],
    ["project.edit", change(created.sha256, [{ oldText: "value", newText: "x", regex: true }])],
    ["project.edit", { path: "file.ts", edits: [{ oldText: "value", newText: "x" }] }],
  ];
  for (const [name, input] of examples) assert.equal((await call(f, name, input)).error.code, "INVALID_ARGUMENTS");
  assert.deepEqual(await readdir(f.root), ["file.ts"]);
});

test("cancellation writes no file, and read-only sessions cannot edit", async (t) => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  const cancelled = await call(f, "project.write", { path: "cancelled.txt", content: "x" }, { signal: controller.signal });
  assert.equal(cancelled.error.code, "OPERATION_CANCELLED");
  assert.deepEqual(await readdir(f.root), []);
  await f.runtime.openProject(f.root, "error", undefined, "reader", { mode: "read" });
  assert.equal((await call(f, "project.write", { path: "reader.txt", content: "bad" }, { runOwner: "reader" })).error.code, "PROJECT_READ_ONLY");
  assert.equal((await call(f, "project.write", { path: "unknown.txt", content: "bad" }, { runOwner: "unknown" })).error.code, "NO_ACTIVE_PROJECT");
  assert.deepEqual(await readdir(f.root), []);
});

test("same-session concurrent edits cannot silently overwrite each other", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  const results = await Promise.all([2, 3].map((number) => call(f, "project.edit", change(created.sha256, [{ oldText: "1", newText: String(number) }]))));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).error.code, "PROJECT_FILE_CHANGED");
});


test("exact byte limit succeeds and an oversized edited result leaves the original intact", async (t) => {
  const f = await fixture(t), source = "X" + "a".repeat(1_048_575);
  const created = await createFile(f, source);
  const loaded = await call(f, "project.read", { path: "file.ts" });
  assert.equal(loaded.data.bytes, 1_048_576);
  assert.equal(loaded.data.text, source);
  const oversized = await call(f, "project.edit", change(created.sha256, [{ oldText: "X", newText: "XX" }]));
  assert.equal(oversized.error.code, "PROJECT_FILE_TOO_LARGE");
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), source);
});

test("combined edit payload is bounded before any edit is applied", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  const edits = Array.from({ length: 3 }, () => ({ oldText: "x".repeat(400_000), newText: "y".repeat(400_000) }));
  const result = await call(f, "project.edit", change(created.sha256, edits));
  assert.equal(result.error.code, "PROJECT_EDIT_TOO_LARGE");
  assert.equal(await readFile(join(f.root, "file.ts"), "utf8"), "const value = 1;\n");
});

test("an expected existing file is not recreated after deletion", async (t) => {
  const f = await fixture(t), created = await createFile(f);
  await rm(join(f.root, "file.ts"));
  const result = await call(f, "project.write", { path: "file.ts", content: "replacement", expectedSha256: created.sha256 });
  assert.equal(result.error.code, "PROJECT_ENTRY_NOT_FOUND");
  assert.deepEqual(await readdir(f.root), []);
});
