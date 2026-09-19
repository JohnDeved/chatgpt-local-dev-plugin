import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

class McpProcess {
  constructor(env) {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = "";
    this.buffer = "";
    this.process = spawn(process.execPath, ["dist/cli.js"], {
      cwd: new URL("../", import.meta.url),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.#onData(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        const message = JSON.parse(line);
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter(message);
        } else if (typeof message.method === "string") {
          this.notifications.push(message);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  request(method, params, timeoutMs = 5_000) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${this.stderr}`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close() {
    this.process.kill("SIGTERM");
  }
}

async function fixture({ hook = false, proxy = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "local-dev-core-"));
  const project = join(home, "projects", "demo");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".local-dev", "activity"), { recursive: true, mode: 0o700 });
  // Explicit fixture policy; production defaults remain approval-required.
  await writeFile(join(home, ".local-dev", "activity", "settings.json"), JSON.stringify({ autoApprove: true, remember: true }), { mode: 0o600 });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "demo-project" }), "utf8");
  const fakeServer = new URL("./fake-mcp-server.mjs", import.meta.url).pathname;
  const codexConfig = proxy
    ? `[mcp_servers.fake]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fakeServer)}]\nenabled_tools = ["echo", "activate_project", "blocked"]\ndisabled_tools = ["blocked"]\nrequired = true\n`
    : "# empty MCP registry\n";
  await writeFile(join(home, ".codex", "config.toml"), codexConfig, "utf8");
  const marker = join(project, "hook-ran");
  await writeFile(join(home, ".local-dev", "config.json"), JSON.stringify({
    version: 1,
    projectRoots: [join(home, "projects")],
    selectedServers: proxy ? [{ id: "fake", alias: "fixture" }] : [],
    projectOpenHooks: hook ? [{
      projectRoot: project,
      argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
    }] : [],
    projectBindings: proxy ? [{ server: "fixture", tool: "activate_project", arguments: { project: "${projectPath}" } }] : [],
  }), "utf8");
  return { home, marker, project };
}

async function initialize(client) {
  const response = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "core-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const started = await client.request("tools/call", { name: "run.start", arguments: { goal: "Verify isolated stdio behavior" } });
  const runId = started.result.structuredContent.data.run.id;
  await client.request("tools/call", { name: "run.update", arguments: { runId, summary: "Run the isolated integration assertions.", todos: [{ id: "verify", title: "Verify stdio behavior", status: "in_progress" }] } });
  return response;
}

test("production stdio server exposes tool-only native tools with ChatGPT statuses", async () => {
  const { home } = await fixture();
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    const initialized = await initialize(client);
    assert.deepEqual(initialized.result.serverInfo, { name: "local-dev", version: "0.3.0" });
    assert.match(initialized.result.instructions, /Keep the user visibly informed/u);
    assert.match(initialized.result.instructions, /exact Local Dev tool, executable path, and command arguments/u);
    assert.match(initialized.result.instructions, /roughly every three tool calls/u);
    assert.equal("resources" in initialized.result.capabilities, false);
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      "project.open",
      "project.current",
      "project.read",
      "project.files",
      "project.release",
      "project.forceRelease",
      "project.handoff",
      "dev.run",
      "dev.batch",
      "dev.poll",
      "dev.stop",
      "dev.diff",
      "ask",
      "run.start",
      "run.update",
      "run.finish",
    ]);
    for (const tool of listed.result.tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
      assert.equal(tool.annotations.openWorldHint, false);
      assert.ok(tool.outputSchema);
      assert.equal(typeof tool._meta["openai/toolInvocation/invoking"], "string");
      assert.equal(typeof tool._meta["openai/toolInvocation/invoked"], "string");
      assert.ok(tool._meta["openai/toolInvocation/invoking"].length <= 64);
      assert.ok(tool._meta["openai/toolInvocation/invoked"].length <= 64);
      assert.equal(tool._meta.ui, undefined);
      assert.equal(tool._meta["openai/outputTemplate"], undefined);
    }
    const poll = listed.result.tools.find((tool) => tool.name === "dev.poll");
    assert.match(poll.description, /after dev\.run with background=true/u);
    assert.match(poll.description, /waitMs/u);
    assert.equal(poll.inputSchema.properties.waitMs.maximum, 120_000);
    assert.match(initialized.result.instructions, /prefer dev\.poll with a bounded waitMs instead of repeated immediate polls/u);
    assert.match(initialized.result.instructions, /do not run sleep or manual ps loops solely to wait/iu);
    const ask = listed.result.tools.find((tool) => tool.name === "ask");
    assert.equal(ask.annotations.readOnlyHint, true);
    assert.match(ask.description, /90 seconds/u);
    const current = await client.request("tools/call", { name: "project.current", arguments: {} });
    assert.equal(current.result.structuredContent.data.path, null);
    assert.equal(client.stderr, "");
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("streams human-readable progress for long native tools", async () => {
  const { home } = await fixture();
  const client = new McpProcess({ ...process.env, HOME: home });
  const updates = (token) => client.notifications
    .filter(({ method, params }) => method === "notifications/progress" && params.progressToken === token)
    .map(({ params }) => params);
  const assertMonotonic = (values) => {
    assert.equal(values[0].progress, 0);
    assert.ok(values.length >= 2);
    assert.equal(values.every((value) => value.total === undefined), true);
    for (let index = 1; index < values.length; index += 1) {
      assert.ok(values[index].progress > values[index - 1].progress);
    }
  };

  try {
    await initialize(client);
    const opened = await client.request("tools/call", {
      name: "project.open",
      arguments: { query: "demo" },
      _meta: { progressToken: "open-progress" },
    });
    assert.equal(opened.result.structuredContent.ok, true);
    const openUpdates = updates("open-progress");
    assertMonotonic(openUpdates);
    assert.equal(openUpdates.some(({ message }) => /Searching configured projects/u.test(message)), true);
    assert.equal(openUpdates.some(({ message }) => /Project demo is active/u.test(message)), true);

    const run = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: ["/bin/sleep", "5.2"], timeoutMs: 7_000 },
      _meta: { progressToken: "run-progress" },
    }, 9_000);
    assert.equal(run.result.structuredContent.ok, true);
    const runUpdates = updates("run-progress");
    assertMonotonic(runUpdates);
    const sleepLabel = `${JSON.stringify("/bin/sleep")} ${JSON.stringify("5.2")}`;
    assert.equal(runUpdates.some(({ message }) => message === `Running ${sleepLabel}…`), true);
    assert.equal(runUpdates.some(({ message }) => message === `Still running ${sleepLabel} (5s elapsed)…`), true);

    const batch = await client.request("tools/call", {
      name: "dev.batch",
      arguments: {
        steps: [
          { argv: [process.execPath, "--version"] },
          { argv: [process.execPath, "--version"] },
        ],
      },
      _meta: { progressToken: "batch-progress" },
    });
    assert.equal(batch.result.structuredContent.ok, true);
    const batchUpdates = updates("batch-progress");
    assertMonotonic(batchUpdates);
    const nodeVersionLabel = `${JSON.stringify(process.execPath)} ${JSON.stringify("--version")}`;
    assert.equal(batchUpdates.some(({ message }) => message === `Step 1/2: ${nodeVersionLabel}`), true);
    assert.equal(batchUpdates.some(({ message }) => message === `Step 2/2: ${nodeVersionLabel}`), true);
    assert.equal(batchUpdates.some(({ message }) => /Completed all 2 command steps/u.test(message)), true);
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("opens a configured project and runs argv without a shell", async () => {
  const { home, project } = await fixture();
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    await initialize(client);
    const before = await client.request("tools/call", { name: "dev.run", arguments: { argv: [process.execPath, "--version"] } });
    assert.equal(before.result.structuredContent.error.code, "NO_ACTIVE_PROJECT");
    const opened = await client.request("tools/call", { name: "project.open", arguments: { query: "demo" } });
    assert.equal(opened.result.structuredContent.data.path, await realpath(project));
    const run = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "-e", "process.stdout.write('core-ok')"] },
    });
    assert.equal(run.result.structuredContent.ok, true);
    assert.equal(run.result.structuredContent.data.exitCode, 0);
    assert.equal(run.result.structuredContent.data.outputTail, "core-ok");
    assert.deepEqual(run.result.structuredContent.data.argv, [process.execPath, "-e", "process.stdout.write('core-ok')"]);
    assert.equal(run.result.structuredContent.data.cwd, await realpath(project));
    assert.equal(run.result.structuredContent.data.background, false);
    assert.equal(typeof run.result.structuredContent.data.startedAt, "string");
    assert.equal(typeof run.result.structuredContent.data.finishedAt, "string");
    assert.equal(new Date(run.result.structuredContent.data.finishedAt) >= new Date(run.result.structuredContent.data.startedAt), true);
    const nested = join(project, "packages", "web");
    await mkdir(nested, { recursive: true });
    const nestedRun = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"], cwd: "packages/web" },
    });
    assert.equal(nestedRun.result.structuredContent.data.outputTail, await realpath(nested));
    const escapedCwd = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "--version"], cwd: "../" },
    });
    assert.equal(escapedCwd.result.structuredContent.error.code, "INVALID_CWD");
    const nonzero = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "-e", "process.stderr.write('failed');process.exit(7)"] },
    });
    assert.equal(nonzero.result.structuredContent.error.code, "COMMAND_EXIT_NONZERO");
    assert.equal(nonzero.result.structuredContent.data.exitCode, 7);
    assert.equal(nonzero.result.structuredContent.data.outputTail, "failed");
    const allowedNonzero = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "-e", "process.exit(3)"], allowNonZero: true },
    });
    assert.equal(allowedNonzero.result.structuredContent.ok, true);
    assert.equal(allowedNonzero.result.structuredContent.data.exitCode, 3);
    const timedOut = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "-e", "process.stdout.write('before-timeout');setInterval(()=>{},1000)"], timeoutMs: 1000 },
    });
    assert.equal(timedOut.result.structuredContent.error.code, "COMMAND_TIMEOUT");
    assert.match(timedOut.result.structuredContent.data.outputTail, /before-timeout/u);
    const shell = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: ["sh", "-c", "echo forbidden"] },
    });
    assert.equal(shell.result.structuredContent.error.code, "INVALID_SHELL");
    const batch = await client.request("tools/call", {
      name: "dev.batch",
      arguments: {
        steps: [
          { argv: [process.execPath, "-e", "process.stdout.write('one')"] },
          { argv: [process.execPath, "-e", "process.stdout.write('two')"], cwd: "packages/web" },
        ],
      },
    });
    assert.equal(batch.result.structuredContent.ok, true);
    assert.equal(batch.result.structuredContent.data.steps.length, 2);
    const background = await client.request("tools/call", {
      name: "dev.run",
      arguments: {
        argv: [
          process.execPath,
          "-e",
          "setTimeout(() => { process.stdout.write('waited'); }, 120)",
        ],
        background: true,
      },
    });
    assert.equal(background.result.structuredContent.data.state, "running");
    const waitedAt = Date.now();
    const waited = await client.request("tools/call", {
      name: "dev.poll",
      arguments: { waitMs: 2_000 },
    });
    assert.equal(waited.result.structuredContent.data.state, "exited");
    assert.equal(waited.result.structuredContent.data.outputTail, "waited");
    assert.ok(Date.now() - waitedAt >= 80);
    const invalidWait = await client.request("tools/call", {
      name: "dev.poll",
      arguments: { waitMs: 120_001 },
    });
    assert.equal(invalidWait.result.structuredContent.error.code, "INVALID_ARGUMENTS");
    const missing = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [join(home, "does-not-exist")] },
    });
    assert.equal(missing.result.structuredContent.error.code, "COMMAND_FAILED");
    const invalid = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "--version"], timeoutMs: 120_001, unexpected: true },
    });
    assert.equal(invalid.result.structuredContent.error.code, "INVALID_ARGUMENTS");
    const extra = await client.request("tools/call", { name: "project.current", arguments: { unexpected: true } });
    assert.equal(extra.result.structuredContent.error.code, "INVALID_ARGUMENTS");
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("runs argv-based project hooks before activating a project", async () => {
  const { home, marker } = await fixture({ hook: true });
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    await initialize(client);
    const opened = await client.request("tools/call", { name: "project.open", arguments: { query: "demo" } });
    assert.equal(opened.result.structuredContent.ok, true);
    assert.equal(opened.result.structuredContent.data.hooksRun, 1);
    assert.equal(await readFile(marker, "utf8"), "ok");
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("synchronizes configured downstream project bindings", async () => {
  const { home, project } = await fixture({ proxy: true });
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    await initialize(client);
    const opened = await client.request("tools/call", { name: "project.open", arguments: { query: "demo" } });
    assert.equal(opened.result.structuredContent.ok, true);
    assert.equal(opened.result.structuredContent.data.bindingWarnings, 0);
    assert.deepEqual(opened.result.structuredContent.data.bindings, [{
      server: "fixture",
      tool: "activate_project",
      status: "ok",
      message: `active=${await realpath(project)}`,
    }]);
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("tracks one background process, detects loopback URLs, and stops it", async () => {
  const { home } = await fixture();
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    await initialize(client);
    await client.request("tools/call", { name: "project.open", arguments: { query: "demo" } });
    const started = await client.request("tools/call", {
      name: "dev.run",
      arguments: {
        argv: [process.execPath, "-e", "console.error('http://127.0.0.1:4321/ready');setInterval(()=>{},1000)"],
        background: true,
      },
    });
    assert.equal(started.result.structuredContent.data.state, "running");
    let polled;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      polled = await client.request("tools/call", { name: "dev.poll", arguments: {} });
      if (polled.result.structuredContent.data.urls.length > 0) break;
    }
    assert.deepEqual(polled.result.structuredContent.data.urls, ["http://127.0.0.1:4321/ready"]);
    const busy = await client.request("tools/call", {
      name: "dev.run",
      arguments: { argv: [process.execPath, "--version"], background: true },
    });
    assert.equal(busy.result.structuredContent.error.code, "BACKGROUND_BUSY");
    const stopped = await client.request("tools/call", { name: "dev.stop", arguments: {} });
    assert.equal(stopped.result.structuredContent.data.state, "exited");
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("paginates, filters, namespaces, sanitizes, and forwards downstream tools", async () => {
  const { home } = await fixture({ proxy: true });
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    await initialize(client);
    const listed = await client.request("tools/list", {});
    const downstream = listed.result.tools.find(({ name }) => name === "fixture.echo");
    assert.ok(downstream);
    assert.equal(listed.result.tools.some(({ name }) => name === "fixture.blocked"), false);
    assert.equal(downstream.title, "Downstream echo");
    assert.deepEqual(downstream.inputSchema.required, ["value"]);
    assert.deepEqual(downstream.outputSchema.required, ["echoed"]);
    assert.deepEqual(downstream.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(downstream._meta.fixture, true);
    assert.equal(downstream._meta.ui, undefined);
    assert.equal(downstream._meta["openai/outputTemplate"], undefined);
    assert.equal(typeof downstream._meta["openai/toolInvocation/invoking"], "string");
    assert.equal(typeof downstream._meta["openai/toolInvocation/invoked"], "string");
    const called = await client.request("tools/call", { name: "fixture.echo", arguments: { value: "proxied" } });
    assert.equal(called.result.content[0].text, "echo=proxied");
    assert.deepEqual(called.result.structuredContent, { echoed: "proxied" });
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});
