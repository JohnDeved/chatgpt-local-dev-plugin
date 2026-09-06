import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DesktopService } from "../src/main/service.ts";

async function until(predicate, timeout = 9000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Expected Ask state did not arrive");
}

test(
  "Ask travels from MCP to the desktop and the local answer resumes the exact tool call",
  { timeout: 20000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "local-dev-web-test-ask-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../../dist/server.js", import.meta.url).pathname],
      env: { ...process.env, HOME: home },
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const client = new Client({ name: "desktop-ask-workflow-test", version: "1" });
    let service;
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await mkdir(join(home, ".local-dev"), { recursive: true });
      await writeFile(join(home, ".codex/config.toml"), "");
      await writeFile(
        join(home, ".local-dev/config.json"),
        JSON.stringify({
          version: 1,
          projectRoots: [home],
          selectedServers: [],
          projectOpenHooks: [],
        }),
      );
      await client.connect(transport);
      const tools = await client.listTools();
      const askDefinition = tools.tools.find((tool) => tool.name === "ask");
      assert.equal(askDefinition.annotations.readOnlyHint, true);
      assert.match(askDefinition.description, /90 seconds/u);
      const start = await client.callTool({
        name: "run.start",
        arguments: { goal: "Verify Ask workflow", title: "Ask workflow" },
      });
      const runId = start.structuredContent.data.run.id;
      // No to-do list yet: Ask is intentionally available before substantive work.
      service = new DesktopService(home);
      await service.start();
      const runtime = await until(() =>
        service.snapshot().runtimes.find((item) => item.connected && item.supportsAsk),
      );
      assert.equal(runtime.askAutoTimeoutMs, 90_000);
      const pendingCall = client.callTool({
        name: "ask",
        arguments: {
          header: "Implementation choice",
          question: "Which approach should I take?",
          options: [
            { id: "safe", label: "Safer change", description: "Preserve compatibility" },
            { id: "fast", label: "Faster change", description: "Prefer speed" },
          ],
          recommended: "safe",
          allowOther: true,
        },
      });
      const pending = await until(
        () => service.snapshot().runtimes.find((item) => item.id === runtime.id)?.asks[0],
      );
      assert.equal(pending.runId, runId);
      assert.equal(pending.recommended, "safe");
      assert.equal(pending.expiresAt, undefined, "Manual policy should not invent a timeout");
      const action = await service.act({
        type: "answerAsk",
        runtimeId: runtime.id,
        askId: pending.id,
        optionId: "fast",
      });
      assert.equal(action.ok, true, action.message);
      const answer = await pendingCall;
      assert.equal(answer.structuredContent.data.optionId, "fast");
      assert.equal(answer.structuredContent.data.label, "Faster change");
      assert.equal(answer.structuredContent.data.source, "user");
      await until(
        () => service.snapshot().runtimes.find((item) => item.id === runtime.id)?.asks.length === 0,
      );
      await service.close();
      service = undefined;
      await client.close();
      const directory = join(home, ".local-dev/activity");
      const logs = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
      const events = (
        await Promise.all(logs.map((name) => readFile(join(directory, name), "utf8")))
      )
        .join("")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        events.some((event) => event.type === "ask.requested" && event.runId === runId),
        true,
      );
      assert.equal(
        events.some(
          (event) => event.type === "ask.answered" && event.detail.answer.source === "user",
        ),
        true,
      );
      assert.equal(
        events.some((event) => event.type === "policy.changed"),
        false,
      );
    } catch (error) {
      throw new Error(`Ask desktop workflow failed. ${diagnostics}`, { cause: error });
    } finally {
      if (service) await service.close();
      await client.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  },
);
