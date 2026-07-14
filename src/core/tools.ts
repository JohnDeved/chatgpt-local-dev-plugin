import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { failure } from "../result.js";
import type { RegistryEntry } from "../registry.js";
import { attachWidget, COMMAND_WIDGET_URI, PROJECT_WIDGET_URI } from "../ui/index.js";
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
        description: "Use this when a local development task needs a configured project to become the active working directory.",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["query"], additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(false, false, true),
      },
      call: async (input) => typeof input.query === "string" && input.query.length > 0 && input.query.length <= 1024 && Object.keys(input).length === 1
        ? result(await runtime.openProject(input.query))
        : invalid("project.open"),
    },
    {
      tool: attachWidget({
        name: "project.list",
        title: "Choose project",
        description: "Use this when the user wants to browse, search, or choose among configured local development projects.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, PROJECT_WIDGET_URI, "Finding projects…", "Projects ready"),
      call: async (input) => Object.keys(input).length === 0 ? result(await runtime.projects()) : invalid("project.list"),
    },
    {
      tool: {
        name: "project.current",
        title: "Current project",
        description: "Use this when you need to know which local project is currently active.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      },
      call: (input) => Object.keys(input).length === 0 ? result(runtime.currentProject()) : invalid("project.current"),
    },
    {
      tool: attachWidget({
        name: "dev.run",
        title: "Run development command",
        description: "Use this when you need to run one argv-based development command in the active project with bounded output and time.",
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
      }, COMMAND_WIDGET_URI, "Running command…", "Command finished"),
      call: async (input) => {
        if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.length > 128 || input.argv.some((part) => typeof part !== "string" || part.length === 0)) return invalid("dev.run");
        if (input.background !== undefined && typeof input.background !== "boolean") return invalid("dev.run");
        if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) return invalid("dev.run");
        if (Object.keys(input).some((key) => !["argv", "background", "timeoutMs"].includes(key))) return invalid("dev.run");
        return result(await runtime.run(input.argv as string[], input.background === true, input.timeoutMs as number | undefined));
      },
    },
    {
      tool: attachWidget({
        name: "dev.poll",
        title: "Poll background process",
        description: "Use this when you need the latest state, output tail, exit status, or preview URLs for the tracked background process.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, COMMAND_WIDGET_URI, "Refreshing process…", "Process updated"),
      call: (input) => Object.keys(input).length === 0 ? result(runtime.poll()) : invalid("dev.poll"),
    },
    {
      tool: attachWidget({
        name: "dev.stop",
        title: "Stop background process",
        description: "Use this when the tracked local background process should be terminated and cleared.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(false, true, true),
      }, COMMAND_WIDGET_URI, "Stopping process…", "Process stopped"),
      call: async (input) => Object.keys(input).length === 0 ? result(await runtime.stop()) : invalid("dev.stop"),
    },
  ];
}
