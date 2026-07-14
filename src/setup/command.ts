import { spawn } from "node:child_process";

const MAX_CAPTURE = 1_048_576;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function append(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_CAPTURE ? next : next.slice(-MAX_CAPTURE);
}

export async function runCommand(program: string, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("COMMAND_TIMEOUT"));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", () => {
      settled = true;
      clearTimeout(timer);
      reject(new Error("COMMAND_FAILED"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runJson(program: string, args: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const result = await runCommand(program, args, timeoutMs);
  if (result.code !== 0) throw new Error("COMMAND_FAILED");
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_JSON");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_JSON");
  }
}
