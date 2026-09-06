import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

let server, baseURL;
const root = resolve("dist/test-ui");
const state = {
  revision: 1,
  runs: [
    {
      id: "runtime:active",
      runtimeId: "runtime",
      runId: "active",
      title: "Improve the local activity timeline",
      goal: "Keep commands readable, approvals visible, and original records accessible.",
      origin: "assistant",
      state: "running",
      startedAt: "2026-09-05T17:00:00.000Z",
      backgroundProcesses: 0,
      contextScope: "session",
      connected: true,
      notes: [
        {
          id: "note1",
          kind: "plan",
          text: "Inspect the current UI, improve the execution log, then verify the approval workflow.",
          timestamp: "2026-09-05T17:00:00.000Z",
        },
      ],
      steering: [],
    },
    {
      id: "runtime:done",
      runtimeId: "runtime",
      runId: "done",
      title: "Verify command output handling",
      goal: "Keep stdout and stderr separate.",
      origin: "assistant",
      state: "completed",
      startedAt: "2026-09-05T16:40:00.000Z",
      endedAt: "2026-09-05T16:42:00.000Z",
      summary:
        "Verified split output chunks and the complete local archive. No data was discarded.",
      backgroundProcesses: 0,
      contextScope: "session",
      connected: true,
      notes: [],
      steering: [],
    },
  ],
  calls: [
    {
      id: "runtime:read",
      runtimeId: "runtime",
      operationId: "read",
      runId: "active",
      tool: "serena.read_file",
      title: "Read ActivityStore.swift",
      target: "native/ActivityStore.swift",
      state: "completed",
      startedAt: "2026-09-05T17:00:01.000Z",
      endedAt: "2026-09-05T17:00:01.250Z",
      approval: "Read-only",
      summary: "File read",
      inputPreview: "relative path: native/ActivityStore.swift",
      inputLimited: false,
      commands: [],
      eventCount: 5,
    },
    {
      id: "runtime:check",
      runtimeId: "runtime",
      operationId: "check",
      runId: "active",
      tool: "dev.run",
      title: "Run npm run check",
      target: "/project",
      state: "completed",
      startedAt: "2026-09-05T17:00:02.000Z",
      endedAt: "2026-09-05T17:00:04.400Z",
      approval: "Approved by you",
      summary: "Exit 0",
      inputPreview: "argv: npm run check",
      inputLimited: false,
      eventCount: 12,
      commands: [
        {
          id: "process-one",
          argv: ["/opt/node/bin/npm", "run", "check"],
          cwd: "/project",
          state: "Exit 0",
          pid: 1234,
          exitCode: 0,
          startedAt: "2026-09-05T17:00:02.000Z",
          endedAt: "2026-09-05T17:00:04.400Z",
          output: {
            all: "TypeScript: no errors\n71 tests passed\nFixture notice\n<img src=x onerror=alert(1)>\n",
            stdout: "TypeScript: no errors\n71 tests passed\n<img src=x onerror=alert(1)>\n",
            stderr: "Fixture notice\n",
          },
          bytes: { all: 100, stdout: 80, stderr: 20 },
          previewLimited: true,
        },
      ],
    },
    {
      id: "runtime:approval",
      runtimeId: "runtime",
      operationId: "approval",
      runId: "active",
      tool: "serena.replace_content",
      title: "Edit timeline.tsx",
      target: "desktop/src/renderer/timeline.tsx",
      state: "waiting",
      startedAt: "2026-09-05T17:00:05.000Z",
      summary: "",
      inputPreview: "File: timeline.tsx\nReplacement: clearer labels",
      inputLimited: false,
      commands: [],
      eventCount: 2,
    },
  ],
  runtimes: [
    {
      id: "runtime",
      pid: 123,
      connected: true,
      supportsRuns: true,
      policy: { autoApprove: false, remember: false, paused: false },
      operations: [
        {
          id: "approval",
          runId: "active",
          tool: "serena.replace_content",
          title: "Edit timeline.tsx",
          arguments: {},
          state: "waiting",
          startedAt: "2026-09-05T17:00:05.000Z",
        },
      ],
      processes: [],
      runs: [],
    },
  ],
  archive: {
    directory: "/fixture/.local-dev/activity",
    bytes: 4000000,
    events: 203,
    calls: 3,
    runs: 2,
    loading: false,
    shown: 100,
  },
  errors: [],
  preference: { autoApprove: false, remember: false, paused: false, pending: false },
  connection: {
    status: "connected",
    configured: true,
    message: "1 local runtime connected",
    diagnostics: "Fixture connection ready",
  },
  platform: "darwin",
  version: "0.5.0",
};

