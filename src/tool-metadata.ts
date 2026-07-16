import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const MAX_STATUS_LENGTH = 64;
const UI_METADATA_KEYS = [
  "ui",
  "openai/outputTemplate",
  "openai/widgetAccessible",
  "openai/visibility",
  "openai/widgetDescription",
  "openai/widgetPrefersBorder",
  "openai/widgetCSP",
  "openai/widgetDomain",
] as const;

function status(value: string): string {
  return value.length <= MAX_STATUS_LENGTH ? value : `${value.slice(0, MAX_STATUS_LENGTH - 1)}…`;
}

function defaultInvoking(tool: Tool): string {
  return status(`Running ${tool.title ?? tool.name}…`);
}

function defaultInvoked(tool: Tool): string {
  return status(`${tool.title ?? tool.name} finished`);
}

function normalizedAnnotations(tool: Tool): Tool["annotations"] {
  const current = tool.annotations ?? {};
  const idempotent = current.idempotentHint === undefined ? {} : { idempotentHint: current.idempotentHint };
  if (current.readOnlyHint === true) {
    return { readOnlyHint: true, openWorldHint: false, destructiveHint: false, ...idempotent };
  }
  return {
    readOnlyHint: false,
    openWorldHint: current.openWorldHint ?? true,
    destructiveHint: current.destructiveHint ?? true,
    ...idempotent,
  };
}

export function withToolStatus(tool: Tool, invoking: string, invoked: string): Tool {
  return {
    ...tool,
    _meta: {
      ...(tool._meta ?? {}),
      "openai/toolInvocation/invoking": status(invoking),
      "openai/toolInvocation/invoked": status(invoked),
    },
  };
}

export interface ProxiedToolContext {
  serverId: string;
  alias: string;
  sourceName: string;
}

const CHROME_BOOTSTRAP = `Control the user's existing Google Chrome through the installed ChatGPT Chrome extension. Use this for tasks that require current tabs, signed-in sessions, page interaction, screenshots, or extension state. The JavaScript session persists across calls. On first use, initialize the browser runtime from the absolute path \`\${nodeRepl.homeDir}/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs\`, select \`agent.browsers.get("extension")\`, and emit the complete \`await chrome.documentation()\` result before interacting. Reuse existing browser and tab bindings. Respect extension confirmations, and never inspect cookies, local storage, profiles, passwords, or session stores.`;

function browserControlTool(tool: Tool, context: ProxiedToolContext | undefined): Tool {
  if (context?.serverId !== "node_repl" || context.sourceName !== "js") return tool;
  return {
    ...tool,
    title: "Control Chrome",
    description: CHROME_BOOTSTRAP,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
      idempotentHint: false,
    },
    _meta: {
      ...(tool._meta ?? {}),
      "openai/toolInvocation/invoking": "Controlling Chrome…",
      "openai/toolInvocation/invoked": "Chrome action finished",
    },
  };
}

export function prepareProxiedTool(tool: Tool, context?: ProxiedToolContext): Tool {
  tool = browserControlTool(tool, context);
  const metadata = { ...(tool._meta ?? {}) };
  for (const key of UI_METADATA_KEYS) delete metadata[key];
  const invoking = typeof metadata["openai/toolInvocation/invoking"] === "string"
    ? metadata["openai/toolInvocation/invoking"]
    : defaultInvoking(tool);
  const invoked = typeof metadata["openai/toolInvocation/invoked"] === "string"
    ? metadata["openai/toolInvocation/invoked"]
    : defaultInvoked(tool);
  return {
    ...tool,
    annotations: normalizedAnnotations(tool),
    _meta: {
      ...metadata,
      "openai/toolInvocation/invoking": status(invoking),
      "openai/toolInvocation/invoked": status(invoked),
    },
  };
}
