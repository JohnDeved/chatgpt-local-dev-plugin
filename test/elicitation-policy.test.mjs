import assert from "node:assert/strict";
import test from "node:test";

import {
  preapprovedBrowserOriginAccess,
  resolveElicitation,
} from "../dist/elicitation.js";

const request = {
  mode: "form",
  message: "Allow Browser use to access https://chatgpt.com?",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    codex_request_type: "approval_request",
    connector_id: "browser-use",
    connector_name: "Browser use",
    origin: "https://chatgpt.com",
    persist: "always",
    tool_name: "access_browser_origin",
    tool_params: { origin: "https://chatgpt.com" },
  },
};

test("accepts configured or globally allowed browser-origin access forms", () => {
  assert.deepEqual(
    preapprovedBrowserOriginAccess(request, ["https://chatgpt.com"], "ask"),
    { action: "accept", content: {} },
  );
  assert.equal(preapprovedBrowserOriginAccess(request, [], "ask"), undefined);
  assert.deepEqual(
    preapprovedBrowserOriginAccess(request, [], "allow-all"),
    { action: "accept", content: {} },
  );
  assert.equal(
    preapprovedBrowserOriginAccess({
      ...request,
      requestedSchema: {
        type: "object",
        properties: { secret: { type: "string" } },
      },
    }, [], "allow-all"),
    undefined,
  );
  assert.equal(
    preapprovedBrowserOriginAccess({
      ...request,
      _meta: { ...request._meta, tool_name: "playwright_click" },
    }, [], "allow-all"),
    undefined,
  );
});

test("forwards every elicitation outside the configured origin policy", async () => {
  let forwarded;
  const result = await resolveElicitation(request, [], "ask", async (params) => {
    forwarded = params;
    return { action: "decline" };
  });

  assert.equal(forwarded, request);
  assert.deepEqual(result, { action: "decline" });
});
