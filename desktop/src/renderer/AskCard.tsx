import { useEffect, useState } from "react";
import { ArrowRight, Clock3, MessageCircleQuestion, Sparkles } from "lucide-react";
import type { ActionResult, AskItem, DesktopBridge } from "../shared/contracts.ts";
import s from "./app.module.css";

function remaining(expiresAt?: string): number | undefined {
  if (!expiresAt) return;
  return Math.max(0, Date.parse(expiresAt) - Date.now());
}
function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AskCard({
  ask,
  runtimeId,
  bridge,
  autoApprove,
  paused,
  notify,
}: {
  ask: AskItem;
  runtimeId: string;
  bridge: DesktopBridge;
  autoApprove: boolean;
  paused: boolean;
  notify: (result: ActionResult) => void;
}) {
  const [left, setLeft] = useState(() => remaining(ask.expiresAt));
  const [sending, setSending] = useState(false);
  const [other, setOther] = useState("");
  useEffect(() => {
    setLeft(remaining(ask.expiresAt));
    if (!ask.expiresAt) return;
    const timer = setInterval(() => setLeft(remaining(ask.expiresAt)), 250);
    return () => clearInterval(timer);
  }, [ask.id, ask.expiresAt]);

  const answer = async (value: { optionId?: string; text?: string }) => {
    if (sending) return;
    setSending(true);
    try {
      const result = await bridge.act({ type: "answerAsk", runtimeId, askId: ask.id, ...value });
      notify(result);
      if (!result.ok) setSending(false);
    } catch (error) {
      notify({ ok: false, message: String(error) });
      setSending(false);
    }
  };

  const recommended = ask.options.find((option) => option.id === ask.recommended);
  const countdown = autoApprove && !paused && left !== undefined;
  return (
    <section className={s.askCard} aria-label="Question from ChatGPT" data-auto-answer={countdown}>
      <header className={s.askHeader}>
        <span className={s.askGlyph}>
          <MessageCircleQuestion size={18} />
        </span>
        <div>
          <small>{ask.header ?? "ChatGPT is asking"}</small>
          <h2>{ask.question}</h2>
        </div>
        <span className={s.grow} />
        <div className={s.askTimer} aria-live="polite">
          {countdown ? (
            <>
              <Clock3 size={13} />
              <span>
                Recommended in <strong>{clock(left!)}</strong>
              </span>
            </>
          ) : paused && autoApprove ? (
            <>
              <Clock3 size={13} />
              <span>Auto-answer paused</span>
            </>
          ) : (
            <span>Waiting for your answer</span>
          )}
        </div>
      </header>
      <div className={s.askOptions} role="group" aria-label="Answer choices">
        {ask.options.map((option) => (
          <button
            key={option.id}
            className={s.askOption}
            data-recommended={option.id === ask.recommended}
            disabled={sending}
            onClick={() => void answer({ optionId: option.id })}
          >
            <span>
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
            {option.id === ask.recommended && (
              <span className={s.recommendedBadge}>
                <Sparkles size={11} />
                Recommended
              </span>
            )}
            <ArrowRight size={14} />
          </button>
        ))}
      </div>
      {ask.allowOther && (
        <form
          className={s.askOther}
          onSubmit={(event) => {
            event.preventDefault();
            if (other.trim()) void answer({ text: other.trim() });
          }}
        >
          <input
            aria-label="Other answer"
            placeholder="Or type another answer…"
            maxLength={2000}
            value={other}
            onChange={(event) => setOther(event.target.value)}
          />
          <button className={s.secondary} disabled={sending || !other.trim()}>
            Send answer
          </button>
        </form>
      )}
      {countdown && (
        <div className={s.askAutoNote}>
          <span>
            <Sparkles size={12} />
            No response will continue with <strong>{recommended?.label}</strong>.
          </span>
          <span>You can override it anytime before the timer ends.</span>
        </div>
      )}
    </section>
  );
}
