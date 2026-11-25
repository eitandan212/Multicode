import { reportTheme } from "./windowChrome";
/**
 * Personal appearance. Stored in this browser only (a per-viewer preference) and applied to
 * <html> before React renders, so there's no flash of the wrong theme.
 */
export type ThemeMode = "system" | "light" | "dark";
export type FontChoice = "instrument" | "inter" | "system";
export type SizeChoice = "compact" | "default" | "large";

export interface Appearance {
  theme: ThemeMode;
  /** null = MultiCode's own Cobalt accent (#2563FF). */
  accent: string | null;
  font: FontChoice;
  size: SizeChoice;
  reducedMotion: boolean;
  intro: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  accent: null,
  font: "inter",
  size: "default",
  reducedMotion: false,
  intro: true,
};

export const ACCENTS: { name: string; value: string | null; swatch: string }[] =
  [
    { name: "MultiCode cobalt", value: null, swatch: "#2563ff" },
    { name: "Amber", value: "#f59e0b", swatch: "#f59e0b" },
    { name: "Emerald", value: "#10b981", swatch: "#10b981" },
    { name: "Violet", value: "#7c5cff", swatch: "#7c5cff" },
    { name: "Rose", value: "#d9467a", swatch: "#d9467a" },
    { name: "Graphite", value: "#5b6470", swatch: "#5b6470" },
  ];

export const FONTS: Record<FontChoice, { label: string; stack: string }> = {
  inter: {
    label: "Inter",
    stack:
      '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  instrument: {
    label: "Instrument Sans",
    stack:
      '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  system: {
    label: "System",
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
};

const KEY = "multicode:appearance";
const HEX = /^#[0-9a-f]{6}$/i;

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(
      localStorage.getItem(KEY) ?? "null",
    ) as Partial<Appearance> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_APPEARANCE;
    const a = { ...DEFAULT_APPEARANCE, ...raw };
    if (a.accent !== null && !HEX.test(String(a.accent))) a.accent = null;
    if (!(a.font in FONTS)) a.font = "inter";
    return a;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  reportTheme(a.theme);
  const set = (name: string, value: string | null) =>
    value === null
      ? root.removeAttribute(name)
      : root.setAttribute(name, value);
  set("data-theme", a.theme === "system" ? null : a.theme);
  set("data-accent", a.accent ? "custom" : null);
  set("data-size", a.size === "default" ? null : a.size);
  set("data-motion", a.reducedMotion ? "reduced" : null);
  if (a.accent) root.style.setProperty("--user-accent", a.accent);
  else root.style.removeProperty("--user-accent");
  root.style.setProperty("--font", FONTS[a.font].stack);
}

/** True when animation should be skipped (system setting or the user's choice). */
export function motionReduced(a: Appearance): boolean {
  try {
    return (
      a.reducedMotion ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return a.reducedMotion;
  }
}
