import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export interface UiResource {
  name: string;
  uri: string;
  description: string;
  html: string;
  prefersBorder: boolean;
}

export function attachWidget(
  tool: Tool,
  resourceUri: string,
  invoking: string,
  invoked: string,
  visibility: Array<"app" | "model"> = ["model", "app"],
): Tool {
  const metadata = tool._meta ?? {};
  const ui = typeof metadata.ui === "object" && metadata.ui !== null && !Array.isArray(metadata.ui)
    ? metadata.ui as Record<string, unknown>
    : {};
  return {
    ...tool,
    _meta: {
      ...metadata,
      ui: { ...ui, resourceUri, visibility },
      "openai/outputTemplate": resourceUri,
      "openai/widgetAccessible": visibility.includes("app"),
      "openai/toolInvocation/invoking": invoking,
      "openai/toolInvocation/invoked": invoked,
    },
  };
}

export function resourceContent(resource: UiResource): {
  uri: string;
  mimeType: string;
  text: string;
  _meta: Record<string, unknown>;
} {
  const csp = { connectDomains: [] as string[], resourceDomains: [] as string[] };
  return {
    uri: resource.uri,
    mimeType: UI_MIME_TYPE,
    text: resource.html,
    _meta: {
      ui: { prefersBorder: resource.prefersBorder, csp },
      "openai/widgetDescription": resource.description,
      "openai/widgetPrefersBorder": resource.prefersBorder,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  };
}