test.beforeAll(async () => {
  // Test-only static server, restricted to the compiled fixture build and loopback.
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, "." + new URL(request.url, "http://fixture").pathname);
      if (path !== root && !path.startsWith(root + "/")) {
        response.writeHead(403).end();
        return;
      }
      const target = path === root ? resolve(root, "index.html") : path;
      const mime =
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[
          extname(target)
        ] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": mime });
      response.end(await readFile(target));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  await mkdir("../build/desktop-previews", { recursive: true });
});
test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function load(page, changes = {}) {
  await page.addInitScript(
    (initial) => {
      let value = structuredClone(initial);
      const subscribers = new Set();
      window.fixtureCalls = [];
      window.fixtureSnapshot = () => structuredClone(value);
      window.fixtureSet = (next) => {
        value = { ...value, ...next, revision: value.revision + 1 };
        for (const listener of subscribers) listener(structuredClone(value));
      };
      window.__localDevTestBridge = {
        ready: async () => ({ ok: true }),
        snapshot: async () => structuredClone(value),
        subscribe: (listener) => {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
        act: async (action) => {
          window.fixtureCalls.push(action);
          if (action.type === "policy") return { ok: false, cancelled: true };
          if (action.type === "answerAsk") {
            window.fixtureSet({
              runtimes: value.runtimes.map((runtime) =>
                runtime.id === action.runtimeId
                  ? {
                      ...runtime,
                      asks: (runtime.asks ?? []).filter((ask) => ask.id !== action.askId),
                    }
                  : runtime,
              ),
            });
            return { ok: true, message: "Answer sent to ChatGPT." };
          }
          if (action.type === "steer")
            return {
              ok: true,
              message: "Queued for the next tool response. Not yet acknowledged.",
            };
          if (action.type === "approve" || action.type === "deny")
            window.fixtureSet({
              calls: value.calls.map((call) =>
                call.operationId === action.operationId
                  ? { ...call, state: action.type === "approve" ? "completed" : "denied" }
                  : call,
              ),
            });
          return { ok: true, message: "Action confirmed by the runtime." };
        },
        details: async (request) => ({
          text:
            request.mode === "raw"
              ? request.operationId === "approval"
                ? JSON.stringify({
                    type: "tool.requested",
                    operationId: "approval",
                    detail: {
                      arguments: {
                        relative_path: "timeline.tsx",
                        mode: "literal",
                        needle: "const label = 1;\nrender(label);",
                        repl: "const label = 2;\nrender(label);",
                      },
                    },
                  }) + "\n"
                : '{"exact":"unmasked-secret"}'
              : request.channel === "stderr"
                ? "Complete stderr from archive\n"
                : "Complete output from archive\nEarlier lines are included.\n",
          images: [],
        }),
        copy: async (text) => {
          window.fixtureCopied = text;
          return { ok: true, message: "Copied." };
        },
        exportDetails: async () => ({ ok: true, message: "Exported locally." }),
      };
    },
    { ...state, ...changes },
  );
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Local Dev", exact: true })).toBeVisible();
}

test("runs have clear goals, explicit boundaries, and expandable command output", async ({
  page,
}) => {
  await load(page);
  await expect(
    page.getByRole("article", { name: "Improve the local activity timeline" }),
  ).toContainText("Keep commands readable");
  await expect(page.getByRole("button", { name: /Run npm run check/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: /Run npm run check/ }).click();
  await expect(page.getByLabel("all output")).toContainText("71 tests passed");
  await page.getByRole("button", { name: "stderr", exact: true }).click();
  await expect(page.getByLabel("stderr output")).toHaveText("Fixture notice\n");
  await page.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureCopied))
    .toBe("/opt/node/bin/npm run check");
  await page.getByRole("button", { name: "Expand output" }).click();
  await expect(page.getByLabel("stderr output")).toContainText("Complete stderr from archive");
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open run: Verify command output handling", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open run: Verify command output handling", exact: true })
    .click();
  await expect(page.getByRole("article", { name: "Verify command output handling" })).toContainText(
    "End",
  );
});

test("attention view exposes approvals without expanding a run", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Attention", exact: false }).first().click();
  await expect(page.getByRole("heading", { name: "Decisions, not distractions." })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("No approvals are waiting.")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.fixtureCalls.some(
        (call) => call.type === "approve" && call.operationId === "approval",
      ),
    ),
  ).toBe(true);
});

