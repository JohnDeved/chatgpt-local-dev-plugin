import type { UiResource } from "./common.js";

export const PROJECT_WIDGET_URI = "ui://widget/local-dev-projects-v1.html";

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
    .top { display: flex; gap: 8px; align-items: center; }
    input { min-width: 0; flex: 1; padding: 8px 10px; border: 1px solid color-mix(in srgb,currentColor 17%,transparent); border-radius: 9px; background: color-mix(in srgb,Canvas 96%,currentColor 4%); color: inherit; font: inherit; }
    button { appearance: none; border: 1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius: 8px; padding: 7px 10px; background: color-mix(in srgb,Canvas 94%,currentColor 6%); color: inherit; font: 650 12px/1.2 inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity: .55; }
    .projects { display: grid; gap: 7px; max-height: 430px; overflow: auto; }
    .project { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 10px; border: 1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius: 11px; }
    .project.active { border-color: color-mix(in srgb,#168653 55%,transparent); background: color-mix(in srgb,#168653 7%,transparent); }
    h2 { margin: 0; font-size: 13px; }
    .path,.aliases,.status { margin: 3px 0 0; color: color-mix(in srgb,currentColor 60%,transparent); font-size: 11px; overflow-wrap: anywhere; }
    .aliases { font-family: ui-monospace,SFMono-Regular,monospace; }
    .active-mark { color: #147a48; font: 750 11px ui-monospace,SFMono-Regular,monospace; text-transform: uppercase; }
    .empty,.error { margin: 0; padding: 12px; border-radius: 9px; color: color-mix(in srgb,currentColor 65%,transparent); font-size: 12px; text-align: center; }
    .error { color: #b42318; background: color-mix(in srgb,#d92d20 10%,transparent); }
  </style>
</head>
<body>
  <main>
    <section class="top"><input id="query" type="search" placeholder="Filter projects…" aria-label="Filter projects"><button id="refresh" type="button">Refresh</button></section>
    <section class="projects" id="projects"><p class="empty">Loading projects…</p></section>
    <p class="status" id="status"></p>
  </main>
  <script>
    const projectsEl = document.getElementById("projects");
    const queryEl = document.getElementById("query");
    const refreshEl = document.getElementById("refresh");
    const statusEl = document.getElementById("status");
    let data = { activePath: null, projects: [] };
    let busy = false;
    let rpcSequence = 0;
    const pending = new Map();

    function rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = "local-dev-projects-" + (++rpcSequence);
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

    function envelope(result) { return result?.structuredContent ?? result; }
    function node(tag, text, className) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; }

    function render() {
      const query = queryEl.value.trim().toLowerCase();
      const visible = data.projects.filter((project) => !query || (project.name + " " + project.path + " " + project.aliases.join(" ")).toLowerCase().includes(query));
      projectsEl.replaceChildren();
      if (!visible.length) {
        projectsEl.append(node("p", data.projects.length ? "No projects match this filter." : "No projects were discovered in configured roots.", "empty"));
        return;
      }
      for (const project of visible) {
        const row = node("article", undefined, "project" + (project.path === data.activePath ? " active" : ""));
        const copy = node("div");
        copy.append(node("h2", project.name), node("p", project.path, "path"));
        if (project.aliases.length > 1) copy.append(node("p", project.aliases.join(" · "), "aliases"));
        if (project.path === data.activePath) row.append(copy, node("span", "active", "active-mark"));
        else {
          const open = node("button", "Open");
          open.type = "button";
          open.disabled = busy;
          open.addEventListener("click", () => openProject(project.path));
          row.append(copy, open);
        }
        projectsEl.append(row);
      }
    }

    async function openProject(path) {
      if (busy) return;
      busy = true;
      statusEl.textContent = "Opening project…";
      render();
      try {
        const result = envelope(await callTool("project.open", { query: path }));
        if (result?.ok === false) throw new Error(result.error?.message || "Project could not be opened");
        data.activePath = result?.data?.path ?? path;
        statusEl.textContent = "Project opened.";
        window.openai?.setWidgetState?.({ data });
      } catch (error) {
        statusEl.textContent = error instanceof Error ? error.message : "Project could not be opened.";
      } finally {
        busy = false;
        render();
      }
    }

    async function refresh() {
      if (busy) return;
      busy = true;
      refreshEl.disabled = true;
      statusEl.textContent = "Refreshing…";
      try {
        const result = envelope(await callTool("project.list", {}));
        update(result);
        statusEl.textContent = "";
      } catch (error) {
        statusEl.textContent = error instanceof Error ? error.message : "Could not refresh projects.";
      } finally {
        busy = false;
        refreshEl.disabled = false;
        render();
      }
    }

    function update(result) {
      const value = envelope(result);
      if (!value || typeof value !== "object") return;
      if (value.ok === false) {
        projectsEl.replaceChildren(node("p", value.error?.message || "Could not load projects.", "error"));
        return;
      }
      const next = value.data;
      if (!next || !Array.isArray(next.projects)) return;
      data = { activePath: next.activePath ?? null, projects: next.projects };
      window.openai?.setWidgetState?.({ data });
      render();
    }

    queryEl.addEventListener("input", render);
    refreshEl.addEventListener("click", refresh);
    window.addEventListener("openai:set_globals", (event) => update(event.detail?.globals?.toolOutput), { passive: true });
    const saved = window.openai?.widgetState?.data;
    update(window.openai?.toolOutput ?? (saved ? { ok: true, data: saved } : null));
  </script>
</body>
</html>`;

export const projectWidget: UiResource = {
  name: "Local Dev project picker",
  uri: PROJECT_WIDGET_URI,
  description: "Shows configured local projects, supports filtering, and lets the user switch the active Local Dev project.",
  html: HTML,
  prefersBorder: true,
};
