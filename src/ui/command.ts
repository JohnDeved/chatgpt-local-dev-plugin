import type { UiResource } from "./common.js";

export const COMMAND_WIDGET_URI = "ui://widget/local-dev-command-v1.html";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif,system-ui,-apple-system,sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px; background: transparent; color: CanvasText; }
    main { display: grid; gap: 10px; }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.3; }
    .sub { margin: 3px 0 0; color: color-mix(in srgb,currentColor 62%,transparent); font-size: 12px; overflow-wrap: anywhere; }
    .badge { flex: none; padding: 4px 8px; border-radius: 999px; background: color-mix(in srgb,currentColor 9%,transparent); font: 700 11px/1 ui-monospace,SFMono-Regular,monospace; text-transform: uppercase; }
    .badge.running { color: #a46500; background: color-mix(in srgb,#d58a00 15%,transparent); }
    .badge.ok { color: #147a48; background: color-mix(in srgb,#168653 14%,transparent); }
    .badge.error { color: #b42318; background: color-mix(in srgb,#d92d20 13%,transparent); }
    .metrics { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 7px; }
    .metric { min-width: 0; padding: 9px; border: 1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius: 10px; }
    .metric span { display: block; color: color-mix(in srgb,currentColor 58%,transparent); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    .metric strong { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 650 12px ui-monospace,SFMono-Regular,monospace; }
    .actions,.urls { display: flex; flex-wrap: wrap; gap: 7px; }
    button { appearance: none; border: 1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius: 8px; padding: 7px 10px; background: color-mix(in srgb,Canvas 94%,currentColor 6%); color: inherit; font: 650 12px/1.2 inherit; cursor: pointer; }
    button.primary { background: currentColor; color: Canvas; }
    button.danger { color: #b42318; border-color: color-mix(in srgb,#d92d20 32%,transparent); }
    button:disabled { cursor: default; opacity: .55; }
    pre { max-height: 300px; margin: 0; padding: 10px; overflow: auto; border: 1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius: 10px; background: color-mix(in srgb,Canvas 96%,currentColor 4%); font: 11px/1.5 ui-monospace,SFMono-Regular,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .notice { padding: 9px 10px; border-radius: 9px; background: color-mix(in srgb,#d58a00 12%,transparent); color: color-mix(in srgb,currentColor 85%,#8a5200 15%); font-size: 11px; }
    .empty { margin: 0; color: color-mix(in srgb,currentColor 62%,transparent); font-size: 12px; }
    @media (max-width: 620px) { .metrics { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <main id="root"><p class="empty">Waiting for command result…</p></main>
  <script>
    const root = document.getElementById("root");
    let latest = null;
    let busy = false;
    let rpcSequence = 0;
    const pending = new Map();

    function rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = "local-dev-" + (++rpcSequence);
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error("Host request timed out"));
        }, 30000);
      });
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message || "Host request failed"));
        else request.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/tool-result") update(message.params);
    }, { passive: true });

    async function callTool(name, args) {
      if (window.openai?.callTool) return await window.openai.callTool(name, args);
      return await rpc("tools/call", { name, arguments: args });
    }

    function structured(result) {
      if (!result) return null;
      return result.structuredContent ?? result;
    }

    function formatDuration(data) {
      if (!data?.startedAt) return "—";
      const elapsed = (data.finishedAt ? new Date(data.finishedAt).getTime() : Date.now()) - new Date(data.startedAt).getTime();
      if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
      if (elapsed < 1000) return elapsed + " ms";
      return (elapsed / 1000).toFixed(elapsed < 10000 ? 1 : 0) + " s";
    }

    function formatStarted(data) {
      if (!data?.startedAt) return "—";
      const started = new Date(data.startedAt);
      return Number.isFinite(started.getTime()) ? started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    }

    function commandText(data) {
      const argv = Array.isArray(data?.argv) ? data.argv : window.openai?.toolInput?.argv;
      return Array.isArray(argv) && argv.length ? argv.join(" ") : "Development command";
    }

    function el(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function button(label, className, handler, disabled = false) {
      const node = el("button", label, className);
      node.type = "button";
      node.disabled = disabled;
      node.addEventListener("click", handler);
      return node;
    }

    function metric(label, value) {
      const node = el("div", undefined, "metric");
      node.append(el("span", label), el("strong", value));
      return node;
    }

    async function action(name, args) {
      if (busy) return;
      busy = true;
      render();
      try {
        const result = await callTool(name, args);
        update(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool call failed";
        latest = { ok: false, tool: name, data: null, error: { code: "UI_TOOL_CALL_FAILED", message } };
      } finally {
        busy = false;
        render();
      }
    }

    function render() {
      const envelope = latest;
      root.replaceChildren();
      if (!envelope) {
        root.append(el("p", "Waiting for command result…", "empty"));
        return;
      }
      if (envelope.ok === false) {
        const header = el("section", undefined, "header");
        const copy = el("div");
        copy.append(el("h1", envelope.tool || "Command failed"), el("p", envelope.error?.message || "The command could not be completed.", "sub"));
        header.append(copy, el("span", envelope.error?.code || "error", "badge error"));
        root.append(header);
        return;
      }
      const data = envelope.data || {};
      const state = data.state || "idle";
      const successful = state === "exited" ? data.exitCode === 0 : state !== "idle";
      const badgeClass = state === "running" ? "running" : successful ? "ok" : state === "idle" ? "" : "error";
      const header = el("section", undefined, "header");
      const copy = el("div");
      copy.append(el("h1", commandText(data)), el("p", data.cwd || "No active process", "sub"));
      header.append(copy, el("span", state, "badge " + badgeClass));
      root.append(header);

      const metrics = el("section", undefined, "metrics");
      metrics.append(
        metric("PID", data.pid === null || data.pid === undefined ? "—" : String(data.pid)),
        metric("Exit", data.exitCode === null || data.exitCode === undefined ? "—" : String(data.exitCode)),
        metric("Started", formatStarted(data)),
        metric("Duration", formatDuration(data)),
        metric("Mode", data.background ? "background" : "foreground"),
      );
      root.append(metrics);

      if (data.truncated) root.append(el("div", "Output was truncated to the most recent bounded tail.", "notice"));

      const actions = el("section", undefined, "actions");
      if (data.background && state !== "idle") actions.append(button("Refresh", "primary", () => action("dev.poll", {}), busy));
      if (data.background && state === "running") actions.append(button("Stop", "danger", () => action("dev.stop", {}), busy));
      actions.append(button("Expand output", "", async () => {
        await window.openai?.requestDisplayMode?.({ mode: "fullscreen" });
      }, busy));
      root.append(actions);

      if (Array.isArray(data.urls) && data.urls.length) {
        const urls = el("section", undefined, "urls");
        for (const href of data.urls) {
          urls.append(button("Open " + href, "", async () => {
            if (window.openai?.openExternal) await window.openai.openExternal({ href, redirectUrl: false });
            else window.open(href, "_blank", "noopener,noreferrer");
          }));
        }
        root.append(urls);
      }

      root.append(el("pre", data.outputTail || "No output captured."));
    }

    function update(result) {
      const value = structured(result);
      if (!value || typeof value !== "object") return;
      latest = value;
      window.openai?.setWidgetState?.({ latest });
      render();
    }

    window.addEventListener("openai:set_globals", (event) => {
      const globals = event.detail?.globals;
      update(globals?.toolOutput ?? globals?.toolResponseMetadata?.mcp_tool_result ?? globals?.toolResponseMetadata?.call_tool_result);
    }, { passive: true });

    update(window.openai?.toolOutput ?? window.openai?.toolResponseMetadata?.mcp_tool_result ?? window.openai?.toolResponseMetadata?.call_tool_result ?? window.openai?.widgetState?.latest);
  </script>
</body>
</html>`;

export const commandWidget: UiResource = {
  name: "Local Dev command viewer",
  uri: COMMAND_WIDGET_URI,
  description: "Shows a local development command, its process state, output, detected preview URLs, and safe process controls.",
  html: HTML,
  prefersBorder: true,
};