test("steering drafts persist and queue only to a declared run", async ({ page }) => {
  await load(page);
  await page.getByLabel("Steering instruction").fill("Only change the UI, preserve the backend.");
  await page.reload();
  await expect(page.getByLabel("Steering instruction")).toHaveValue(
    "Only change the UI, preserve the backend.",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Steering instruction")).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("Not yet acknowledged");
  expect(
    await page.evaluate(() => window.fixtureCalls.find((call) => call.type === "steer").text),
  ).toBe("Only change the UI, preserve the backend.");
});

test("observed runs cannot trigger the old steering deadlock", async ({ page }) => {
  await load(page, {
    runs: [{ ...state.runs[0], origin: "observed", goal: null, title: "Goal not reported" }],
  });
  await page.getByLabel("Steering instruction").fill("Keep this draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText(/Ask ChatGPT to call run.start/)).toBeVisible();
});

test("cancelled approval confirmation leaves the setting off", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Auto-approve all" });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.getByLabel("Color theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keyboard search and modal detail focus are usable", async ({ page }) => {
  await load(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("searchbox").fill("no-such-run");
  await expect(page.getByRole("heading", { name: "No matching runs", exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: /Run npm run check/ }).click();
  await page
    .locator('[data-operation-id="check"]')
    .getByRole("button", { name: "Original records", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("unmasked-secret");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("desktop light/dark and narrow layouts have no horizontal overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 840 });
  await load(page);
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-runs-light.png`,
  });
  await page.getByRole("button", { name: /Run npm run check/ }).click();
  await page.getByLabel("all output").scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-command.png`,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Color theme", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-runs-dark.png`,
  });
  await page.setViewportSize({ width: 390, height: 780 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-narrow.png`,
  });
});

test("run navigation keeps the steering recipient and selected history stable", async ({
  page,
}) => {
  await load(page);
  await page.getByLabel("Steering instruction").fill("Keep this draft for the active run.");
  await page
    .getByRole("button", { name: "Open run: Verify command output handling", exact: true })
    .click();
  await expect(page.getByRole("article", { name: "Verify command output handling" })).toBeVisible();
  await expect(page.getByLabel("Target run")).toHaveValue("runtime:active");
  await page.evaluate(
    (runs) => window.fixtureSet({ runs }),
    [
      ...state.runs,
      {
        ...state.runs[0],
        id: "runtime:incoming",
        runId: "incoming",
        title: "New incoming work",
        startedAt: "2026-09-05T18:00:00.000Z",
      },
    ],
  );
  await expect(page.getByRole("article", { name: "Verify command output handling" })).toBeVisible();
  await expect(page.getByLabel("Target run")).toHaveValue("runtime:active");
  await page.reload();
  await expect(page.getByRole("article", { name: "Verify command output handling" })).toBeVisible();
  await expect(page.getByLabel("Steering instruction")).toHaveValue(
    "Keep this draft for the active run.",
  );
});

test("newest action opens automatically and disabling this behavior survives reload", async ({
  page,
}) => {
  await load(page);
  const newest = page.locator('[data-operation-id="approval"] > button');
  await expect(newest).toHaveAttribute("aria-expanded", "true");
  const follow = page.getByRole("button", { name: "Auto-expand newest activity", exact: true });
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  const incoming = {
    ...state.calls[0],
    id: "runtime:incoming-step",
    operationId: "incoming-step",
    title: "Read new-file.ts",
    target: "src/new-file.ts",
    startedAt: "2026-09-05T17:00:06.000Z",
  };
  await page.evaluate((calls) => window.fixtureSet({ calls }), [...state.calls, incoming]);
  await expect(page.locator('[data-operation-id="incoming-step"] > button')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(newest).toHaveAttribute("aria-expanded", "false");
  await follow.click();
  const later = {
    ...incoming,
    id: "runtime:later-step",
    operationId: "later-step",
    title: "Read later-file.ts",
    startedAt: "2026-09-05T17:00:07.000Z",
  };
  await page.evaluate((calls) => window.fixtureSet({ calls }), [...state.calls, incoming, later]);
  await expect(page.locator('[data-operation-id="later-step"] > button')).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator('[data-operation-id="incoming-step"] > button')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.reload();
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await expect(newest).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Auto-expand newest activity", exact: true }),
  ).not.toBeChecked();
});

test("refreshes and manual collapse do not fight the newest-step preference", async ({ page }) => {
  await load(page);
  const latest = page.locator('[data-operation-id="approval"] > button');
  await latest.click();
  await expect(latest).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(
    (calls) => window.fixtureSet({ calls }),
    state.calls.map((call) => ({ ...call, eventCount: call.eventCount + 1 })),
  );
  await expect(latest).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-operation-id="approval"] [role="region"]')).toHaveAttribute(
    "inert",
    "",
  );
});

test("command filters keep pending approvals visible", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await expect(page.getByRole("button", { name: /Read ActivityStore.swift/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Run npm run check/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All steps", exact: true }).click();
  await expect(page.getByRole("button", { name: /Read ActivityStore.swift/ })).toBeVisible();
});

test("steering shortcut leaves Enter as newline and rejects oversized messages", async ({
  page,
}) => {
  await load(page);
  const input = page.getByLabel("Steering instruction");
  await input.fill("First line");
  await input.press("End");
  await input.press("Enter");
  await input.pressSequentially("Second line");
  await expect(input).toHaveValue("First line\nSecond line");
  await input.press("Control+Enter");
  await expect(input).toHaveValue("");
  expect(
    await page.evaluate(() => window.fixtureCalls.filter((call) => call.type === "steer").length),
  ).toBe(1);
  await input.fill("x".repeat(4001));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await input.press("Control+Enter");
  expect(
    await page.evaluate(() => window.fixtureCalls.filter((call) => call.type === "steer").length),
  ).toBe(1);
});

test("paused approvals explain the gate without blocking denial", async ({ page }) => {
  await load(page, { preference: { ...state.preference, paused: true } });
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByText("Resume new actions before approving.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
});

test("live run clocks advance while completed durations and history timestamps stay stable", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-05T17:00:10.000Z") });
  await load(page);
  const clock = page
    .getByRole("article", { name: state.runs[0].title })
    .locator('[data-run-clock="runtime:active"]');
  await expect(clock).toContainText("10s elapsed");
  await page.clock.fastForward(5000);
  await expect(clock).toContainText("15s elapsed");
  const completed = page.getByRole("button", {
    name: "Open run: Verify command output handling",
    exact: true,
  });
  await expect(completed.locator("time")).toHaveAttribute("datetime", state.runs[1].startedAt);
  await expect(completed.locator('[data-run-clock="runtime:done"]')).toHaveText("2m 0s");
});

test("recorded edits have readable diff provenance and remain safe text", async ({
  page,
}, testInfo) => {
  await load(page);
  const edit = page.getByRole("region", { name: "Edit diff", exact: true });
  await expect(edit).toContainText("Requested text diff");
  await expect(edit).toContainText("does not prove the edit was applied");
  await expect(edit.locator('[data-kind="remove"]')).toContainText("const label = 1;");
  await expect(edit.locator('[data-kind="add"]')).toContainText("const label = 2;");
  await expect(edit.locator("script")).toHaveCount(0);
  await edit.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-edit-diff.png`,
  });
});

test("narrow navigation and reduced motion remain accessible", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 780 });
  await load(page);
  await expect(page.getByLabel("Selected run", { exact: true })).toBeVisible();
  await page.getByLabel("Selected run", { exact: true }).selectOption("runtime:done");
  await expect(page.getByRole("article", { name: "Verify command output handling" })).toBeVisible();
  expect(
    await page
      .locator("article header")
      .evaluate((element) => parseFloat(getComputedStyle(element).animationDuration)),
  ).toBeLessThan(0.001);
  const overflowing = await page.evaluate(() =>
    [...document.querySelectorAll("button, input, select, textarea")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
      })
      .map((element) => element.getAttribute("aria-label") || element.textContent),
  );
  expect(overflowing).toEqual([]);
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-mobile-history.png`,
  });
});

function row(page, id) {
  return page.locator(`[data-operation-id="${id}"]`).first();
}
async function appendStep(page, id, seconds, parentId) {
  await page.evaluate(
    ({ id, seconds, parentId }) => {
      const current = window.fixtureSnapshot();
      const call = {
        ...current.calls[0],
        id: `runtime:${id}`,
        operationId: id,
        parentId,
        title: `New action ${id}`,
        state: "running",
        startedAt: `2026-09-05T17:00:${String(seconds).padStart(2, "0")}.000Z`,
        endedAt: undefined,
        commands: [],
        tool: "serena.read_file",
        target: `src/${id}.ts`,
      };
      window.fixtureSet({ calls: [...current.calls, call] });
    },
    { id, seconds, parentId },
  );
}

test("newest item opens, predecessor closes, and output refresh does not override a manual collapse", async ({
  page,
}) => {
  await load(page);
  await expect(
    row(page, "approval").getByRole("button", { name: /Edit timeline/ }),
  ).toHaveAttribute("aria-expanded", "true");
  await appendStep(page, "next", 6);
  await expect(row(page, "approval")).toHaveAttribute("data-expanded", "false");
  await expect(row(page, "next")).toHaveAttribute("data-expanded", "true");
  await row(page, "next")
    .getByRole("button", { name: /New action next/ })
    .click();
  await page.evaluate(() => {
    const current = window.fixtureSnapshot();
    window.fixtureSet({
      calls: current.calls.map((call) =>
        call.operationId === "next"
          ? {
              ...call,
              state: "completed",
              eventCount: call.eventCount + 10,
              summary: "Additional output",
            }
          : call,
      ),
    });
  });
  await expect(row(page, "next")).toHaveAttribute("data-expanded", "false");
  await row(page, "check")
    .getByRole("button", { name: /Run npm run check/ })
    .click();
  await appendStep(page, "following", 7);
  // Browsing an older action suspends automatic disclosure changes as well as scrolling.
  await expect(row(page, "check")).toHaveAttribute("data-expanded", "true");
  await expect(row(page, "following")).toHaveAttribute("data-expanded", "false");
  await page.getByRole("button", { name: "Resume live following", exact: true }).click();
  await expect(row(page, "check")).toHaveAttribute("data-expanded", "false");
  await expect(row(page, "following")).toHaveAttribute("data-expanded", "true");
  await expect(row(page, "check").locator('[role="region"]').first()).toHaveAttribute("inert", "");
});

test("manual expansion setting persists across reloads and does not change permission policy", async ({
  page,
}) => {
  await load(page);
  await page.getByRole("button", { name: "Auto-expand newest activity", exact: true }).click();
  await row(page, "check")
    .getByRole("button", { name: /Run npm run check/ })
    .click();
  await appendStep(page, "manual", 6);
  await expect(row(page, "manual")).toHaveAttribute("data-expanded", "false");
  await expect(row(page, "check")).toHaveAttribute("data-expanded", "true");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Auto-expand newest activity" })).not.toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Auto-expand newest activity", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, "approval")).toHaveAttribute("data-expanded", "false");
  expect(
    await page.evaluate(() => window.fixtureCalls.some((call) => call.type === "policy")),
  ).toBe(false);
});

test("new nested activity opens its ancestor and old history never steals expansion", async ({
  page,
}) => {
  await load(page);
  await appendStep(page, "nested", 6, "read");
  await expect(row(page, "read")).toHaveAttribute("data-expanded", "true");
  await expect(row(page, "nested")).toHaveAttribute("data-expanded", "true");
  await expect(row(page, "approval")).toHaveAttribute("data-expanded", "false");
  await row(page, "nested")
    .getByRole("button", { name: /New action nested/ })
    .click();
  await appendStep(page, "older", 0);
  await expect(row(page, "nested")).toHaveAttribute("data-expanded", "false");
  await expect(row(page, "older")).toHaveAttribute("data-expanded", "false");
  // A denser layout may not need scrolling, so following need not have been suspended.
  const resume = page.getByRole("button", { name: "Resume live following", exact: true });
  if (await resume.count()) await resume.click();
  await appendStep(page, "rootnext", 7);
  await expect(row(page, "read")).toHaveAttribute("data-expanded", "false");
  await expect(row(page, "rootnext")).toHaveAttribute("data-expanded", "true");
});

test("animations are visible normally and disabled by reduced motion or the saved preference", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await load(page);
  const transition = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[data-operation-id="approval"] > [data-open]'))
          .transitionDuration,
    );
  expect(await transition()).toContain("0.23s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await transition()).toBe("0s");
  await expect(row(page, "approval")).toHaveAttribute("data-expanded", "true");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Interface animations" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  expect(await transition()).toBe("0s");
  await row(page, "approval")
    .getByRole("button", { name: /Edit timeline/ })
    .click();
  await expect(row(page, "approval").locator('[role="region"]').first()).not.toBeVisible();
});

test("run elapsed time advances without tool traffic, stops at completion, and history has timestamps", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-05T17:00:10.000Z") });
  await load(page);
  const run = page.getByRole("article", { name: "Improve the local activity timeline" });
  const clock = run.locator('[data-run-clock="runtime:active"]');
  await expect(clock).toContainText("10s elapsed");
  await page.clock.fastForward(4000);
  await expect(clock).toContainText("14s elapsed");
  const history = page.getByRole("button", {
    name: "Open run: Verify command output handling",
    exact: true,
  });
  await expect(history.locator('time[datetime="2026-09-05T16:40:00.000Z"]')).toBeVisible();
  await expect(history.locator("time")).toHaveAttribute("title", /2026/);
  await page.evaluate(() => {
    const current = window.fixtureSnapshot();
    window.fixtureSet({
      runs: current.runs.map((item) =>
        item.runId === "active"
          ? { ...item, state: "completed", endedAt: "2026-09-05T17:00:12.000Z" }
          : item,
      ),
    });
  });
  await expect(clock).toContainText("12s duration");
  await page.clock.fastForward(10000);
  await expect(clock).toContainText("12s duration");
});

test("an edit has a labeled requested diff instead of an invented applied change", async ({
  page,
}, testInfo) => {
  await load(page);
  const diff = row(page, "approval").getByRole("region", { name: "Edit diff", exact: true });
  await expect(diff).toContainText("Requested text diff");
  await expect(diff).toContainText("does not prove the edit was applied");
  await expect(diff.locator('[data-kind="remove"] code')).toHaveText("const label = 1;");
  await expect(diff.locator('[data-kind="add"] code')).toHaveText("const label = 2;");
  await diff.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../build/desktop-previews/${testInfo.project.name}-edit-diff.png`,
  });
});

