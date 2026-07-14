import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type SpawnedCommand = ChildProcessWithoutNullStreams;

export function spawnCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnedCommand {
  if (argv.length === 0 || argv.some((part) => part.length === 0)) throw new Error("INVALID_ARGV");
  return spawn(argv[0] as string, argv.slice(1), {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
