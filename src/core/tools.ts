import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { MAX_EDITS, MAX_TEXT_BYTES, SHA256_PATTERN, type TextEdit } from "./files.js";
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
    localDevRun: { type: "object", description: "Run context and pending local user steering, when supplied by the server. Acknowledge returned steering IDs with run.update before further actions." },
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

function validFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function validFileContent(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_BYTES;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && new RegExp(SHA256_PATTERN, "u").test(value);
}

function textEdits(value: unknown): value is TextEdit[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_EDITS && value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.oldText === "string" && item.oldText.length > 0 && item.oldText.length <= MAX_TEXT_BYTES
      && validFileContent(item.newText)
      && Object.keys(item).every((key) => ["oldText", "newText"].includes(key));
  });
}

function validMissingAction(value: unknown): value is MissingProjectAction {
  return value === "error" || value === "create" || value === "temporary";
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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
            mode: {
              type: "string",
              description: "Acquire a shared read-only lease or an exclusive writer lease.",
              enum: ["read", "write"],
              default: "write",
            },
            leaseMs: {
              type: "integer",
              description: "Idle lease lifetime before safe reconciliation.",
              minimum: 1000,
              maximum: 3_600_000,
            },
            expectedHead: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
            handoffId: { type: "string", format: "uuid" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, false, false),
      }, "Resolving project…", "Project ready"),
      call: async (input, context) => {
        if (typeof input.query !== "string" || input.query.length === 0 || input.query.length > 1024) return invalid("project.open");
        if (input.onMissing !== undefined && !validMissingAction(input.onMissing)) return invalid("project.open");
        if (input.mode !== undefined && input.mode !== "read" && input.mode !== "write") return invalid("project.open");
        if (input.leaseMs !== undefined && (typeof input.leaseMs !== "number" || !Number.isInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 3_600_000)) return invalid("project.open");
        if (input.expectedHead !== undefined && (typeof input.expectedHead !== "string" || !/^[a-f0-9]{40,64}$/u.test(input.expectedHead))) return invalid("project.open");
        if (input.handoffId !== undefined && !validUuid(input.handoffId)) return invalid("project.open");
        if (Object.keys(input).some((key) => !["query", "onMissing", "mode", "leaseMs", "expectedHead", "handoffId"].includes(key))) return invalid("project.open");
        return result(await runtime.openProject(input.query, input.onMissing ?? "error", context?.progress, context?.runOwner ?? "runtime", {
          mode: input.mode === "read" ? "read" : "write",
          ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs as number }),
          ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead as string }),
          ...(input.handoffId === undefined ? {} : { handoffId: input.handoffId as string }),
        }));
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
      call: (input, context) => Object.keys(input).length === 0 ? result(runtime.currentProject(context?.runOwner ?? "runtime")) : invalid("project.current"),
    },
    {
      tool: withToolStatus({
        name: "project.read",
        title: "Read project file",
        description: "Read one UTF-8 project file (maximum 1 MiB) and return its exact text, byte count and sha256. Use that hash as expectedSha256 for project.edit or replacing an existing file with project.write. No newline or whitespace normalization is performed.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
          required: ["path"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Reading project file…", "Project file read"),
      call: async (input, context) => validFilePath(input.path) && Object.keys(input).length === 1
        ? result(await runtime.readProject(input.path, context?.runOwner ?? "runtime", context?.signal))
        : invalid("project.read"),
    },
    {
      tool: withToolStatus({
        name: "project.write",
        title: "Write project file",
        description: "Create a UTF-8 source file, or replace it only with the current sha256 from project.read. Pass literal content with normal newlines; do not encode Python, shell, JSON or base64 wrappers. Without expectedSha256 an existing file is never overwritten. Parent directories are created by default. Preserves supplied whitespace exactly. Requires a write lease and normal approval; maximum 1 MiB.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: 1024, description: "Relative file path inside the active project; no symlinks, parent traversal or .git metadata." },
            content: { type: "string", maxLength: MAX_TEXT_BYTES, description: "Complete literal UTF-8 text. Empty content is allowed. Newlines, tabs and indentation are preserved, not formatted." },
            expectedSha256: { type: "string", pattern: SHA256_PATTERN, description: "For replacing an existing file: its current sha256 from project.read. Omit only when creating a new file." },
            createParents: { type: "boolean", default: true, description: "Create missing regular parent directories for a new file. Existing-file replacements never create missing paths." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      }, "Writing project file…", "Project file written"),
      call: async (input, context) => {
        if (!validFilePath(input.path)) return invalid("project.write");
        if (!validFileContent(input.content)) return invalid("project.write");
        if (input.expectedSha256 !== undefined && !validHash(input.expectedSha256)) return invalid("project.write");
        if (input.createParents !== undefined && typeof input.createParents !== "boolean") return invalid("project.write");
        if (Object.keys(input).some((key) => !["path", "content", "expectedSha256", "createParents"].includes(key))) return invalid("project.write");
        return result(await runtime.writeProject({
          path: input.path, content: input.content,
          ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
          ...(input.createParents === undefined ? {} : { createParents: input.createParents }),
        }, context?.runOwner ?? "runtime", context?.signal));
      },
    },
    {
      tool: withToolStatus({
        name: "project.edit",
        title: "Edit project file",
        description: "Apply exact literal oldText/newText replacements to one UTF-8 project file after project.read. Each oldText must match once in the evolving text; missing or ambiguous matches fail without writing any edits. Provide surrounding context instead of regexes or line numbers. The hash must still match. Replacements are literal (including dollar signs/backslashes), whitespace is preserved, and the complete result is published atomically. Requires write lease/approval; at most 100 edits and a 1 MiB file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: 1024 },
            expectedSha256: { type: "string", pattern: SHA256_PATTERN, description: "Current sha256 returned by project.read; a mismatch rejects stale edits." },
            edits: {
              type: "array", minItems: 1, maxItems: MAX_EDITS,
              description: "Literal replacements applied in order in memory. All must succeed before the file changes; combined old/new text is bounded to 2 MiB.",
              items: {
                type: "object",
                properties: {
                  oldText: { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES, description: "Exact existing text, including whitespace, with enough context to match only once." },
                  newText: { type: "string", maxLength: MAX_TEXT_BYTES, description: "Literal replacement text; an empty string deletes the matched text." },
                },
                required: ["oldText", "newText"], additionalProperties: false,
              },
            },
          },
          required: ["path", "expectedSha256", "edits"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      }, "Editing project file…", "Project file edited"),
      call: async (input, context) => {
        if (!validFilePath(input.path) || !validHash(input.expectedSha256) || !textEdits(input.edits)) return invalid("project.edit");
        if (Object.keys(input).some((key) => !["path", "expectedSha256", "edits"].includes(key))) return invalid("project.edit");
        return result(await runtime.editProject({ path: input.path, expectedSha256: input.expectedSha256, edits: input.edits }, context?.runOwner ?? "runtime", context?.signal));
      },
    },
    {
      tool: withToolStatus({
        name: "project.files",
        title: "List project files",
        description: "List one bounded directory inside the authenticated active project.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", minLength: 1, maxLength: 1024, default: "." } },
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Listing project files…", "Project files listed"),
      call: async (input, context) => (input.path === undefined || (typeof input.path === "string" && input.path.length > 0 && input.path.length <= 1024)) && Object.keys(input).every((key) => key === "path")
        ? result(await runtime.listProject(input.path as string | undefined, context?.runOwner ?? "runtime"))
        : invalid("project.files"),
    },
    {
      tool: withToolStatus({
        name: "project.release",
        title: "Release project",
        description: "Relinquish the authenticated session's exact idle lease generation and return a handoff ticket.",
        inputSchema: {
          type: "object",
          properties: { generation: { type: "string", format: "uuid" } },
          required: ["generation"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      }, "Releasing project lease…", "Project lease relinquished"),
      call: async (input, context) => validUuid(input.generation) && Object.keys(input).length === 1
        ? result(await runtime.releaseProject(input.generation, context?.runOwner ?? "runtime"))
        : invalid("project.release"),
    },
    {
      tool: withToolStatus({
        name: "project.forceRelease",
        title: "Force release stale project",
        description: "Cooperatively reclaim one exact stale lease generation. Active work is never evicted and every request is audited.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: 1024 },
            generation: { type: "string", format: "uuid" },
            reason: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["path", "generation", "reason"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(false, true, false),
      }, "Checking stale project lease…", "Stale project lease reclaimed"),
      call: async (input, context) => typeof input.path === "string" && input.path.length > 0 && input.path.length <= 1024 && validUuid(input.generation) && typeof input.reason === "string" && input.reason.trim().length > 0 && input.reason.length <= 1000 && Object.keys(input).length === 3
        ? result(await runtime.forceReleaseProject(input.path, input.generation, input.reason, context?.runOwner ?? "runtime"))
        : invalid("project.forceRelease"),
    },
    {
      tool: withToolStatus({
        name: "project.handoff",
        title: "Verify project handoff",
        description: "Verify that a relinquished project was acquired by an independent runtime.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Checking project handoff…", "Project handoff checked"),
      call: async (input) => validUuid(input.id) && Object.keys(input).length === 1
        ? result(await runtime.handoffProject(input.id))
        : invalid("project.handoff"),
    },
    {
      tool: withToolStatus({
        name: "dev.run",
        title: "Run command",
        description: "Use project.write/project.edit for ordinary source-file changes, not Python/Node snippets. Use this when one executable must run in the active project. Pass argv directly, use cwd for a relative subdirectory, and never invoke a shell with evaluation flags. A conservative set of intrinsic version/Git metadata inspections can run under a read lease; every other command requires a write lease.",
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
      call: async (input, context) => {
        if (!validArgv(input.argv)) return invalid("dev.run");
        if (input.background !== undefined && typeof input.background !== "boolean") return invalid("dev.run");
        if (!validCommandOptions(input, ["argv", "background", "cwd", "timeoutMs", "allowNonZero"])) return invalid("dev.run");
        return result(await runtime.run(
          input.argv,
          input.background === true,
          input.timeoutMs as number | undefined,
          input.cwd as string | undefined,
          input.allowNonZero === true,
          context?.progress,
          context?.runOwner ?? "runtime",
        ));
      },
    },
    {
      tool: withToolStatus({
        name: "dev.batch",
        title: "Run command batch",
        description: "Use this when two or more bounded foreground commands should run sequentially in the active project. Each step receives a direct argv array; no shell evaluation is allowed. A batch can run under a read lease only when every step is classified as inspection-only.",
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
      call: async (input, context) => {
        if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 20) return invalid("dev.batch");
        if (input.stopOnError !== undefined && typeof input.stopOnError !== "boolean") return invalid("dev.batch");
        if (Object.keys(input).some((key) => !["steps", "stopOnError"].includes(key))) return invalid("dev.batch");
        const steps = input.steps.map(batchStep);
        if (steps.some((step) => step === undefined)) return invalid("dev.batch");
        return result(await runtime.batch(steps as BatchStep[], input.stopOnError !== false, context?.progress, context?.runOwner ?? "runtime"));
      },
    },
    {
      tool: withToolStatus({
        name: "dev.poll",
        title: "Poll background process",
        description: "Use this after dev.run with background=true to inspect or wait for the tracked background process. Set waitMs to block for up to 120 seconds and return early when the process exits; prefer that bounded wait over repeated polling when you only need completion. Leave waitMs at 0 for an immediate output/URL check.",
        inputSchema: {
          type: "object",
          properties: {
            waitMs: {
              type: "integer",
              description: "Optional bounded wait before returning. Returns early when the process exits; 0 checks immediately.",
              minimum: 0,
              maximum: 120_000,
              default: 0,
            },
          },
          additionalProperties: false,
        },
        outputSchema: envelope,
        annotations: annotations(true, false, true),
      }, "Checking background process…", "Background process checked"),
      call: async (input, context) => {
        if (Object.keys(input).some((key) => key !== "waitMs")) return invalid("dev.poll");
        const waitMs = input.waitMs;
        if (waitMs !== undefined && (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000)) return invalid("dev.poll");
        return result(await runtime.poll(waitMs, context?.runOwner ?? "runtime"));
      },
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
      call: async (input, context) => Object.keys(input).length === 0
        ? result(await runtime.stop(context?.progress, context?.runOwner ?? "runtime"))
        : invalid("dev.stop"),
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
      call: async (input, context) => Object.keys(input).length === 0
        ? result(await runtime.diff(context?.progress, context?.runOwner ?? "runtime"))
        : invalid("dev.diff"),
    },
  ];
}
