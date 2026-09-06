import {
  object,
  string,
  type ActivityEvent,
  type CallItem,
  type Channel,
  type CommandItem,
  type RunItem,
  type SteeringItem,
} from "./contracts.ts";

export function commandText(argv: string[]): string {
  return argv
    .map((part) =>
      part && /^[a-zA-Z0-9_./:=+@%,~-]+$/.test(part)
        ? part
        : "'" + part.replaceAll("'", "'\\''") + "'",
    )
    .join(" ");
}
export function commandDisplay(argv: string[]): {
  invocation: string;
  executable: string;
  script?: string;
} {
  const executable = argv[0] ?? "";
  const name = executable.split(/[\\/]/).at(-1) ?? executable;
  const flags = name.startsWith("python") ? ["-c"] : ["-e", "--eval"];
  const interpreter = ["node", "nodejs", "python", "python3", "ruby", "perl", "swift"].includes(
    name,
  );
  const flag = interpreter
    ? argv.findIndex((part, index) => index > 0 && flags.includes(part))
    : -1;
  if (flag > 0 && flag + 1 < argv.length)
    return {
      executable,
      invocation:
        commandText([name, ...argv.slice(1, flag + 1)]) +
        " ‹inline script›" +
        (flag + 2 < argv.length ? " " + commandText(argv.slice(flag + 2)) : ""),
      script: argv[flag + 1],
    };
  return { executable, invocation: commandText([name, ...argv.slice(1)]) };
}
export function readable(value: unknown, depth = 0): string {
  if (depth > 7) return JSON.stringify(value, null, 2);
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return readable(JSON.parse(value), depth + 1);
      } catch {
        /* Plain text. */
      }
    }
    return value;
  }
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => readable(item, depth + 1)).join("\n");
  if (typeof value !== "object") return String(value);
  const data = object(value);
  if (Object.keys(data).length === 1 && "result" in data) return readable(data.result, depth + 1);
  if (Array.isArray(data.content)) {
    const blocks = object(data._meta).localDevRun ? data.content.slice(0, -1) : data.content;
    const native = object(object(data.structuredContent).data);
    if (typeof native.outputTail === "string") return native.outputTail;
    return blocks
      .map((block) =>
        object(block).type === "text" ? readable(object(block).text, depth + 1) : "",
      )
      .filter(Boolean)
      .join("\n\n");
  }
  return Object.entries(data)
    .map(([key, item]) => `${key.replaceAll("_", " ")}: ${readable(item, depth + 1)}`)
    .join("\n\n");
}
export function titleFor(
  tool: string,
  args: Record<string, unknown>,
): { title: string; target: string } {
  const name = tool.split(".").at(-1) ?? tool;
  const path = string(args.relative_path ?? args.path ?? args.file_path);
  const target =
    path ||
    string(
      args.question ??
        args.query ??
        args.project ??
        args.url ??
        args.name_path_pattern ??
        args.substring_pattern,
    );
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  const verbs: Record<string, string> = {
    read_file: "Read",
    create_text_file: "Write",
    replace_content: "Edit",
    replace_symbol_body: "Edit",
    insert_after_symbol: "Edit",
    insert_before_symbol: "Edit",
    list_dir: "List folder",
    find_file: "Find file",
    find_symbol: "Inspect symbol",
    get_symbols_overview: "Inspect code",
    search_for_pattern: "Search code",
    find_referencing_symbols: "Find references",
    activate_project: "Open project",
    open: "Open project",
    current: "Check project",
    get_current_config: "Check project",
    initial_instructions: "Read tool instructions",
    diff: "Review changes",
    poll: "Check process",
    stop: "Stop process",
    batch: "Run commands",
    ask: "Ask",
  };
  if (Array.isArray(args.argv)) {
    const command = commandDisplay(args.argv as string[]);
    return {
      title:
        command.script === undefined
          ? "Run " + command.invocation
          : "Run " + command.executable.split(/[\\/]/).at(-1) + " script",
      target: string(args.cwd),
    };
  }
  if (Array.isArray(args.steps)) return { title: `Run ${args.steps.length} commands`, target };
  const verb = verbs[name] ?? (tool.includes("chrome") ? "Use browser" : name.replaceAll("_", " "));
  return { title: verb + (filename ? " " + filename : ""), target };
}

