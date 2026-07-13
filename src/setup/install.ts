import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { runCommand } from "./command.js";

const VERSION = "v0.0.10";
const RELEASE = `https://github.com/openai/tunnel-client/releases/download/${VERSION}`;

function archiveName(): string {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_PLATFORM");
  if (process.arch === "arm64") return `tunnel-client-${VERSION}-darwin-arm64.zip`;
  if (process.arch === "x64") return `tunnel-client-${VERSION}-darwin-amd64.zip`;
  throw new Error("UNSUPPORTED_PLATFORM");
}

export async function installTunnelClient(home: string): Promise<string> {
  const archive = archiveName();
  const temporary = await mkdtemp(join(tmpdir(), "local-dev-tunnel-client-"));
  const zip = join(temporary, archive);
  const sums = join(temporary, "SHA256SUMS.txt");
  try {
    const download = await runCommand("/usr/bin/curl", ["-fsSL", "--proto", "=https", "--tlsv1.2", "-o", zip, `${RELEASE}/${archive}`], 120_000);
    if (download.code !== 0) throw new Error("DOWNLOAD_FAILED");
    const checksumDownload = await runCommand("/usr/bin/curl", ["-fsSL", "--proto", "=https", "--tlsv1.2", "-o", sums, `${RELEASE}/SHA256SUMS.txt`], 30_000);
    if (checksumDownload.code !== 0) throw new Error("DOWNLOAD_FAILED");
    const expectedLine = (await readFile(sums, "utf8")).split(/\r?\n/u).find((line) => line.trim().endsWith(basename(archive)));
    if (expectedLine === undefined) throw new Error("CHECKSUM_MISSING");
    const expected = expectedLine.trim().split(/\s+/u)[0];
    const measured = await runCommand("/usr/bin/shasum", ["-a", "256", zip]);
    const actual = measured.stdout.trim().split(/\s+/u)[0];
    if (measured.code !== 0 || expected === undefined || actual !== expected) throw new Error("CHECKSUM_FAILED");
    const unzip = await runCommand("/usr/bin/unzip", ["-q", zip, "-d", temporary]);
    if (unzip.code !== 0 || !(await readdir(temporary)).includes("tunnel-client")) throw new Error("INSTALL_FAILED");
    const destinationDirectory = join(home, ".local", "bin");
    const destination = join(destinationDirectory, "tunnel-client");
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    await copyFile(join(temporary, "tunnel-client"), destination);
    await chmod(destination, 0o700);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