test("selecting history does not redirect an unsent steering draft", async ({ page }) => {
  await load(page);
  await page.getByLabel("Steering instruction").fill("Preserve this recipient and text");
  const target = await page.getByLabel("Target run").inputValue();
  await page
    .getByRole("button", { name: "Open run: Verify command output handling", exact: true })
    .click();
  await appendStep(page, "incoming", 9);
  await expect(page.getByRole("article", { name: "Verify command output handling" })).toBeVisible();
  await expect(page.getByLabel("Target run")).toHaveValue(target);
  await expect(page.getByLabel("Steering instruction")).toHaveValue(
    "Preserve this recipient and text",
  );
});

test("workbench terminal and preferences have a visible identity", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 840 });
  await load(page);
  await expect(page.locator('[data-design="lavender-reference-0.6"]')).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await row(page, "check")
    .getByRole("button", { name: /Run npm run check/ })
    .click();
  const command = row(page, "check").getByRole("region", {
    name: "Command npm run check",
    exact: true,
  });
  await expect(command).toBeVisible();
  await command.scrollIntoViewIfNeeded();
  await command.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-terminal-panel.png`,
  });
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-workbench-command.png`,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const preference = page.getByRole("switch", { name: "Auto-expand newest activity" });
  await preference.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-preferences.png`,
  });
});

async function trackActualAnimations(page) {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    window.studioMotion = [];
    window.studioAnimations = [];
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      const row = this.closest("[data-call-id]");
      if (row) {
        window.studioMotion.push({
          id: row.dataset.callId,
          kind: row.dataset.motionEvent,
          duration: options.duration,
        });
        window.studioAnimations.push(animation);
      }
      return animation;
    };
  });
}

test("studio motion acknowledges real arrivals and completion, never every output chunk", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 1400 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await trackActualAnimations(page);
  await load(page, { calls: [state.calls[0]], runs: [{ ...state.runs[0], notes: [] }] });
  expect(await page.evaluate(() => window.studioMotion)).toEqual([]);
  await appendStep(page, "animated", 6);
  await expect
    .poll(() => page.evaluate(() => window.studioMotion))
    .toContainEqual({ id: "runtime:animated", kind: "arrive", duration: 360 });
  await page.evaluate(() => {
    const snapshot = window.fixtureSnapshot();
    window.fixtureSet({
      calls: snapshot.calls.map((call) =>
        call.operationId === "animated" ? { ...call, state: "completed" } : call,
      ),
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.studioMotion))
    .toContainEqual({ id: "runtime:animated", kind: "complete", duration: 420 });
  const count = await page.evaluate(() => window.studioMotion.length);
  await page.evaluate(() => {
    const snapshot = window.fixtureSnapshot();
    window.fixtureSet({
      calls: snapshot.calls.map((call) => ({ ...call, eventCount: call.eventCount + 40 })),
    });
  });
  expect(await page.evaluate(() => window.studioMotion.length)).toBe(count);
});

test("OS reduced motion cancels browser animations and prevents new effects", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 1400 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await trackActualAnimations(page);
  await load(page, { calls: [state.calls[0]], runs: [{ ...state.runs[0], notes: [] }] });
  await appendStep(page, "moving", 6);
  await expect.poll(() => page.evaluate(() => window.studioMotion.length)).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.studioAnimations.some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  await appendStep(page, "still", 7);
  expect(await page.evaluate(() => window.studioMotion.length)).toBe(1);
  await expect(row(page, "still")).toHaveAttribute("data-expanded", "true");
});

test("saved animation setting disables JavaScript effects as well as CSS", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 1400 });
  await trackActualAnimations(page);
  await load(page, { calls: [state.calls[0]], runs: [{ ...state.runs[0], notes: [] }] });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Interface animations", exact: true }).uncheck();
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await appendStep(page, "manual-motion-off", 6);
  expect(await page.evaluate(() => window.studioMotion)).toEqual([]);
  await expect(row(page, "manual-motion-off")).toHaveAttribute("data-expanded", "true");
});

test("latest navigation reveals a real filtered step without changing permissions or recipient", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await load(page, { calls: state.calls.slice(0, 2) });
  await page.getByLabel("Steering instruction").fill("Keep this draft for the current run");
  const target = await page.getByLabel("Target run").inputValue();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(row(page, "check")).toHaveCount(0);
  await page.getByRole("button", { name: "Show latest action", exact: true }).click();
  await expect(row(page, "check")).toHaveAttribute("data-expanded", "true");
  await expect(row(page, "check").locator(":scope > button")).toBeFocused();
  await expect(page.getByRole("button", { name: "All steps", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Target run")).toHaveValue(target);
  await expect(page.getByLabel("Steering instruction")).toHaveValue(
    "Keep this draft for the current run",
  );
  expect(await page.evaluate(() => window.fixtureCalls)).toEqual([]);
});

test("studio composition is readable at desktop and small desktop widths", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-09-05T17:02:08.000Z") });
  await page.setViewportSize({ width: 1180, height: 920 });
  await load(page, { calls: state.calls.slice(0, 2), runs: state.runs, version: "0.6.0" });
  await expect(page.getByLabel("Target run")).toHaveValue("runtime:active");
  await expect(page.locator("[data-overview]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show latest action", exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-studio-overview.png`,
  });
  await page.getByRole("button", { name: "Show latest action", exact: true }).click();
  await page.getByLabel("all output").scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-studio-timeline.png`,
  });
  await page.setViewportSize({ width: 760, height: 680 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-studio-compact.png`,
  });
});

