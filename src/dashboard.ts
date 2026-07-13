import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CallJournal } from "./observability.js";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Local Dev · MCP Calls</title>
  <style>
    :root { color-scheme: dark; --bg:#070b14; --panel:#0d1422; --line:#1d2a3f; --text:#edf4ff; --muted:#8fa1ba; --blue:#63a7ff; --cyan:#4de2d0; --red:#ff7285; --amber:#f7bf65; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 15% 0,#15294c 0,transparent 32rem),var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif; }
    header { position:sticky; top:0; z-index:2; display:flex; justify-content:space-between; gap:18px; align-items:center; padding:18px clamp(18px,4vw,48px); border-bottom:1px solid var(--line); background:color-mix(in srgb,var(--bg) 88%,transparent); backdrop-filter:blur(18px); }
    h1 { margin:0; font-size:20px; letter-spacing:-.02em; }
    .eyebrow { color:var(--cyan); font:700 11px/1.2 ui-monospace,SFMono-Regular,monospace; letter-spacing:.14em; text-transform:uppercase; }
    .live { display:flex; align-items:center; gap:8px; color:var(--muted); }
    .dot { width:8px; height:8px; border-radius:99px; background:var(--cyan); box-shadow:0 0 14px var(--cyan); }
    main { width:min(1180px,calc(100% - 32px)); margin:28px auto 60px; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px; }
    .metric,.toolbar,.empty,.call { border:1px solid var(--line); background:linear-gradient(145deg,color-mix(in srgb,var(--panel) 96%,white 4%),var(--panel)); border-radius:14px; box-shadow:0 18px 60px #0004; }
    .metric { padding:16px 18px; }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; margin-top:4px; font-size:24px; }
    .toolbar { display:flex; gap:12px; padding:12px; margin-bottom:12px; }
    input,select { min-width:0; padding:10px 12px; color:var(--text); border:1px solid var(--line); border-radius:9px; background:#080e19; font:inherit; }
    input { flex:1; }
    .calls { display:grid; gap:9px; }
    .call { overflow:hidden; }
    .call summary { display:grid; grid-template-columns:minmax(180px,1fr) 110px 90px 90px 170px; gap:14px; align-items:center; padding:14px 16px; cursor:pointer; list-style:none; }
    .call summary::-webkit-details-marker { display:none; }
    .tool { overflow:hidden; text-overflow:ellipsis; font:650 13px ui-monospace,SFMono-Regular,monospace; color:#cfe2ff; }
    .server,.when,.duration { color:var(--muted); }
    .status { width:max-content; padding:3px 8px; border-radius:99px; font-size:11px; font-weight:750; text-transform:uppercase; letter-spacing:.07em; }
    .status.ok { color:var(--cyan); background:#14332f; }
    .status.error { color:var(--red); background:#3a1921; }
    .status.running { color:var(--amber); background:#382b16; }
    .detail { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:0 16px 16px; border-top:1px solid var(--line); }
    .block { min-width:0; padding-top:14px; }
    .block h2 { margin:0 0 8px; color:var(--muted); font-size:11px; letter-spacing:.1em; text-transform:uppercase; }
    pre { max-height:380px; overflow:auto; margin:0; padding:12px; border:1px solid var(--line); border-radius:10px; background:#060a11; color:#bdd0eb; font:12px/1.55 ui-monospace,SFMono-Regular,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .media { grid-column:1/-1; color:var(--cyan); font-size:12px; }
    .empty { padding:44px; color:var(--muted); text-align:center; }
    footer { margin-top:18px; color:var(--muted); font-size:12px; text-align:center; }
    @media (max-width:760px) { .metrics{grid-template-columns:1fr 1fr}.call summary{grid-template-columns:1fr auto}.server,.when,.duration{display:none}.detail{grid-template-columns:1fr}.toolbar{flex-direction:column} }
  </style>
</head>
<body>
  <header><div><div class="eyebrow">Private loopback observability</div><h1>Local Dev MCP Calls</h1></div><div class="live"><i class="dot"></i><span id="connection">Connecting</span></div></header>
  <main>
    <section class="metrics">
      <div class="metric"><span>Captured calls</span><strong id="total">0</strong></div>
      <div class="metric"><span>Successful</span><strong id="ok">0</strong></div>
      <div class="metric"><span>Errors</span><strong id="errors">0</strong></div>
      <div class="metric"><span>Median duration</span><strong id="median">—</strong></div>
    </section>
    <section class="toolbar"><input id="query" type="search" placeholder="Filter by tool or server…" aria-label="Filter calls"><select id="status" aria-label="Filter status"><option value="">All statuses</option><option>ok</option><option>error</option><option>running</option></select></section>
    <section class="calls" id="calls"></section>
    <footer>Arguments and results are bounded; credential-like values and media payload bytes are redacted.</footer>
  </main>
  <script>
    const callsEl=document.getElementById("calls"),queryEl=document.getElementById("query"),statusEl=document.getElementById("status");
    let calls=[];
    const text=(tag,value,className)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el};
    const pretty=value=>JSON.stringify(value,null,2);
    function metrics(){
      document.getElementById("total").textContent=String(calls.length);
      document.getElementById("ok").textContent=String(calls.filter(call=>call.status==="ok").length);
      document.getElementById("errors").textContent=String(calls.filter(call=>call.status==="error").length);
      const times=calls.map(call=>call.durationMs).filter(value=>typeof value==="number").sort((a,b)=>a-b);
      document.getElementById("median").textContent=times.length?times[Math.floor(times.length/2)]+" ms":"—";
    }
    function render(){
      metrics();
      const query=queryEl.value.trim().toLowerCase(),status=statusEl.value;
      const visible=calls.filter(call=>(!status||call.status===status)&&(!query||(call.tool+" "+call.server).toLowerCase().includes(query)));
      callsEl.replaceChildren();
      if(!visible.length){callsEl.append(text("div",calls.length?"No calls match this filter.":"Waiting for the first MCP tool call…","empty"));return}
      for(const call of visible){
        const details=document.createElement("details");details.className="call";
        const summary=document.createElement("summary");
        summary.append(text("span",call.tool,"tool"),text("span",call.server,"server"),text("span",call.status,"status "+call.status),text("span",call.durationMs===null?"—":call.durationMs+" ms","duration"),text("time",new Date(call.startedAt).toLocaleTimeString(),"when"));
        const detail=document.createElement("div");detail.className="detail";
        for(const [title,value] of [["Arguments",call.arguments],["Result",call.result]]){const block=document.createElement("section");block.className="block";block.append(text("h2",title),text("pre",pretty(value)));detail.append(block)}
        if(call.media.length){detail.append(text("div",call.media.map(item=>item.type+" · "+item.mimeType+" · "+Math.round(item.encodedBytes/1024)+" KiB").join("   "),"media"))}
        details.append(summary,detail);callsEl.append(details);
      }
    }
    async function refresh(){
      try{const response=await fetch("./api/calls",{cache:"no-store"});if(!response.ok)throw new Error();calls=await response.json();document.getElementById("connection").textContent="Live";document.querySelector(".dot").style.background="var(--cyan)";render()}
      catch{document.getElementById("connection").textContent="Disconnected";document.querySelector(".dot").style.background="var(--red)"}
    }
    queryEl.addEventListener("input",render);statusEl.addEventListener("change",render);refresh();setInterval(refresh,900);
  </script>
</body>
</html>`;

export interface DashboardRuntime {
  url: string;
  close(): Promise<void>;
}

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("DASHBOARD_BIND_FAILED"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startDashboard(journal: CallJournal, urlFile: string): Promise<DashboardRuntime> {
  const token = randomBytes(24).toString("hex");
  const basePath = `/${token}/`;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    if (request.method !== "GET") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    if (request.url === basePath) {
      response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(HTML);
      return;
    }
    if (request.url === `${basePath}api/calls`) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(journal.snapshot()));
      return;
    }
    response.writeHead(404).end("Not found");
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}${basePath}`;
  try {
    await mkdir(dirname(urlFile), { recursive: true, mode: 0o700 });
    await writeFile(urlFile, `${url}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(urlFile, 0o600);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    url,
    close: async () => {
      await closeServer(server);
      const current = await readFile(urlFile, "utf8").catch(() => "");
      if (current.trim() === url) await unlink(urlFile).catch(() => undefined);
    },
  };
}
