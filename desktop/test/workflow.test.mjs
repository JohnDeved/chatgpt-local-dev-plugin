import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DesktopService } from "../src/main/service.ts";
import { ActivityArchive } from "../src/main/archive.ts";

async function until(predicate) {
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error("Expected desktop state did not arrive");
}

test(
  "desktop to IPC to MCP work lifecycle survives interruption of the viewer and archive replay",
  { timeout: 25000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "local-dev-web-test-"));
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
    const client = new Client({ name: "desktop-workflow-test", version: "1" });
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
      const start = await client.callTool({
        name: "run.start",
        arguments: { goal: "Verify persisted task work", title: "Task lifecycle" },
      });
      const runId = start.structuredContent.data.run.id;
      const update = async (todos, steeringTasks = [], acknowledgedSteeringIds = []) => {
        const result = await client.callTool({
          name: "run.update",
          arguments: {
            runId,
            summary: "Explicit integration state update",
            todos,
            steeringTasks,
            acknowledgedSteeringIds,
          },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return result;
      };
      await update([
        {
          id: "main",
          title: "Original implementation",
          status: "paused",
          note: "Waiting while working on user direction",
        },
      ]);
      service = new DesktopService(home);
      await service.start();
      await until(() =>
        service.snapshot().runs.some((run) => run.runId === runId && run.connected),
      );
      const runtime = service.snapshot().runtimes.find((runtime) => runtime.connected);
      assert.equal(runtime.workTracking, true);
      const id = randomUUID();
      const send = await service.act({
        type: "steer",
        runtimeId: runtime.id,
        runId,
        messageId: id,
        text: "Only inspect status; do not edit files.",
      });
      assert.equal(send.ok, true, send.message);
      const response = await client.callTool({ name: "project.current", arguments: {} });
      assert.equal(response.structuredContent.error.code, "STEERING_PENDING");
      assert.match(response.content.at(-1).text, /Only inspect status/u);
      await update(
        [{ id: "direction", title: "Handle the user direction", status: "queued", steeringId: id }],
        [],
        [id],
      );
      await until(() => service.snapshot().runs[0]?.steering[0]?.state === "acknowledged");
      assert.equal(service.snapshot().runs[0].steering[0].taskStatus, "queued");
      for (const status of ["in_progress", "paused", "queued", "in_progress", "completed"]) {
        const updateResult = await update(
          [{ id: "direction", status }],
          [{ id, status, note: `Direction ${status}` }],
        );
        await until(() => service.snapshot().runs[0]?.steering[0]?.taskStatus === status);
        const state = service.snapshot().runs[0];
        assert.equal(state.todos.find((todo) => todo.id === "direction").status, status);
        assert.equal(state.todos.find((todo) => todo.id === "main").status, "paused");
        assert.equal(state.todos.find((todo) => todo.id === "direction").steeringId, id);
        assert.match(updateResult.content.at(-1).text, /Original implementation/u);
      }
      let finish = await client.callTool({
        name: "run.finish",
        arguments: { runId, outcome: "completed", summary: "Pretend done" },
      });
      assert.equal(finish.structuredContent.error.code, "RUN_TODOS_UNFINISHED");
      // Reopening the viewer cannot lose task state or change permissions.
      await service.close();
      service = new DesktopService(home);
      await service.start();
      await until(() => service.snapshot().runs[0]?.todos?.length === 2);
      assert.equal(
        service.snapshot().runs[0].todos.find((todo) => todo.id === "main").status,
        "paused",
      );
      await update([{ id: "main", status: "completed", note: "Original work also verified" }]);
      finish = await client.callTool({
        name: "run.finish",
        arguments: { runId, outcome: "completed", summary: "All tracked work verified" },
      });
      assert.equal(finish.structuredContent.data.run.state, "completed");
      await until(() =>
        service.snapshot().runs.some((run) => run.runId === runId && run.state === "completed"),
      );
      await service.close();
      service = undefined;
      await client.close();
      const directory = join(home, ".local-dev/activity");
      const archive = new ActivityArchive(directory);
      await archive.scan();
      const restored = [...archive.index.runs.values()].find((run) => run.runId === runId);
      assert.equal(restored.state, "completed");
      assert.equal(restored.steering[0].taskStatus, "completed");
      assert.equal(restored.todos.length, 2);
      assert.ok(restored.todos.every((todo) => todo.status === "completed"));
      const logs = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
      const events = (
        await Promise.all(logs.map((name) => readFile(join(directory, name), "utf8")))
      )
        .join("")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        events.some((event) => event.type === "policy.changed"),
        false,
      );
    } catch (error) {
      throw new Error(`Desktop workflow failed. ${diagnostics}`, { cause: error });
    } finally {
      if (service) await service.close();
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
