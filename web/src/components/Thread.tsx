import { useEffect, useRef, useState } from "react";
import type { CrewMember } from "../../../server/shared";
import { colorFor } from "../crewColors";
import type { RunView, StreamState } from "../runState";
import { Icon, Spinner } from "./Icon";
import { elapsed } from "./Sidebar";

const PHASE_TEXT: Record<string, string> = {
  starting: "Assembling the crew",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  fixing: "Fixing review notes",
};

export function Thread({ run, crew, onShowChanges }: { run: RunView; crew: CrewMember[]; onShowChanges: () => void }) {
  const running = run.status === "running";
  const [now, setNow] = useState(Date.now());
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // Follow the conversation while the crew works.
  useEffect(() => {
    if (running) end.current?.scrollIntoView({ block: "end" });
  }, [running, run.streams.length, run.tasks, run.reviews.length]);

  const name = (id?: string) => crew.find((m) => m.id === id)?.name ?? "Agent";
  const took = run.startedAt ? elapsed((run.endedAt ?? now) - run.startedAt) : "";

  return (
    <div className="thread">
      <div className="msg-user">
        <p>{run.prompt}</p>
      </div>

      <div className="work-head">
        {running ? (
          <>
            <Spinner size={12} /> {PHASE_TEXT[run.phase] ?? "Working"} · {took}
          </>
        ) : (
          <>Worked for {took}</>
        )}
      </div>

      {run.plan && (
        <div className="msg-agent">
          {run.plan.summary && <p>{run.plan.summary}</p>}
          <ul className="checklist">
            {run.tasks.map((t) => (
              <li key={t.id} className={`check s-${t.status}`} style={{ ["--agent" as string]: colorFor(crew, t.memberId) }}>
                <span className="check-mark" aria-label={t.status}>
                  {t.status === "done" ? <Icon name="check" size={12} /> : t.status === "failed" ? <Icon name="x" size={12} /> : null}
                </span>
                <span>
                  {t.fix && <span className="fix-tag">Fix</span>}
                  {t.title}
                  <span className="muted">
                    {" "}
                    · {t.memberId ? name(t.memberId) : "queued"}
                    {t.files.length ? ` · ${t.files.join(", ")}` : ""}
                  </span>
                  {t.error && <span className="err-text block-line">{t.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.streams.length > 0 && (
        <div className="tool-lines">
          {run.streams.map((s) => (
            <ToolLine key={s.id} stream={s} name={name(s.memberId)} color={colorFor(crew, s.memberId)} />
          ))}
        </div>
      )}

      {run.reviews.map(({ round, review }) => (
        <div key={round} className="msg-agent">
          <p className="review-line">
            <span className={`review-badge ${review.approved ? "ok" : "warn"}`}>
              {review.approved ? "Approved" : `${review.issues.length} issue${review.issues.length === 1 ? "" : "s"}`}
            </span>
            {review.summary}
          </p>
          {review.issues.length > 0 && (
            <ul className="issues">
              {review.issues.map((i, k) => (
                <li key={k}>
                  {i.file && <code>{i.file}</code>} {i.problem}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {run.status === "done" && (
        <div className="msg-agent">
          <p>Done. {run.changed.length} file{run.changed.length === 1 ? "" : "s"} changed.</p>
          {run.diff && run.diff.length > 0 && (
            <button className="changes-card" onClick={onShowChanges}>
              <Icon name="file" size={14} />
              <span>Changes</span>
              <span className="muted truncate">{run.diff.map((d) => d.path).join(", ")}</span>
              <span className="plus">+{run.diff.reduce((n, d) => n + d.additions, 0)}</span>
              <span className="minus">−{run.diff.reduce((n, d) => n + d.deletions, 0)}</span>
              <Icon name="chevron" size={13} />
            </button>
          )}
        </div>
      )}
      {run.status === "error" && (
        <div className="msg-agent" role="alert">
          <p className={run.error === "Cancelled" ? "muted" : "err-text"}>
            {run.error === "Cancelled" ? "You stopped the crew." : `The crew couldn't finish: ${run.error}`}
          </p>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function ToolLine({ stream, name, color }: { stream: StreamState; name: string; color: string }) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (stream.status === "error") setOpen(true);
  }, [stream.status]);

  useEffect(() => {
    const el = body.current;
    if (el && stream.status === "live") el.scrollTop = el.scrollHeight;
  }, [stream.text, stream.status, open]);

  return (
    <div className={`tool-line st-${stream.status}`} style={{ ["--agent" as string]: color }}>
      <button className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        {stream.status === "live" ? <Spinner size={12} /> : <Icon name="terminal" size={14} />}
        <span className="tool-who">{name}</span>
        <span className="tool-what truncate">{stream.title}</span>
        <span className="tool-meta">
          {stream.status === "live" ? "" : stream.status === "error" ? "failed" : `${stream.text.length.toLocaleString()} chars`}
        </span>
        <Icon name={open ? "chevronDown" : "chevron"} size={13} />
      </button>
      {open && (
        <pre ref={body} className="tool-body">
          {stream.text || (stream.status === "live" ? "Thinking…" : "")}
          {stream.error && <span className="err-text">{`\n${stream.error}`}</span>}
        </pre>
      )}
    </div>
  );
}
