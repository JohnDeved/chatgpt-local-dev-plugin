import { useEffect, useState } from "react";
import { FileDiff, Minus, Plus } from "lucide-react";
import type { CallItem } from "../shared/contracts.ts";
import { readEditDiff, type EditDiff as EditRecord } from "../shared/edit-diff.ts";
import type { UiActions } from "./CommandPanel.tsx";
import s from "./app.module.css";

export function EditDiff({
  call,
  bridge,
  inspect,
}: Pick<UiActions, "bridge" | "inspect"> & { call: CallItem }) {
  const [record, setRecord] = useState<EditRecord>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [allLines, setAllLines] = useState(false);
  const request = {
    runtimeId: call.runtimeId,
    operationId: call.operationId,
    mode: "raw" as const,
  };
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError("");
    void bridge
      .details(request)
      .then((detail) => {
        if (!stale) {
          setRecord(readEditDiff(detail.text, call.operationId));
          setLoading(false);
        }
      })
      .catch((issue: unknown) => {
        if (!stale) {
          setError(String(issue));
          setLoading(false);
        }
      });
    return () => {
      stale = true;
    };
  }, [bridge, call.id, call.state]);
  if (loading) return <p className={s.quiet}>Reading recorded edit details…</p>;
  if (error) return <p className={s.inlineError}>Could not load the edit record: {error}</p>;
  if (!record)
    return (
      <p className={s.quiet}>
        No captured before/after text is available.{" "}
        <button className={s.textButton} onClick={() => inspect(request)}>
          Inspect original records
        </button>
      </p>
    );
  const added = record.lines.filter((line) => line.kind === "add").length;
  const removed = record.lines.filter((line) => line.kind === "remove").length;
  const visible = allLines ? record.lines : record.lines.slice(0, 200);
  return (
    <section className={s.editDiff} aria-label="Edit diff">
      <header>
        <FileDiff size={15} />
        <strong>{record.title}</strong>
        <span className={s.grow} />
        {record.lines.length > 0 && (
          <span className={s.diffCounts}>
            <span>
              <Plus size={11} />
              {added}
            </span>
            <span>
              <Minus size={11} />
              {removed}
            </span>
          </span>
        )}
      </header>
      <p className={s.diffPath}>{record.path}</p>
      <p className={s.diffExplanation}>{record.explanation}</p>
      {record.lines.length > 0 ? (
        <div className={s.diffCode} tabIndex={0} aria-label="Recorded edit comparison">
          {visible.map((line, index) => (
            <div key={index} className={s.diffLine} data-kind={line.kind}>
              <span
                className={s.diffLineNumber}
                aria-label={line.before ? `Before line ${line.before}` : undefined}
              >
                {line.before ?? ""}
              </span>
              <span
                className={s.diffLineNumber}
                aria-label={line.after ? `After line ${line.after}` : undefined}
              >
                {line.after ?? ""}
              </span>
              <span aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
              </span>
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className={s.diffTextBlocks}>
          {record.before !== undefined && (
            <div>
              <h5>Find pattern</h5>
              <pre>{record.before}</pre>
            </div>
          )}
          <div>
            <h5>{record.before !== undefined ? "Replacement" : "Proposed contents"}</h5>
            <pre>{record.after}</pre>
          </div>
        </div>
      )}
      <footer>
        {record.lines.length > 200 && (
          <button className={s.textButton} onClick={() => setAllLines(!allLines)}>
            {allLines ? "Show first 200 lines" : `Show all ${record.lines.length} lines`}
          </button>
        )}
        <span className={s.grow} />
        <button className={s.textButton} onClick={() => inspect(request)}>
          Original records
        </button>
      </footer>
    </section>
  );
}
