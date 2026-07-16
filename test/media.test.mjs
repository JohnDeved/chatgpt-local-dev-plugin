import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inlineLocalMedia } from "../dist/media.js";

const fixtures = [
  ["image/png", "image", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ["image/jpeg", "image", Buffer.from([255, 216, 255, 0])],
  ["image/gif", "image", Buffer.from("GIF87a", "ascii")],
  ["image/gif", "image", Buffer.from("GIF89a", "ascii")],
  ["image/webp", "image", Buffer.from("RIFF0000WEBP", "ascii")],
  ["audio/wav", "audio", Buffer.from("RIFF0000WAVE", "ascii")],
  ["audio/ogg", "audio", Buffer.from("OggS", "ascii")],
  ["audio/flac", "audio", Buffer.from("fLaC", "ascii")],
  ["audio/mpeg", "audio", Buffer.from("ID3", "ascii")],
  ["audio/mpeg", "audio", Buffer.from([255, 224, 0])],
];

test("recognizes every supported inline media signature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-dev-media-"));
  try {
    for (const [mimeType, type, data] of fixtures) {
      const path = join(directory, mimeType.replace("/", "-"));
      await writeFile(path, data);
      const result = await inlineLocalMedia(
        { content: [{ type: "text", text: path }] },
        { roots: [directory], maxBytes: 1024 },
      );
      assert.deepEqual(result.content[1], {
        type,
        mimeType,
        data: data.toString("base64"),
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
