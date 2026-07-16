import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

type ElicitInput = (params: ElicitRequest["params"]) => Promise<ElicitResult>;
type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function matches(value: UnknownRecord | undefined, expected: UnknownRecord): boolean {
  return value !== undefined && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

export function preapprovedBrowserOriginAccess(
  params: ElicitRequest["params"],
  approvedOrigins: readonly string[],
): ElicitResult | undefined {
  if (params.mode !== "form") return undefined;

  const meta = record(params._meta);
  const schema = record(params.requestedSchema);
  const origin = meta?.origin;
  if (typeof origin !== "string" || !approvedOrigins.includes(origin)) return undefined;
  if (!matches(meta, {
    codex_approval_kind: "mcp_tool_call",
    codex_request_type: "approval_request",
    connector_id: "browser-use",
    tool_name: "access_browser_origin",
    origin,
  })) return undefined;
  if (!matches(record(meta?.tool_params), { origin }) || !matches(schema, { type: "object" })) return undefined;
  const properties = record(schema?.properties);
  return properties !== undefined && Object.keys(properties).length === 0
    ? { action: "accept", content: {} }
    : undefined;
}

export async function resolveElicitation(
  params: ElicitRequest["params"],
  approvedOrigins: readonly string[],
  forward: ElicitInput,
): Promise<ElicitResult> {
  return preapprovedBrowserOriginAccess(params, approvedOrigins) ?? await forward(params);
}
