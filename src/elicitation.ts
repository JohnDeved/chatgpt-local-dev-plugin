import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

type ElicitInput = (params: ElicitRequest["params"]) => Promise<ElicitResult>;
type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

export function preapprovedBrowserOriginAccess(
  params: ElicitRequest["params"],
  approvedOrigins: readonly string[],
): ElicitResult | undefined {
  if (params.mode !== "form") return undefined;

  const meta = record(params._meta);
  const toolParams = record(meta?.tool_params);
  const schema = record(params.requestedSchema);
  const properties = record(schema?.properties);
  const origin = meta?.origin;

  if (
    typeof origin !== "string"
    || !approvedOrigins.includes(origin)
    || meta?.codex_approval_kind !== "mcp_tool_call"
    || meta?.codex_request_type !== "approval_request"
    || meta?.connector_id !== "browser-use"
    || meta?.tool_name !== "access_browser_origin"
    || toolParams?.origin !== origin
    || schema?.type !== "object"
    || properties === undefined
    || Object.keys(properties).length !== 0
  ) return undefined;

  return { action: "accept", content: {} };
}

export async function resolveElicitation(
  params: ElicitRequest["params"],
  approvedOrigins: readonly string[],
  forward: ElicitInput,
): Promise<ElicitResult> {
  return preapprovedBrowserOriginAccess(params, approvedOrigins) ?? await forward(params);
}