test("system time formatting and persistent 12/24-hour overrides apply consistently", async ({
  page,
}) => {
  await load(page, { systemClock: { hour12: false, locale: "en-US", source: "macos" } });
  const times = page.locator(`time[datetime="${state.runs[0].startedAt}"]`);
  await expect(times.first()).not.toHaveAttribute("title", /AM|PM/);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Time format", { exact: true })).toHaveValue("system");
  await expect(
    page.getByLabel("Time format", { exact: true }).locator('option[value="system"]'),
  ).toHaveText("System (24-hour)");
  await page.getByLabel("Time format", { exact: true }).selectOption("12h");
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(times.first()).toHaveAttribute("title", /AM|PM/);
  await page.reload();
  await expect(times.first()).toHaveAttribute("title", /AM|PM/);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Time format", { exact: true }).selectOption("24h");
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(times.first()).not.toHaveAttribute("title", /AM|PM/);
  expect(
    await page.evaluate(() => window.fixtureCalls.some((call) => call.type === "policy")),
  ).toBe(false);
});

test("latest-first live following keeps new work visible and offers explicit resume while reading history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 760 });
  await load(page);
  await appendStep(page, "leading", 6);
  await expect(page.locator("[data-call-id]").first()).toHaveAttribute(
    "data-operation-id",
    "leading",
  );
  const main = page.locator("main");
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    page.getByRole("button", { name: "Resume live following", exact: true }),
  ).toBeVisible();
  const before = await main.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(96);
  await appendStep(page, "new-leading", 7);
  expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(96);
  await page.getByRole("button", { name: "Resume live following", exact: true }).click();
  await expect(row(page, "new-leading").locator(":scope > button")).toBeInViewport();
  await expect(page.locator("article")).toHaveAttribute("data-live-follow", "following");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Follow live activity", exact: true }).uncheck();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Follow live activity", exact: true }),
  ).not.toBeChecked();
});

