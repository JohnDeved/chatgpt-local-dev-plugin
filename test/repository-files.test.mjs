import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { collectRepositoryFiles } from "../scripts/files.mjs";

test("repository checks include native sources without traversing generated application workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-file-scope-"));
  try {
    for (const name of ["src", "native", "desktop", "generated-app"]) await mkdir(join(root, name));
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "desktop", "package.json"), "{}");
    await writeFile(join(root, "src", "example.ts"), "export {};");
    await writeFile(join(root, "native", "Example.swift"), "import Foundation");
    await writeFile(join(root, "generated-app", "config.json"), "/* unrelated JSON with comments */");
    const files = await collectRepositoryFiles(root, new Set(), new Set([".ts", ".swift", ".json"]));
    assert.deepEqual(files.map((file) => relative(root, file)).sort(), ["desktop/package.json", "native/Example.swift", "package.json", "src/example.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
