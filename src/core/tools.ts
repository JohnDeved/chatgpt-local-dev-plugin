import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { failure } from "../result.js";
import type { RegistryEntry } from "../registry.js";
import { CoreRuntime } from "./runtime.js";

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

const annotations = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean): Tool["annotations"] => ({
  readOnlyHint,
  openWorldHint: false,
  destructiveHint,
  idempotentHint,
});

function result(value: unknown): CallToolResult {
  return value as CallToolResult;
}

function invalid(tool: string): CallToolResult {
  return result(failure(tool, "INVALID_ARGUMENTS", "Tool arguments did not match the advertised schema."));
}

export function coreTools(runtime: CoreRuntime): RegistryEntry[] {
  return [
    {
      tool: {
        name: "project.open",
        title: "Open project",
        description: "Resolve a validated directory inside configured roots and make it active.",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["query"], additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(false, false, true),
      },
      call: async (input) => typeof input.query === "string" && input.query.length > 0 && input.query.length <= 1024 && Object.keys(input).length === 1
        ? result(await runtime.openProject(input.query))
        : invalid("project.open"),
    },
    {
      tool: {
        name: "project.current",
        title: "Current project",
        description: "Return the active project directory.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      },
      call: (input) => Object.keys(input).length === 0 ? result(runtime.currentProject()) : invalid("project.current"),
    },
    {
      tool: {
        name: "dev.run",
        title: "Run development command",
        description: "Run one argv array in the active project with shell disabled and bounded output/time.",
        inputSchema: {
          type: "object",
          properties: {
            argv: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 128 },
            background: { type: "boolean", default: false },
            timeoutMs: { type: "integer", minimum: 1, maximum: 120_000 },
          },
          required: ["argv"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      },
      call: async (input) => {
        if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.length > 128 || input.argv.some((part) => typeof part !== "string" || part.length === 0)) return invalid("dev.run");
        if (input.background !== undefined && typeof input.background !== "boolean") return invalid("dev.run");
        if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) return invalid("dev.run");
        if (Object.keys(input).some((key) => !["argv", "background", "timeoutMs"].includes(key))) return invalid("dev.run");
        return result(await runtime.run(input.argv as string[], input.background === true, input.timeoutMs as number | undefined));
      },
    },
    {
      tool: {
        name: "dev.poll",
        title: "Poll background process",
        description: "Return the single background process state, bounded output tail, exit status, and loopback URLs.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      },
      call: (input) => Object.keys(input).length === 0 ? result(runtime.poll()) : invalid("dev.poll"),
    },
    {
      tool: {
        name: "dev.stop",
        title: "Stop background process",
        description: "Stop and clear the single tracked background process.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(false, true, true),
      },
      call: async (input) => Object.keys(input).length === 0 ? result(await runtime.stop()) : invalid("dev.stop"),
    },
  ];
}