test("public update and to-do context stay visible beside a wide timeline", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await load(page, {
    runs: [
      {
        ...state.runs[0],
        todos: [
          {
            id: "design",
            title: "Refine the visual hierarchy",
            status: "completed",
            note: "Reviewed both themes",
            updatedAt: state.runs[0].startedAt,
          },
          {
            id: "tests",
            title: "Verify the installed UI",
            status: "in_progress",
            updatedAt: state.runs[0].startedAt,
          },
          {
            id: "later",
            title: "Keep this task for later",
            status: "paused",
            updatedAt: state.runs[0].startedAt,
          },
        ],
        steering: [
          {
            id: "direction",
            text: "Keep history readable",
            state: "acknowledged",
            createdAt: state.runs[0].startedAt,
            taskStatus: "queued",
          },
        ],
      },
    ],
  });
  const context = page.getByRole("complementary", { name: "Run context", exact: true });
  await expect(context.getByRole("region", { name: "Run to-dos", exact: true })).toBeVisible();
  await expect(context.locator('[data-todo-id="tests"]')).toContainText("In progress");
  await expect(
    context.getByRole("region", { name: "Steering work status", exact: true }),
  ).toContainText("Queued");
  const latest = context.getByRole("region", { name: "Latest public update", exact: true });
  const before = await latest.boundingBox();
  await page.locator("main").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const after = await latest.boundingBox();
  expect(Math.abs(after.y - before.y)).toBeLessThan(3);
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-tasks-context.png`,
  });
});

test("narrow run titles keep reading width beside an approval prompt", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await load(page);
  const heading = page.getByRole("heading", { name: state.runs[0].title, exact: true });
  const box = await heading.boundingBox();
  expect(box.width).toBeGreaterThan(220);
  expect(box.height).toBeLessThan(135);
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-compact-final.png`,
  });
});

test("all five task states are distinct from steering delivery and update without losing older work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const statuses = ["queued", "in_progress", "paused", "completed", "cancelled"];
  const run = {
    ...state.runs[0],
    todos: statuses.map((status, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      status,
      updatedAt: state.runs[0].startedAt,
    })),
    steering: [
      {
        id: "direction",
        text: "Implement this direction",
        state: "acknowledged",
        taskStatus: "queued",
        createdAt: state.runs[0].startedAt,
      },
      {
        id: "legacy",
        text: "Old acknowledged message",
        state: "acknowledged",
        createdAt: state.runs[0].startedAt,
      },
    ],
  };
  await load(page, { runs: [run] });
  const rail = page.getByRole("complementary", { name: "Run context", exact: true });
  const tasks = rail.getByRole("region", { name: "Run to-dos", exact: true });
  for (const status of statuses)
    await expect(tasks.locator(`[data-task-status="${status}"]`)).toHaveCount(1);
  const directions = rail.getByRole("region", { name: "Steering work status", exact: true });
  await expect(directions).toContainText("Work status not reported");
  await expect(directions.locator('[data-task-status="queued"]')).toHaveCount(1);
  await page.evaluate(
    (runs) => window.fixtureSet({ runs }),
    [
      {
        ...run,
        steering: run.steering.map((message) =>
          message.id === "direction"
            ? { ...message, taskStatus: "completed", taskNote: "Implementation verified" }
            : message,
        ),
      },
    ],
  );
  await expect(directions.locator('[data-task-status="completed"]')).toHaveCount(1);
  await expect(directions).toContainText("Implementation verified");
  await expect(tasks.locator('[data-todo-id="task-2"]')).toContainText("Paused");
});

test("old runtime explains the task activation gap without issuing controls automatically", async ({
  page,
}) => {
  await load(page, {
    runtimes: state.runtimes.map((runtime) => ({ ...runtime, workTracking: false })),
  });
  const activation = page.getByRole("region", { name: "Work tracking activation", exact: true });
  await expect(activation).toContainText("Reconnect, then refresh ChatGPT tools");
  await expect(
    activation.getByRole("button", { name: "Reconnect updated runtime…" }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.fixtureCalls)).toEqual([]);
});

test("reviewing older output survives a new call until explicit resume", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1180, height: 760 });
  await load(page);
  await row(page, "check").locator(":scope > button").click();
  await expect(page.locator("article")).toHaveAttribute("data-live-follow", "suspended");
  const command = row(page, "check").getByRole("region", {
    name: "Command npm run check",
    exact: true,
  });
  await command.scrollIntoViewIfNeeded();
  await appendStep(page, "arriving-while-reading", 8);
  await expect(row(page, "check")).toHaveAttribute("data-expanded", "true");
  await expect(row(page, "arriving-while-reading")).toHaveAttribute("data-expanded", "false");
  await expect(command).toBeVisible();
  await page.getByRole("button", { name: "Resume live following", exact: true }).click();
  await expect(row(page, "check")).toHaveAttribute("data-expanded", "false");
  await expect(row(page, "arriving-while-reading")).toHaveAttribute("data-expanded", "true");
});

test("compact public update stays readable while the timeline scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await load(page);
  const update = page.getByRole("region", { name: "Pinned public update", exact: true });
  await expect(update).toBeVisible();
  await page.locator("main").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(update).toBeInViewport();
  await update.getByRole("button", { name: "Read full update" }).click();
  await expect(update.getByRole("button", { name: "Keep compact" })).toBeVisible();
});