/** Display decoding only. The full original event bytes remain in the journal. */
export class OutputDecoder {
  private mode: "text" | "escape" | "csi" | "osc" | "oscEscape" = "text";
  private cr = false;
  append(source: string): string {
    let result = "";
    for (const char of source) {
      const code = char.codePointAt(0)!;
      if (this.mode === "escape") {
        this.mode = char === "[" ? "csi" : ["]", "P", "^", "_"].includes(char) ? "osc" : "text";
        continue;
      }
      if (this.mode === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.mode = "text";
        continue;
      }
      if (this.mode === "osc") {
        if (code === 7 || code === 0x9c) this.mode = "text";
        else if (code === 27) this.mode = "oscEscape";
        continue;
      }
      if (this.mode === "oscEscape") {
        this.mode = char === "\\" ? "text" : "osc";
        continue;
      }
      if (code === 27) {
        this.mode = "escape";
        continue;
      }
      if (code === 0x9b || code === 0x9d) {
        this.mode = code === 0x9b ? "csi" : "osc";
        continue;
      }
      if (char === "\r") {
        result += "\n";
        this.cr = true;
        continue;
      }
      if (char === "\n") {
        if (!this.cr) result += "\n";
        this.cr = false;
        continue;
      }
      if (code === 8) {
        result += "␈";
        continue;
      }
      if ((code < 32 && char !== "\t") || (code >= 0x7f && code <= 0x9f)) continue;
      this.cr = false;
      result += char;
    }
    return result;
  }
}
export function createCommand(id: string, argv: string[], cwd: string): CommandItem {
  return {
    id,
    argv,
    cwd,
    state: "Starting",
    output: { all: "", stdout: "", stderr: "" },
    bytes: { all: 0, stdout: 0, stderr: 0 },
    previewLimited: false,
  };
}
export function parseRun(value: unknown, runtimeId: string): RunItem | undefined {
  const run = object(value);
  if (typeof run.id !== "string") return;
  return {
    id: runtimeId + ":" + run.id,
    runtimeId,
    runId: run.id,
    title: string(run.title, "Goal not reported"),
    goal: typeof run.goal === "string" ? run.goal : null,
    origin: string(run.origin, "observed"),
    state: string(run.state, "running"),
    startedAt: string(run.startedAt),
    endedAt: typeof run.endedAt === "string" ? run.endedAt : undefined,
    summary: typeof run.summary === "string" ? run.summary : undefined,
    backgroundProcesses: 0,
    backgroundProcessPolicy: run.backgroundProcessPolicy === "keep" ? "keep" : "cleanup",
    contextScope: string(run.contextScope, "runtime"),
    notes: [],
    steering: Array.isArray(run.steering) ? (run.steering as SteeringItem[]) : [],
    todos: Array.isArray(run.todos) ? (run.todos as RunItem["todos"]) : undefined,
    connected: false,
  };
}
export class TimelineIndex {
  readonly runs = new Map<string, RunItem>();
  readonly calls = new Map<string, CallItem>();
  private readonly decoders = new Map<string, OutputDecoder>();
  events = 0;
  accept(event: ActivityEvent): void {
    this.events++;
    const detail = object(event.detail);
    const runKey = event.runtimeId + ":" + event.runId;
    if (event.type === "run.started") {
      const run = parseRun(detail.run, event.runtimeId);
      if (run) this.runs.set(run.id, run);
    }
    const run = this.runs.get(runKey);
    if (run) {
      if (event.type === "run.todoUpdated") {
        const todo = object(detail.todo);
        if (typeof todo.id === "string" && typeof todo.title === "string") {
          const todos = run.todos ?? [];
          const index = todos.findIndex((item) => item.id === todo.id);
          if (index < 0) todos.push(todo as unknown as NonNullable<RunItem["todos"]>[number]);
          else todos[index] = todo as unknown as NonNullable<RunItem["todos"]>[number];
          run.todos = todos;
        }
      }
      if (event.type === "steering.taskUpdated") {
        const message = run.steering.find((item) => item.id === detail.id);
        if (message) {
          message.taskStatus = detail.status as SteeringItem["taskStatus"];
          message.taskNote = string(detail.note);
          message.taskUpdatedAt = string(detail.updatedAt);
        }
      }
      if (event.type === "run.processPolicy") {
        run.backgroundProcessPolicy =
          detail.backgroundProcessPolicy === "keep" ? "keep" : "cleanup";
      }
      if (event.type === "run.goal") {
        run.goal = string(detail.goal);
        run.title = string(detail.title, run.title);
        run.origin = string(detail.origin, run.origin);
      }
      if (event.type === "run.note")
        run.notes.push({
          id: `${event.runtimeId}:${event.sequence}`,
          kind: string(detail.kind, "progress"),
          text: string(detail.text),
          timestamp: event.timestamp,
        });
      if (event.type === "run.ended" || event.type === "run.interrupted") {
        run.state = string(detail.state, "interrupted");
        run.endedAt = string(detail.endedAt, event.timestamp);
        run.summary = string(detail.summary);
        run.backgroundProcesses = Number(detail.backgroundProcesses ?? 0);
        if (
          detail.backgroundProcessPolicy === "keep" ||
          detail.backgroundProcessPolicy === "cleanup"
        )
          run.backgroundProcessPolicy = detail.backgroundProcessPolicy;
      }
      if (event.type === "steering.queued") {
        const message = detail.message as SteeringItem;
        if (message?.id && !run.steering.some((item) => item.id === message.id))
          run.steering.push({ ...message });
      }
      if (event.type === "steering.returned" || event.type === "steering.acknowledged") {
        const message = run.steering.find((item) => item.id === detail.id);
        if (message) {
          message.state = event.type === "steering.returned" ? "returned" : "acknowledged";
          if (typeof detail.response === "string") message.response = detail.response;
        }
      }
    }
    if (event.type === "runtime.closed") {
      for (const item of this.runs.values())
        if (item.runtimeId === event.runtimeId && item.state === "running") {
          item.state = "interrupted";
          item.endedAt = event.timestamp;
        }
      for (const item of this.calls.values())
        if (
          item.runtimeId === event.runtimeId &&
          ["waiting", "running", "requested", "stopping"].includes(item.state)
        )
          item.state = "interrupted";
    }
    if (!event.operationId) return;
    const key = `${event.runtimeId}:${event.operationId}`;
    if (event.type === "tool.requested") {
      const args = object(detail.arguments);
      const tool = string(detail.tool, "Tool");
      const input = readable(args);
      this.calls.set(key, {
        id: key,
        runtimeId: event.runtimeId,
        operationId: event.operationId,
        runId: event.runId,
        parentId: event.parentId,
        tool,
        ...titleFor(tool, args),
        state: "requested",
        startedAt: event.timestamp,
        summary: "",
        inputPreview: input.slice(0, 12000),
        inputLimited: input.length > 12000,
        commands: [],
        eventCount: 0,
      });
    }
    const call = this.calls.get(key);
    if (!call) return;
    call.eventCount++;
    switch (event.type) {
      case "approval.requested":
        call.state = "waiting";
        break;
      case "approval.accepted":
        call.approval =
          detail.source === "user"
            ? "Approved by you"
            : detail.source === "auto-approve-all"
              ? "Auto-approved"
              : "Read-only";
        break;
      case "approval.denied":
        call.state = "denied";
        break;
      case "tool.started":
        call.state = "running";
        break;
      case "operation.stopRequested":
        call.state = "stopping";
        break;
      case "tool.completed":
        call.state = "completed";
        call.endedAt = event.timestamp;
        break;
      case "tool.failed":
        if (call.state !== "denied") call.state = "failed";
        call.endedAt = event.timestamp;
        call.summary = string(object(detail.error).message, call.summary);
        break;
      case "tool.cancelled":
        call.state = "cancelled";
        call.endedAt = event.timestamp;
        break;
      case "tool.result": {
        const result = object(detail.result);
        const native = object(object(result.structuredContent).data);
        call.summary =
          typeof native.exitCode === "number"
            ? `Exit ${native.exitCode}`
            : (readable(result).split("\n").find(Boolean)?.slice(0, 220) ?? "");
        break;
      }
      case "process.requested":
        if (typeof detail.processId === "string")
          call.commands.push(
            createCommand(
              detail.processId,
              Array.isArray(detail.argv) ? (detail.argv as string[]) : [],
              string(detail.cwd),
            ),
          );
        break;
      case "process.started": {
        const cmd = call.commands.find((item) => item.id === detail.processId);
        if (cmd) {
          cmd.state = "Running";
          cmd.startedAt = event.timestamp;
          cmd.pid = Number(detail.pid);
        }
        break;
      }
      case "process.exited": {
        const cmd = call.commands.find((item) => item.id === detail.processId);
        if (cmd) {
          cmd.state =
            typeof detail.exitCode === "number"
              ? `Exit ${detail.exitCode}`
              : `Signal ${detail.signal}`;
          cmd.exitCode = typeof detail.exitCode === "number" ? detail.exitCode : undefined;
          cmd.signal = typeof detail.signal === "string" ? detail.signal : undefined;
          cmd.endedAt = event.timestamp;
        }
        break;
      }
      case "process.stopUnconfirmed": {
        const cmd = call.commands.find((item) => item.id === detail.processId);
        if (cmd) cmd.state = "Stop not confirmed";
        break;
      }
      case "process.output": {
        const cmd = call.commands.find((item) => item.id === detail.processId);
        if (!cmd) break;
        const stream: Channel = detail.stream === "stderr" ? "stderr" : "stdout";
        const decoderKey = `${event.runtimeId}:${cmd.id}:${stream}`;
        let decoder = this.decoders.get(decoderKey);
        if (!decoder) {
          decoder = new OutputDecoder();
          this.decoders.set(decoderKey, decoder);
        }
        const text = decoder.append(string(detail.text));
        cmd.output[stream] += text;
        cmd.output.all += text;
        cmd.bytes[stream] += Number(detail.bytes ?? 0);
        cmd.bytes.all += Number(detail.bytes ?? 0);
        for (const channel of ["all", stream] as Channel[])
          if (cmd.output[channel].length > 16000) {
            cmd.output[channel] = cmd.output[channel].slice(-16000);
            cmd.previewLimited = true;
          }
      }
    }
  }
}
export function duration(start: string, end?: string): string {
  const seconds = Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  return seconds < 1
    ? `${Math.round(seconds * 1000)} ms`
    : seconds < 60
      ? `${Math.round(seconds)}s`
      : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
