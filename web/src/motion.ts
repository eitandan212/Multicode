// Motion helpers: things leave the screen as smoothly as they arrive.
import { useEffect, useState } from "react";

export const EXIT_MS = 200;

/** True when the user asked for less motion (OS setting or MultiCode's own switch). */
export function reducedMotion(): boolean {
  if (document.documentElement.dataset.motion === "reduced") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Keeps something mounted while it animates out: `mounted` stays true for `ms` after `open`
 * turns false, and `closing` is true during that time so CSS can play the exit.
 */
export function usePresence(
  open: boolean,
  ms = 320,
): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const t = window.setTimeout(
      () => setMounted(false),
      reducedMotion() ? 0 : ms,
    );
    return () => window.clearTimeout(t);
  }, [open, mounted, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/**
 * Every <dialog> plays a short exit before it closes, whether it's closed by a button,
 * by code or with Escape. Installed once at startup; dialogs need no changes.
 */
export function installDialogExit(): void {
  const proto = HTMLDialogElement.prototype;
  if ((proto as unknown as { __mcExit?: boolean }).__mcExit) return;
  (proto as unknown as { __mcExit?: boolean }).__mcExit = true;
  const nativeClose = proto.close;
  proto.close = function close(this: HTMLDialogElement, value?: string) {
    if (!this.open || reducedMotion()) return nativeClose.call(this, value);
    if (this.dataset.closing) return;
    this.dataset.closing = "1";
    window.setTimeout(() => {
      delete this.dataset.closing;
      nativeClose.call(this, value);
    }, EXIT_MS);
  };
  // Escape: play the exit instead of the instant native close. React's onCancel handlers
  // are skipped; the dialog's onClose still fires once the exit is done.
  document.addEventListener(
    "cancel",
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDialogElement) || reducedMotion()) return;
      e.preventDefault();
      e.stopPropagation();
      d.close();
    },
    true,
  );
}

/**
 * Segmented controls get a pill that slides to the chosen option. Works for every `.seg` in the
 * app without changing components: it follows `.is-active` and sets two CSS variables.
 */
export function installSegPills(): void {
  const place = (seg: HTMLElement) => {
    const active = seg.querySelector<HTMLElement>(":scope > .is-active");
    if (!active || !active.offsetWidth) {
      delete seg.dataset.pill;
      return;
    }
    // Measured against the control itself (offsetLeft would follow whichever ancestor is positioned).
    const box = seg.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    seg.style.setProperty(
      "--pill-x",
      `${r.left - box.left - seg.clientLeft}px`,
    );
    seg.style.setProperty("--pill-y", `${r.top - box.top - seg.clientTop}px`);
    seg.style.setProperty("--pill-w", `${r.width}px`);
    seg.style.setProperty("--pill-h", `${r.height}px`);
    if (!seg.dataset.pill) {
      seg.dataset.pill = "1";
      // First placement doesn't slide in from the left edge.
      seg.dataset.pillStill = "1";
      requestAnimationFrame(() =>
        requestAnimationFrame(() => delete seg.dataset.pillStill),
      );
    }
  };
  let queued = false;
  const all = () => {
    queued = false;
    document.querySelectorAll<HTMLElement>(".seg").forEach(place);
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(all);
    }
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target as HTMLElement;
      if (
        m.type === "attributes"
          ? t.parentElement?.classList.contains("seg")
          : t.querySelector?.(".seg") || t.classList?.contains("seg")
      ) {
        schedule();
        return;
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  window.addEventListener("resize", schedule);
  schedule();
}

/** A short burst of confetti in the logo's colours. Draws for ~1.6 s, then removes itself. */
export function celebrate(from?: { x: number; y: number }): void {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.className = "confetti";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colors = ["--logo-a", "--logo-b", "--logo-c"].map(
    (v) => css.getPropertyValue(v).trim() || "#2563ff",
  );
  const origin = from ?? { x: innerWidth / 2, y: innerHeight * 0.75 };
  const parts = Array.from({ length: 110 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const speed = 7 + Math.random() * 9;
    return {
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      color: colors[Math.floor(Math.random() * colors.length)]!,
    };
  });
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 1600);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < 1600) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** Rolls a number up to its new value (ease-out, ~600 ms); jumps straight there with less motion. */
export function useCountUp(value: number, ms = 600): number {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (reducedMotion() || shown === value) {
      setShown(value);
      return;
    }
    const from = shown;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      setShown(Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Animate only when the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ms]);
  return shown;
}
