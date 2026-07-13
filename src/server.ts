#!/usr/bin/env node

import { createToolRegistry, toolDescriptors } from "./tools.js";
import type { JsonObject, JsonRpcRequest, JsonValue } from "./types.js";
import { isObject } from "./validation.js";

const SERVER_NAME = "local-dev-compatibility-gate";
const SERVER_VERSION = "0.1.0";
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
]);
const MAX_INPUT_LINE_BYTES = 65_536;
const MAX_CONCURRENT_CALLS = 16;

const tools = createToolRegistry();
const activeRequests = new Map<string, AbortController>();
let activeCallCount = 0;
let inputBuffer = "";

function idKey(id: JsonValue): string {
  return JSON.stringify(id);
}

function writeMessage(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id: JsonValue, result: JsonValue): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(
  id: JsonValue,
  code: number,
  message: string,
  machineCode: string,
): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data: { code: machineCode },
    },
  });
}

function negotiateProtocol(requested: JsonValue | undefined): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

function isRequest(value: JsonValue): value is JsonObject & JsonRpcRequest {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string"
  );
}

async function handleToolCall(id: JsonValue, params: JsonValue | undefined): Promise<void> {
  if (!isObject(params) || typeof params.name !== "string") {
    writeError(id, -32602, "Invalid tools/call parameters.", "INVALID_ARGUMENT");
    return;
  }

  const tool = tools.get(params.name);
  const input = params.arguments;
  if (input !== undefined && !isObject(input)) {
    writeError(id, -32602, "Tool arguments must be an object.", "INVALID_ARGUMENT");
    return;
  }

  if (!tool) {
    writeResult(id, {
      content: [
        {
          type: "text",
          text: `${params.name} error UNKNOWN_TOOL: Tool is not registered.`,
        },
      ],
      structuredContent: {
        ok: false,
        tool: params.name,
        data: null,
        error: { code: "UNKNOWN_TOOL", message: "Tool is not registered." },
      },
      isError: true,
    });
    return;
  }

  if (activeCallCount >= MAX_CONCURRENT_CALLS) {
    writeResult(id, {
      content: [
        {
          type: "text",
          text: `${tool.name} error BUSY: Too many concurrent compatibility calls.`,
        },
      ],
      structuredContent: {
        ok: false,
        tool: tool.name,
        data: null,
        error: {
          code: "BUSY",
          message: "Too many concurrent compatibility calls.",
        },
      },
      isError: true,
    });
    return;
  }

  const controller = new AbortController();
  activeRequests.set(idKey(id), controller);
  activeCallCount += 1;
  try {
    const result = await tool.handler(input ?? {}, controller.signal);
    writeResult(id, result as unknown as JsonValue);
  } catch {
    writeResult(id, {
      content: [
        {
          type: "text",
          text: `${tool.name} error INTERNAL_ERROR: Compatibility call failed.`,
        },
      ],
      structuredContent: {
        ok: false,
        tool: tool.name,
        data: null,
        error: { code: "INTERNAL_ERROR", message: "Compatibility call failed." },
      },
      isError: true,
    });
  } finally {
    activeRequests.delete(idKey(id));
    activeCallCount -= 1;
  }
}

async function handleRequest(request: JsonObject & JsonRpcRequest): Promise<void> {
  const id = request.id;

  if (request.method === "notifications/cancelled") {
    if (isObject(request.params) && request.params.requestId !== undefined) {
      activeRequests.get(idKey(request.params.requestId))?.abort();
    }
    return;
  }

  if (request.method.startsWith("notifications/")) {
    return;
  }

  if (id === undefined) {
    return;
  }

  switch (request.method) {
    case "initialize": {
      const requestedVersion = isObject(request.params)
        ? request.params.protocolVersion
        : undefined;
      writeResult(id, {
        protocolVersion: negotiateProtocol(requestedVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Temporary Phase 1 compatibility tools only. Do not treat this server as the production Local Dev implementation.",
      });
      return;
    }
    case "ping":
      writeResult(id, {});
      return;
    case "tools/list":
      writeResult(id, { tools: toolDescriptors(tools) });
      return;
    case "tools/call":
      await handleToolCall(id, request.params);
      return;
    default:
      writeError(id, -32601, "Method not found.", "METHOD_NOT_FOUND");
  }
}

function handleLine(line: string): void {
  if (line.length === 0) {
    return;
  }

  if (new TextEncoder().encode(line).byteLength > MAX_INPUT_LINE_BYTES) {
    writeError(null, -32600, "Input message is too large.", "INPUT_TOO_LARGE");
    return;
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(line) as JsonValue;
  } catch {
    writeError(null, -32700, "Invalid JSON.", "PARSE_ERROR");
    return;
  }

  if (!isRequest(parsed)) {
    writeError(null, -32600, "Invalid JSON-RPC request.", "INVALID_REQUEST");
    return;
  }

  void handleRequest(parsed).catch(() => {
    if (parsed.id !== undefined) {
      writeError(parsed.id, -32603, "Internal error.", "INTERNAL_ERROR");
    }
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIndex = inputBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    handleLine(line);
    newlineIndex = inputBuffer.indexOf("\n");
  }

  if (new TextEncoder().encode(inputBuffer).byteLength > MAX_INPUT_LINE_BYTES) {
    inputBuffer = "";
    writeError(null, -32600, "Input message is too large.", "INPUT_TOO_LARGE");
  }
});
process.stdin.resume();

process.on("uncaughtException", () => {
  process.stderr.write("local-dev compatibility server: uncaught exception\n");
  process.exitCode = 1;
});
process.on("unhandledRejection", () => {
  process.stderr.write("local-dev compatibility server: unhandled rejection\n");
  process.exitCode = 1;
});
