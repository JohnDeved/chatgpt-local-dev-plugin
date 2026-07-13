import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeAtomic(path: string, content: string): Promise<string | undefined> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let backup: string | undefined;
  if (await exists(path)) {
    backup = `${path}.backup.${timestamp()}`;
    await copyFile(path, backup);
    await chmod(backup, 0o600);
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return backup;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function restoreAtomic(path: string, backup: string | undefined): Promise<void> {
  if (backup === undefined) {
    await removeFile(path);
    return;
  }
  const temporary = `${path}.restore-${process.pid}-${Date.now()}`;
  await copyFile(backup, temporary);
  await rename(temporary, path);
  await chmod(path, 0o600);
}
