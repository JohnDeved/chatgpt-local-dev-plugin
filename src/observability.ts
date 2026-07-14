import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)/iu;
const SENSITIVE_VALUE = /^(?:Bearer\s+\S+|Basic\s+\S+|sk-(?:proj-)?[A-Za-z0-9_-]{12,})$/u;
const MAX_STRING = 8_192;
const MAX_ARRAY = 128;
const MAX_DEPTH = 10;

export type CallStatus = "error" | "ok" | "running";

export interface MediaSummary {
  type: "audio" | "image";
  mimeType: string;
  encodedBytes: number;
}

export interface CallRecord {
  id: string;
  sequence: number;
  tool: string;
  server: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: CallStatus;
  arguments: unknown;
  result: unknown;
  media: MediaSummary[];
}

interface ActiveCall {
  id: string;
  started: number;
}

function clipped(value: string): string {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} chars omitted]`;
}

function safeValue(value: unknown, key = "", depth = 0): unknown {
  if (key === "localDevDiff") return "[widget-only diff omitted]";
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? "[redacted]" : clipped(value);
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => safeValue(item, "", depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} items omitted]`);
    return items;
  }
  if (typeof value !== "object" || value === undefined) return String(value);
  const record = value as Record<string, unknown>;
  if ((record.type === "image" || record.type === "audio") && typeof record.data === "string") {
    return {
      ...Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== "data")
        .map(([entryKey, entryValue]) => [entryKey, safeValue(entryValue, entryKey, depth + 1)])),
      data: `[base64 omitted: ${record.data.length} chars]`,
    };
  }
  return Object.fromEntries(Object.entries(record).map(([entryKey, entryValue]) => [
    entryKey,
    safeValue(entryValue, entryKey, depth + 1),
  ]));
}

function media(result: CallToolResult): MediaSummary[] {
  return result.content.flatMap((block) => block.type === "image" || block.type === "audio"
    ? [{
        type: block.type,
        mimeType: block.mimeType,
        encodedBytes: Buffer.byteLength(block.data, "base64"),
      }]
    : []);
}

function failed(result: CallToolResult): boolean {
  if (result.isError === true) return true;
  const structured = result.structuredContent;
  return typeof structured === "object" && structured !== null && "ok" in structured && structured.ok === false;
}

export class CallJournal {
  private readonly calls: CallRecord[] = [];
  private sequence = 0;

  constructor(private readonly capacity = 200) {}

  begin(tool: string, arguments_: Record<string, unknown>): ActiveCall {
    const id = randomUUID();
    const started = performance.now();
    this.sequence += 1;
    const prefix = tool.includes(".") ? tool.slice(0, tool.indexOf(".")) : "";
    this.calls.push({
      id,
      sequence: this.sequence,
      tool,
      server: prefix === "dev" || prefix === "project" || prefix === "" ? "local-dev" : prefix,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      status: "running",
      arguments: safeValue(arguments_),
      result: null,
      media: [],
    });
    while (this.calls.length > this.capacity) this.calls.shift();
    return { id, started };
  }

  complete(call: ActiveCall, result: CallToolResult): void {
    const record = this.calls.find(({ id }) => id === call.id);
    if (record === undefined) return;
    record.finishedAt = new Date().toISOString();
    record.durationMs = Math.round((performance.now() - call.started) * 10) / 10;
    record.status = failed(result) ? "error" : "ok";
    record.result = safeValue(result);
    record.media = media(result);
  }

  fail(call: ActiveCall): void {
    const record = this.calls.find(({ id }) => id === call.id);
    if (record === undefined) return;
    record.finishedAt = new Date().toISOString();
    record.durationMs = Math.round((performance.now() - call.started) * 10) / 10;
    record.status = "error";
    record.result = { error: "Tool call failed before returning an MCP result." };
  }

  snapshot(): CallRecord[] {
    return this.calls.map((call) => structuredClone(call)).reverse();
  }
}
