import { createHash } from "node:crypto";

const CODEX_TURN_METADATA = "x-codex-turn-metadata";
const OPENAI_SESSION = "openai/session";
const processFallbackSessionId = `local-dev-${process.pid}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSessionId(
  metadata: Record<string, unknown> | undefined,
  transportSessionId: string | undefined,
): string {
  if (transportSessionId !== undefined) return transportSessionId;
  const openAiSession = metadata?.[OPENAI_SESSION];
  if (typeof openAiSession !== "string" || openAiSession.length === 0) {
    return processFallbackSessionId;
  }
  const digest = createHash("sha256").update(openAiSession).digest("hex").slice(0, 32);
  return `local-dev-${digest}`;
}

function stableTurnId(
  metadata: Record<string, unknown> | undefined,
  requestId: string | number,
): string {
  const openAiSession = metadata?.[OPENAI_SESSION];
  if (typeof openAiSession !== "string" || openAiSession.length === 0) {
    return String(requestId);
  }
  const digest = createHash("sha256")
    .update(`turn:${openAiSession}`)
    .digest("hex")
    .slice(0, 32);
  return `local-dev-turn-${digest}`;
}

export function requestMetadataForTool(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  transportSessionId: string | undefined,
  requestId: string | number,
): Record<string, unknown> | undefined {
  if (!toolName.startsWith("chrome.")) return metadata;

  const existingTurnMetadata = isRecord(metadata?.[CODEX_TURN_METADATA])
    ? metadata[CODEX_TURN_METADATA]
    : {};
  const sessionId = typeof existingTurnMetadata.session_id === "string"
    ? existingTurnMetadata.session_id
    : stableSessionId(metadata, transportSessionId);
  const turnId = typeof existingTurnMetadata.turn_id === "string"
    ? existingTurnMetadata.turn_id
    : stableTurnId(metadata, requestId);

  if (
    metadata !== undefined
    && existingTurnMetadata.session_id === sessionId
    && existingTurnMetadata.turn_id === turnId
  ) return metadata;

  return {
    ...(metadata ?? {}),
    [CODEX_TURN_METADATA]: {
      ...existingTurnMetadata,
      session_id: sessionId,
      turn_id: turnId,
    },
  };
}
