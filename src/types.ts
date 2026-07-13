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
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  annotations: ToolAnnotations;
  handler: (
    input: JsonObject,
    signal: AbortSignal,
  ) => Promise<ToolCallResult> | ToolCallResult;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonValue;
  method: string;
  params?: JsonValue;
}
