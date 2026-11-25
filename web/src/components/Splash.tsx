import { useEffect, useState } from "react";
import { LogoMark } from "./Logo";

const WORD = "MultiCode";
const HOLD_MS = 1500;
const EXIT_MS = 420;

/**
 * Opening animation: the brackets slide in, the M rises between them, the name and the
 * tagline settle out of a soft blur, then the curtain lifts. Click or press any key to skip.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const leave = window.setTimeout(() => setLeaving(true), HOLD_MS);
    const skip = () => setLeaving(true);
    window.addEventListener("keydown", skip, { once: true });
    return () => {
      window.clearTimeout(leave);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(onDone, EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving, onDone]);

  return (
    <div className={`splash ${leaving ? "is-leaving" : ""}`} onClick={() => setLeaving(true)} role="presentation">
      <svg className="splash-ribbons" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <path pathLength={1} className="sr sr1" d="M-120 620 C 220 480, 420 760, 680 600 S 1060 380, 1340 470" />
        <path pathLength={1} className="sr sr2" d="M-80 210 C 180 320, 340 90, 600 180 S 1000 360, 1320 160" />
      </svg>
      <div className="splash-center">
        <LogoMark size={64} className="splash-logo" />
        <h1 className="splash-word" aria-label="MultiCode">
          {WORD.split("").map((ch, i) => (
            <span key={i} style={{ animationDelay: `${560 + i * 32}ms` }} aria-hidden>
              {ch}
            </span>
          ))}
        </h1>
        <p className="splash-tag">One workspace. Many engines.</p>
      </div>
    </div>
  );
}
