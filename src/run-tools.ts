import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { RegistryEntry } from "./registry.js";
import { failure, success } from "./result.js";
import type { JsonValue } from "./types.js";
import { withToolStatus } from "./tool-metadata.js";
import type { RunTracker } from "./runs.js";

export const RUN_TOOL_NAMES = new Set(["run.start", "run.update", "run.finish"]);
const runId = z.string().uuid();
const goal = z.string().trim().min(1).max(4000);
const summary = z.string().trim().min(1).max(2000);
const backgroundProcessPolicy = z
  .enum(["cleanup", "keep"])
  .describe("cleanup stops run-owned background processes before successful completion; keep leaves them running when persistence is the intended deliverable.");
const startSchema = z.object({
  goal,
  title: z.string().trim().min(1).max(120).optional(),
  plan: summary.optional(),
  backgroundProcessPolicy: backgroundProcessPolicy.default("cleanup"),
}).strict();
const updateSchema = z.object({ runId, summary, kind: z.enum(["plan", "progress", "decision"]).default("progress"),
  acknowledgedSteeringIds: z.array(z.string().min(1).max(80)).max(20).default([]), goal: goal.optional(),
  steeringTasks: z.array(z.object({ id: z.string().min(1).max(80), status: z.enum(["queued", "in_progress", "paused", "completed", "cancelled"]), note: z.string().trim().min(1).max(2000).optional() }).strict()).max(20).default([]),
  todos: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u), title: z.string().trim().min(1).max(500).optional(), steeringId: z.string().min(1).max(80).optional(), status: z.enum(["queued", "in_progress", "paused", "completed", "cancelled"]), note: z.string().trim().min(1).max(2000).optional() }).strict()).max(100).default([]),
  backgroundProcessPolicy: backgroundProcessPolicy.optional(),
}).strict();
const finishSchema = z.object({ runId, outcome: z.enum(["completed", "failed", "cancelled"]), summary }).strict();

export function runTools(
  tracker: RunTracker,
  backgroundCount: (id: string) => number,
  stopBackgroundProcesses: (id: string) => Promise<{ requested: number; stopped: number; remaining: number }> = async (id) => ({ requested: 0, stopped: 0, remaining: backgroundCount(id) }),
): RegistryEntry[] {
  const definitions = [
    { name: "run.start", title: "Start worker run", schema: startSchema,
      description: "Call once before local work for each user request. Publish the user's goal and a brief plan. An observed run is promoted, not duplicated. Keep the returned runId. backgroundProcessPolicy defaults to cleanup; use keep only when leaving a server/service running is an intentional deliverable. Do not invent a goal or claim work has finished." },
    { name: "run.update", title: "Update worker run", schema: updateSchema,
      description: "Publish a concise user-facing plan, progress, or decision summary. Not private chain-of-thought. Acknowledge local steering IDs returned in tool responses before further work, and explain the next step. Publish todos with stable IDs and titles before substantive work (the dispatcher enforces this); link a todo to a direction with steeringId when appropriate; update their statuses and notes without forgetting paused work when steering arrives. Use steeringTasks to track work separately from delivery. backgroundProcessPolicy may be changed to keep only when persistent run-owned services are intentionally meant to outlive completion. Use the runId returned by run.start." },
    { name: "run.finish", title: "Finish worker run", schema: finishSchema,
      description: "Call before your final answer to explicitly end the user's local work with completed, failed, or cancelled and a factual summary. Cannot report completed with active tool operations, unacknowledged steering, or unresolved steering tasks. On completed runs, run-owned background processes are stopped by default; backgroundProcessPolicy=keep is the explicit escape hatch for an intentional persistent server/service. Completion is rejected if cleanup cannot be confirmed. Failed/cancelled outcomes do not pretend unfinished work is complete." },
  ] as const;
  return definitions.map((definition): RegistryEntry => ({
    tool: withToolStatus({ name: definition.name, title: definition.title, description: definition.description,
      inputSchema: z.toJSONSchema(definition.schema, { io: "input" }) as RegistryEntry["tool"]["inputSchema"],
      outputSchema: { type: "object", properties: { ok: { type: "boolean" }, tool: { type: "string" }, data: {}, error: {}, localDevRun: { type: "object", description: "Run identity, state, goal, and pending steering to acknowledge." } }, required: ["ok", "tool", "data", "error"] },
      annotations: { readOnlyHint: false, destructiveHint: definition.name === "run.finish", openWorldHint: false, idempotentHint: false },
    }, "Updating run…", "Run status recorded"),
    call: async (input, context) => {
      const owner = context?.runOwner ?? "runtime";
      try {
        context?.signal?.throwIfAborted();
        let run;
        if (definition.name === "run.start") {
          const value = startSchema.parse(input);
          run = tracker.start(owner, value.goal, value.title, value.backgroundProcessPolicy);
          if (value.plan !== undefined) tracker.update(owner, run.id, value.plan, "plan");
        } else if (definition.name === "run.update") {
          const value = updateSchema.parse(input);
          run = tracker.update(owner, value.runId, value.summary, value.kind, value.acknowledgedSteeringIds, value.goal, value.steeringTasks, value.todos, value.backgroundProcessPolicy);
        } else {
          const value = finishSchema.parse(input);
          let remainingBackgroundProcesses = backgroundCount(value.runId);
          if (value.outcome === "completed" && tracker.backgroundProcessPolicy(owner, value.runId) === "cleanup" && remainingBackgroundProcesses > 0) {
            const cleanup = await stopBackgroundProcesses(value.runId);
            remainingBackgroundProcesses = cleanup.remaining;
            if (cleanup.remaining > 0) throw new Error("RUN_PROCESS_CLEANUP_UNCONFIRMED");
          }
          run = tracker.finish(owner, value.runId, value.outcome, value.summary, remainingBackgroundProcesses);
        }
        return tracker.attach(run.id, success(definition.name, { run } as unknown as JsonValue, `run=${run.id} state=${run.state}`) as unknown as CallToolResult);
      } catch (error) {
        const code = error instanceof z.ZodError ? "INVALID_ARGUMENTS"
          : error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "RUN_REPORT_FAILED";
        const result = failure(definition.name, code, code === "ACTIVE_RUN_EXISTS"
          ? "An explicit run is still open in this context. Finish it honestly before starting a different goal."
          : code === "RUN_TODO_LIST_REQUIRED" ? "Declare the goal using run.start and publish a nonempty to-do list with run.update.todos before substantive work or successful completion. Refresh the Local Dev tool definitions if todos is missing. Status, stopping, reporting, and failed/cancelled outcomes remain available."
          : code === "RUN_PROCESS_CLEANUP_UNCONFIRMED" ? "One or more run-owned background processes could not be confirmed stopped, so completion was not recorded. Inspect Processes or stop them explicitly, then retry; use backgroundProcessPolicy=keep only when persistence is intentional."
          : (code === "STEERING_TASKS_UNFINISHED" || code === "RUN_TODOS_UNFINISHED") ? "The run still has unfinished directions or to-dos. Update their task statuses with run.update.steeringTasks or run.update.todos before reporting completion, or report a truthful failed/cancelled outcome."
          : "The run report was not accepted. Correct its arguments or address pending steering/operations before retrying.") as unknown as CallToolResult;
        const run = tracker.activeFor(owner);
        return run === undefined ? result : tracker.attach(run.id, result);
      }
    },
  }));
}
