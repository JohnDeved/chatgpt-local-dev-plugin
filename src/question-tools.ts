import { randomUUID } from "node:crypto";

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { RegistryEntry } from "./registry.js";
import { failure, success } from "./result.js";
import type { JsonValue } from "./types.js";
import { attachWidget, QUESTION_WIDGET_URI } from "./ui/index.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

interface QuestionDefinition {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
  required: boolean;
}

interface QuestionRequest {
  title: string;
  intro?: string;
  questions: QuestionDefinition[];
}

const envelope = {
  type: "object" as const,
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    data: {},
    error: { anyOf: [{ type: "null" }, { type: "object" }] },
  },
  required: ["ok", "tool", "data", "error"],
};

const annotations: Tool["annotations"] = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

function result(value: unknown): CallToolResult {
  return value as CallToolResult;
}

function string(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : undefined;
}

function optionalString(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return string(value, max) ?? null;
}

function normalize(input: Record<string, unknown>): QuestionRequest | undefined {
  if (Object.keys(input).some((key) => !["title", "intro", "questions"].includes(key))) return undefined;
  const title = string(input.title, 120) ?? "A few questions";
  const intro = optionalString(input.intro, 1_000);
  if (intro === null || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return undefined;
  const questionIds = new Set<string>();
  const questions: QuestionDefinition[] = [];
  for (const raw of input.questions) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["id", "header", "question", "options", "multiSelect", "allowCustom", "required"].includes(key))) return undefined;
    const id = string(value.id, 64);
    const header = string(value.header, 32);
    const question = string(value.question, 500);
    if (id === undefined || !ID.test(id) || header === undefined || question === undefined || questionIds.has(id)) return undefined;
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 6) return undefined;
    if (value.multiSelect !== undefined && typeof value.multiSelect !== "boolean") return undefined;
    if (value.allowCustom !== undefined && typeof value.allowCustom !== "boolean") return undefined;
    if (value.required !== undefined && typeof value.required !== "boolean") return undefined;
    const optionIds = new Set<string>();
    const options: QuestionOption[] = [];
    for (const rawOption of value.options) {
      if (typeof rawOption !== "object" || rawOption === null || Array.isArray(rawOption)) return undefined;
      const option = rawOption as Record<string, unknown>;
      if (Object.keys(option).some((key) => !["id", "label", "description"].includes(key))) return undefined;
      const optionId = string(option.id, 64);
      const label = string(option.label, 120);
      const description = optionalString(option.description, 300);
      if (optionId === undefined || !ID.test(optionId) || label === undefined || description === null || optionIds.has(optionId)) return undefined;
      optionIds.add(optionId);
      options.push({ id: optionId, label, ...(description === undefined ? {} : { description }) });
    }
    questionIds.add(id);
    questions.push({
      id,
      header,
      question,
      options,
      multiSelect: value.multiSelect === true,
      allowCustom: value.allowCustom !== false,
      required: value.required !== false,
    });
  }
  return { title, ...(intro === undefined ? {} : { intro }), questions };
}

export function questionTools(): RegistryEntry[] {
  return [{
    tool: attachWidget({
      name: "question.ask",
      title: "Ask structured questions",
      description: "Use this when progress depends on one to four user decisions that are best answered together. Provide concise headers, two to six concrete options per question, and allow a custom answer unless there is a strong reason not to.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          intro: { type: "string", minLength: 1, maxLength: 1_000 },
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
                header: { type: "string", minLength: 1, maxLength: 32 },
                question: { type: "string", minLength: 1, maxLength: 500 },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 6,
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
                      label: { type: "string", minLength: 1, maxLength: 120 },
                      description: { type: "string", minLength: 1, maxLength: 300 },
                    },
                    required: ["id", "label"],
                    additionalProperties: false,
                  },
                },
                multiSelect: { type: "boolean", default: false },
                allowCustom: { type: "boolean", default: true },
                required: { type: "boolean", default: true },
              },
              required: ["id", "header", "question", "options"],
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
      outputSchema: envelope,
      annotations,
    }, QUESTION_WIDGET_URI, "Preparing questions…", "Questions ready"),
    call: (input) => {
      const request = normalize(input);
      if (request === undefined) {
        return result(failure("question.ask", "INVALID_ARGUMENTS", "Questions did not match the advertised schema or contained duplicate ids."));
      }
      const data = { requestId: randomUUID(), ...request } as unknown as JsonValue;
      return result(success("question.ask", data, `${request.questions.length} questions awaiting answers`));
    },
  }];
}
