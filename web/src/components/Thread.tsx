import { Markdown } from "./Markdown";
import { PromptText } from "./PromptText";
import type { RunSummary } from "../../../server/shared";
import { useEffect, useRef, useState } from "react";
import { SignInDialog } from "./AgentSetup";
import type {
  ConnectionView,
  CrewMember,
  FileDiff,
} from "../../../server/shared";
import { LogoLoader } from "./Logo";
import { useCountUp } from "../motion";
import { ProviderLogo } from "./ProviderLogo";
import { colorFor } from "../crewColors";
import type { AskView, RunView, StreamState } from "../runState";
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
  /** Earlier turns of this thread, oldest first. */
  earlier?: RunSummary[];
  /** The project, for attached pictures. */
  project?: string;
  crew: CrewMember[];
  connections: ConnectionView[];
  undo: { can: boolean; undoneAt?: number };
  /** Still waiting for apply/discard, or what you decided. */
  review: {
    pending?: "sandbox" | "design";
    resolution?: "applied" | "discarded";
  };
  onShowChanges: () => void;
  onUndo: (
    force: boolean,
  ) => Promise<{ conflicts: string[]; skipped: string[] }>;
  onApply: (
    variant?: string,
    force?: boolean,
  ) => Promise<{ conflicts: string[] }>;
  onDiscard: () => Promise<void>;
  /** Put a prompt back in the composer to edit and send again. */
  onReuse?: (prompt: string) => void;
  /** Your answer to an action waiting for approval. */
  onAnswer?: (id: string, allow: boolean, always?: boolean) => Promise<void>;
}

/** True when the thread is scrolled (nearly) to the bottom, so following new output won't yank the reader. */
function nearBottom(el: Element | null): boolean {
  const s = el?.closest(".scroll");
  return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 160;
}

const fmt = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

