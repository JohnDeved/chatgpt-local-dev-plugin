import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { CallStatus, CallJournal } from "./observability.js";
import type { RegistryEntry } from "./registry.js";
import { failure, success } from "./result.js";
import type { JsonValue } from "./types.js";
import { attachWidget, CALLS_WIDGET_URI } from "./ui/index.js";

const envelope = {
  type: "object" as const,
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    data: {},
    error: { anyOf: [{ type: "null" }, { type: "object" }] },
  },
  required: ["ok", "tool", "data", "error"],
};

const annotations: Tool["annotations"] = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

function result(value: unknown): CallToolResult {
  return value as CallToolResult;
}

export function observabilityTools(journal: CallJournal): RegistryEntry[] {
  return [{
    tool: attachWidget({
      name: "observability.recent_calls",
      title: "Inspect recent tool calls",
      description: "Use this when the user wants to inspect recent Local Dev MCP calls, failures, durations, redacted arguments, or bounded results.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          status: { type: "string", enum: ["ok", "error", "running"] },
          server: { type: "string", minLength: 1, maxLength: 128 },
        },
        additionalProperties: false,
      },
      outputSchema: envelope,
      annotations,
    }, CALLS_WIDGET_URI, "Reading recent calls…", "Recent calls ready"),
    call: (input) => {
      const allowed = new Set(["limit", "status", "server"]);
      if (Object.keys(input).some((key) => !allowed.has(key))) {
        return result(failure("observability.recent_calls", "INVALID_ARGUMENTS", "Tool arguments did not match the advertised schema."));
      }
      const limit = input.limit === undefined ? 50 : input.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        return result(failure("observability.recent_calls", "INVALID_ARGUMENTS", "limit must be an integer from 1 to 100."));
      }
      const status = input.status;
      if (status !== undefined && status !== "ok" && status !== "error" && status !== "running") {
        return result(failure("observability.recent_calls", "INVALID_ARGUMENTS", "status must be ok, error, or running."));
      }
      const server = input.server;
      if (server !== undefined && (typeof server !== "string" || server.length === 0 || server.length > 128)) {
        return result(failure("observability.recent_calls", "INVALID_ARGUMENTS", "server must be a non-empty string no longer than 128 characters."));
      }
      const calls = journal.snapshot()
        .filter((call) => call.tool !== "observability.recent_calls")
        .filter((call) => status === undefined || call.status === status as CallStatus)
        .filter((call) => server === undefined || call.server === server)
        .slice(0, limit);
      return result(success(
        "observability.recent_calls",
        { calls } as unknown as JsonValue,
        `${calls.length} calls`,
      ));
    },
  }];
}
