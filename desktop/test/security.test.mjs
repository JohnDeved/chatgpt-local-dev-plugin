import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("the production renderer contains no fixture bridge and loads only bundled resources", async () => {
  const html = await readFile(new URL("../dist/renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /<script[^>]+https?:/);
  const directory = new URL("../dist/renderer/assets/", import.meta.url);
  for (const file of (await readdir(directory)).filter((file) => file.endsWith(".js"))) {
    const source = await readFile(new URL(file, directory), "utf8");
    assert.equal(
      source.includes("__localDevTestBridge"),
      false,
      "Fixture bridge must be compiled out",
    );
    assert.equal(source.includes("fixtureCalls"), false);
  }
});

test("browser UI modules do not import platform code or inject tool output as HTML", async () => {
  const root = new URL("../src/renderer/", import.meta.url);
  for (const name of await readdir(root)) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const source = await readFile(new URL(name, root), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:node:|bun|\.\.\/main\/)/, name);
    assert.equal(source.includes("dangerouslySetInnerHTML"), false, name);
  }
  const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  assert.match(main, /navigationRules: JSON\.stringify\(\["views:\/\/mainview\/\*"\]\)/);
});
