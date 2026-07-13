import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const MEDIA_VIEWER_URI = "ui://widget/local-dev-media-v1.html";
export const MEDIA_VIEWER_MIME_TYPE = "text/html;profile=mcp-app";

export function attachMediaViewer(tool: Tool): Tool {
  const metadata = tool._meta ?? {};
  const ui = typeof metadata.ui === "object" && metadata.ui !== null && !Array.isArray(metadata.ui)
    ? metadata.ui as Record<string, unknown>
    : {};
  if (typeof ui.resourceUri === "string" || typeof metadata["openai/outputTemplate"] === "string") return tool;
  return {
    ...tool,
    _meta: {
      ...metadata,
      ui: { ...ui, resourceUri: MEDIA_VIEWER_URI },
      "openai/outputTemplate": MEDIA_VIEWER_URI,
      "openai/toolInvocation/invoked": "Media ready",
    },
  };
}

export const MEDIA_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 10px; background: transparent; }
    #media { display: grid; gap: 10px; }
    figure { margin: 0; overflow: hidden; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; background: color-mix(in srgb, Canvas 94%, currentColor 6%); }
    img { display: block; width: 100%; height: auto; }
    audio { display: block; width: calc(100% - 20px); margin: 10px; }
    #empty { margin: 0; color: color-mix(in srgb, currentColor 65%, transparent); font-size: 13px; }
  </style>
</head>
<body>
  <main id="media" aria-live="polite"><p id="empty">Waiting for media…</p></main>
  <script>
    const root = document.getElementById("media");

    function resultFromMetadata(value) {
      const candidates = [value?.mcp_tool_result, value?.call_tool_result, value];
      return candidates.find((candidate) => Array.isArray(candidate?.content));
    }

    function render(result) {
      const blocks = Array.isArray(result?.content)
        ? result.content.filter((block) => block?.type === "image" || block?.type === "audio")
        : [];
      if (blocks.length === 0) return;
      root.replaceChildren(...blocks.map((block) => {
        const figure = document.createElement("figure");
        const element = document.createElement(block.type === "image" ? "img" : "audio");
        element.src = "data:" + block.mimeType + ";base64," + block.data;
        if (block.type === "image") element.alt = "MCP tool screenshot";
        else element.controls = true;
        figure.append(element);
        return figure;
      }));
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0" || message.method !== "ui/notifications/tool-result") return;
      render(message.params);
    }, { passive: true });

    window.addEventListener("openai:set_globals", (event) => {
      render(resultFromMetadata(event.detail?.globals?.toolResponseMetadata));
    }, { passive: true });

    render(resultFromMetadata(window.openai?.toolResponseMetadata));
  </script>
</body>
</html>`;
