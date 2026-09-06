import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// Small monochrome terminal mark. The OS treats its alpha as a template tray icon.
const size = 40;
const pixels = Buffer.alloc((size * 4 + 1) * size);
function pixel(x, y) {
  if (x >= 0 && x < size && y >= 0 && y < size) pixels[y * (size * 4 + 1) + 1 + x * 4 + 3] = 255;
}
function line(x1, y1, x2, y2) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let i = 0; i <= steps; i++)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        pixel(
          Math.round(x1 + ((x2 - x1) * i) / steps) + dx,
          Math.round(y1 + ((y2 - y1) * i) / steps) + dy,
        );
}
line(6, 8, 34, 8);
line(34, 8, 34, 32);
line(34, 32, 6, 32);
line(6, 32, 6, 8);
line(12, 15, 18, 20);
line(18, 20, 12, 25);
line(23, 25, 28, 25);
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
const directory = fileURLToPath(new URL("../public/", import.meta.url));
await mkdir(directory, { recursive: true });
await writeFile(directory + "tray.png", png);
