import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";

import type { InlineMediaConfig } from "./config/types.js";
import { isPathInside } from "./path.js";

interface DetectedMedia {
  type: "audio" | "image";
  mimeType: string;
}

function ascii(data: Buffer, start: number, end: number): string {
  return data.subarray(start, end).toString("ascii");
}

function detectMedia(data: Buffer): DetectedMedia | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { type: "image", mimeType: "image/png" };
  }
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return { type: "image", mimeType: "image/jpeg" };
  }
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(data, 0, 6))) {
    return { type: "image", mimeType: "image/gif" };
  }
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") {
    return { type: "image", mimeType: "image/webp" };
  }
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WAVE") {
    return { type: "audio", mimeType: "audio/wav" };
  }
  if (data.length >= 4 && ascii(data, 0, 4) === "OggS") {
    return { type: "audio", mimeType: "audio/ogg" };
  }
  if (data.length >= 4 && ascii(data, 0, 4) === "fLaC") {
    return { type: "audio", mimeType: "audio/flac" };
  }
  if (data.length >= 3 && ascii(data, 0, 3) === "ID3") {
    return { type: "audio", mimeType: "audio/mpeg" };
  }
  if (data[0] === 255 && data[1] !== undefined && (data[1] & 224) === 224) {
    return { type: "audio", mimeType: "audio/mpeg" };
  }
  return undefined;
}

async function resolvedRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
  return [...new Set(resolved.filter((root): root is string => root !== undefined))];
}

async function mediaBlock(path: string, roots: string[], maxBytes: number): Promise<ContentBlock | undefined> {
  if (!isAbsolute(path) || path.includes("\n") || path.includes("\r")) return undefined;
  const resolved = await realpath(path).catch(() => undefined);
  if (resolved === undefined || !roots.some((root) => isPathInside(root, resolved))) return undefined;
  const handle = await open(resolved, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) return undefined;
    const data = await handle.readFile();
    const detected = detectMedia(data);
    if (detected === undefined) return undefined;
    return { type: detected.type, data: data.toString("base64"), mimeType: detected.mimeType };
  } finally {
    await handle.close();
  }
}

export async function inlineLocalMedia(
  result: CallToolResult,
  configuration: InlineMediaConfig | undefined,
): Promise<CallToolResult> {
  if (configuration === undefined) return result;
  const roots = await resolvedRoots(configuration.roots);
  if (roots.length === 0) return result;
  const content: ContentBlock[] = [];
  const seen = new Set<string>();
  for (const block of result.content) {
    content.push(block);
    if (block.type !== "text") continue;
    const path = block.text.trim();
    if (seen.has(path)) continue;
    const media = await mediaBlock(path, roots, configuration.maxBytes);
    if (media !== undefined) {
      seen.add(path);
      content.push(media);
    }
  }
  if (content.length === result.content.length) return result;
  const mediaCount = content.filter((block) => block.type === "image" || block.type === "audio").length;
  return {
    ...result,
    content,
    ...(result.structuredContent === undefined
      ? { structuredContent: { localDevMedia: { count: mediaCount } } }
      : {}),
  };
}
