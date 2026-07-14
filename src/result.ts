import type { JsonValue, StructuredResult, ToolCallResult } from "./types.js";

function compactValue(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 160 ? serialized : `${serialized.slice(0, 157)}...`;
}

export function success(
  tool: string,
  data: JsonValue,
  summary: string,
  metadata?: Record<string, unknown>,
): ToolCallResult {
  const structuredContent: StructuredResult = {
    ok: true,
    tool,
    data,
    error: null,
  };

  return {
    structuredContent,
    content: [{ type: "text", text: `${tool} ok: ${summary}` }],
    ...(metadata === undefined ? {} : { _meta: metadata }),
  };
}

export function failure(
  tool: string,
  code: string,
  message: string,
): ToolCallResult {
  const structuredContent: StructuredResult = {
    ok: false,
    tool,
    data: null,
    error: { code, message },
  };

  return {
    structuredContent,
    content: [{ type: "text", text: `${tool} error ${code}: ${message}` }],
    isError: true,
  };
}

export function summarizeEcho(value: JsonValue): string {
  return `echo=${compactValue(value)}`;
}
