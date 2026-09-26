import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isPathInside } from "../path.js";
import type { JsonValue } from "../types.js";

export const MAX_TEXT_BYTES = 1_048_576;
export const MAX_EDITS = 100;
export const SHA256_PATTERN = "^[a-f0-9]{64}$";

export interface TextEdit { oldText: string; newText: string; }
export interface WriteInput { path: string; content: string; expectedSha256?: string; createParents?: boolean; }
export interface EditInput { path: string; expectedSha256: string; edits: TextEdit[]; }

export class FileEditError extends Error {
  constructor(readonly code: string, message: string, readonly detail: JsonValue = null) { super(message); }
}

interface Document { text: string; sha256: string; bytes: number; info: Stats; }
interface WriteReceipt { path: string; created: boolean; changed: boolean; beforeSha256: string | null; sha256: string; bytes: number; }

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function textBuffer(text: string): Buffer {
  if (Buffer.from(text, "utf8").toString("utf8") !== text || text.includes("\0")) throw new FileEditError("PROJECT_FILE_NOT_TEXT", "Only valid UTF-8 text without NUL bytes is supported.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_TEXT_BYTES) throw new FileEditError("PROJECT_FILE_TOO_LARGE", "UTF-8 file content must not exceed 1 MiB.");
  return bytes;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function changed(): never {
  throw new FileEditError("PROJECT_FILE_CHANGED", "The file changed. Read it again with project.read and retry using its new sha256; nothing was overwritten.");
}

async function optionalStat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if (errno(error) === "ENOENT") return undefined; throw error; }
}

function relativeParts(requested: string): string[] {
  if (isAbsolute(requested) || requested.includes("\\") || requested.includes("\0")) {
    throw new FileEditError("INVALID_PROJECT_PATH", "Use a relative project file path without parent traversal or symlinks.");
  }
  const parts = requested.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || [".git", ".hg", ".svn"].includes(part.toLowerCase()))) {
    throw new FileEditError("INVALID_PROJECT_PATH", "Parent traversal and repository metadata are not editable through project.write/project.edit.");
  }
  return parts;
}

async function ensureDirectory(path: string, create: boolean): Promise<void> {
  let info = await optionalStat(path);
  if (!info && create) {
    try { await mkdir(path); } catch (error) { if (errno(error) !== "EEXIST") throw error; }
    info = await lstat(path);
  }
  if (!info) throw new FileEditError("PROJECT_DIRECTORY_MISSING", "The parent directory does not exist. Enable createParents for a new file.");
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) {
    throw new FileEditError("INVALID_PROJECT_PATH", "The path must contain only regular project directories, not symlinks.");
  }
}

/** Paths for writes must not traverse symlinks, parent segments or repository metadata. */
async function targetPath(root: string, requested: string, createParents: boolean, signal?: AbortSignal): Promise<string> {
  const parts = relativeParts(requested);
  if (await realpath(root) !== root) throw new FileEditError("INVALID_PROJECT_PATH", "The active project path changed; reopen the project before editing.");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    signal?.throwIfAborted();
    parent = join(parent, part);
    await ensureDirectory(parent, createParents);
  }
  const target = resolve(parent, parts.at(-1) as string);
  if (!isPathInside(root, target)) throw new FileEditError("INVALID_PROJECT_PATH", "The target must remain inside the active project.");
  const info = await optionalStat(target);
  if (info?.isSymbolicLink()) throw new FileEditError("INVALID_PROJECT_PATH", "Editing through a symlink is not supported. Use the real project file path.");
  if (info && (!info.isFile() || info.nlink !== 1)) throw new FileEditError("PROJECT_FILE_UNWRITABLE", "The target must be a regular, non-hard-linked project file.");
  return target;
}

/** Bounded read preserves CRLF, final-newline choice and BOM; invalid UTF-8 is not silently replaced. */
export async function readTextDocument(path: string, signal?: AbortSignal): Promise<Document> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new FileEditError("PROJECT_FILE_UNREADABLE", "The requested path is not a regular text file.");
    if (before.size > MAX_TEXT_BYTES) throw new FileEditError("PROJECT_FILE_TOO_LARGE", "UTF-8 file content must not exceed 1 MiB.");
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > MAX_TEXT_BYTES) throw new FileEditError("PROJECT_FILE_TOO_LARGE", "UTF-8 file content must not exceed 1 MiB.");
    const after = await handle.stat();
    if (size !== before.size || !sameFile(before, after)) changed();
    const bytes = buffer.subarray(0, size);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new FileEditError("PROJECT_FILE_NOT_TEXT", "The file is not valid UTF-8; binary/other encodings must use an appropriate file tool."); }
    if (text.includes("\0")) throw new FileEditError("PROJECT_FILE_NOT_TEXT", "The file contains NUL bytes and is not supported as text.");
    return { text, bytes: size, sha256: digest(bytes), info: before };
  } finally { await handle.close(); }
}

