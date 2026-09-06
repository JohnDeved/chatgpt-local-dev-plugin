import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  object,
  string,
  type ActivityEvent,
  type DetailRequest,
  type DetailResponse,
} from "../shared/contracts.ts";
import { OutputDecoder, readable, TimelineIndex } from "../shared/presentation.ts";

interface Reference {
  file: string;
  offset: number;
  length: number;
  runtimeId: string;
  operationId?: string;
  parentId?: string;
  processId?: string;
  type: string;
  sequence: number;
}
interface Cursor {
  offset: number;
  pending: Buffer;
  identity: string;
}
export interface Manifest {
  runtimeId: string;
  pid: number;
  socketPath: string;
  journalPath: string;
  startedAt: string;
}
export class ActivityArchive {
  readonly index = new TimelineIndex();
  readonly references: Reference[] = [];
  readonly errors = new Set<string>();
  private readonly cursors = new Map<string, Cursor>();
  bytes = 0;
  loading = false;
  constructor(readonly directory: string) {}
  async scan(): Promise<Manifest[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory, { withFileTypes: true });
    const manifests: Manifest[] = [];
    this.bytes = 0;
    this.loading = false;
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !file.isFile() ||
        !/^[a-zA-Z0-9-]+\.(jsonl|json)$/.test(file.name) ||
        file.name === "settings.json"
      )
        continue;
      const path = join(this.directory, file.name);
      try {
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("Not an owned regular file");
        const handle = await open(path, "r");
        try {
          if (file.name.endsWith(".json")) {
            if (stat.size > 65536) throw new Error("Oversize runtime manifest");
            const json = object(JSON.parse(await handle.readFile("utf8")));
            if (
              typeof json.runtimeId === "string" &&
              /^[a-zA-Z0-9-]{1,100}$/.test(json.runtimeId) &&
              typeof json.socketPath === "string" &&
              typeof json.pid === "number"
            )
              manifests.push(json as unknown as Manifest);
            continue;
          }
          this.bytes += stat.size;
          const identity = `${stat.dev}:${stat.ino}`;
          const cursor = this.cursors.get(path) ?? {
            offset: 0,
            pending: Buffer.alloc(0),
            identity,
          };
          if (cursor.identity !== identity || stat.size < cursor.offset)
            throw new Error("Archive changed externally; restart the viewer to rebuild its index");
          const buffer = Buffer.alloc(Math.min(1024 * 1024, stat.size - cursor.offset));
          if (buffer.length) {
            const read = await handle.read(buffer, 0, buffer.length, cursor.offset);
            cursor.offset += read.bytesRead;
            cursor.pending = Buffer.concat([cursor.pending, buffer.subarray(0, read.bytesRead)]);
            let newline: number;
            while ((newline = cursor.pending.indexOf(10)) >= 0) {
              const offset = cursor.offset - cursor.pending.length;
              const bytes = cursor.pending.subarray(0, newline);
              cursor.pending = cursor.pending.subarray(newline + 1);
              if (!bytes.length) continue;
              try {
                const event = JSON.parse(bytes.toString("utf8")) as ActivityEvent;
                if (
                  typeof event.runtimeId !== "string" ||
                  typeof event.sequence !== "number" ||
                  typeof event.type !== "string"
                )
                  throw new Error("Invalid event envelope");
                this.references.push({
                  file: path,
                  offset,
                  length: bytes.length,
                  runtimeId: event.runtimeId,
                  operationId: event.operationId,
                  parentId: event.parentId,
                  processId:
                    typeof object(event.detail).processId === "string"
                      ? (object(event.detail).processId as string)
                      : undefined,
                  type: event.type,
                  sequence: event.sequence,
                });
                this.index.accept(event);
              } catch (error) {
                this.errors.add(`${file.name} at byte ${offset}: ${String(error)}`);
              }
            }
          }
          this.cursors.set(path, cursor);
          if (cursor.offset < stat.size) this.loading = true;
        } finally {
          await handle.close();
        }
      } catch (error) {
        this.errors.add(`${file.name}: ${String(error)}`);
      }
    }
    return manifests;
  }
  async details(request: DetailRequest): Promise<DetailResponse> {
    const related = new Set([request.operationId]);
    let previous = 0;
    while (previous !== related.size) {
      previous = related.size;
      for (const ref of this.references)
        if (
          ref.runtimeId === request.runtimeId &&
          ref.parentId &&
          related.has(ref.parentId) &&
          ref.operationId
        )
          related.add(ref.operationId);
    }
    const refs = this.references
      .filter(
        (ref) =>
          ref.runtimeId === request.runtimeId &&
          ref.operationId &&
          related.has(ref.operationId) &&
          (!request.processId || ref.processId === request.processId),
      )
      .sort((a, b) => a.sequence - b.sequence);
    if (!refs.length) throw new Error("The selected record is not available in the local archive.");
    let text = "";
    const images: DetailResponse["images"] = [];
    const seenImages = new Set<string>();
    const decoders = new Map<string, OutputDecoder>();
    const hasOutput = refs.some((ref) => ref.type === "process.output");
    for (const ref of refs) {
      if (
        request.mode === "input" &&
        ref.type !== "tool.requested" &&
        ref.type !== "process.requested"
      )
        continue;
      if (request.mode === "result" && ref.type !== "tool.result" && ref.type !== "tool.failed")
        continue;
      if (
        request.mode === "output" &&
        ref.type !== "process.output" &&
        !(ref.type === "tool.result" && !hasOutput)
      )
        continue;
      const handle = await open(ref.file, "r");
      let bytes: Buffer;
      try {
        bytes = Buffer.alloc(ref.length);
        const read = await handle.read(bytes, 0, ref.length, ref.offset);
        if (read.bytesRead !== ref.length)
          throw new Error("The original record was shortened externally.");
      } finally {
        await handle.close();
      }
      if (request.mode === "raw") {
        text += bytes.toString("utf8") + "\n";
        continue;
      }
      const event = JSON.parse(bytes.toString("utf8")) as ActivityEvent;
      const detail = object(event.detail);
      if (request.mode === "output" && ref.type === "process.output") {
        const channel = detail.stream === "stderr" ? "stderr" : "stdout";
        if (request.channel && request.channel !== "all" && channel !== request.channel) continue;
        const key = `${ref.processId}:${channel}`;
        let decoder = decoders.get(key);
        if (!decoder) {
          decoder = new OutputDecoder();
          decoders.set(key, decoder);
        }
        text += decoder.append(string(detail.text));
      } else {
        const value =
          request.mode === "input"
            ? (detail.arguments ?? { argv: detail.argv, cwd: detail.cwd })
            : (detail.result ?? detail.error);
        text += readable(value) + "\n\n";
        const visit = (node: unknown): void => {
          if (Array.isArray(node)) {
            node.forEach(visit);
            return;
          }
          const obj = object(node);
          if (
            obj.type === "image" &&
            typeof obj.data === "string" &&
            ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(string(obj.mimeType)) &&
            !seenImages.has(obj.data)
          ) {
            seenImages.add(obj.data);
            images.push({ mimeType: obj.mimeType as string, data: obj.data });
          }
          for (const item of Object.values(obj)) if (item && typeof item === "object") visit(item);
        };
        visit(value);
      }
    }
    return { text: text || "No output was captured for this selection.", images };
  }
}
