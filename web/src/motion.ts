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

/**
 * Click a picture in a chat (or one attached in the box) to see it large, in place
 * (instead of a new window). Esc, a click or the × closes it.
 */
export function installLightbox(): void {
  const SELECTOR = ".prompt-pics img, .composer-pic img, .markdown img, .msg img";
  document.addEventListener("click", (e) => {
    const img = (e.target as Element | null)?.closest?.(SELECTOR) as HTMLImageElement | null;
    if (!img || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Picture");
    const big = document.createElement("img");
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    const x = document.createElement("button");
    x.className = "lightbox-x";
    x.setAttribute("aria-label", "Close");
    x.textContent = "×";
    box.append(big, x);
    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      box.classList.add("is-closing");
      window.setTimeout(() => box.remove(), 180);
    };
    const onKey = (k: KeyboardEvent) => {
      if (k.key === "Escape") {
        k.stopPropagation();
        close();
      }
    };
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    document.body.append(box);
    x.focus();
  });
}
