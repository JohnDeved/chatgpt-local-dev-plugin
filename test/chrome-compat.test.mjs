import assert from "node:assert/strict";
import test from "node:test";

import { chromeCompatibilityEntries } from "../dist/chrome-compat.js";

test("maps cached Chrome tool names to the node_repl Chrome bridge", async () => {
  const calls = [];
  const chromeJs = {
    tool: { name: "chrome.js", inputSchema: { type: "object", properties: {} } },
    call: async (arguments_, meta) => {
      calls.push({ arguments_, meta });
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const entries = chromeCompatibilityEntries(new Map([["chrome.js", chromeJs]]));
  assert.deepEqual(entries.map(({ tool }) => tool.name), [
    "chrome.navigate",
    "chrome.evaluate",
    "chrome.screenshot",
  ]);

  const meta = { "x-codex-turn-metadata": { session_id: "session", turn_id: "turn" } };
  await entries[1].call({ script: "continue until it works" }, meta);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta, meta);
  assert.equal(calls[0].arguments_.title, "Inspect Chrome");
  assert.equal(calls[0].arguments_.timeout_ms, 60_000);
  assert.match(calls[0].arguments_.code, /agent\.browsers\.get\("extension"\)/u);
  assert.match(calls[0].arguments_.code, /chrome\.user\.openTabs\(\)/u);
  assert.match(calls[0].arguments_.code, /chrome\.user\.claimTab/u);
  assert.match(calls[0].arguments_.code, /domSnapshot/u);
  assert.match(calls[0].arguments_.code, /continue until it works/u);
});

test("does not expose compatibility tools without the Chrome bridge", () => {
  assert.deepEqual(chromeCompatibilityEntries(new Map()), []);
});