test("new activity is actually visible beneath pinned controls on a narrow window", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 780 });
  await load(page);
  await appendStep(page, "mobile-leading", 9);
  const trigger = row(page, "mobile-leading").locator(":scope > button");
  await expect(trigger).toBeInViewport();
  const box = await trigger.boundingBox();
  const pinned = await page
    .getByRole("region", { name: "Pinned public update", exact: true })
    .boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(pinned.y + pinned.height - 3);
  await expect(page.locator("article")).toHaveAttribute("data-live-follow", "following");
});

for (const [width, height] of [
  [1440, 900],
  [1180, 820],
  [1080, 760],
  [760, 680],
  [390, 780],
]) {
  test(`space audit at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date("2026-09-05T17:02:08.000Z") });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.setViewportSize({ width, height });
    await load(page, { calls: state.calls.slice(0, 2) });
    await expect(
      page.getByRole("region", { name: "Command npm run check", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } : null;
      };
      const main = rect("main"),
        action = rect('[data-call-id="runtime:check"]'),
        output = rect('[aria-label="all output"]');
      const visible = (r) =>
        r ? Math.max(0, Math.min(r.bottom, main.bottom) - Math.max(r.y, main.y)) : 0;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        main,
        action,
        output,
        header: rect("header[class]"),
        overview: rect("[data-overview]"),
        composer: rect('[aria-label="Steering composer"]'),
        context: rect('[aria-label="Run context"]'),
        visibleActionHeight: visible(action),
        visibleOutputHeight: visible(output),
        contentWidth: action.width,
        timelineGutter: action.x - main.x,
      };
    });
    const phase = process.env.LOCAL_DEV_SPACE_PHASE || "after";
    if (phase === "after") {
      expect(metrics.visibleOutputHeight).toBeGreaterThan(36);
      expect(metrics.composer.height).toBeLessThanOrEqual(95);
      expect(metrics.timelineGutter).toBeLessThanOrEqual(50);
      expect(metrics.action.y).toBeLessThan(
        { 1440: 250, 1180: 260, 1080: 340, 760: 370, 390: 470 }[width],
      );
    }
    await mkdir("../build/space-audit", { recursive: true });
    await writeFile(
      `../build/space-audit/${phase}-${testInfo.project.name}-${width}.json`,
      JSON.stringify(metrics, null, 2),
    );
    await page.screenshot({
      animations: "disabled",
      path: `../build/space-audit/${phase}-${testInfo.project.name}-${width}.png`,
    });
    console.log(`SPACE ${testInfo.project.name} ${width}: ` + JSON.stringify(metrics));
  });
}

test("compact workspace keeps full goals, execution details, and context preferences reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const goal = "Preserve every recorded detail while improving the timeline. ".repeat(12);
  await load(page, { calls: state.calls.slice(0, 2), runs: [{ ...state.runs[0], goal }] });
  const goalButton = page.getByRole("button", { name: "Show full goal", exact: true });
  await expect(goalButton).toHaveAttribute("aria-expanded", "false");
  await goalButton.click();
  await expect(page.getByRole("button", { name: "Collapse goal", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.getByRole("button", { name: "Collapse goal", exact: true }).click();
  const command = page.getByRole("region", { name: "Command npm run check", exact: true });
  await command.locator("details").first().locator("summary").click();
  await expect(command.locator("details").first()).toContainText("/opt/node/bin/npm");
  await command.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureCopied))
    .toBe("/opt/node/bin/npm run check");
  const preferences = page.getByRole("region", { name: "Quick view preferences", exact: true });
  await preferences.locator("summary").click();
  await preferences
    .getByRole("switch", { name: "Auto-expand newest activity", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Auto-expand newest activity", exact: true }),
  ).not.toBeChecked();
  expect(
    await page.evaluate(() => window.fixtureCalls.some((call) => call.type === "policy")),
  ).toBe(false);
});

test("space-efficient composer grows for writing without losing its recipient or draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 760 });
  await load(page);
  const input = page.getByLabel("Steering instruction");
  const before = await input.boundingBox();
  await input.focus();
  await input.fill("First line\nSecond line\nThird line\nFourth line");
  const expanded = await input.boundingBox();
  expect(expanded.height).toBeGreaterThan(before.height + 30);
  const target = await page.getByLabel("Target run").inputValue();
  await page
    .getByRole("button", { name: "Open run: Verify command output handling", exact: true })
    .click();
  await expect(input).toHaveValue("First line\nSecond line\nThird line\nFourth line");
  await expect(page.getByLabel("Target run")).toHaveValue(target);
  await page.reload();
  await expect(input).toHaveValue("First line\nSecond line\nThird line\nFourth line");
  await expect(page.getByLabel("Target run")).toHaveValue(target);
});

test("a single timeline toolbar and current update leave room for keyboard-accessible work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 760 });
  await load(page, { calls: state.calls.slice(0, 2) });
  await expect(page.locator("[data-follow-control]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Pause live following", exact: true })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("region", { name: "Pinned public update", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Latest public update", exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  const update = page.getByRole("region", { name: "Pinned public update", exact: true });
  await update.getByRole("button", { name: "Read full update", exact: true }).click();
  await expect(update.getByRole("button", { name: "Keep compact", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("collapsed command output shows only the last three lines and leaves wheel scrolling to the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 620 });
  const lines = Array.from(
    { length: 24 },
    (_, index) => `line-${String(index + 1).padStart(2, "0")}`,
  );
  const calls = state.calls.slice(0, 2).map((call) =>
    call.operationId !== "check"
      ? call
      : {
          ...call,
          commands: call.commands.map((command) => ({
            ...command,
            output: { all: lines.join("\n") + "\n", stdout: lines.join("\n") + "\n", stderr: "" },
            bytes: { all: 240, stdout: 240, stderr: 0 },
            previewLimited: false,
          })),
        },
  );
  await load(page, { calls });
  const preview = page.getByLabel("all output");
  await expect(preview).toHaveAttribute("data-output-mode", "preview");
  await expect(preview).toHaveText("line-22\nline-23\nline-24\n");
  await expect(preview).not.toHaveAttribute("tabindex");
  await expect(page.getByRole("button", { name: "Follow new output", exact: true })).toHaveCount(0);
  const main = page.locator("main");
  await main.evaluate((element) => {
    element.scrollTop = 0;
  });
  await preview.hover();
  await page.mouse.wheel(0, 260);
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await preview.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Copy displayed output", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureCopied))
    .toBe("line-22\nline-23\nline-24\n");
  await page.getByRole("button", { name: "Expand output", exact: true }).click();
  await expect(preview).toHaveAttribute("data-output-mode", "expanded");
  await expect(preview).toContainText("line-01");
  await expect(preview).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("button", { name: "Follow new output", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse output", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await preview.evaluate((element) => {
    element.scrollTop = 0;
  });
  await preview.hover();
  await page.mouse.wheel(0, 220);
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Collapse output", exact: true }).click();
  await expect(preview).toHaveText("line-22\nline-23\nline-24\n");
});

test("latest update is not sticky inside the wide right context rail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 620 });
  await load(page, {
    runs: [
      {
        ...state.runs[0],
        todos: Array.from({ length: 14 }, (_, index) => ({
          id: `todo-${index}`,
          title: `Task ${index}`,
          status: "queued",
          updatedAt: state.runs[0].startedAt,
        })),
      },
    ],
  });
  const context = page.getByRole("complementary", { name: "Run context", exact: true });
  const latest = context.getByRole("region", { name: "Latest public update", exact: true });
  expect(await latest.evaluate((element) => getComputedStyle(element).position)).not.toBe("sticky");
  const before = await latest.boundingBox();
  await context.evaluate((element) => {
    element.scrollTop = Math.min(220, element.scrollHeight - element.clientHeight);
  });
  const after = await latest.boundingBox();
  expect(after.y).toBeLessThan(before.y - 20);
});

function runtimeWithAsk(ask) {
  return state.runtimes.map((runtime) =>
    runtime.id === "runtime"
      ? { ...runtime, supportsAsk: true, askAutoTimeoutMs: 90_000, asks: [ask] }
      : runtime,
  );
}

test("Ask card shows a 1:30 auto-approve countdown and lets the user override the recommendation", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-05T17:00:00.000Z") });
  const ask = {
    id: "ask-one",
    operationId: "ask-op",
    runId: "active",
    question: "Which implementation should I use?",
    header: "Implementation choice",
    options: [
      { id: "safe", label: "Safer change", description: "Preserve compatibility" },
      { id: "fast", label: "Faster change", description: "Prefer speed" },
    ],
    recommended: "safe",
    allowOther: true,
    createdAt: "2026-09-05T17:00:00.000Z",
    expiresAt: "2026-09-05T17:01:30.000Z",
  };
  await load(page, {
    preference: { ...state.preference, autoApprove: true },
    runtimes: runtimeWithAsk(ask),
  });
  const card = page.getByRole("region", { name: "Question from ChatGPT", exact: true });
  await expect(card).toContainText("Which implementation should I use?");
  await expect(card).toContainText("Recommended in 1:30");
  await expect(card.getByRole("button", { name: /Safer change/ })).toContainText("Recommended");
  await page.clock.fastForward(30_000);
  await expect(card).toContainText("Recommended in 1:00");
  await card.getByRole("button", { name: /Faster change/ }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureCalls.at(-1))).toEqual({
    type: "answerAsk",
    runtimeId: "runtime",
    askId: "ask-one",
    optionId: "fast",
  });
});

test("Ask supports manual custom answers and never invents a timeout when auto-approve is off", async ({
  page,
}) => {
  const ask = {
    id: "ask-manual",
    runId: "active",
    question: "Which direction?",
    options: [
      { id: "safe", label: "Safer" },
      { id: "fast", label: "Faster" },
    ],
    recommended: "safe",
    allowOther: true,
    createdAt: "2026-09-05T17:00:00.000Z",
  };
  await load(page, { runtimes: runtimeWithAsk(ask) });
  const card = page.getByRole("region", { name: "Question from ChatGPT", exact: true });
  await expect(card).toContainText("Waiting for your answer");
  await expect(card).not.toContainText("No response will continue");
  await card.getByLabel("Other answer").fill("Use the hybrid path");
  await card.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureCalls.at(-1))).toEqual({
    type: "answerAsk",
    runtimeId: "runtime",
    askId: "ask-manual",
    text: "Use the hybrid path",
  });
});

test("pausing suspends Ask auto-answer but keeps explicit choices available", async ({ page }) => {
  const ask = {
    id: "ask-paused",
    runId: "active",
    question: "Continue with which plan?",
    options: [
      { id: "safe", label: "Safe plan" },
      { id: "fast", label: "Fast plan" },
    ],
    recommended: "safe",
    allowOther: false,
    createdAt: "2026-09-05T17:00:00.000Z",
  };
  await load(page, {
    preference: { ...state.preference, autoApprove: true, paused: true },
    runtimes: runtimeWithAsk(ask),
  });
  const card = page.getByRole("region", { name: "Question from ChatGPT", exact: true });
  await expect(card).toContainText("Auto-answer paused");
  await card.getByRole("button", { name: /Safe plan/ }).click();
  await expect(card).toHaveCount(0);
});

test("Ask is visible from Attention and remains usable on a narrow window", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const ask = {
    id: "ask-narrow",
    runId: "active",
    question: "Pick the next implementation strategy",
    options: [
      { id: "safe", label: "Safer change", description: "Keep compatibility and verify" },
      { id: "fast", label: "Faster change", description: "Move quickly" },
    ],
    recommended: "safe",
    allowOther: true,
    createdAt: "2026-09-05T17:00:00.000Z",
  };
  await load(page, { runtimes: runtimeWithAsk(ask) });
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  const card = page.getByRole("region", { name: "Question from ChatGPT", exact: true });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: `../build/desktop-previews/${testInfo.project.name}-ask-narrow.png`,
  });
  await card.getByRole("button", { name: /Safer change/ }).focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
});
