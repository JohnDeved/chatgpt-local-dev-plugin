#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ActivityHub, activityEvent } from "./activity.js";
import { ASK_TOOL_NAME, askTool } from "./ask-tool.js";
import { chromeCompatibilityEntries } from "./chrome-compat.js";
import { loadConfiguration } from "./config/index.js";
import { coreTools, CoreRuntime } from "./core/index.js";
import { resolveElicitation } from "./elicitation.js";
import { createToolProgress, type ToolProgress } from "./progress.js";
import { ProxyManager } from "./proxy.js";
import { failure } from "./result.js";
import { RUN_TOOL_NAMES, runTools } from "./run-tools.js";
import { runOwner } from "./runs.js";
import { requestMetadataForTool } from "./request-meta.js";
import { ToolRegistry } from "./registry.js";
import { toolInvokedStatus, toolInvokingStatus } from "./tool-metadata.js";

const SERVER_INSTRUCTIONS = [
  "Keep the user visibly informed during Local Dev work.",
  "Begin each user-request workflow with run.start: provide the user goal, concise title, and a short public plan. Reuse its runId for run.update and run.finish.",
  "Use the ask tool when a real user choice materially changes the work. Give 2–6 explicit options and one recommended option. In Auto-approve all mode the user gets 90 seconds to override before Local Dev returns the recommendation; do not use Ask for routine permissions or secrets.",
  "Before substantive work, publish a nonempty run.update.todos list with stable IDs. Keep queued, in_progress, paused, completed, or cancelled states explicit. Report steering implementation separately with steeringTasks; acknowledgement is not completion. Unfinished work remains in every subsequent tool response and prevents a completed run.",
  "Publish run.update at meaningful milestones, before long operations, and when your approach changes. These are concise public plans/progress/decision summaries, never private chain-of-thought or an invented thinking stream.",
  "Local user steering is returned in tool-response text. Before further actions, acknowledge the returned steering message IDs using run.update and explain how you will adapt, subject to existing permissions and safety rules.",
  "Before your final answer, call run.finish with a truthful completed, failed, or cancelled outcome and summary. Never infer completion from inactivity; background services may remain running and are reported separately.",
  "Name the exact Local Dev tool, executable path, and command arguments being used; do not mask, summarize, or omit tool inputs in status updates.",
  "Before the first tool call in a multi-step workflow, send a concise update naming the immediate next action.",
  "After each meaningful milestone or roughly every three tool calls, send another concise update with what finished and what comes next.",
  "Before a command or browser action that may take more than ten seconds, say what is about to run.",
  "Do not remain silent through long-running work, but do not narrate every trivial read.",
  "Local Dev independently records full activity in its local macOS menu-bar app.",
  "Local approval policy belongs to the user. Never change, bypass, or forge the local approval settings or control channel.",
  "If approval is pending, the user can approve or deny it in the Local Dev menu-bar app. Do not repeatedly retry a denied action.",
  "Resolve a project automatically before running local commands.",
  "Infer an existing project name or path from the user's request and call project.open.",
  "If no existing project fits, choose onMissing=create for durable work or onMissing=temporary for disposable experiments; temporary projects are deleted when the Local Dev runtime closes.",
  "Never ask the user to choose from a project picker.",
  "If project.open returns ambiguous candidates, select the best candidate from the request and retry with its exact path.",
  "Project activation synchronizes configured downstream project bindings.",
  "Prefer downstream semantic code tools for navigation and precise edits.",
  "Use dev.run for one direct argv command or dev.batch for bounded sequential commands; never invoke a shell with evaluation flags.",
  "Use relative cwd for monorepo subdirectories, dev.poll for the single background process, and dev.stop to terminate it.",
  "After all file-changing operations for a user request, run the repository check and call dev.diff at most once.",
].join(" ");