export function Thread({
  run,
  earlier = [],
  project,
  crew,
  connections,
  undo,
  review,
  onShowChanges,
  onUndo,
  onApply,
  onDiscard,
  onReuse,
  onAnswer,
}: ThreadProps) {
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
    // Follow only while you're at the bottom; reading further up stays where you are.
    if (running && nearBottom(end.current)) end.current?.scrollIntoView({ block: "end" });
  }, [running, run.streams.length, run.tasks, run.reviews.length]);
  useEffect(() => {
    if (wasRunning.current && !running) {
      // Wait a frame so the final card has its height before scrolling to it.
      requestAnimationFrame(() => {
        if (nearBottom(end.current)) end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      });
    }
    wasRunning.current = running;
  }, [running, run.diff]);

  /** Who an id is: a crew member, an Auto/single-model member, the manager or the fallback. */
  const who = (
    id?: string,
  ):
    | {
        name: string;
        kind?: ConnectionView["kind"];
        conn?: ConnectionView;
        model?: string;
      }
    | undefined => {
    if (!id) return undefined;
    const m = crew.find((x) => x.id === id);
    if (m) {
      const c = connections.find((x) => x.id === m.connectionId);
      return {
        name: m.name,
        kind: c?.kind,
        conn: c,
        model: m.model || c?.defaultModel,
      };
    }
    const mgr = run.context?.manager;
    if (mgr && id === mgr.id) {
      const c = connections.find((x) => x.id === mgr.connectionId);
      return {
        name: mgr.name,
        kind: c?.kind ?? "opencode-cli",
        conn: c,
        model: mgr.model,
      };
    }
    if (id === run.context?.fallback?.id)
      return { name: run.context!.fallback!.name, kind: "opencode-cli" };
    const auto = /^(?:auto|solo)-(.+)$/.exec(id);
    const c = auto ? connections.find((x) => x.id === auto[1]) : undefined;
    return c
      ? { name: c.label, kind: c.kind, conn: c, model: c.defaultModel }
      : undefined;
  };
  const name = (id?: string) => who(id)?.name ?? "Agent";
  const logo = (id?: string) => {
    const w = who(id);
    return w?.kind ? (
      <ProviderLogo
        kind={w.kind}
        acp={w.conn?.acp}
        baseUrl={w.conn?.baseUrl}
        model={w.model}
        size={14}
      />
    ) : null;
  };
  const took = run.startedAt
    ? elapsed((run.endedAt ?? now) - run.startedAt)
    : "";

  return (
    <div className="thread">
      {earlier.map((t) => (
        <div key={t.id} className="turn-earlier">
          <div className="msg-user-wrap">
            <div className="msg-user">
              <PromptText text={t.prompt} project={project} />
            </div>
          </div>
          <div className={`msg-agent ${t.status === "error" ? "is-failed" : ""}`}>
            <Markdown
              text={t.reply ?? (t.status === "cancelled" ? "Stopped." : t.status === "error" ? "This turn failed." : "Done.")}
            />
            {t.changedFiles && t.changedFiles.length > 0 && (
              <p className="turn-files muted small">
                <Icon name="file" size={12} /> {t.changedFiles.length} file{t.changedFiles.length === 1 ? "" : "s"} changed:{" "}
                {t.changedFiles.slice(0, 6).join(", ")}
                {t.changedFiles.length > 6 ? "…" : ""}
              </p>
            )}
          </div>
        </div>
      ))}
      <div className="msg-user-wrap enter">
        <div className="msg-user">
          <PromptText text={run.prompt} project={project} />
        </div>
        <div className="msg-actions">
          <CopyButton text={run.prompt} />
          {onReuse && (
            <button className="icon-btn small-btn" onClick={() => onReuse(run.prompt)} title="Edit and send again" aria-label="Edit and send again">
              <Icon name="compose" size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="work-head enter">
        {running ? (
          <>
            <LogoLoader />{" "}
            <span className="shiny">{PHASE_TEXT[run.phase] ?? "Working"}</span>{" "}
            <span>· {took}</span>
          </>
        ) : (
          <>Worked for {took}</>
        )}
        {run.usage.input + run.usage.output > 0 && (
          <span
            className="usage"
            title={`${run.usage.input.toLocaleString()} new in · ${run.usage.output.toLocaleString()} out${run.usage.cached ? ` · ${run.usage.cached.toLocaleString()} re-read from cache (cheap, not counted)` : ""}`}
          >
            <CountUp value={run.usage.input + run.usage.output} format={fmt} />{" "}
            tokens
            {run.usage.freeTokens > 0 && (
              <span className="free-tag">{fmt(run.usage.freeTokens)} free</span>
            )}
            {run.usage.costUsd > 0 && (
              <span>
                · ${run.usage.costUsd.toFixed(run.usage.costUsd < 0.1 ? 3 : 2)}
              </span>
            )}
          </span>
        )}
      </div>

      {run.limits.map((l, i) => (
        <div key={i} className="notice enter">
          <Icon name="spark" size={14} />
          <span>
            <b>{name(l.memberId)}</b> reached its usage limit.{" "}
            <b>{l.fallback}</b> took over so the work keeps going, until{" "}
            {new Date(l.until).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </span>
        </div>
      ))}
      {run.protectedHits.length > 0 && (
        <div className="notice warn enter">
          <Icon name="shield" size={14} />
          <span>
            Blocked changes to protected files and restored them:{" "}
            {run.protectedHits.map((p) => (
              <code key={p}>{p}</code>
            ))}
          </span>
        </div>
      )}

      {run.context && ((run.context.safety && run.context.safety !== "direct") || run.context.economy) && (
        <div className="ctx-badges enter">
          {run.context.safety && run.context.safety !== "direct" && (
            <span className="ctx-badge">
              <Icon name="shield" size={12} /> {run.context.safety === "sandbox" ? "Sandbox" : "Plan only"}
            </span>
          )}
          {run.context.economy && <span className="ctx-badge">Economy</span>}
        </div>
      )}

      {run.plan && (
        <div className="msg-agent enter">
          {run.plan.summary && <Markdown text={run.plan.summary} />}
          <ul className="checklist">
            {run.tasks.map((t) => (
              <li
                key={t.id}
                className={`check enter s-${t.status}`}
                style={{ ["--agent" as string]: colorFor(crew, t.memberId) }}
              >
                <span className="check-mark" aria-label={t.status}>
                  {t.status === "done" ? (
                    <Icon name="check" size={12} />
                  ) : t.status === "failed" ? (
                    <Icon name="x" size={12} />
                  ) : null}
                </span>
                <span>
                  {t.fix && (
                    <span className="fix-tag">
                      {t.id.endsWith("-retry") ? "Retry" : "Fix"}
                    </span>
                  )}
                  <span
                    className={t.status === "running" ? "shiny" : undefined}
                  >
                    {t.title}
                  </span>
                  <span className="muted">
                    {" "}
                    ·{" "}
                    {t.memberId ? (
                      <span className="task-who">
                        {logo(t.memberId)}
                        {name(t.memberId)}
                      </span>
                    ) : (
                      "next free agent"
                    )}
                    {t.files.length ? ` · ${t.files.join(", ")}` : ""}
                  </span>
                  {t.why && <span className="why">{t.why}</span>}
                  {t.error && (
                    <span className="err-text block-line">{t.error}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.streams.length > 0 &&
        (running ? (
        <div className="tool-lines">
          {run.streams.map((s) => (
            <ToolLine
              key={s.id}
              stream={s}
              name={name(s.memberId)}
              logo={logo(s.memberId)}
              color={colorFor(crew, s.memberId)}
            />
          ))}
        </div>
        ) : (
          // Finished: the agents' steps fold into one quiet line; open it to see each one.
          <details className="steps-fold enter">
            <summary>
              <Icon name="chevron" size={12} className="ctx-caret" />
              {run.streams.length} step{run.streams.length === 1 ? "" : "s"}
              {run.context && run.context.plugins.length + run.context.skills.length > 0
                ? ` · ${run.context.plugins.length + run.context.skills.length} tools and skills`
                : ""}
            </summary>
            {run.context && (run.context.plugins.length > 0 || run.context.skills.length > 0) && (
              <div className="context-row">
                {run.context.plugins.map((p) => (
                  <span key={p} className="ctx-chip plugin" title="Plugin">
                    <Icon name="puzzle" size={12} /> {p}
                  </span>
                ))}
                {run.context.skills.map((sk) => (
                  <span key={sk} className="ctx-chip" title="Skill">
                    <Icon name="book" size={12} /> {sk}
                  </span>
                ))}
              </div>
            )}
        <div className="tool-lines">
          {run.streams.map((s) => (
            <ToolLine
              key={s.id}
              stream={s}
              name={name(s.memberId)}
              logo={logo(s.memberId)}
              color={colorFor(crew, s.memberId)}
            />
          ))}
        </div>
          </details>
        ))}

      {run.hookFailures.map((h, i) => (
        <details key={`hook-${i}`} className="check-line enter is-bad">
          <summary>
            <Icon name="x" size={13} />
            <span className="muted small">{h.event} hook failed</span>
            <code>{h.command}</code>
          </summary>
          {h.output && <pre className="check-output">{h.output}</pre>}
        </details>
      ))}
      {run.checks.map((c, i) => (
        <details key={`check-${i}`} className={`check-line enter ${c.ok ? "is-ok" : "is-bad"}`}>
          <summary>
            <Icon name={c.ok ? "check" : "x"} size={13} />
            <code>{c.command}</code>
            <span className="muted small">
              {c.ok ? "passed" : "failed"} · {Math.max(1, Math.round(c.ms / 1000))}s
            </span>
          </summary>
          {c.output && <pre className="check-output">{c.output}</pre>}
        </details>
      ))}
      {run.reviews.map(({ round, review }) => (
        <div key={round} className="msg-agent enter">
          <p className="review-line">
            <span className={`review-badge ${review.approved ? "ok" : "warn"}`}>
              {review.approved
                ? "Approved"
                : `${review.issues.length} issue${review.issues.length === 1 ? "" : "s"}`}
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

      {run.status === "done" && run.variants && (
        <DesignGallery
          run={run}
          name={name}
          logo={logo}
          review={review}
          onApply={onApply}
          onDiscard={onDiscard}
        />
      )}

      {run.status === "done" && !run.variants && (
        <div className="msg-agent enter is-done">
          <div className="done-line">
          <span className="done-mark" aria-hidden>
            <Icon name="check" size={13} />
          </span>
          <Markdown
            text={
              run.context?.safety === "readonly"
                ? run.summary?.trim() || "Here's the plan. Nothing was changed (plan-only mode)."
                : run.changed.length === 0
                  ? run.summary?.trim() || "Done. No files changed."
                  : review.pending === "sandbox"
                    ? "Done in the sandbox. Review the changes, then apply them to your project."
                    : "Done. The crew finished and reviewed the work."
            }
          />
          </div>
          {review.pending === "sandbox" && (
            <ApplyBar
              onApply={(force) => onApply(undefined, force)}
              onDiscard={onDiscard}
            />
          )}
          {review.resolution === "discarded" && (
            <p className="muted small">You discarded these changes.</p>
          )}
          {run.diff && run.diff.length > 0 && (
            <EditedCard
              files={run.diff}
              undo={undo}
              onReview={onShowChanges}
              onUndo={onUndo}
            />
          )}
        </div>
      )}
      {run.status === "error" && (
        <div className="msg-agent enter" role="alert">
          <p className={run.error === "Cancelled" ? "muted" : "err-text"}>
            {run.error === "Cancelled"
              ? "You stopped the crew."
              : `The crew couldn't finish: ${run.error}`}
          </p>
          <SignInFix error={run.error} />
        </div>
      )}
      {run.answered.length > 0 && (
        <p className="muted small answered-line">
          {(() => {
            const yes = run.answered.filter((a) => a.allow).length;
            const no = run.answered.length - yes;
            return `You approved ${yes}${no ? ` and declined ${no}` : ""} action${run.answered.length === 1 ? "" : "s"} in this thread.`;
          })()}
        </p>
      )}
      {run.asks.length > 0 && onAnswer && (
        <div className="asks" aria-live="polite">
          <ApprovalCard
            key={run.asks[0]!.id}
            ask={run.asks[0]!}
            waiting={run.asks.length}
            who={name(run.asks[0]!.memberId)}
            logo={logo(run.asks[0]!.memberId)}
            onAnswer={onAnswer}
          />
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

/** "Not signed in" errors get the fix right there: a Sign in button, no terminal. */
function SignInFix({ error }: { error?: string }) {
  const [open, setOpen] = useState(false);
  if (!error || !/sign(ed)? in|log in|login/i.test(error)) return null;
  const kind = /codex/i.test(error)
    ? "codex-cli"
    : /antigravity/i.test(error)
      ? "antigravity"
      : /claude/i.test(error)
        ? "claude-cli"
        : null;
  if (!kind) return null;
  return (
    <>
      <button className="btn primary small" onClick={() => setOpen(true)}>
        Sign in to {kind === "codex-cli" ? "Codex" : kind === "antigravity" ? "Antigravity" : "Claude Code"}
      </button>
      {open && <SignInDialog kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}

const ASK_TEXT = {
  edit: { verb: "wants to change", yes: "Allow", all: "Allow all edits", no: "Decline", icon: "pencil" },
  tool: { verb: "wants to use a tool", yes: "Allow", all: "Allow all tools", no: "Decline", icon: "wrench" },
  review: { verb: "already changed this", yes: "Keep", all: "Keep all", no: "Revert", icon: "eye" },
} as const;

/** One action waiting for your yes (as in Claude Code): what, who, the exact change, and answers. */
function ApprovalCard({
  ask,
  waiting,
  who,
  logo,
  onAnswer,
}: {
  ask: AskView;
  waiting: number;
  who: string;
  logo: React.ReactNode;
  onAnswer: (id: string, allow: boolean, always?: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const t = ASK_TEXT[ask.kind];
  const answer = async (allow: boolean, always = false) => {
    setBusy(true);
    try {
      await onAnswer(ask.id, allow, always);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`ask-card enter is-${ask.kind}`} role="alertdialog" aria-label={`${who} ${t.verb}`}>
      <header>
        <Icon name={t.icon} size={15} />
        <span className="ask-who">
          {logo} <strong>{who}</strong> <span className="muted">{t.verb}</span>
        </span>
        {waiting > 1 && <span className="muted small push-right">{waiting} waiting</span>}
      </header>
      <p className="ask-title">{ask.title}</p>
      {ask.files && ask.files.length > 0 && (
        <div className="ask-files">
          {ask.files.map((f) => (
            <code key={f}>{f}</code>
          ))}
        </div>
      )}
      {ask.detail && (
        <details className="ask-detail" open={ask.kind !== "tool"}>
          <summary>{ask.kind === "tool" ? "Details" : "The change"}</summary>
          <pre>
            {ask.detail.split("\n").map((line, i) => (
              <span
                key={i}
                className={
                  /^\+(?!\+\+)/.test(line) ? "add" : /^-(?!--)/.test(line) ? "del" : /^@@/.test(line) ? "hunk" : undefined
                }
              >
                {line || " "}
              </span>
            ))}
          </pre>
        </details>
      )}
      {ask.kind === "review" && (
        <p className="muted small">This agent can't pause before editing, so its change is shown now. Revert puts the files back as they were.</p>
      )}
      <div className="ask-actions">
        <button className="btn primary" disabled={busy} onClick={() => void answer(true)} autoFocus>
          {t.yes}
        </button>
        <button className="btn" disabled={busy} onClick={() => void answer(true, true)} title="For the rest of this thread">
          {t.all}
        </button>
        <button className="btn danger-ghost push-right" disabled={busy} onClick={() => void answer(false)}>
          {t.no}
        </button>
      </div>
    </section>
  );
}

function ToolLine({
  stream,
  name,
  logo,
  color,
}: {
  stream: StreamState;
  name: string;
  logo: React.ReactNode;
  color: string;
}) {
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
    <div
      className={`tool-line enter st-${stream.status}`}
      style={{ ["--agent" as string]: color }}
    >
      <button
        className="tool-row"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {logo ? (
          <span
            className={`tool-logo ${stream.status === "live" ? "is-live" : ""}`}
          >
            {logo}
          </span>
        ) : stream.status === "live" ? (
          <Pulse />
        ) : (
          <Icon name="terminal" size={14} />
        )}
        <span className="tool-who">{name}</span>
        <span
          className={`tool-what truncate ${stream.status === "live" ? "shiny" : ""}`}
        >
          {stream.title}
        </span>
        <span className="tool-meta">
          {stream.status === "live" ? (
            <span className="ellipsis" aria-label="working">
              <i />
              <i />
              <i />
            </span>
          ) : stream.status === "error" ? (
            <span className="err-text">failed</span>
          ) : (
            <Icon name="check" size={13} className="tool-done" />
          )}
        </span>
        <Icon name={open ? "chevronDown" : "chevron"} size={13} />
      </button>
      {open && stream.text && stream.status !== "live" && (
        <div className="tool-body-actions">
          <CopyButton text={stream.text} label="Copy output" />
        </div>
      )}
      {open && (
        <pre ref={body} className="tool-body">
          {stream.text || (stream.status === "live" ? "Thinking…" : "")}
          {stream.error && (
            <span className="err-text">{`\n${stream.error}`}</span>
          )}
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
  const [state, setState] = useState<{
    busy?: boolean;
    conflicts?: string[];
    error?: string;
  }>({});
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
            <span className="plus">+{adds}</span>{" "}
            <span className="minus">−{dels}</span>
          </span>
        </span>
        {undo.undoneAt ? (
          <span className="muted small">Undone</span>
        ) : (
          undo.can && (
            <button
              className="btn small ghost"
              onClick={() => runUndo(false)}
              disabled={state.busy}
            >
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
            {state.conflicts.join(", ")} changed after this thread. Undo would
            overwrite those edits.
          </span>
          <button className="btn small danger" onClick={() => runUndo(true)}>
            Undo anyway
          </button>
        </div>
      )}
      {state.error && (
        <p className="err-text small edited-warn">{state.error}</p>
      )}
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
        <button
          className="edited-more"
          onClick={() => setAll(!all)}
          aria-expanded={all}
        >
          {all
            ? "Show fewer files"
            : `Show ${files.length - SHOWN_FILES} more file${files.length - SHOWN_FILES === 1 ? "" : "s"}`}
          <Icon name={all ? "chevronDown" : "chevron"} size={12} />
        </button>
      )}
    </div>
  );
}

/** Apply / Discard for work done in a sandbox. */
function ApplyBar({
  onApply,
  onDiscard,
}: {
  onApply: (force?: boolean) => Promise<{ conflicts: string[] }>;
  onDiscard: () => Promise<void>;
}) {
  const [state, setState] = useState<{
    busy?: boolean;
    conflicts?: string[];
    error?: string;
  }>({});
  const go = async (force = false) => {
    setState({ busy: true });
    try {
      const r = await onApply(force);
      setState(r.conflicts.length ? { conflicts: r.conflicts } : {});
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return (
    <div className="apply-bar">
      <Icon name="shield" size={16} />
      <span>Your project is untouched until you apply.</span>
      <button
        className="btn small ghost"
        disabled={state.busy}
        onClick={() => onDiscard()}
      >
        Discard
      </button>
      <button
        className="btn small primary"
        disabled={state.busy}
        onClick={() => go(false)}
      >
        Apply to project
      </button>
      {state.conflicts && (
        <div className="edited-warn full">
          <span>
            {state.conflicts.join(", ")} changed in your project meanwhile.
          </span>
          <button className="btn small danger" onClick={() => go(true)}>
            Apply anyway
          </button>
        </div>
      )}
      {state.error && <p className="err-text small full">{state.error}</p>}
    </div>
  );
}

/** MultiDesign: the variants side by side, each a live preview. */
function DesignGallery({
  run,
  name,
  logo,
  review,
  onApply,
  onDiscard,
}: {
  run: RunView;
  name: (id?: string) => string;
  logo: (id?: string) => React.ReactNode;
  review: ThreadProps["review"];
  onApply: ThreadProps["onApply"];
  onDiscard: ThreadProps["onDiscard"];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ready = (id: string) =>
    run.tasks.find((t) => t.id === id)?.status === "done";
  return (
    <div className="msg-agent wide enter">
      <p>
        {review.pending === "design"
          ? "Your designs are ready. Try each one, then use the one you like."
          : review.resolution === "applied"
            ? "You applied one of these designs."
            : "You discarded these designs."}
      </p>
      <div className="gallery">
        {run.variants!.map((v) => (
          <figure
            key={v.id}
            className={`variant ${ready(v.id) ? "" : "is-failed"}`}
          >
            <div className="variant-frame">
              {ready(v.id) && review.pending === "design" ? (
                <iframe
                  title={v.title}
                  src={`/preview-sandbox/${run.id}/${v.id}/`}
                  sandbox="allow-scripts allow-forms"
                  loading="lazy"
                />
              ) : (
                <span className="muted small">
                  {ready(v.id) ? "Closed" : "No design"}
                </span>
              )}
            </div>
            <figcaption>
              <span className="variant-title">
                {logo(v.memberId)} <b>{v.title}</b>
              </span>
              <span className="muted small">{name(v.memberId)}</span>
              {review.pending === "design" && ready(v.id) && (
                <div className="variant-actions">
                  <a
                    className="btn small ghost"
                    href={`/preview-sandbox/${run.id}/${v.id}/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                  <button
                    className="btn small primary"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(v.id);
                      setError("");
                      try {
                        await onApply(v.id);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === v.id ? "Applying…" : "Use this design"}
                  </button>
                </div>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
      {error && <p className="err-text small">{error}</p>}
      {review.pending === "design" && (
        <button
          className="btn small ghost align-start"
          onClick={() => onDiscard()}
        >
          Discard all designs
        </button>
      )}
    </div>
  );
}

/** A number that rolls up to its value. */
function CountUp({
  value,
  format,
}: {
  value: number;
  format: (n: number) => string;
}) {
  return <span className="count-up">{format(useCountUp(value))}</span>;
}

/** Copies text and says so for a moment. */
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn small-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      title={done ? "Copied" : label}
      aria-label={done ? "Copied" : label}
    >
      <Icon name={done ? "check" : "file"} size={13} />
    </button>
  );
}
