import Electrobun, {
  BrowserView,
  BrowserWindow,
  Tray,
  Utils,
  ApplicationMenu,
} from "electrobun/main";
import { homedir } from "node:os";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopService, isolatedTestHome } from "./service.ts";
import { validateDetail, type DesktopRpc, type UiSnapshot } from "../shared/contracts.ts";

const testHome = process.env.LOCAL_DEV_WEB_TEST_HOME;
if (testHome && !isolatedTestHome(testHome))
  throw new Error("Desktop testing requires a separate isolated home.");
const home = testHome ?? homedir();
const directory = join(home, ".local-dev", "activity");
await mkdir(directory, { recursive: true, mode: 0o700 });
const instanceFile = join(directory, "desktop-instance.json");
const activationFile = join(directory, "desktop-open.request");
if (!testHome) {
  try {
    const previous = JSON.parse(await readFile(instanceFile, "utf8")) as { pid: number };
    if (Number.isInteger(previous.pid) && previous.pid > 0) {
      let alive = false;
      try {
        process.kill(previous.pid, 0);
        alive = true;
      } catch {
        /* Stale lock. */
      }
      if (alive) {
        await writeFile(activationFile, String(Date.now()), { mode: 0o600 });
        Utils.quit();
        await new Promise(() => undefined);
      }
    }
  } catch {
    /* First launch or stale instance record. */
  }
  await writeFile(instanceFile, JSON.stringify({ pid: process.pid, version: "0.7.0" }), {
    mode: 0o600,
  });
}
let allowedQuit = false;
let quitPending = false;
let win: BrowserWindow | undefined;
let rpc: ReturnType<typeof BrowserView.defineRPC<DesktopRpc>> | undefined;
let rendered = false;
const confirmationText = {
  autoApprove: {
    message: "Auto-approve all Local Dev actions?",
    detail:
      "Commands, edits, deletions, and supported approval requests will run without asking. Activity remains visible. This does not expand macOS permissions. You can turn this off or pause new actions at any time.",
    accept: "Enable auto-approve",
  },
  stopAll: {
    message: "Stop all Local Dev work?",
    detail:
      "New actions will be paused. Cancellation will be requested for owned operations and process groups. Stop requests are not proof that every downstream action has stopped.",
    accept: "Stop all work",
  },
  reconnect: {
    message: "Reconnect the Local Dev runtime?",
    detail:
      "This reloads the backend and briefly disconnects ChatGPT tools. Development servers and other commands managed by the old runtime may stop. Approval preferences will not be changed.",
    accept: "Reconnect runtime",
  },
  quit: {
    message: "Pause new actions and quit Local Dev?",
    detail:
      "New Local Dev actions will be blocked before the tray app quits. Existing background processes keep running unless you stop them separately.",
    accept: "Pause and quit",
  },
};
const service = new DesktopService(home, {
  confirm: async (kind) => {
    if (testHome) return false;
    const text = confirmationText[kind];
    const result = await Utils.showMessageBox({
      type: "question",
      title: "Local Dev",
      message: text.message,
      detail: text.detail,
      buttons: [text.accept, "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    return result.response === 0;
  },
  openArchive: (path) => {
    if (!Utils.openPath(path)) throw new Error("The archive folder could not be opened.");
  },
  openLoginSettings: () => {
    const url =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
        : process.platform === "win32"
          ? "ms-settings:startupapps"
          : undefined;
    if (!url)
      throw new Error(
        "Configure startup through your Linux desktop's Startup Applications settings. Automatic Linux login registration is not implemented in this build.",
      );
    if (!Utils.openExternal(url)) throw new Error("Startup settings could not be opened.");
  },
  quit: () => {
    allowedQuit = true;
    void close().then(() => Utils.quit());
  },
});
await service.start();
if (process.platform === "darwin") Utils.setDockIconVisible(false);
const tray = new Tray({
  title: "Local Dev",
  image: "views://mainview/tray.png",
  template: true,
  width: 20,
  height: 20,
});
const show = () => {
  if (win) {
    if (win.isVisible()) win.activate();
    else {
      win.show();
      win.activate();
    }
    return;
  }
  rpc = BrowserView.defineRPC<DesktopRpc>({
    maxRequestTime: 120000,
    handlers: {
      requests: {
        snapshot: async ({ limit }) => {
          await service.refreshClock();
          return service.snapshot(limit);
        },
        ready: async () => {
          rendered = true;
          await writeFile(
            join(directory, "desktop-ready.json"),
            JSON.stringify({
              pid: process.pid,
              version: "0.7.0",
              domCommitted: true,
              timestamp: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
          rpc?.send.state(service.snapshot());
          return { ok: true };
        },
        act: (action) => service.act(action),
        details: (request) => service.archive.details(validateDetail(request)),
        copy: ({ text }) => {
          if (typeof text !== "string" || text.length > 32000000)
            throw new Error(
              "Clipboard content exceeds the supported size; export the record instead.",
            );
          Utils.clipboardWriteText(text);
          return { ok: true, message: "Copied." };
        },
        exportDetails: async (input) => {
          const request = validateDetail(input);
          if (testHome) return { ok: false, cancelled: true };
          const approval = await Utils.showMessageBox({
            type: "question",
            title: "Export local activity",
            message: "Export this unmasked record?",
            detail:
              "It may contain secrets. A private file will be written in ~/.local-dev/exports. Nothing will be uploaded.",
            buttons: ["Export", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          });
          if (approval.response !== 0) return { ok: false, cancelled: true };
          const detail = await service.archive.details(request);
          const exports = join(home, ".local-dev", "exports");
          await mkdir(exports, { recursive: true, mode: 0o700 });
          const path = join(
            exports,
            `${Date.now()}-${randomUUID().slice(0, 8)}.${request.mode === "raw" ? "jsonl" : "txt"}`,
          );
          await writeFile(path, detail.text, { mode: 0o600, flag: "wx" });
          Utils.openPath(exports);
          return { ok: true, message: `Exported locally to ${path}` };
        },
      },
      messages: {},
    },
  });
  win = new BrowserWindow({
    title: "Local Dev",
    url: "views://mainview/index.html",
    renderer: "native",
    frame: { width: 1080, height: 840 },
    rpc,
    navigationRules: JSON.stringify(["views://mainview/*"]),
    titleBarStyle: "default",
  });
  win.on("close", () => {
    win = undefined;
    rpc = undefined;
  });
};
tray.on("tray-clicked", (event: unknown) => {
  const action = (event as { data: { action?: string } }).data.action;
  if (!action || action === "open") show();
  else if (action === "quit") void service.act({ type: "quit" });
});
if (process.platform !== "darwin")
  tray.setMenu([
    { type: "normal", label: "Open Local Dev", action: "open" },
    { type: "separator" },
    { type: "normal", label: "Pause and quit…", action: "quit" },
  ]);
ApplicationMenu.setApplicationMenu([
  {
    label: "Local Dev",
    submenu: [
      { label: "Show Local Dev", action: "open" },
      { type: "separator" },
      { label: "Pause and quit…", action: "quit", accelerator: "CmdOrCtrl+Q" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);
ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const action = (event as { data: { action: string } }).data.action;
  if (action === "open") show();
  else if (action === "quit") void service.act({ type: "quit" });
});
Electrobun.events.on("before-quit", (event: { response?: { allow: boolean } }) => {
  if (allowedQuit) return;
  event.response = { allow: false };
  if (!quitPending) {
    quitPending = true;
    void service.act({ type: "quit" }).finally(() => {
      quitPending = false;
    });
  }
});
let lastTrayTitle = "";
let knownAskIds = new Set<string>();
let latest: UiSnapshot | undefined;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
service.subscribe((state) => {
  latest = state;
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    if (!latest) return;
    const waiting = latest.calls.filter((call) => call.state === "waiting").length;
    const running = latest.calls.filter((call) => call.state === "running").length;
    const askIds = new Set(
      latest.runtimes.flatMap((runtime) =>
        (runtime.asks ?? []).map((ask) => `${runtime.id}:${ask.id}`),
      ),
    );
    const hasNewAsk = [...askIds].some((id) => !knownAskIds.has(id));
    knownAskIds = askIds;
    const asking = askIds.size;
    const suffix = latest.preference.paused
      ? "Paused"
      : asking
        ? `${asking} question${asking === 1 ? "" : "s"}`
        : waiting
          ? `${waiting} approvals`
          : running
            ? `${running} running`
            : latest.connection.status === "connected"
              ? "Ready"
              : "Offline";
    const title = `Local Dev · ${suffix}${latest.preference.autoApprove ? " · AUTO" : ""}`;
    if (lastTrayTitle !== title) {
      tray.setTitle(title);
      lastTrayTitle = title;
    }
    if (rpc && win && rendered) rpc.send.state(latest);
    if (hasNewAsk) show();
  }, 180);
});
let openedAt = 0;
const activationTimer = setInterval(() => {
  void stat(activationFile)
    .then((info) => {
      if (info.mtimeMs > openedAt) {
        openedAt = info.mtimeMs;
        show();
      }
    })
    .catch(() => undefined);
}, 1000);
async function close() {
  clearInterval(activationTimer);
  if (pushTimer) clearTimeout(pushTimer);
  await service.close();
  if (!testHome) await unlink(instanceFile).catch(() => undefined);
}
show();
if (testHome) {
  const deadline = Date.now() + 20000;
  const smoke = setInterval(() => {
    if (rendered && service.snapshot().connection.status === "connected") {
      clearInterval(smoke);
      void writeFile(
        join(testHome, "native-webview-ready.json"),
        JSON.stringify({
          renderer: "native",
          domCommitted: true,
          rpc: true,
          runtimeConnected: true,
          platform: process.platform,
        }),
        { mode: 0o600 },
      ).then(async () => {
        allowedQuit = true;
        await close();
        Utils.quit();
      });
    } else if (Date.now() > deadline) {
      clearInterval(smoke);
      allowedQuit = true;
      void close().then(() => Utils.quit(1));
    }
  }, 100);
}
