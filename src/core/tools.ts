import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { failure } from "../result.js";
import type { RegistryEntry } from "../registry.js";
import { withToolStatus } from "../tool-metadata.js";
import { CoreRuntime, type BatchStep, type MissingProjectAction } from "./runtime.js";

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

const commandProperties = {
  argv: {
    type: "array" as const,
    description: "Executable followed by its arguments. Pass argv directly; do not invoke a shell.",
    items: { type: "string" as const, minLength: 1 },
    minItems: 1,
    maxItems: 128,
  },
  cwd: {
    type: "string" as const,
    description: "Optional working directory relative to the active project.",
    minLength: 1,
    maxLength: 1024,
  },
  timeoutMs: {
    type: "integer" as const,
    description: "Optional bounded timeout in milliseconds.",
    minimum: 1,
    maximum: 120_000,
  },
  allowNonZero: {
    type: "boolean" as const,
    description: "Return a nonzero foreground exit as data instead of a tool error.",
    default: false,
  },
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

function validArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every((part) => typeof part === "string" && part.length > 0);
}

function validCommandOptions(input: Record<string, unknown>, allowed: string[]): boolean {
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 1024)) return false;
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) return false;
  if (input.allowNonZero !== undefined && typeof input.allowNonZero !== "boolean") return false;
  return !Object.keys(input).some((key) => !allowed.includes(key));
}

function batchStep(value: unknown): BatchStep | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!validArgv(input.argv) || !validCommandOptions(input, ["argv", "cwd", "timeoutMs", "allowNonZero"])) return undefined;
  return {
    argv: input.argv,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs as number }),
    ...(input.allowNonZero === undefined ? {} : { allowNonZero: input.allowNonZero as boolean }),
  };
}

function validMissingAction(value: unknown): value is MissingProjectAction {
  return value === "error" || value === "create" || value === "temporary";
}

export function coreTools(runtime: CoreRuntime): RegistryEntry[] {
  return [
    {
      tool: withToolStatus({
        name: "project.open",
        title: "Resolve project",
        description: "Use this when a local development task needs a project. Infer an existing project name or path from the request. When no existing project fits, choose create for durable work or temporary for disposable experiments. If a query is ambiguous, inspect the returned candidates and retry with the best exact path; do not ask the user to use a picker.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Existing project name/path, or a concise new project slug when onMissing is create or temporary.",
              minLength: 1,
              maxLength: 1024,
            },
            onMissing: {
              type: "string",
              description: "What to do when no configured project matches the query.",
              enum: ["error", "create", "temporary"],
              default: "error",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, false, false),
      }, "Resolving project…", "Project ready"),
      call: async (input) => {
        if (typeof input.query !== "string" || input.query.length === 0 || input.query.length > 1024) return invalid("project.open");
        if (input.onMissing !== undefined && !validMissingAction(input.onMissing)) return invalid("project.open");
        if (Object.keys(input).some((key) => !["query", "onMissing"].includes(key))) return invalid("project.open");
        return result(await runtime.openProject(input.query, input.onMissing ?? "error"));
      },
    },
    {
      tool: withToolStatus({
        name: "project.current",
        title: "Check current project",
        description: "Use this when you need to know which project is active and whether it is existing, newly created, or temporary.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Checking current project…", "Current project checked"),
      call: (input) => Object.keys(input).length === 0 ? result(runtime.currentProject()) : invalid("project.current"),
    },
    {
      tool: withToolStatus({
        name: "dev.run",
        title: "Run command",
        description: "Use this when one executable must run in the active project. Pass argv directly, use cwd for a relative subdirectory, and never invoke a shell with evaluation flags.",
        inputSchema: {
          type: "object",
          properties: {
            ...commandProperties,
            background: {
              type: "boolean",
              description: "Track the command as the single background process instead of waiting for it to exit.",
              default: false,
            },
          },
          required: ["argv"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      }, "Running command…", "Command finished"),
      call: async (input) => {
        if (!validArgv(input.argv)) return invalid("dev.run");
        if (input.background !== undefined && typeof input.background !== "boolean") return invalid("dev.run");
        if (!validCommandOptions(input, ["argv", "background", "cwd", "timeoutMs", "allowNonZero"])) return invalid("dev.run");
        return result(await runtime.run(
          input.argv,
          input.background === true,
          input.timeoutMs as number | undefined,
          input.cwd as string | undefined,
          input.allowNonZero === true,
        ));
      },
    },
    {
      tool: withToolStatus({
        name: "dev.batch",
        title: "Run command batch",
        description: "Use this when two or more bounded foreground commands should run sequentially in the active project. Each step receives a direct argv array; no shell evaluation is allowed.",
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "Two to twenty foreground command steps run in order.",
              minItems: 2,
              maxItems: 20,
              items: {
                type: "object",
                properties: commandProperties,
                required: ["argv"],
                additionalProperties: false,
              },
            },
            stopOnError: {
              type: "boolean",
              description: "Stop after the first failed step instead of continuing the batch.",
              default: true,
            },
          },
          required: ["steps"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      }, "Running command batch…", "Command batch finished"),
      call: async (input) => {
        if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 20) return invalid("dev.batch");
        if (input.stopOnError !== undefined && typeof input.stopOnError !== "boolean") return invalid("dev.batch");
        if (Object.keys(input).some((key) => !["steps", "stopOnError"].includes(key))) return invalid("dev.batch");
        const steps = input.steps.map(batchStep);
        if (steps.some((step) => step === undefined)) return invalid("dev.batch");
        return result(await runtime.batch(steps as BatchStep[], input.stopOnError !== false));
      },
    },
    {
      tool: withToolStatus({
        name: "dev.poll",
        title: "Poll background process",
        description: "Use this when you need the latest state, output tail, exit status, or preview URLs for the tracked background process.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Checking background process…", "Background process checked"),
      call: async (input) => Object.keys(input).length === 0 ? result(await runtime.poll()) : invalid("dev.poll"),
    },
    {
      tool: withToolStatus({
        name: "dev.stop",
        title: "Stop background process",
        description: "Use this when the tracked local background process should be terminated and cleared.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(false, true, true),
      }, "Stopping background process…", "Background process stopped"),
      call: async (input) => Object.keys(input).length === 0 ? result(await runtime.stop()) : invalid("dev.stop"),
    },
    {
      tool: withToolStatus({
        name: "dev.diff",
        title: "Review project changes",
        description: "Use this at most once after all file-changing operations for a user request to return the cumulative bounded Git working-tree diff.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Reading project changes…", "Project changes ready"),
      call: async (input) => Object.keys(input).length === 0 ? result(await runtime.diff()) : invalid("dev.diff"),
    },
  ];
}