function expected(document: Document, hash: string): void { if (document.sha256 !== hash) changed(); }

async function prepareTemporary(target: string, content: Buffer, mode: number): Promise<string> {
  const temporary = join(dirname(target), `.local-dev-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    return temporary;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function replaceObserved(temporary: string, target: string, original: Document, signal?: AbortSignal): Promise<void> {
  const info = await optionalStat(target);
  if (!info || !sameFile(original.info, info)) changed();
  const current = await readTextDocument(target, signal);
  if (!sameFile(original.info, current.info) || current.sha256 !== original.sha256) changed();
  signal?.throwIfAborted();
  await rename(temporary, target);
}

async function createWithoutClobber(temporary: string, target: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  // link is no-clobber: a concurrent file creator cannot be overwritten by rename.
  try { await link(temporary, target); }
  catch (error) {
    if (errno(error) === "EEXIST") throw new FileEditError("PROJECT_FILE_EXISTS", "Another writer created this file. Read it before retrying.");
    throw error;
  }
}

/** Prepare in memory, publish from a same-directory temporary file, never truncate the old file. */
async function publish(
  root: string, path: string, target: string, content: Buffer, original: Document | undefined, signal?: AbortSignal,
): Promise<WriteReceipt> {
  const sha256 = digest(content);
  const receipt = { path, created: !original, changed: sha256 !== original?.sha256, beforeSha256: original?.sha256 ?? null, sha256, bytes: content.length };
  if (!receipt.changed) return receipt;
  const mode = original ? original.info.mode & 0o777 : 0o666 & ~process.umask();
  const temporary = await prepareTemporary(target, content, mode);
  try {
    signal?.throwIfAborted();
    // Revalidate directories immediately before verifying and publishing the target.
    if (await targetPath(root, path, false, signal) !== target) changed();
    if (original) await replaceObserved(temporary, target, original, signal);
    else await createWithoutClobber(temporary, target, signal);
    return receipt;
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function writeTextFile(root: string, input: WriteInput, signal?: AbortSignal): Promise<WriteReceipt> {
  signal?.throwIfAborted();
  const content = textBuffer(input.content);
  const target = await targetPath(root, input.path, input.expectedSha256 === undefined && input.createParents !== false, signal);
  const info = await optionalStat(target);
  if (input.expectedSha256 === undefined) {
    if (info) throw new FileEditError("PROJECT_FILE_EXISTS", "The file already exists. Read it with project.read and provide expectedSha256 before replacing it.");
    return await publish(root, input.path, target, content, undefined, signal);
  }
  if (!info) throw new FileEditError("PROJECT_ENTRY_NOT_FOUND", "The file no longer exists. Read the current project before replacing it.");
  const original = await readTextDocument(target, signal);
  expected(original, input.expectedSha256);
  return await publish(root, input.path, target, content, original, signal);
}

export async function editTextFile(root: string, input: EditInput, signal?: AbortSignal): Promise<WriteReceipt & { editsApplied: number }> {
  signal?.throwIfAborted();
  let total = 0;
  for (const edit of input.edits) total += textBuffer(edit.oldText).length + textBuffer(edit.newText).length;
  if (total > 2 * MAX_TEXT_BYTES) throw new FileEditError("PROJECT_EDIT_TOO_LARGE", "Combined oldText/newText must not exceed 2 MiB.");
  const target = await targetPath(root, input.path, false, signal);
  const original = await readTextDocument(target, signal);
  expected(original, input.expectedSha256);
  let text = original.text;
  for (const [index, edit] of input.edits.entries()) {
    signal?.throwIfAborted();
    const found = text.indexOf(edit.oldText);
    if (found < 0) throw new FileEditError("PROJECT_EDIT_NOT_FOUND", "oldText was not found exactly. Read the file and include matching whitespace/context; no edits were written.", { edit: index + 1 });
    if (text.indexOf(edit.oldText, found + 1) >= 0) throw new FileEditError("PROJECT_EDIT_AMBIGUOUS", "oldText occurs more than once. Include more surrounding context; no edits were written.", { edit: index + 1 });
    text = text.slice(0, found) + edit.newText + text.slice(found + edit.oldText.length);
    textBuffer(text);
  }
  return { ...await publish(root, input.path, target, textBuffer(text), original, signal), editsApplied: input.edits.length };
}
