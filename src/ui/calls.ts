import type { UiResource } from "./common.js";

export const CALLS_WIDGET_URI = "ui://widget/local-dev-calls-v1.html";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif,system-ui,-apple-system,sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px; background: transparent; color: CanvasText; }
    main { display: grid; gap: 9px; }
    .toolbar { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 7px; }
    input,select,button { min-width: 0; border: 1px solid color-mix(in srgb,currentColor 17%,transparent); border-radius: 8px; padding: 7px 9px; background: color-mix(in srgb,Canvas 95%,currentColor 5%); color: inherit; font: 12px inherit; }
    button { cursor: pointer; font-weight: 650; }
    button:disabled { cursor: default; opacity: .55; }
    .summary { display: flex; flex-wrap: wrap; gap: 7px; color: color-mix(in srgb,currentColor 63%,transparent); font-size: 11px; }
    .summary span { padding: 4px 7px; border-radius: 999px; background: color-mix(in srgb,currentColor 7%,transparent); }
    .calls { display: grid; gap: 7px; max-height: 520px; overflow: auto; }
    details { border: 1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius: 10px; overflow: hidden; }
    summary { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 9px; align-items: center; padding: 9px 10px; cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    .tool { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 650 11px ui-monospace,SFMono-Regular,monospace; }
    .duration,.server { color: color-mix(in srgb,currentColor 60%,transparent); font-size: 10px; }
    .status { padding: 3px 6px; border-radius: 999px; font: 750 9px ui-monospace,SFMono-Regular,monospace; text-transform: uppercase; }
    .status.ok { color: #147a48; background: color-mix(in srgb,#168653 13%,transparent); }
    .status.error { color: #b42318; background: color-mix(in srgb,#d92d20 12%,transparent); }
    .status.running { color: #a46500; background: color-mix(in srgb,#d58a00 14%,transparent); }
    .detail { display: grid; gap: 8px; padding: 9px 10px 10px; border-top: 1px solid color-mix(in srgb,currentColor 12%,transparent); }
    h3 { margin: 0 0 4px; color: color-mix(in srgb,currentColor 58%,transparent); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; }
    pre { max-height: 260px; margin: 0; padding: 8px; overflow: auto; border-radius: 8px; background: color-mix(in srgb,Canvas 96%,currentColor 4%); font: 10px/1.45 ui-monospace,SFMono-Regular,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { margin: 0; padding: 18px; text-align: center; color: color-mix(in srgb,currentColor 60%,transparent); font-size: 12px; }
    @media (max-width: 520px) { .toolbar { grid-template-columns: 1fr auto; } select { grid-column: 1/-1; } .server { display: none; } }
  </style>
</head>
<body>
  <main>
    <section class="toolbar"><input id="query" type="search" aria-label="Filter calls" placeholder="Filter calls…"><select id="status" aria-label="Filter by status"><option value="">All statuses</option><option value="ok">Successful</option><option value="error">Errors</option><option value="running">Running</option></select><button id="refresh" type="button">Refresh</button></section>
    <section class="summary" id="summary"></section>
    <section class="calls" id="calls"><p class="empty">Loading calls…</p></section>
  </main>
  <script>
    const queryEl = document.getElementById("query");
    const statusEl = document.getElementById("status");
    const refreshEl = document.getElementById("refresh");
    const summaryEl = document.getElementById("summary");
    const callsEl = document.getElementById("calls");
    let calls = [];
    let busy = false;
    let rpcSequence = 0;
    const pending = new Map();

    function rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = "local-dev-calls-" + (++rpcSequence);
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        setTimeout(() => { if (pending.delete(id)) reject(new Error("Host request timed out")); }, 30000);
      });
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message || "Host request failed")); else request.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/tool-result") update(message.params);
    }, { passive: true });
    async function callTool(name, args) { if (window.openai?.callTool) return await window.openai.callTool(name, args); return await rpc("tools/call", { name, arguments: args }); }
    function envelope(result) { return result?.structuredContent ?? result; }
    function node(tag, text, className) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; }
    function pretty(value) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }

    function render() {
      const query = queryEl.value.trim().toLowerCase();
      const status = statusEl.value;
      const visible = calls.filter((call) => (!status || call.status === status) && (!query || (call.tool + " " + call.server).toLowerCase().includes(query)));
      const completed = calls.filter((call) => typeof call.durationMs === "number").map((call) => call.durationMs).sort((a,b) => a-b);
      summaryEl.replaceChildren(
        node("span", calls.length + " captured"),
        node("span", calls.filter((call) => call.status === "error").length + " errors"),
        node("span", completed.length ? "median " + completed[Math.floor(completed.length / 2)] + " ms" : "no completed calls"),
      );
      callsEl.replaceChildren();
      if (!visible.length) { callsEl.append(node("p", calls.length ? "No calls match this filter." : "No prior calls are available.", "empty")); return; }
      for (const call of visible) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        const name = node("div");
        name.append(node("div", call.tool, "tool"), node("div", call.server, "server"));
        summary.append(name, node("span", call.durationMs === null ? "—" : call.durationMs + " ms", "duration"), node("span", call.status, "status " + call.status));
        const detail = node("div", undefined, "detail");
        for (const [title, value] of [["Arguments", call.arguments], ["Result", call.result]]) {
          const block = node("section"); block.append(node("h3", title), node("pre", pretty(value))); detail.append(block);
        }
        if (Array.isArray(call.media) && call.media.length) detail.append(node("div", call.media.map((item) => item.type + " · " + item.mimeType + " · " + Math.round(item.encodedBytes / 1024) + " KiB").join("   "), "duration"));
        details.append(summary, detail); callsEl.append(details);
      }
    }

    async function refresh() {
      if (busy) return;
      busy = true; refreshEl.disabled = true;
      try { update(await callTool("observability.recent_calls", { limit: 50 })); }
      finally { busy = false; refreshEl.disabled = false; }
    }

    function update(result) {
      const value = envelope(result);
      if (!value || value.ok === false || !Array.isArray(value.data?.calls)) return;
      calls = value.data.calls;
      window.openai?.setWidgetState?.({ calls });
      render();
    }

    queryEl.addEventListener("input", render);
    statusEl.addEventListener("change", render);
    refreshEl.addEventListener("click", refresh);
    window.addEventListener("openai:set_globals", (event) => update(event.detail?.globals?.toolOutput), { passive: true });
    update(window.openai?.toolOutput ?? (window.openai?.widgetState?.calls ? { ok: true, data: { calls: window.openai.widgetState.calls } } : null));
  </script>
</body>
</html>`;

export const callsWidget: UiResource = {
  name: "Local Dev call inspector",
  uri: CALLS_WIDGET_URI,
  description: "Shows recent redacted Local Dev MCP calls with status, duration, bounded arguments, results, and media metadata.",
  html: HTML,
  prefersBorder: true,
};
