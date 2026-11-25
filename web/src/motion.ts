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
