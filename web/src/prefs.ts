// Per-device preferences (this browser / this computer only), like Appearance.
export interface Prefs {
  /** enter: Enter sends, Shift+Enter is a new line. mod: Ctrl/⌘+Enter sends, Enter is a new line. */
  sendKey: "enter" | "mod";
  /** A desktop notification when a thread finishes while MultiCode isn't in front. */
  notifyDone: boolean;
  /** …and when an action waits for your approval. */
  notifyApproval: boolean;
  /** A soft chime when a thread finishes. */
  sound: boolean;
  /** The pet: approvals, finished work and news, on your screen. */
  pet: boolean;
}

export const DEFAULT_PREFS: Prefs = { sendKey: "enter", notifyDone: true, notifyApproval: true, sound: false, pet: true };
const KEY = "multicode:prefs";

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
  window.dispatchEvent(new CustomEvent("multicode:prefs", { detail: p }));
}

/** A desktop notification, only while MultiCode isn't the window in front. */
export function notify(title: string, body: string): void {
  if (document.hasFocus() || typeof Notification === "undefined") return;
  const show = () => {
    const n = new Notification(title, { body, icon: "/favicon.svg", silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission === "default") void Notification.requestPermission().then((r) => r === "granted" && show());
}

/** A short, soft two-note chime (no audio file needed). */
export function chime(): void {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.55);
    }
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* no audio */
  }
}
