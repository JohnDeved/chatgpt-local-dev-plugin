import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ActivityHub } from "./activity.js";
import type { RegistryEntry } from "./registry.js";
import { failure, success } from "./result.js";
import type { JsonValue } from "./types.js";
import { withToolStatus } from "./tool-metadata.js";

export const ASK_TOOL_NAME = "ask";
const option = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,50}$/u),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
}).strict();
const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  header: z.string().trim().min(1).max(80).optional(),
  options: z.array(option).min(2).max(6),
  recommended: z.string().regex(/^[a-zA-Z0-9-]{1,50}$/u),
  allowOther: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.options.map((item) => item.id));
  if (ids.size !== value.options.length) context.addIssue({ code: "custom", message: "Option IDs must be unique", path: ["options"] });
  if (!ids.has(value.recommended)) context.addIssue({ code: "custom", message: "recommended must name one option ID", path: ["recommended"] });
});

export function askTool(activity: ActivityHub): RegistryEntry {
  return {
    tool: withToolStatus({
      name: ASK_TOOL_NAME,
      title: "Ask the user",
      description: "Ask one concise user-facing question when a real choice materially affects the work. Provide 2–6 explicit options and mark exactly one option as recommended. The Local Dev app shows the question immediately. If Auto-approve all is enabled, the user has 90 seconds to override it before Local Dev returns the recommended option automatically. Do not use this for routine confirmations already handled by approvals, or to request secrets. Other text input is available only when allowOther is true.",
      inputSchema: z.toJSONSchema(askSchema, { io: "input" }) as RegistryEntry["tool"]["inputSchema"],
      outputSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" }, tool: { type: "string" }, data: {
            type: "object",
            properties: {
              askId: { type: "string" }, optionId: { type: "string" }, label: { type: "string" }, text: { type: "string" },
              source: { type: "string", enum: ["user", "auto-recommended"] }, waitedMs: { type: "number" },
            },
            required: ["askId", "source", "waitedMs"],
          }, error: {},
        }, required: ["ok", "tool", "data", "error"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    }, "Waiting for your answer…", "Answer received"),
    call: async (input, context) => {
      try {
        const value = askSchema.parse(input);
        const answer = await activity.ask(value, context?.signal);
        const summary = answer.source === "auto-recommended"
          ? `No user answer after 90 seconds; continued with recommended option “${answer.label}”.`
          : answer.optionId ? `User selected “${answer.label}”.` : "User supplied a custom answer.";
        return success(ASK_TOOL_NAME, answer as unknown as JsonValue, summary) as unknown as CallToolResult;
      } catch (error) {
        const code = error instanceof z.ZodError ? "INVALID_ARGUMENTS"
          : error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "ASK_FAILED";
        return failure(ASK_TOOL_NAME, code,
          code === "OPERATION_CANCELLED" ? "The question was cancelled before an answer was returned."
          : code === "ASK_RUNTIME_CLOSED" ? "The Local Dev runtime closed while waiting for the answer."
          : "The question could not be completed. Check Local Dev for the exact recorded state.") as unknown as CallToolResult;
      }
    },
  };
}
