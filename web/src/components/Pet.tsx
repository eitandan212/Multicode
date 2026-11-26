import { useEffect, useRef, useState } from "react";
import type { RunSummary } from "../../../server/shared";
import { api } from "../api";
import { plainPrompt } from "./PromptText";

type Approval = Awaited<ReturnType<typeof api.approvals>>[number];
type Mood = "idle" | "busy" | "alert" | "happy" | "sad";

/**
 * MultiCode's pet: a little character that sits on your screen (its own window in the desktop
 * app, a corner of the page in the browser). It asks for approvals, says when work is done or
 * failed, and when a new version is ready. Everything else, it naps.
 */
export function Pet({ onOpen, standalone = false }: { onOpen: (runId: string) => void; standalone?: boolean }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [update, setUpdate] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [hover, setHover] = useState(false);
  const [now, setNow] = useState(Date.now());
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const [a, r] = await Promise.all([api.approvals().catch(() => []), api.allRuns().catch(() => null)]);
      if (!live) return;
      setApprovals(a);
      if (r) setRuns(r);
      setNow(Date.now());
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2500);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  // A new version (desktop app): checked now and every half hour.
  useEffect(() => {
    const u = window.multicodeDesktop?.update;
    if (!u) return;
    const check = () => void u.check().then((r) => setUpdate(r?.available && r.version ? r.version : null)).catch(() => {});
    check();
    const t = window.setInterval(check, 30 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  const working = runs.filter((r) => r.status === "running");
  // Finished since the pet started, in the last 10 minutes, not yet waved away.
  const finished = runs
    .filter((r) => r.endedAt && r.endedAt > startedAt.current && now - r.endedAt < 10 * 60_000 && !dismissed.has(r.id) && r.status !== "running")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const ask = approvals[0];

  const dismiss = (id: string) => setDismissed((s) => new Set(s).add(id));
  const answer = async (a: Approval, allow: boolean) => {
    setBusy(a.id);
    await api.approve(a.runId, a.id, allow).catch(() => {});
    setApprovals((list) => list.filter((x) => x.id !== a.id));
    setBusy("");
  };

  let mood: Mood = "idle";
  let bubble: React.ReactNode = null;
  if (ask) {
    mood = "alert";
    bubble = (
      <>
        <span className="pet-kicker">Waiting for you · {ask.chat}</span>
        <span className="pet-text">{ask.title}</span>
        <span className="pet-actions">
          <button className="pet-btn primary" disabled={busy === ask.id} onClick={() => void answer(ask, true)}>
            Allow
          </button>
          <button className="pet-btn" disabled={busy === ask.id} onClick={() => void answer(ask, false)}>
            Decline
          </button>
          <button className="pet-btn ghost" onClick={() => onOpen(ask.runId)}>
            Open
          </button>
        </span>
        {approvals.length > 1 && <span className="pet-more">+{approvals.length - 1} more waiting</span>}
      </>
    );
  } else if (finished) {
    const ok = finished.status === "done";
    mood = ok ? "happy" : "sad";
    bubble = (
      <>
        <span className="pet-kicker">{ok ? (finished.pending ? "Ready for your review" : "Done") : finished.status === "cancelled" ? "Stopped" : "Something went wrong"}</span>
        <span className="pet-text">{finished.title || plainPrompt(finished.prompt)}</span>
        <span className="pet-actions">
          <button className="pet-btn primary" onClick={() => { onOpen(finished.id); dismiss(finished.id); }}>
            Open
          </button>
          <button className="pet-btn ghost" onClick={() => dismiss(finished.id)}>
            OK
          </button>
        </span>
      </>
    );
  } else if (update && !dismissed.has(`update-${update}`)) {
    mood = "happy";
    bubble = (
      <>
        <span className="pet-kicker">New version</span>
        <span className="pet-text">MultiCode {update} is ready. Update from the sidebar.</span>
        <span className="pet-actions">
          <button className="pet-btn ghost" onClick={() => dismiss(`update-${update}`)}>
            Later
          </button>
        </span>
      </>
    );
  } else if (working.length) {
    mood = "busy";
    if (hover)
      bubble = (
        <>
          <span className="pet-kicker">Working{working.length > 1 ? ` on ${working.length} tasks` : ""}</span>
          <span className="pet-text">{working[0]!.title || plainPrompt(working[0]!.prompt)}</span>
        </>
      );
  } else if (hover) {
    bubble = <span className="pet-text">All quiet. Ctrl+K finds anything; / opens commands.</span>;
  }

  return (
    <div className={`pet ${standalone ? "is-standalone" : ""}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {bubble && (
        <div className="pet-bubble" role="status" aria-live="polite">
          {bubble}
        </div>
      )}
      <div className={`pet-body is-${mood}`} title="MultiCode" aria-hidden>
        <svg viewBox="0 0 64 64" width="56" height="56">
          <defs>
            <linearGradient id="pet-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#4f7cff" />
              <stop offset="1" stopColor="#f59e0b" />
            </linearGradient>
          </defs>
          <path className="pet-blob" d="M32 6c14 0 26 10 26 25S47 58 32 58 6 46 6 31 18 6 32 6z" fill="url(#pet-g)" />
          <g className="pet-eyes">
            <ellipse cx="24" cy="30" rx="4" ry={mood === "idle" ? 1.2 : 5} fill="#fff" />
            <ellipse cx="40" cy="30" rx="4" ry={mood === "idle" ? 1.2 : 5} fill="#fff" />
            {mood !== "idle" && (
              <>
                <circle cx={mood === "alert" ? 25.5 : 24} cy="31" r="2" fill="#111" />
                <circle cx={mood === "alert" ? 41.5 : 40} cy="31" r="2" fill="#111" />
              </>
            )}
          </g>
          {mood === "happy" && <path d="M25 41c4 4 10 4 14 0" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" />}
          {mood === "sad" && <path d="M25 44c4-3 10-3 14 0" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" />}
          {mood === "alert" && <circle cx="32" cy="43" r="3" fill="#fff" />}
          {mood === "idle" && <text x="46" y="16" className="pet-z" fontSize="10" fill="currentColor">z</text>}
        </svg>
        {approvals.length > 0 && <span className="pet-badge">{approvals.length}</span>}
      </div>
    </div>
  );
}
