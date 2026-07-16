import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigError,
  loadConfiguration,
  parseCodexConfig,
  parseLocalDevConfig,
} from "../dist/config/index.js";

const codexFixture = `
[mcp_servers.local]
command = "node"
args = ["server.mjs"]
cwd = "/tmp/project"
env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]
enabled_tools = ["read", "write"]
disabled_tools = ["write"]
required = true
startup_timeout_ms = 2500
tool_timeout_sec = 45
default_tools_approval_mode = "writes"
[mcp_servers.local.env]
MODE = "test"
[mcp_servers.local.tools.read]
approval_mode = "approve"

[mcp_servers.public_http]
url = "https://example.test/mcp"

[mcp_servers.direct_http]
url = "https://direct.example.test/mcp"
auth = "oauth"
bearer_token_env_var = "DIRECT_TOKEN"

[mcp_servers.managed_http]
url = "https://managed.example.test/mcp"
auth = "chatgpt"

[mcp_servers.disabled]
command = "disabled-server"
enabled = false
`;

test("parses enabled Codex stdio and HTTP entries without resolving credentials", () => {
  const parsed = parseCodexConfig(codexFixture);
  assert.equal(parsed.servers.length, 4);
  assert.deepEqual(parsed.disabledIds, ["disabled"]);
  const local = parsed.servers[0];
  assert.equal(local.transport, "stdio");
  assert.deepEqual(local.args, ["server.mjs"]);
  assert.deepEqual(local.envVars, [
    { name: "LOCAL_TOKEN", source: "local" },
    { name: "REMOTE_TOKEN", source: "remote" },
  ]);
  assert.equal(local.startupTimeoutMs, 2500);
  assert.equal(local.toolTimeoutMs, 45_000);
  assert.deepEqual(local.tools, { read: { approvalMode: "approve" } });
  assert.equal(parsed.servers[1].independentlyUsable, true);
  assert.equal(parsed.servers[3].independentlyUsable, false);
});

test("rejects ambiguous transports and redacts configured values from errors", () => {
  const secret = "do-not-print-this-secret";
  assert.throws(
    () => parseCodexConfig(`[mcp_servers.bad]\ncommand="node"\nurl="https://example.test"\nenv={TOKEN="${secret}"}`),
    (error) => error instanceof ConfigError && error.code === "INVALID_CODEX_CONFIG" && !error.message.includes(secret),
  );
});

test("parses strict Local Dev selections, roots, and argv hooks", () => {
  const config = parseLocalDevConfig(JSON.stringify({
    version: 1,
    projectRoots: ["/work"],
    approvedBrowserOrigins: ["https://chatgpt.com"],
    selectedServers: [{
      id: "local",
      alias: "code",
      inlineMedia: { roots: ["/tmp"], maxBytes: 1024, tools: ["screenshot"] },
    }],
    projectOpenHooks: [{ projectRoot: "/work/project", argv: ["npm", "install"] }],
    projectBindings: [{ server: "code", tool: "activate_project", arguments: { project: "${projectPath}", nested: [1, true] } }],
  }));
  assert.deepEqual(config.approvedBrowserOrigins, ["https://chatgpt.com"]);
  assert.deepEqual(config.selectedServers, [{
    id: "local",
    alias: "code",
    inlineMedia: { roots: ["/tmp"], maxBytes: 1024, tools: ["screenshot"] },
  }]);
  assert.deepEqual(config.projectOpenHooks[0].argv, ["npm", "install"]);
  assert.deepEqual(config.projectBindings, [{
    server: "code",
    tool: "activate_project",
    arguments: { project: "${projectPath}", nested: [1, true] },
  }]);
});

test("rejects relative roots, duplicate aliases, unknown fields, and shell strings", () => {
  const base = { version: 1, projectRoots: ["/work"], selectedServers: [], projectOpenHooks: [] };
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, projectRoots: ["relative"] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, selectedServers: [{ id: "a", alias: "same" }, { id: "b", alias: "same" }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, selectedServers: [{ id: "a", alias: "a", inlineMedia: { roots: ["relative"] } }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, selectedServers: [{ id: "a", alias: "a", inlineMedia: { roots: ["/tmp"], maxBytes: 30 * 1024 * 1024 } }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, selectedServers: [{ id: "a", alias: "a", inlineMedia: { roots: ["/tmp"], tools: [] } }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, approvedBrowserOrigins: ["https://chatgpt.com/path"] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, approvedBrowserOrigins: ["https://chatgpt.com", "https://chatgpt.com"] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, surprise: true })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, projectOpenHooks: [{ projectRoot: "/work", argv: "npm install" }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, projectOpenHooks: [{ projectRoot: "/outside", argv: ["npm", "install"] }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, projectBindings: [{ server: "missing", tool: "activate", arguments: {} }] })), ConfigError);
  assert.throws(() => parseLocalDevConfig(JSON.stringify({ ...base, selectedServers: [{ id: "a", alias: "a" }], projectBindings: [{ server: "a", tool: "activate", arguments: [] }] })), ConfigError);
});

test("loads from a temporary home and resolves only explicitly selected usable servers", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-config-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".local-dev"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), codexFixture, "utf8");
    await writeFile(join(home, ".local-dev", "config.json"), JSON.stringify({
      version: 1,
      projectRoots: ["/work"],
      selectedServers: [
        { id: "local", alias: "code" },
        { id: "managed_http", alias: "managed" },
      ],
      projectOpenHooks: [],
    }), "utf8");
    const loaded = await loadConfiguration({ home });
    assert.deepEqual(loaded.selectedServers.map(({ alias }) => alias), ["code"]);
    assert.deepEqual(loaded.skippedServers, [
      { id: "disabled", code: "DISABLED" },
      { id: "managed_http", code: "MANAGED_AUTH" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uses empty Local Dev selections when its file does not exist", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-config-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), codexFixture, "utf8");
    const loaded = await loadConfiguration({ home });
    assert.deepEqual(loaded.localDev.selectedServers, []);
    assert.deepEqual(loaded.selectedServers, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fails selected disabled, unknown, and required managed-auth servers", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-dev-config-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".local-dev"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), `${codexFixture}\n[mcp_servers.required_managed]\nurl="https://required.test/mcp"\nauth="oauth"\nrequired=true\n`, "utf8");
    for (const id of ["disabled", "missing", "required_managed"]) {
      await writeFile(join(home, ".local-dev", "config.json"), JSON.stringify({
        version: 1,
        projectRoots: [],
        selectedServers: [{ id, alias: "selected" }],
        projectOpenHooks: [],
      }), "utf8");
      await assert.rejects(() => loadConfiguration({ home }), ConfigError);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
