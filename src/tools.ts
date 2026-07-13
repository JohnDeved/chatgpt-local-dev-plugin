import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { failure, success, summarizeEcho } from "./result.js";
import type {
  JsonObject,
  JsonValue,
  ToolAnnotations,
  ToolCallResult,
  ToolDefinition,
} from "./types.js";
import {
  hasOnlyKeys,
  isIntegerInRange,
  isStringInRange,
  jsonByteLength,
} from "./validation.js";

const MAX_ECHO_BYTES = 16_384;
const MAX_WRITE_BYTES = 4_096;
const MAX_SLEEP_MS = 120_000;
const MAX_SEQUENCE_ABS = 9_000_000_000_000_000;

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

const localMutationAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

const resultEnvelopeSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "tool", "data", "error"],
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    data: {},
    error: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
        },
      ],
    },
  },
};

function invalid(tool: string, message: string): ToolCallResult {
  return failure(tool, "INVALID_ARGUMENT", message);
}

function sleepFor(durationMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, durationMs);

    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function homeDirectory(): string {
  const configuredHome = process.env.HOME;
  return configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
}

export function createToolRegistry(): Map<string, ToolDefinition> {
  let sequence = 0;
  const tools = new Map<string, ToolDefinition>();

  const register = (tool: ToolDefinition): void => {
    tools.set(tool.name, tool);
  };

  register({
    name: "compat_ping",
    title: "Compatibility ping",
    description: "Return a deterministic pong with the caller-provided nonce.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["nonce"],
      properties: {
        nonce: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    outputSchema: resultEnvelopeSchema,
    annotations: readOnlyAnnotations,
    handler(input) {
      if (
        !hasOnlyKeys(input, ["nonce"]) ||
        !isStringInRange(input.nonce, 1, 128)
      ) {
        return invalid("compat_ping", "nonce must be a 1-128 character string.");
      }

      return success(
        "compat_ping",
        { pong: true, nonce: input.nonce },
        `pong nonce=${input.nonce}`,
      );
    },
  });

  register({
    name: "compat_echo",
    title: "Structured compatibility echo",
    description: `Echo one JSON value when its serialized form is at most ${MAX_ECHO_BYTES} bytes.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: {},
        repeat: { type: "integer", minimum: 1, maximum: 20_000 },
      },
    },
    outputSchema: resultEnvelopeSchema,
    annotations: readOnlyAnnotations,
    handler(input) {
      if (!hasOnlyKeys(input, ["value", "repeat"]) || !("value" in input)) {
        return invalid("compat_echo", "value is required and must be valid JSON.");
      }

      let echoedValue = input.value;
      if (input.repeat !== undefined) {
        if (
          typeof input.value !== "string" ||
          !isIntegerInRange(input.repeat, 1, 20_000)
        ) {
          return invalid(
            "compat_echo",
            "repeat requires a string value and an integer from 1 through 20000.",
          );
        }
        echoedValue = input.value.repeat(input.repeat);
      }

      const serializedBytes = jsonByteLength(echoedValue);
      if (serializedBytes > MAX_ECHO_BYTES) {
        return failure(
          "compat_echo",
          "OUTPUT_TOO_LARGE",
          `Echo payload exceeds ${MAX_ECHO_BYTES} bytes.`,
        );
      }

      return success(
        "compat_echo",
        { value: echoedValue, serializedBytes },
        summarizeEcho(echoedValue),
      );
    },
  });

  register({
    name: "compat_sleep",
    title: "Bounded compatibility sleep",
    description: `Wait for an exact requested duration from 0 through ${MAX_SLEEP_MS} milliseconds.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["durationMs"],
      properties: {
        durationMs: { type: "integer", minimum: 0, maximum: MAX_SLEEP_MS },
      },
    },
    outputSchema: resultEnvelopeSchema,
    annotations: readOnlyAnnotations,
    async handler(input, signal) {
      if (
        !hasOnlyKeys(input, ["durationMs"]) ||
        !isIntegerInRange(input.durationMs, 0, MAX_SLEEP_MS)
      ) {
        return invalid(
          "compat_sleep",
          `durationMs must be an integer from 0 through ${MAX_SLEEP_MS}.`,
        );
      }

      const completed = await sleepFor(input.durationMs, signal);
      if (!completed) {
        return failure("compat_sleep", "CANCELLED", "Sleep was cancelled.");
      }

      return success(
        "compat_sleep",
        { requestedMs: input.durationMs, completed: true },
        `completed ${input.durationMs}ms`,
      );
    },
  });

  register({
    name: "compat_sequence_increment",
    title: "Increment compatibility sequence",
    description: "Increment process-local benchmark state by a bounded integer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["by"],
      properties: {
        by: { type: "integer", minimum: -1_000_000, maximum: 1_000_000 },
      },
    },
    outputSchema: resultEnvelopeSchema,
    annotations: localMutationAnnotations,
    handler(input) {
      if (
        !hasOnlyKeys(input, ["by"]) ||
        !isIntegerInRange(input.by, -1_000_000, 1_000_000)
      ) {
        return invalid(
          "compat_sequence_increment",
          "by must be an integer from -1000000 through 1000000.",
        );
      }

      const nextValue = sequence + input.by;
      if (!Number.isSafeInteger(nextValue) || Math.abs(nextValue) > MAX_SEQUENCE_ABS) {
        return failure(
          "compat_sequence_increment",
          "SEQUENCE_RANGE",
          "Sequence would exceed the supported safe range.",
        );
      }

      sequence = nextValue;
      return success(
        "compat_sequence_increment",
        { value: sequence, incrementedBy: input.by },
        `value=${sequence}`,
      );
    },
  });

  register({
    name: "compat_sequence_read",
    title: "Read compatibility sequence",
    description: "Read process-local benchmark state without changing it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: resultEnvelopeSchema,
    annotations: readOnlyAnnotations,
    handler(input) {
      if (!hasOnlyKeys(input, [])) {
        return invalid("compat_sequence_read", "No arguments are accepted.");
      }

      return success(
        "compat_sequence_read",
        { value: sequence },
        `value=${sequence}`,
      );
    },
  });

  register({
    name: "compat_write_marker",
    title: "Write harmless compatibility marker",
    description:
      "Create one new UTF-8 marker under ~/.local-dev/compatibility-writes; existing files are never overwritten.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["marker", "content", "confirm"],
      properties: {
        marker: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
        },
        content: { type: "string", minLength: 1, maxLength: MAX_WRITE_BYTES },
        confirm: { const: true },
      },
    },
    outputSchema: resultEnvelopeSchema,
    annotations: localMutationAnnotations,
    async handler(input) {
      if (
        !hasOnlyKeys(input, ["marker", "content", "confirm"]) ||
        !isStringInRange(input.marker, 1, 64) ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.marker) ||
        !isStringInRange(input.content, 1, MAX_WRITE_BYTES) ||
        input.confirm !== true
      ) {
        return invalid(
          "compat_write_marker",
          "marker, bounded content, and confirm=true are required.",
        );
      }

      const contentBytes = new TextEncoder().encode(input.content).byteLength;
      if (contentBytes > MAX_WRITE_BYTES) {
        return failure(
          "compat_write_marker",
          "OUTPUT_TOO_LARGE",
          `Marker content exceeds ${MAX_WRITE_BYTES} UTF-8 bytes.`,
        );
      }

      const relativePath = `.local-dev/compatibility-writes/${input.marker}.txt`;
      const directory = join(homeDirectory(), ".local-dev", "compatibility-writes");
      const path = join(directory, `${input.marker}.txt`);

      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, input.content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "";
        if (code === "EEXIST") {
          return failure(
            "compat_write_marker",
            "ALREADY_EXISTS",
            "Marker already exists; choose a new marker name.",
          );
        }
        return failure(
          "compat_write_marker",
          "WRITE_FAILED",
          "Marker could not be written.",
        );
      }

      const sha256 = createHash("sha256").update(input.content).digest("hex");
      return success(
        "compat_write_marker",
        { relativePath, bytes: contentBytes, sha256, created: true },
        `created ${relativePath} (${contentBytes} bytes)`,
      );
    },
  });

  if (process.env.LOCAL_DEV_COMPAT_ENABLE_REFRESH_PROBE === "1") {
    register({
      name: "compat_refresh_probe",
      title: "Compatibility refresh probe",
      description:
        "Optional discovery-only tool enabled by LOCAL_DEV_COMPAT_ENABLE_REFRESH_PROBE=1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      outputSchema: resultEnvelopeSchema,
      annotations: readOnlyAnnotations,
      handler(input) {
        if (!hasOnlyKeys(input, [])) {
          return invalid("compat_refresh_probe", "No arguments are accepted.");
        }
        return success(
          "compat_refresh_probe",
          { token: "refresh-v2" },
          "token=refresh-v2",
        );
      },
    });
  }

  return tools;
}

export const compatibilityLimits = {
  maxEchoBytes: MAX_ECHO_BYTES,
  maxWriteBytes: MAX_WRITE_BYTES,
  maxSleepMs: MAX_SLEEP_MS,
} as const;

export function toolDescriptors(
  tools: Map<string, ToolDefinition>,
): JsonValue[] {
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: {
      readOnlyHint: tool.annotations.readOnlyHint,
      openWorldHint: tool.annotations.openWorldHint,
      destructiveHint: tool.annotations.destructiveHint,
      idempotentHint: tool.annotations.idempotentHint ?? false,
    },
  }));
}
