import { useEffect, useState } from "react";
import type { AccountUsage, UsageWindow } from "../../../server/shared";
import { api } from "../api";
import { ProviderLogo } from "./ProviderLogo";
import { resetsIn } from "./UsageDialog";

const EVERY = 5 * 60_000;

/** The sidebar's glance at your limits: the window closest to running out, and when it resets. */
export function UsageMeter({ onOpen }: { onOpen: () => void }) {
  const [top, setTop] = useState<{ a: AccountUsage; w: UsageWindow } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void api
        .usage()
        .then((all) => {
          const best = all
            .flatMap((a) => a.windows.map((w) => ({ a, w })))
            .sort((x, y) => y.w.usedPercent - x.w.usedPercent)[0];
          if (live) setTop(best ?? null);
        })
        .catch(() => {});
    read();
    const t = window.setInterval(read, EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!top) return null;
  const p = Math.round(top.w.usedPercent);
  return (
    <button className={`usage-meter ${p >= 90 ? "is-high" : p >= 70 ? "is-mid" : ""}`} onClick={onOpen} title="Usage & limits">
      <span className="usage-meter-head">
        <ProviderLogo kind={top.a.kind} size={14} />
        <span className="truncate">{top.w.label}</span>
        <strong>{p}%</strong>
      </span>
      <span className="usage-track">
        <span style={{ width: `${p}%` }} />
      </span>
      {top.w.resetsAt && <span className="muted small">Resets {resetsIn(top.w.resetsAt)}</span>}
    </button>
  );
}
