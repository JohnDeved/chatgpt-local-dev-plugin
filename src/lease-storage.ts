import { constants } from "node:fs";
import { lstat, mkdir, open, rename, type FileHandle } from "node:fs/promises";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class LeaseError extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) { super(code); }
}
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const EXCLUSIVE = 0x20; // Darwin sys/fcntl.h O_EXLOCK (not exported by Node).

/** Storage root is injected. Construction performs no filesystem operation. */
export class LeaseStorage<T> {
  constructor(readonly directory: string, private readonly initial: () => T, private readonly decode: (value: unknown) => T) {
    if (!isAbsolute(directory)) throw new LeaseError("REGISTRY_PATH_MUST_BE_ABSOLUTE");
  }
  private async prepare(): Promise<void> {
    if (process.platform !== "darwin") throw new LeaseError("LEASE_PLATFORM_UNSUPPORTED");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new LeaseError("UNSAFE_REGISTRY_DIRECTORY");
  }
  private async check(handle: FileHandle, max = 8 * 1024 * 1024): Promise<void> {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > max || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new LeaseError("UNSAFE_REGISTRY_FILE");
  }
  private async read(path: string, max?: number): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await this.check(file, max); return await file.readFile(); } finally { await file.close(); }
  }
  private async replace(path: string, value: string | Buffer): Promise<void> {
    // Only newly-created data files are renamed. The kernel lock inode is permanent.
    const temp = `${path}.${randomUUID()}.pending`;
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  }
  async marker(id: string, probe = false): Promise<FileHandle | null> {
    await this.prepare();
    if (!/^[a-z0-9.-]{1,100}$/u.test(id)) throw new LeaseError("INVALID_REGISTRY_MARKER");
    try {
      const file = await open(join(this.directory, id), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | EXCLUSIVE, 0o600);
      try { await this.check(file, 256); return file; } catch (error) { await file.close(); throw error; }
    } catch (error) { if (probe && errno(error) === "EAGAIN") return null; throw error; }
  }
  async transaction<R>(action: (state: T) => Promise<R>): Promise<R> {
    const deadline = Date.now() + 10000;
    let lock: FileHandle | null;
    while (!(lock = await this.marker("transaction.lock", true))) {
      if (Date.now() >= deadline) throw new LeaseError("LEASE_TRANSACTION_BUSY");
      await delay(10);
    }
    try {
      const keyPath = join(this.directory, "authority.key"), path = join(this.directory, "state.json");
      let key: Buffer, createdKey = false;
      try { key = await this.read(keyPath, 32); }
      catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        try { await lstat(path); throw new LeaseError("REGISTRY_KEY_MISSING"); }
        catch (found) { if (errno(found) !== "ENOENT") throw found; }
        key = randomBytes(32); await this.replace(keyPath, key); createdKey = true;
      }
      if (key.length !== 32) throw new LeaseError("REGISTRY_KEY_INVALID");
      let state: T;
      try {
        const record = JSON.parse((await this.read(path)).toString()) as { payload?: unknown; signature?: unknown };
        if (typeof record.payload !== "string" || typeof record.signature !== "string" || !/^[a-f0-9]{64}$/u.test(record.signature)) throw new LeaseError("REGISTRY_AUTHENTICATION_FAILED");
        const expected = createHmac("sha256", key).update(record.payload).digest();
        if (!timingSafeEqual(expected, Buffer.from(record.signature, "hex"))) throw new LeaseError("REGISTRY_AUTHENTICATION_FAILED");
        state = this.decode(JSON.parse(record.payload));
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        if (!createdKey) throw new LeaseError("REGISTRY_STATE_MISSING");
        state = this.initial();
      }
      // Persist audited rejected transitions/reconciliation, then surface failure.
      let result: R | undefined, thrown: unknown, failed = false;
      try { result = await action(state); } catch (error) { failed = true; thrown = error; }
      const payload = JSON.stringify(state), signature = createHmac("sha256", key).update(payload).digest("hex");
      await this.replace(path, JSON.stringify({ payload, signature }) + "\n");
      if (failed) throw thrown;
      return result as R;
    } finally { await lock.close(); }
  }
}
