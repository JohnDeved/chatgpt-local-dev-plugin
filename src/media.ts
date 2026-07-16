import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";

import type { InlineMediaConfig } from "./config/types.js";
import { isPathInside } from "./path.js";

interface DetectedMedia {
  type: "audio" | "image";
  mimeType: string;
}

interface PrefixMedia extends DetectedMedia {
  prefix: Buffer;
}

const PREFIX_MEDIA: readonly PrefixMedia[] = [
  { prefix: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), type: "image", mimeType: "image/png" },
  { prefix: Buffer.from([255, 216, 255]), type: "image", mimeType: "image/jpeg" },
  { prefix: Buffer.from("GIF87a", "ascii"), type: "image", mimeType: "image/gif" },
  { prefix: Buffer.from("GIF89a", "ascii"), type: "image", mimeType: "image/gif" },
  { prefix: Buffer.from("OggS", "ascii"), type: "audio", mimeType: "audio/ogg" },
  { prefix: Buffer.from("fLaC", "ascii"), type: "audio", mimeType: "audio/flac" },
  { prefix: Buffer.from("ID3", "ascii"), type: "audio", mimeType: "audio/mpeg" },
];
const RIFF_MEDIA: Readonly<Record<string, DetectedMedia>> = {
  WEBP: { type: "image", mimeType: "image/webp" },
  WAVE: { type: "audio", mimeType: "audio/wav" },
};
const MPEG_AUDIO: DetectedMedia = { type: "audio", mimeType: "audio/mpeg" };

function ascii(data: Buffer, start: number, end: number): string {
  return data.subarray(start, end).toString("ascii");
}

function detectMedia(data: Buffer): DetectedMedia | undefined {
  const prefixed = PREFIX_MEDIA.find(({ prefix }) => data.subarray(0, prefix.length).equals(prefix));
  if (prefixed !== undefined) return { type: prefixed.type, mimeType: prefixed.mimeType };
  if (ascii(data, 0, 4) === "RIFF") return RIFF_MEDIA[ascii(data, 8, 12)];
  return data[0] === 255 && ((data[1] ?? 0) & 224) === 224 ? MPEG_AUDIO : undefined;
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
