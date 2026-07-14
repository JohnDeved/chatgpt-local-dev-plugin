export type ConfigErrorCode =
  | "CONFIG_NOT_FOUND"
  | "INVALID_TOML"
  | "INVALID_CODEX_CONFIG"
  | "INVALID_LOCAL_CONFIG"
  | "UNKNOWN_SERVER"
  | "UNAVAILABLE_SERVER";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly path: string;

  constructor(code: ConfigErrorCode, path: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.path = path;
  }
}
