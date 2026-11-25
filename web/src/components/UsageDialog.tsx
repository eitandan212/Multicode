import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountUsage, UsageWindow } from "../../../server/shared";
import { api } from "../api";
import { useOpenDialog } from "./embed";
import { Icon, Spinner } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

/** "in 2 h 13 min" / "in 3 days", from now. */
export function resetsIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `in ${Math.round(h / 24)} days`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

const level = (p: number) => (p >= 90 ? "is-high" : p >= 70 ? "is-mid" : "");

export function UsageBar({ w }: { w: UsageWindow }) {
  return (
    <div className={`usage-row ${level(w.usedPercent)}`}>
      <div className="usage-head">
        <span>{w.label}</span>
        <strong>{Math.round(w.usedPercent)}% used</strong>
      </div>
      <div className="usage-track" role="progressbar" aria-valuenow={Math.round(w.usedPercent)} aria-valuemin={0} aria-valuemax={100} aria-label={w.label}>
        <span style={{ width: `${w.usedPercent}%` }} />
      </div>
      {w.resetsAt && (
        <span className="muted small">
          Resets {resetsIn(w.resetsAt)} · {when(w.resetsAt)}
        </span>
      )}
    </div>
  );
}

/** Subscription limits, as Claude's /usage shows them: how much of each window is used and when it resets. */
export function UsageDialog({ onClose, onConnect }: { onClose: () => void; onConnect: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  const [accounts, setAccounts] = useState<AccountUsage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    openDialog(ref.current);
  }, []);
  const load = useCallback(async (fresh: boolean) => {
    setBusy(true);
    setError("");
    try {
      setAccounts(await api.usage(fresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <dialog ref={ref} className="dialog usage-dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <div>
          <h2>Usage & limits</h2>
          <p className="muted">How much of each subscription you've used, and when it resets.</p>
        </div>
        <button className="btn small" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Spinner /> : <Icon name="sync" size={14} />} Refresh
        </button>
      </header>
      <div className="dialog-body usage-body">
        {error && <p className="err-text">{error}</p>}
        {!accounts ? (
          <p className="muted">
            <Spinner /> Reading your limits…
          </p>
        ) : accounts.length === 0 ? (
          <div className="usage-empty">
            <p>Connect a Claude or ChatGPT subscription to see its limits here.</p>
            <button className="btn primary" onClick={onConnect}>
              Open connections
            </button>
          </div>
        ) : (
          accounts.map((a) => (
            <section key={a.connectionId} className="usage-card">
              <header>
                <ProviderLogo kind={a.kind} size={20} />
                <strong>{a.label}</strong>
                {a.plan && <span className="usage-plan">{a.plan}</span>}
              </header>
              {a.error ? (
                <p className="muted small">Couldn't read its limits: {a.error}</p>
              ) : a.windows.length === 0 ? (
                <p className="muted small">
                  This account doesn't report plan limits (an API key, or an organization account).
                </p>
              ) : (
                a.windows.map((w) => <UsageBar key={w.id} w={w} />)
              )}
              {a.extra && <p className="muted small">{a.extra}</p>}
              <p className="muted small usage-checked">
                Checked {new Date(a.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </p>
            </section>
          ))
        )}
        <p className="muted small">
          Read from Claude and Codex themselves, without using any of your limits. Other services don't report
          their limits; MultiCode notices when they run out and switches to a free model.
        </p>
      </div>
    </dialog>
  );
}
