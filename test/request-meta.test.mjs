import assert from "node:assert/strict";
import test from "node:test";

import { requestMetadataForTool } from "../dist/request-meta.js";

test("fills missing Chrome turn metadata from the MCP request context", () => {
  const metadata = requestMetadataForTool(
    "chrome.js",
    { existing: true },
    "transport-session",
    42,
  );

  assert.deepEqual(metadata, {
    existing: true,
    "x-codex-turn-metadata": {
      session_id: "transport-session",
      turn_id: "42",
    },
  });
});

test("derives restart-stable opaque session and turn ids from the ChatGPT session", () => {
  const first = requestMetadataForTool(
    "chrome.js",
    { "openai/session": "signed-session-value" },
    undefined,
    1,
  );
  const second = requestMetadataForTool(
    "chrome.js",
    { "openai/session": "signed-session-value" },
    undefined,
    2,
  );
  const different = requestMetadataForTool(
    "chrome.js",
    { "openai/session": "another-session-value" },
    undefined,
    3,
  );

  const firstTurn = first["x-codex-turn-metadata"];
  const secondTurn = second["x-codex-turn-metadata"];
  const differentTurn = different["x-codex-turn-metadata"];
  assert.equal(firstTurn.session_id, secondTurn.session_id);
  assert.equal(firstTurn.turn_id, secondTurn.turn_id);
  assert.notEqual(firstTurn.session_id, differentTurn.session_id);
  assert.notEqual(firstTurn.turn_id, differentTurn.turn_id);
  assert.match(firstTurn.session_id, /^local-dev-[a-f0-9]{32}$/u);
  assert.match(firstTurn.turn_id, /^local-dev-turn-[a-f0-9]{32}$/u);
  assert.equal(firstTurn.session_id.includes("signed-session-value"), false);
  assert.equal(firstTurn.turn_id.includes("signed-session-value"), false);
});

test("preserves supplied Chrome turn metadata and leaves other tools unchanged", () => {
  const supplied = {
    "x-codex-turn-metadata": {
      session_id: "real-session",
      turn_id: "real-turn",
      thread_source: "chatgpt",
    },
  };

  assert.equal(requestMetadataForTool("chrome.js", supplied, "fallback-session", 7), supplied);
  assert.equal(requestMetadataForTool("dev.run", undefined, "transport-session", 8), undefined);
});
