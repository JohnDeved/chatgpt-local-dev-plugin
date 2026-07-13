import type { LocalDevConfig, SelectedServer } from "../config/types.js";

export interface SetupState {
  version: 1;
  alias: string;
  binaryPath: string;
  tunnelId: string;
  runtimeKeyRef: string;
  mcpCommand: string;
  launchAgentPath: string | null;
  configuredAt: string;
}

export interface SetupPaths {
  home: string;
  codexConfig: string;
  localConfig: string;
  dashboardUrl: string;
  state: string;
  launchAgent: string;
  logDirectory: string;
}

export interface SetupOptions {
  yes?: boolean;
  projectRoots?: string[];
  selectedServers?: SelectedServer[];
  alias?: string;
  tunnelId?: string;
  runtimeKeyRef?: string;
  tunnelClientBin?: string;
  openBrowser?: boolean;
  installService?: boolean;
}

export interface SetupResult {
  ready: boolean;
  configuration: LocalDevConfig;
  state: SetupState;
  checklist: string[];
}

export interface RuntimeStatus {
  alias?: string;
  tunnel_id?: string;
  process_running?: boolean;
  healthy?: boolean;
  ready?: boolean;
  runtime_state?: string;
  ui_url?: string;
  remote_lookup_auth_ref?: string;
  control_plane_poll_health?: { state?: string; reason?: string };
  repair_actions?: Array<{ id?: string; command?: string; reason?: string }>;
}
