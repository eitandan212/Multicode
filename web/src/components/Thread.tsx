import { useEffect, useRef, useState } from "react";
import type { ConnectionView, CrewMember, FileDiff } from "../../../server/shared";
import { ProviderLogo } from "./ProviderLogo";
import { colorFor } from "../crewColors";
import type { RunView, StreamState } from "../runState";
import { Icon, Pulse } from "./Icon";
import { elapsed } from "./Sidebar";

const PHASE_TEXT: Record<string, string> = {
  starting: "Assembling the crew",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  fixing: "Fixing review notes",
};

interface ThreadProps {
  run: RunView;
  crew: CrewMember[];
  connections: ConnectionView[];
  undo: { can: boolean; undoneAt?: number };
  onShowChanges: () => void;
  onUndo: (force: boolean) => Promise<{ conflicts: string[]; skipped: string[] }>;
}

export function Thread({ run, crew, connections, undo, onShowChanges, onUndo }: ThreadProps) {
  const running = run.status === "running";
  const [now, setNow] = useState(Date.now());
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // Follow the conversation while the crew works, and once more to land on the result.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running) end.current?.scrollIntoView({ block: "end" });
  }, [running, run.streams.length, run.tasks, run.reviews.length]);
  useEffect(() => {
    if (wasRunning.current && !running) {
      // Wait a frame so the final card has its height before scrolling to it.
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
    }
    wasRunning.current = running;
  }, [running, run.diff]);

  const name = (id?: string) => crew.find((m) => m.id === id)?.name ?? "Agent";
  const logo = (id?: string) => {
    const m = crew.find((x) => x.id === id);
    const c = m && connections.find((x) => x.id === m.connectionId);
    return c ? <ProviderLogo kind={c.kind} baseUrl={c.baseUrl} model={m.model || c.defaultModel} size={14} /> : null;
  };
  const took = run.startedAt ? elapsed((run.endedAt ?? now) - run.startedAt) : "";

  return (
    <div className="thread">
      <div className="msg-user enter">
        <p>{run.prompt}</p>
      </div>

      <div className="work-head enter">
        {running ? (
          <>
            <Pulse /> <span className="shiny">{PHASE_TEXT[run.phase] ?? "Working"}</span> <span>· {took}</span>
          </>
        ) : (
          <>Worked for {took}</>
        )}
      </div>

      {run.context && (run.context.skills.length > 0 || run.context.plugins.length > 0) && (
        <div className="context-row enter">
          {run.context.plugins.map((p) => (
            <span key={p} className="ctx-chip plugin" title="Plugin">
              <Icon name="puzzle" size={12} /> {p}
            </span>
          ))}
          {run.context.skills.map((s) => (
            <span key={s} className="ctx-chip" title="Skill">
              <Icon name="book" size={12} /> {s}
            </span>
          ))}
        </div>
      )}

      {run.plan && (
        <div className="msg-agent enter">
          {run.plan.summary && <p>{run.plan.summary}</p>}
          <ul className="checklist">
            {run.tasks.map((t) => (
              <li key={t.id} className={`check enter s-${t.status}`} style={{ ["--agent" as string]: colorFor(crew, t.memberId) }}>
                <span className="check-mark" aria-label={t.status}>
                  {t.status === "done" ? <Icon name="check" size={12} /> : t.status === "failed" ? <Icon name="x" size={12} /> : null}
                </span>
                <span>
                  {t.fix && <span className="fix-tag">{t.id.endsWith("-retry") ? "Retry" : "Fix"}</span>}
                  <span className={t.status === "running" ? "shiny" : undefined}>{t.title}</span>
                  <span className="muted">
                    {" "}
                    · {t.memberId ? name(t.memberId) : "next free agent"}
                    {t.files.length ? ` · ${t.files.join(", ")}` : ""}
                  </span>
                  {t.why && <span className="why">{t.why}</span>}
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
            <ToolLine key={s.id} stream={s} name={name(s.memberId)} logo={logo(s.memberId)} color={colorFor(crew, s.memberId)} />
          ))}
        </div>
      )}

      {run.reviews.map(({ round, review }) => (
        <div key={round} className="msg-agent enter">
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
        <div className="msg-agent enter">
          <p>Done. {run.changed.length === 0 ? "No files changed." : "The crew finished and reviewed the work."}</p>
          {run.diff && run.diff.length > 0 && <EditedCard files={run.diff} undo={undo} onReview={onShowChanges} onUndo={onUndo} />}
        </div>
      )}
      {run.status === "error" && (
        <div className="msg-agent enter" role="alert">
          <p className={run.error === "Cancelled" ? "muted" : "err-text"}>
            {run.error === "Cancelled" ? "You stopped the crew." : `The crew couldn't finish: ${run.error}`}
          </p>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function ToolLine({ stream, name, logo, color }: { stream: StreamState; name: string; logo: React.ReactNode; color: string }) {
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
    <div className={`tool-line enter st-${stream.status}`} style={{ ["--agent" as string]: color }}>
      <button className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        {stream.status === "live" ? <Pulse /> : <Icon name="terminal" size={14} />}
        {logo}
        <span className="tool-who">{name}</span>
        <span className={`tool-what truncate ${stream.status === "live" ? "shiny" : ""}`}>{stream.title}</span>
        <span className="tool-meta">
          {stream.status === "live" ? <span className="ellipsis" aria-label="working"><i /><i /><i /></span> : stream.status === "error" ? "failed" : `${stream.text.length.toLocaleString()} chars`}
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

const SHOWN_FILES = 3;

/** "Edited N files" summary with per-file line counts. */
function EditedCard({
  files,
  undo,
  onReview,
  onUndo,
}: {
  files: FileDiff[];
  undo: ThreadProps["undo"];
  onReview: () => void;
  onUndo: ThreadProps["onUndo"];
}) {
  const [all, setAll] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; conflicts?: string[]; error?: string }>({});
  const runUndo = async (force: boolean) => {
    setState({ busy: true });
    try {
      const r = await onUndo(force);
      setState(r.conflicts.length ? { conflicts: r.conflicts } : {});
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const shown = all ? files : files.slice(0, SHOWN_FILES);
  return (
    <div className="edited">
      <div className="edited-head">
        <span className="edited-icon" aria-hidden>
          <Icon name="file" size={15} />
        </span>
        <span className="edited-title">
          <b>
            Edited {files.length} file{files.length === 1 ? "" : "s"}
          </b>
          <span>
            <span className="plus">+{adds}</span> <span className="minus">−{dels}</span>
          </span>
        </span>
        {undo.undoneAt ? (
          <span className="muted small">Undone</span>
        ) : (
          undo.can && (
            <button className="btn small ghost" onClick={() => runUndo(false)} disabled={state.busy}>
              <Icon name="undo" size={13} /> Undo
            </button>
          )
        )}
        <button className="btn small" onClick={onReview}>
          Review
        </button>
      </div>
      {state.conflicts && (
        <div className="edited-warn" role="alert">
          <span>
            {state.conflicts.join(", ")} changed after this thread. Undo would overwrite those edits.
          </span>
          <button className="btn small danger" onClick={() => runUndo(true)}>
            Undo anyway
          </button>
        </div>
      )}
      {state.error && <p className="err-text small edited-warn">{state.error}</p>}
      <ul className="edited-files">
        {shown.map((f) => (
          <li key={f.path}>
            <span className="truncate">{f.path}</span>
            <span className="plus">+{f.additions}</span>
            <span className="minus">−{f.deletions}</span>
          </li>
        ))}
      </ul>
      {files.length > SHOWN_FILES && (
        <button className="edited-more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show fewer files" : `Show ${files.length - SHOWN_FILES} more file${files.length - SHOWN_FILES === 1 ? "" : "s"}`}
          <Icon name={all ? "chevronDown" : "chevron"} size={12} />
        </button>
      )}
    </div>
  );
}
