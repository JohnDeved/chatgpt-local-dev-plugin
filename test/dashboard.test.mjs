import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startDashboard } from "../dist/dashboard.js";
import { CallJournal } from "../dist/observability.js";

test("records bounded calls while redacting credentials and media bytes", () => {
  const journal = new CallJournal(2);
  const first = journal.begin("chrome.screenshot", {
    url: "http://127.0.0.1:4321/",
    authorization: "Bearer visible-by-key",
    nested: { apiKey: "should-not-appear", ordinary: "kept" },
  });
  journal.complete(first, {
    content: [{ type: "image", mimeType: "image/png", data: "a".repeat(400) }],
  });
  const second = journal.begin("dev.run", { argv: ["npm", "run", "check"], token: "hidden" });
  journal.complete(second, { content: [{ type: "text", text: "ok" }] });
  const third = journal.begin("project.current", {});
  journal.fail(third);

  const calls = journal.snapshot();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ tool }) => tool), ["project.current", "dev.run"]);
  assert.equal(calls[1].arguments.token, "[redacted]");
  assert.equal(calls[0].status, "error");

  const mediaJournal = new CallJournal();
  const mediaCall = mediaJournal.begin("chrome.screenshot", { password: "hidden" });
  mediaJournal.complete(mediaCall, {
    content: [{ type: "image", mimeType: "image/png", data: "a".repeat(400) }],
  });
  const captured = mediaJournal.snapshot()[0];
  assert.equal(captured.arguments.password, "[redacted]");
  assert.deepEqual(captured.media, [{ type: "image", mimeType: "image/png", encodedBytes: 300 }]);
  assert.match(captured.result.content[0].data, /base64 omitted/u);
  assert.equal(JSON.stringify(captured).includes("a".repeat(100)), false);
});

test("serves the dashboard only through its tokenized loopback URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-dev-dashboard-"));
  const urlFile = join(directory, "dashboard.url");
  const journal = new CallJournal();
  const call = journal.begin("project.current", {});
  journal.complete(call, { content: [{ type: "text", text: "active=/tmp/project" }] });
  const dashboard = await startDashboard(journal, urlFile);
  try {
    const url = new URL(dashboard.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.pathname, /^\/[a-f0-9]{48}\/$/u);
    assert.equal((await readFile(urlFile, "utf8")).trim(), dashboard.url);
    assert.equal((await stat(urlFile)).mode & 0o777, 0o600);

    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Local Dev MCP Calls/u);
    const calls = await fetch(new URL("api/calls", dashboard.url)).then((response) => response.json());
    assert.equal(calls[0].tool, "project.current");
    const denied = await fetch(`${url.origin}/api/calls`);
    assert.equal(denied.status, 404);
    const mutation = await fetch(dashboard.url, { method: "POST" });
    assert.equal(mutation.status, 405);
  } finally {
    await dashboard.close();
    await rm(directory, { recursive: true, force: true });
  }
});
