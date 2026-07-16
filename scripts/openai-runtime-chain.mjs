import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [, , depthValue, targetCommand, ...targetArguments] = process.argv;
const depth = Number.parseInt(depthValue ?? "", 10);

if (!Number.isInteger(depth) || depth < 0 || targetCommand == null) {
  console.error(
    "Usage: openai-runtime-chain.mjs <depth> <command> [arguments...]",
  );
  process.exit(64);
}

const scriptPath = fileURLToPath(import.meta.url);
const command = depth > 0 ? process.execPath : targetCommand;
const argumentsForChild =
  depth > 0
    ? [scriptPath, String(depth - 1), targetCommand, ...targetArguments]
    : targetArguments;

const child = spawn(command, argumentsForChild, {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode == null && child.signalCode == null) child.kill(signal);
  });
}

child.once("error", (error) => {
  console.error(`Failed to launch trusted runtime child: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal != null) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