export async function runServer(): Promise<void> {
  const nodeBin = dirname(process.execPath);
  process.env.PATH = process.env.PATH ? `${nodeBin}${delimiter}${process.env.PATH}` : nodeBin;
  const configuration = await loadConfiguration();
  const activity = new ActivityHub();
  await activity.start();
  const server = new Server(
    { name: "local-dev", version: "0.3.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const proxy = new ProxyManager(async (params) =>
    await activity.elicit(params, async () => await resolveElicitation(
      params,
      configuration.localDev.approvedBrowserOrigins,
      configuration.localDev.browserOriginPolicy,
      async (request) => await server.elicitInput(request),
    )),
    (type, detail) => activity.record(type, detail),
  );
  let downstreamEntries;
  try { downstreamEntries = await proxy.connect(configuration.selectedServers); }
  catch (error) { await activity.close(); throw error; }
  const downstream = new Map(downstreamEntries.map((entry) => [entry.tool.name, entry]));
  const runtime = new CoreRuntime(
    configuration.localDev.projectRoots,
    configuration.localDev.projectOpenHooks,
    configuration.localDev.projectBindings,
    async (name, arguments_) => {
      const entry = downstream.get(name);
      if (entry === undefined) return undefined;
      return await activity.execute(entry.tool, arguments_, async (signal) => await entry.call(arguments_, { signal }));
    },
  );
  const registry = new ToolRegistry();
  registry.addAll(coreTools(runtime));
  registry.add(askTool(activity));
  registry.addAll(runTools(activity.runs, (id) => activity.backgroundCount(id)));
  registry.addAll(downstreamEntries);
  registry.addAll(chromeCompatibilityEntries(downstream));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.list() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const entry = registry.get(params.name);
    if (entry === undefined) return failure(params.name, "UNKNOWN_TOOL", "The requested tool is not registered.") as never;
    const owner = runOwner(params._meta ?? extra._meta, extra.sessionId);
    if (RUN_TOOL_NAMES.has(params.name)) {
      return await entry.call(params.arguments ?? {}, { runOwner: owner, signal: extra.signal });
    }
    const run = activity.runs.ensure(owner);
    const metadata = requestMetadataForTool(params.name, params._meta ?? extra._meta, extra.sessionId, extra.requestId);
    const remoteProgress = createToolProgress(metadata, extra.sendNotification);
    try {
      activity.runs.assertCanProceed(run.id);
      if (!["project.current", "dev.poll", "dev.stop", ASK_TOOL_NAME].includes(params.name)) activity.runs.requireTodoList(run.id);
      return await activity.execute(entry.tool, params.arguments ?? {}, async (signal) => {
        const progress: ToolProgress = {
          async report(message, fraction) {
            activityEvent("operation.progress", { message });
            await remoteProgress?.report(message, fraction);
          },
        };
        await progress.report(toolInvokingStatus(entry.tool), 0);
        const result = await entry.call(params.arguments ?? {}, {
          ...(metadata === undefined ? {} : { meta: metadata }), signal, progress,
        });
        const failed = result.isError === true || result.structuredContent?.ok === false;
        await progress.report(failed ? `${entry.tool.title ?? entry.tool.name} failed` : toolInvokedStatus(entry.tool), 1);
        return activity.runs.attach(run.id, result);
      }, extra.signal, { request: metadata, project: runtime.currentProject().structuredContent.data }, run.id);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "LOCAL_OPERATION_FAILED";
      await remoteProgress?.report(`${entry.tool.title ?? entry.tool.name}: ${code}`);
      const result = failure(params.name, code, code === "STEERING_PENDING"
        ? "Local user steering must be acknowledged with run.update before another action is dispatched."
        : code === "RUN_TODO_LIST_REQUIRED"
          ? "Before local work, declare the goal with run.start and publish a nonempty list using run.update.todos. Refresh the app tool definitions if this field is missing. No operation was dispatched; status and stop controls remain available."
          : "The operation did not complete. Inspect its full details in the Local Dev menu-bar app.");
      return activity.runs.attach(run.id, result as never);
    }
  });
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await runtime.close();
    await proxy.close();
    await activity.close();
    await server.close();
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  server.onclose = () => void close();
  await server.connect(transport);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch(() => {
    process.stderr.write("local-dev: server failed to start.\n");
    process.exitCode = 1;
  });
}
