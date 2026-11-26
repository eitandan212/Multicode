import { useEffect, useRef, useState } from "react";
import type { AccountUsage, ConnectionView, CrewMember } from "../../../server/shared";
import { contextWindow } from "../../../server/shared";
import { api } from "../api";
import { UsageBar } from "./UsageDialog";

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

/**
 * The context ring, as in Claude Code, Codex and Cursor: how full the model's context was on the
 * last call. Click it for the numbers and your subscription limits.
 */
export function ContextRing({
  lastCall,
  crew,
  connections,
  onOpenUsage,
}: {
  lastCall?: { memberId: string; tokens: number };
  crew: CrewMember[];
  connections: ConnectionView[];
  onOpenUsage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<AccountUsage[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const member = lastCall ? crew.find((m) => m.id === lastCall.memberId) : undefined;
  const conn = member ? connections.find((c) => c.id === member.connectionId) : undefined;
  const model = member?.model || conn?.defaultModel || "";
  const limit = conn ? contextWindow(conn.kind, model) : 128_000;
  const used = lastCall?.tokens ?? 0;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const level = pct >= 90 ? "is-high" : pct >= 70 ? "is-mid" : "";

  useEffect(() => {
    if (!open) return;
    if (!plans) void api.usage(false).then(setPlans).catch(() => setPlans([]));
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, plans]);

  const r = 7;
  const c = 2 * Math.PI * r;
  const label = lastCall ? `Context ${pct}% full (${fmt(used)} of ${fmt(limit)} tokens)` : "Context and usage";
  return (
    <div className="ctx-ring-wrap" ref={ref}>
      <button type="button" className={`ctx-ring ${level}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label} title={label}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r={r} className="ctx-ring-track" />
          <circle cx="9" cy="9" r={r} className="ctx-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 9 9)" />
        </svg>
        {lastCall && <span className="ctx-ring-pct">{pct}%</span>}
      </button>
      {open && (
        <div className="menu-pop ctx-pop" role="dialog" aria-label="Context and usage">
          <div className="ctx-pop-section">
            <strong>Context</strong>
            {lastCall ? (
              <>
                <div className={`usage-track ${level}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Context used">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="muted small">
                  {fmt(used)} of {fmt(limit)} tokens on the last call{member ? ` · ${member.name}` : ""}
                  {model ? ` (${model})` : ""}. When it fills up, MultiCode compacts the request automatically.
                </span>
              </>
            ) : (
              <span className="muted small">Shows how full the model's context is once the crew starts working.</span>
            )}
          </div>
          <div className="ctx-pop-section">
            <strong>Plan limits</strong>
            {!plans ? (
              <span className="muted small">Reading your limits…</span>
            ) : plans.flatMap((a) => a.windows).length === 0 ? (
              <span className="muted small">No subscription reports limits (API keys and free models don't).</span>
            ) : (
              plans.map((a) => a.windows.slice(0, 2).map((w) => <UsageBar key={`${a.connectionId}-${w.id}`} w={{ ...w, label: `${a.label} · ${w.label}` }} />))
            )}
            <button type="button" className="link small" onClick={() => { setOpen(false); onOpenUsage(); }}>
              All usage & limits
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
