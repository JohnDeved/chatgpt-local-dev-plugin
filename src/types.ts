export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface ToolError {
  code: string;
  message: string;
}

export interface StructuredResult {
  ok: boolean;
  tool: string;
  data: JsonValue;
  error: ToolError | null;
}

export interface ToolCallResult {
  structuredContent: StructuredResult;
  content: Array<{ type: "text"; text: string }>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}
