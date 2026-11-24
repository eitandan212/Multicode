import { useEffect, useRef, useState } from "react";
import type { CrewMember } from "../../../server/shared";
import { colorFor } from "../crewColors";
import type { RunView, StreamState } from "../runState";

interface Props {
  run: RunView | null;
  crew: CrewMember[];
  canRun: boolean;
  project: string;
  pastRuns: { id: string; prompt: string }[];
  onPickRun: (id: string) => void;
  onSubmit: (prompt: string) => Promise<void>;
  onCancel: () => void;
}

const PHASE_TEXT: Record<string, string> = {
  starting: "Assembling the crew",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  fixing: "Fixing review notes",
  done: "Done",
  stopped: "Stopped",
};

const STARTERS = [
  "A pomodoro timer with a calm design and keyboard shortcuts",
  "A landing page for a neighbourhood bakery with today's menu",
  "A 2-player tic-tac-toe with score tracking and animations",
];

export function Mission({ run, crew, canRun, project, pastRuns, onPickRun, onSubmit, onCancel }: Props) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const running = run?.status === "running";

  const submit = async () => {
    if (!prompt.trim() || running) return;
    setSending(true);
    setError("");
    try {
      await onSubmit(prompt.trim());
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const name = (id?: string) => crew.find((m) => m.id === id)?.name ?? "Agent";

  return (
    <section className="mission" aria-label="Mission">
      <div className="mission-scroll">
        {pastRuns.length > 1 && (
          <nav className="history" aria-label="Earlier requests">
            {pastRuns.map((r) => (
              <button key={r.id} className={`history-chip ${r.id === run?.id ? "is-active" : ""}`} onClick={() => onPickRun(r.id)} title={r.prompt}>
                {r.prompt}
              </button>
            ))}
          </nav>
        )}

        {!run && (
          <div className="mission-empty">
            <h1>What should the crew build in {project}?</h1>
            <p className="muted">Describe it like you would to a team. They plan it, build it in parallel and review each other's work.</p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} className="starter" onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {run && (
          <article className="run">
            <header className="run-head">
              <p className="run-prompt">{run.prompt}</p>
              <div className={`phase phase-${run.status}`}>
                {running && <span className="pulse" aria-hidden />}
                {PHASE_TEXT[run.phase] ?? run.phase}
              </div>
            </header>

            {run.plan && (
              <section className="block">
                <h3>Plan</h3>
                {run.plan.summary && <p className="plan-summary">{run.plan.summary}</p>}
                <ol className="tasks">
                  {run.tasks.map((t) => (
                    <li key={t.id} className={`task s-${t.status}`} style={{ ["--agent" as string]: colorFor(crew, t.memberId) }}>
                      <span className="task-mark" aria-label={t.status} />
                      <div>
                        <span className="task-title">
                          {t.fix && <span className="tag">fix</span>}
                          {t.title}
                        </span>
                        <span className="muted small">
                          {t.memberId ? name(t.memberId) : "waiting"}
                          {t.files.length ? ` · ${t.files.join(", ")}` : ""}
                        </span>
                        {t.error && <span className="err-text small">{t.error}</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {run.streams.length > 0 && (
              <section className="block">
                <h3>Crew activity</h3>
                <div className="lanes">
                  {run.streams.map((s) => (
                    <Lane key={s.id} stream={s} name={name(s.memberId)} color={colorFor(crew, s.memberId)} />
                  ))}
                </div>
              </section>
            )}

            {run.reviews.map(({ round, review }) => (
              <section key={round} className={`block review ${review.approved ? "is-approved" : "has-issues"}`}>
                <h3>{review.approved ? `Review ${round}: approved` : `Review ${round}: ${review.issues.length} issue${review.issues.length === 1 ? "" : "s"}`}</h3>
                {review.summary && <p>{review.summary}</p>}
                {review.issues.length > 0 && (
                  <ul className="issues">
                    {review.issues.map((i, k) => (
                      <li key={k}>
                        {i.file && <code>{i.file}</code>} {i.problem}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}

            {run.status === "done" && (
              <section className="block outcome ok">
                <h3>Finished · {run.changed.length} file{run.changed.length === 1 ? "" : "s"} changed</h3>
                <p className="muted small">Open the preview to try it, or ask for the next change below.</p>
              </section>
            )}
            {run.status === "error" && (
              <section className="block outcome bad" role="alert">
                <h3>{run.error === "Cancelled" ? "You stopped the crew" : "The crew couldn't finish"}</h3>
                {run.error !== "Cancelled" && <p>{run.error}</p>}
              </section>
            )}
          </article>
        )}
      </div>

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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={canRun ? (run ? "Ask for a change…" : "Describe what to build…") : "Connect an AI to start"}
          disabled={!canRun}
          rows={3}
          maxLength={20000}
          aria-label="Request for the crew"
        />
        <div className="composer-bar">
          <span className="muted small">{error ? <span className="err-text">{error}</span> : "Ctrl + Enter to send"}</span>
          {running ? (
            <button type="button" className="btn danger" onClick={onCancel}>
              Stop crew
            </button>
          ) : (
            <button className="btn primary" disabled={!canRun || !prompt.trim() || sending}>
              {sending ? "Starting…" : "Send to crew"}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function Lane({ stream, name, color }: { stream: StreamState; name: string; color: string }) {
  const [open, setOpen] = useState(stream.status === "live");
  const body = useRef<HTMLPreElement>(null);

  // Open while streaming, fold away when finished so the next lanes stay in view. Errors stay open.
  useEffect(() => {
    setOpen(stream.status !== "ok");
  }, [stream.status]);

  useEffect(() => {
    const el = body.current;
    if (el && stream.status === "live") el.scrollTop = el.scrollHeight;
  }, [stream.text, stream.status]);

  return (
    <div className={`lane st-${stream.status}`} style={{ ["--agent" as string]: color }}>
      <button className="lane-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="lane-name">{name}</span>
        <span className="lane-title">{stream.title}</span>
        <span className="lane-status small">
          {stream.status === "live" ? "streaming" : stream.status === "ok" ? `${stream.text.length.toLocaleString()} chars` : "failed"}
        </span>
      </button>
      {open && (
        <pre ref={body} className="lane-body">
          {stream.text || (stream.status === "live" ? "Thinking…" : "")}
          {stream.error && <span className="err-text">{`\n${stream.error}`}</span>}
        </pre>
      )}
    </div>
  );
}
