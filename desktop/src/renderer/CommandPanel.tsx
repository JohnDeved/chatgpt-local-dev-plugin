import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Folder, WrapText } from "lucide-react";
import { commandDisplay, commandText, duration } from "../shared/presentation.ts";
import type {
  ActionResult,
  CallItem,
  Channel,
  CommandItem,
  DesktopBridge,
  DetailRequest,
} from "../shared/contracts.ts";
import s from "./app.module.css";

export interface UiActions {
  bridge: DesktopBridge;
  notify: (result: ActionResult) => void;
  inspect: (request: DetailRequest) => void;
  paused?: boolean;
}

function outputLines(value: string): string[] {
  if (!value) return [];
  const trailingNewline = value.endsWith("\n");
  const body = trailingNewline ? value.slice(0, -1) : value;
  if (!body) return [];
  return body.split("\n");
}
function lastOutputLines(value: string, count = 3): string {
  const lines = outputLines(value);
  if (!lines.length) return "";
  const result = lines.slice(-count).join("\n");
  return value.endsWith("\n") ? result + "\n" : result;
}

export function CommandPanel({
  command,
  call,
  bridge,
  notify,
  inspect,
}: UiActions & { command: CommandItem; call: CallItem }) {
  const [channel, setChannel] = useState<Channel>("all");
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState<{ channel: Channel; bytes: number; text: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const output = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const display = commandDisplay(command.argv);
  const detail: DetailRequest = {
    runtimeId: call.runtimeId,
    operationId: call.operationId,
    processId: command.id,
    mode: "output",
    channel,
  };
  const capturedText = command.output[channel];
  const expandedText = loaded?.channel === channel ? loaded.text : capturedText;
  const visibleText = expanded ? expandedText : lastOutputLines(capturedText);
  const capturedLines = outputLines(capturedText).length;
  const hasHiddenOutput = command.previewLimited || capturedLines > 3;
  const complete =
    !command.previewLimited || (loaded?.channel === channel && loaded.bytes === command.bytes.all);
  const running = ["Starting", "Running"].includes(command.state);

  useEffect(() => {
    if (!expanded || !command.previewLimited || complete) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void bridge
        .details(detail)
        .then((result) => {
          if (!cancelled) {
            setLoaded({ channel, bytes: command.bytes.all, text: result.text });
            setLoading(false);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setError(String(error));
            setLoading(false);
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [expanded, channel, command.bytes.all, command.id, command.previewLimited, complete]);

  useLayoutEffect(() => {
    if (
      expanded &&
      follow &&
      atBottom.current &&
      window.getSelection()?.isCollapsed !== false &&
      output.current
    )
      output.current.scrollTop = output.current.scrollHeight;
  }, [visibleText, expanded, follow]);

  const copy = (value: string) =>
    void bridge
      .copy(value)
      .then((result) => notify(result.ok ? { ok: true, message: "Copied." } : result));
  return (
    <section className={s.command} aria-label={`Command ${display.invocation}`}>
      <div className={s.commandHeader}>
        <pre className={s.invocation}>
          <span aria-hidden="true">$ </span>
          {display.invocation}
        </pre>
        <button
          className={s.textButton}
          aria-label="Copy command"
          onClick={() => copy(commandText(command.argv))}
        >
          <Copy size={12} />
          <span>Copy command</span>
        </button>
      </div>
      <details className={s.commandMeta}>
        <summary>
          <Folder size={12} />
          <span title={command.cwd}>{command.cwd || "Execution details"}</span>
        </summary>
        <div>
          <span>Executable</span>
          <code>{command.argv[0]}</code>
          {command.cwd && (
            <>
              <span>Working directory</span>
              <code>{command.cwd}</code>
            </>
          )}
        </div>
      </details>
      {display.script !== undefined && (
        <details className={s.script}>
          <summary>
            Inline script <span>{display.script.split("\n").length} lines</span>
          </summary>
          <button className={s.textButton} onClick={() => copy(display.script!)}>
            <Copy size={12} />
            Copy source
          </button>
          <pre>{display.script}</pre>
        </details>
      )}
      <div className={s.outputToolbar}>
        <span>Output</span>
        {command.bytes.stderr > 0 && <span className={s.stderrFlag}>stderr</span>}
        <span className={s.grow} />
        <div className={s.segmented} aria-label="Output stream">
          {(["all", "stdout", "stderr"] as Channel[]).map((value) => (
            <button key={value} aria-pressed={value === channel} onClick={() => setChannel(value)}>
              {value === "all" ? "All" : value}
            </button>
          ))}
        </div>
        <button
          className={s.iconButton}
          aria-label="Wrap output lines"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={14} />
        </button>
        {expanded && (
          <button
            className={s.iconButton}
            aria-label="Follow new output"
            aria-pressed={follow}
            onClick={() => {
              setFollow(!follow);
              atBottom.current = true;
              if (output.current) output.current.scrollTop = output.current.scrollHeight;
            }}
          >
            <ArrowDownToLine size={14} />
          </button>
        )}
        <button
          className={s.iconButton}
          aria-label="Copy displayed output"
          disabled={!visibleText}
          onClick={() => copy(visibleText)}
        >
          <Copy size={14} />
        </button>
      </div>
      {visibleText ? (
        <pre
          ref={output}
          tabIndex={expanded ? 0 : undefined}
          aria-label={`${channel} output`}
          data-output-mode={expanded ? "expanded" : "preview"}
          className={`${s.output} ${wrap ? s.wrap : ""} ${expanded ? s.expandedOutput : s.outputPreview}`}
          onScroll={() => {
            if (expanded && output.current)
              atBottom.current =
                output.current.scrollHeight -
                  output.current.scrollTop -
                  output.current.clientHeight <
                28;
          }}
        >
          {visibleText}
        </pre>
      ) : (
        <p className={s.noOutput}>
          {running
            ? "Waiting for output…"
            : channel !== "all" && command.bytes.all
              ? `No ${channel} output was captured.`
              : "No text output was produced."}
        </p>
      )}
      <div className={s.outputFooter}>
        <span>{new Intl.NumberFormat().format(command.bytes[channel])} bytes captured</span>
        {!expanded && hasHiddenOutput && (
          <span>Showing last {Math.min(3, capturedLines)} lines</span>
        )}
        {!complete && <span>Preview only; earlier output retained</span>}
        <span className={s.grow} />
        {(hasHiddenOutput || expanded) && (
          <button
            className={s.textButton}
            aria-expanded={expanded}
            disabled={!command.bytes.all}
            onClick={() => {
              setExpanded(!expanded);
              atBottom.current = true;
            }}
          >
            {loading ? "Loading…" : expanded ? "Collapse output" : "Expand output"}
          </button>
        )}
        <button className={s.textButton} onClick={() => inspect({ ...detail, mode: "raw" })}>
          Original record
        </button>
      </div>
      {error && (
        <p role="alert" className={s.inlineError}>
          {error}
        </p>
      )}
      <div className={s.commandOutcome}>
        <span
          className={
            command.exitCode === undefined ? s.muted : command.exitCode === 0 ? s.success : s.danger
          }
        >
          {command.exitCode === 0 ? "✓ " : command.exitCode !== undefined ? "× " : ""}
          {command.state}
        </span>
        {command.pid && <span className={s.muted}>PID {command.pid}</span>}
        <span className={s.grow} />
        <span>{command.startedAt && duration(command.startedAt, command.endedAt)}</span>
      </div>
    </section>
  );
}
