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
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${this.stderr}`)), 5_000);
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
  await mkdir(join(home, ".local-dev"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "demo-project" }), "utf8");
  const fakeServer = new URL("./fake-mcp-server.mjs", import.meta.url).pathname;
  const codexConfig = proxy
    ? `[mcp_servers.fake]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fakeServer)}]\nenabled_tools = ["echo", "blocked"]\ndisabled_tools = ["blocked"]\nrequired = true\n`
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
  return response;
}

test("production stdio server exposes native tools and MCP Apps widgets", async () => {
  const { home } = await fixture();
  const client = new McpProcess({ ...process.env, HOME: home });
  try {
    const initialized = await initialize(client);
    assert.deepEqual(initialized.result.serverInfo, { name: "local-dev", version: "0.3.0" });
    assert.deepEqual(initialized.result.capabilities.resources, {});
    const resources = await client.request("resources/list", {});
    assert.deepEqual(resources.result.resources.map(({ uri }) => uri), [
      "ui://widget/local-dev-media-v1.html",
      "ui://widget/local-dev-command-v2.html",
      "ui://widget/local-dev-projects-v1.html",
      "ui://widget/local-dev-calls-v1.html",
      "ui://widget/local-dev-question-v1.html",
    ]);
    const viewer = await client.request("resources/read", { uri: "ui://widget/local-dev-media-v1.html" });
    assert.equal(viewer.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(viewer.result.contents[0].text, /ui\/notifications\/tool-result/u);
    const questionWidget = await client.request("resources/read", { uri: "ui://widget/local-dev-question-v1.html" });
    assert.equal(questionWidget.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(questionWidget.result.contents[0].text, /sendFollowUpMessage|ui\/message/u);
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      "project.open",
      "project.list",
      "project.current",
      "dev.run",
      "dev.poll",
      "dev.stop",
      "dev.diff",
      "question.ask",
      "observability.recent_calls",
    ]);
    for (const tool of listed.result.tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
      assert.equal(tool.annotations.openWorldHint, false);
      assert.ok(tool.outputSchema);
    }
    const visualTools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
    assert.equal(visualTools.get("project.list")._meta.ui.resourceUri, "ui://widget/local-dev-projects-v1.html");
    assert.equal(visualTools.get("dev.run")._meta, undefined);
    assert.equal(visualTools.get("dev.poll")._meta, undefined);
    assert.equal(visualTools.get("dev.stop")._meta, undefined);
    assert.equal(visualTools.get("dev.diff")._meta.ui.resourceUri, "ui://widget/local-dev-command-v2.html");
    assert.equal(visualTools.get("question.ask")._meta.ui.resourceUri, "ui://widget/local-dev-question-v1.html");
    assert.equal(visualTools.get("question.ask").annotations.idempotentHint, false);
    await client.request("tools/call", { name: "project.current", arguments: {} });
    const projectList = await client.request("tools/call", { name: "project.list", arguments: {} });
    assert.equal(projectList.result.structuredContent.data.projects[0].name, "demo-project");
    const questions = await client.request("tools/call", {
      name: "question.ask",
      arguments: {
        title: "Choose implementation details",
        questions: [{
          id: "stack",
          header: "Stack",
          question: "Which UI stack should be used?",
          options: [{ id: "vanilla", label: "Vanilla" }, { id: "react", label: "React" }],
        }],
      },
    });
    assert.equal(questions.result.structuredContent.data.questions[0].allowCustom, true);
    assert.equal(typeof questions.result.structuredContent.data.requestId, "string");
    const recent = await client.request("tools/call", { name: "observability.recent_calls", arguments: { limit: 10 } });
    assert.equal(recent.result.structuredContent.data.calls.some(({ tool }) => tool === "project.current"), true);
    assert.equal(recent.result.structuredContent.data.calls.some(({ tool }) => tool === "observability.recent_calls"), false);
    const dashboardUrl = (await readFile(join(home, ".local-dev", "dashboard.url"), "utf8")).trim();
    const dashboardCalls = await fetch(new URL("api/calls", dashboardUrl)).then((response) => response.json());
    assert.equal(dashboardCalls.some(({ tool }) => tool === "project.current"), true);
    assert.equal(dashboardCalls[0].tool, "observability.recent_calls");
    assert.equal(client.stderr, "");
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    const polled = await client.request("tools/call", { name: "dev.poll", arguments: {} });
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

test("paginates, filters, namespaces, preserves, and forwards downstream tools", async () => {
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
    assert.match(downstream._meta.ui.resourceUri, /^ui:\/\/local-dev\/fixture\/[a-f0-9]{20}\.html$/u);
    assert.equal(downstream._meta["openai/outputTemplate"], downstream._meta.ui.resourceUri);
    const resources = await client.request("resources/list", {});
    const proxiedResource = resources.result.resources.find(({ uri }) => uri === downstream._meta.ui.resourceUri);
    assert.ok(proxiedResource);
    assert.equal(proxiedResource.name, "fixture: Downstream echo widget");
    const resource = await client.request("resources/read", { uri: downstream._meta.ui.resourceUri });
    assert.equal(resource.result.contents[0].uri, downstream._meta.ui.resourceUri);
    assert.match(resource.result.contents[0].text, /Downstream widget/u);
    const called = await client.request("tools/call", { name: "fixture.echo", arguments: { value: "proxied" } });
    assert.equal(called.result.content[0].text, "echo=proxied");
    assert.deepEqual(called.result.structuredContent, { echoed: "proxied" });
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});
