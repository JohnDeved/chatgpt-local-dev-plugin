import type { JsonValue, StructuredResult, ToolCallResult } from "./types.js";

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
  data: JsonValue = null,
  metadata?: Record<string, unknown>,
): ToolCallResult {
  const structuredContent: StructuredResult = {
    ok: false,
    tool,
    data,
    error: { code, message },
  };

  return {
    structuredContent,
    content: [{ type: "text", text: `${tool} error ${code}: ${message}` }],
    isError: true,
    ...(metadata === undefined ? {} : { _meta: metadata }),
  };
}
