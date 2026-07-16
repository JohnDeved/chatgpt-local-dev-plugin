import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RegistryEntry } from "./registry.js";

const BROWSER_CLIENT = join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "chrome", "latest", "scripts", "browser-client.mjs");

const bootstrap = `if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(BROWSER_CLIENT)});
  await setupBrowserRuntime({ globals: globalThis });
}
if (globalThis.chrome == null) {
  globalThis.chrome = await agent.browsers.get("extension");
  nodeRepl.write(await chrome.documentation());
}
await chrome.nameSession("🔎 ChatGPT Chrome control");`;

const acquireChatGptTab = `if (globalThis.localDevChromeTab == null) {
  const openTabs = await chrome.user.openTabs();
  const preferred = openTabs.find((tab) => typeof tab.url === "string" && /(^|\\.)chatgpt\\.com$/u.test(new URL(tab.url).hostname))
    ?? openTabs.find((tab) => typeof tab.url === "string" && /(^|\\.)openai\\.com$/u.test(new URL(tab.url).hostname));
  if (preferred == null) {
    throw new Error("No open ChatGPT tab was found in the current Chrome profile.");
  }
  globalThis.localDevChromeTab = await chrome.user.claimTab(preferred);
}`;

function tool(name: string, title: string, description: string, inputSchema: Tool["inputSchema"]): Tool {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
      idempotentHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Controlling Chrome…",
      "openai/toolInvocation/invoked": "Chrome action finished",
    },
  };
}

function javascriptEntry(
  name: string,
  title: string,
  description: string,
  inputSchema: Tool["inputSchema"],
  chromeJs: RegistryEntry,
  code: (arguments_: Record<string, unknown>) => string,
): RegistryEntry {
  return {
    tool: tool(name, title, description, inputSchema),
    call: async (arguments_, meta) => await chromeJs.call({
      code: code(arguments_),
      title,
      timeout_ms: 60_000,
    }, meta) as CallToolResult,
  };
}

export function chromeCompatibilityEntries(downstream: ReadonlyMap<string, RegistryEntry>): RegistryEntry[] {
  const chromeJs = downstream.get("chrome.js");
  if (chromeJs === undefined) return [];

  return [
    javascriptEntry(
      "chrome.navigate",
      "Navigate Chrome",
      "Navigate the currently claimed ChatGPT Chrome tab to a URL.",
      {
        type: "object",
        properties: { url: { type: "string", minLength: 1 } },
        required: ["url"],
        additionalProperties: false,
      },
      chromeJs,
      ({ url }) => `${bootstrap}\n${acquireChatGptTab}\nawait localDevChromeTab.goto(${JSON.stringify(url)});\nnodeRepl.write(JSON.stringify({ title: await localDevChromeTab.title(), url: await localDevChromeTab.url() }, null, 2));`,
    ),
    javascriptEntry(
      "chrome.evaluate",
      "Inspect Chrome",
      "Inspect the open ChatGPT tab in the user's current Chrome profile.",
      {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
        additionalProperties: false,
      },
      chromeJs,
      ({ script }) => `${bootstrap}\n${acquireChatGptTab}\nconst snapshot = await localDevChromeTab.playwright.domSnapshot();\nconst requestedNeedle = ${JSON.stringify(script)};\nnodeRepl.write(JSON.stringify({ title: await localDevChromeTab.title(), url: await localDevChromeTab.url(), containsRequestedText: requestedNeedle.length > 0 && snapshot.includes(requestedNeedle), snapshot }, null, 2));`,
    ),
    javascriptEntry(
      "chrome.screenshot",
      "Screenshot Chrome",
      "Capture the currently open ChatGPT tab from the user's Chrome profile.",
      {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      chromeJs,
      () => `${bootstrap}\n${acquireChatGptTab}\nawait nodeRepl.emitImage(await localDevChromeTab.screenshot({ fullPage: false }));`,
    ),
  ];
}
