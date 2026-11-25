import { useState } from "react";
import type { CrewMember, RunMode, Settings } from "../../../server/shared";
import { colorFor } from "../crewColors";
import { Icon } from "./Icon";

interface Props {
  crew: CrewMember[];
  settings: Settings;
  project: string;
  canRun: boolean;
  running: boolean;
  /** Finished / total tasks of the running thread, for the progress bar. */
  progress?: { done: number; total: number };
  placeholder: string;
  onSubmit: (prompt: string, mode: RunMode) => Promise<void>;
  onOpenSafety: () => void;
  onStop: () => void;
  onOpenCrew: () => void;
  onReviewRounds: (n: number) => void;
}

export function Composer(p: Props) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<RunMode>("build");
  const [error, setError] = useState("");

  const submit = async () => {
    if (!prompt.trim() || p.running || !p.canRun) return;
    setSending(true);
    setError("");
    try {
      await p.onSubmit(prompt.trim(), mode);
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const reviews = p.settings.maxReviewRounds;

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={p.placeholder}
          disabled={!p.canRun}
          rows={2}
          maxLength={20000}
          aria-label="Message the crew"
        />
        <div className="composer-bar">
          <div
            className="seg mini mode-switch"
            role="radiogroup"
            aria-label="What the crew should do"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === "build"}
              className={mode === "build" ? "is-active" : ""}
              onClick={() => setMode("build")}
            >
              Build
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "design"}
              className={mode === "design" ? "is-active" : ""}
              onClick={() => setMode("design")}
              title="Several models each design their own version; you pick one"
            >
              <Icon name="palette" size={13} /> MultiDesign
            </button>
          </div>
          <button
            type="button"
            className="chip crew-chip push-right"
            onClick={p.onOpenCrew}
            title="Edit crew"
          >
            <span className="crew-dots" aria-hidden>
              {p.crew.slice(0, 4).map((m) => (
                <span
                  key={m.id}
                  style={{ background: colorFor(p.crew, m.id) }}
                />
              ))}
            </span>
            {p.crew.length === 0
              ? "No crew yet"
              : p.crew.length === 1
                ? p.crew[0]!.name
                : `Crew of ${p.crew.length}`}
          </button>
          {p.running ? (
            <button
              type="button"
              className="send stop"
              onClick={p.onStop}
              aria-label="Stop the crew"
              title="Stop"
            >
              <Icon name="stop" size={13} />
            </button>
          ) : (
            <button
              className="send"
              disabled={!p.canRun || !prompt.trim() || sending}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </form>
      <div className="composer-meta">
        <button
          type="button"
          className="meta-item meta-btn"
          onClick={p.onOpenSafety}
          title="Savings & safety"
        >
          <Icon name="shield" size={13} />
          {p.settings.safety === "sandbox"
            ? "Sandbox"
            : p.settings.safety === "readonly"
              ? "Plan only"
              : "Direct + undo"}
          {p.settings.economy && <span className="free-tag">Economy</span>}
        </button>
        {p.running && p.progress && p.progress.total > 0 && (
          <span
            className="meta-item progress"
            aria-label={`${p.progress.done} of ${p.progress.total} tasks done`}
          >
            <span className="progress-track">
              <span
                className="progress-fill"
                style={{
                  width: `${(p.progress.done / p.progress.total) * 100}%`,
                }}
              />
            </span>
            {p.progress.done}/{p.progress.total}
          </span>
        )}
        {error ? (
          <span className="err-text">{error}</span>
        ) : (
          <label className="meta-item meta-select">
            <Icon name="shield" size={13} />
            <select
              value={reviews}
              onChange={(e) => p.onReviewRounds(Number(e.target.value))}
              aria-label="Review rounds"
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "No review" : `Review × ${n}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
