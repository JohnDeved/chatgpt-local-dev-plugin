declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options: { recursive: boolean; mode?: number },
  ): Promise<string | undefined>;
  export function writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: string; mode?: number },
  ): Promise<void>;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  stdin: {
    on(event: "data", listener: (chunk: string) => void): void;
    resume(): void;
    setEncoding(encoding: "utf8"): void;
  };
  stdout: {
    write(data: string): boolean;
  };
  stderr: {
    write(data: string): boolean;
  };
  on(event: string, listener: (error: unknown) => void): void;
};
