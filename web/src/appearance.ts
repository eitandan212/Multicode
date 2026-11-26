import { reportTheme } from "./windowChrome";
/**
 * Personal appearance. Stored in this browser only (a per-viewer preference) and applied to
 * <html> before React renders, so there's no flash of the wrong theme.
 */
export type ThemeMode = "system" | "light" | "dark";
export type FontChoice = "instrument" | "inter" | "system";
export type SizeChoice = "compact" | "default" | "large";
export type RadiusChoice = "sharp" | "default" | "round";
/** How statuses look: coloured dots, emoji, or small symbols. */
export type StatusStyle = "dots" | "emoji" | "symbols";
/** none, a built-in scene, your own colour, or your own picture. */
export type BackgroundKind = "none" | "preset" | "color" | "image";

export interface Appearance {
  theme: ThemeMode;
  /** null = MultiCode's own Cobalt accent (#2563FF). */
  accent: string | null;
  font: FontChoice;
  size: SizeChoice;
  reducedMotion: boolean;
  intro: boolean;
  background: BackgroundKind;
  bgPreset: string;
  bgColor: string;
  /** A JPEG data URL, resized in the browser before it's saved. */
  bgImage: string | null;
  /** 0-90: how much the theme colour covers the background, for readable text. */
  bgDim: number;
  /** 0-24 px. */
  bgBlur: number;
  radius: RadiusChoice;
  statusStyle: StatusStyle;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  accent: null,
  font: "inter",
  size: "default",
  reducedMotion: false,
  intro: true,
  background: "none",
  bgPreset: "aurora",
  bgColor: "#1e293b",
  bgImage: null,
  bgDim: 55,
  bgBlur: 0,
  radius: "default",
  statusStyle: "dots",
};

/** Built-in backgrounds: CSS only, nothing to download. */
export const BG_PRESETS: { id: string; name: string; css: string }[] = [
  { id: "aurora", name: "Aurora", css: "radial-gradient(1200px 700px at 15% 10%, #5b7cfa 0%, transparent 60%), radial-gradient(900px 700px at 85% 30%, #a855f7 0%, transparent 55%), radial-gradient(900px 600px at 50% 100%, #10b981 0%, transparent 60%), #0b1020" },
  { id: "sunset", name: "Sunset", css: "linear-gradient(160deg, #ff7e5f 0%, #feb47b 35%, #6a3093 100%)" },
  { id: "ocean", name: "Ocean", css: "linear-gradient(200deg, #0f2027 0%, #203a43 45%, #2c5364 100%)" },
  { id: "forest", name: "Forest", css: "radial-gradient(1000px 600px at 20% 0%, #3a7d44 0%, transparent 60%), linear-gradient(180deg, #13291a 0%, #0a140d 100%)" },
  { id: "peach", name: "Peach", css: "linear-gradient(135deg, #fde2e4 0%, #fad2e1 30%, #e2ece9 70%, #bee1e6 100%)" },
  { id: "candy", name: "Candy", css: "radial-gradient(800px 600px at 0% 0%, #ff9a9e 0%, transparent 60%), radial-gradient(800px 600px at 100% 100%, #a18cd1 0%, transparent 60%), #fbc2eb" },
  { id: "midnight", name: "Midnight", css: "radial-gradient(1px 1px at 20% 30%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 70% 60%, #fff 50%, transparent 51%), radial-gradient(1.5px 1.5px at 40% 80%, #cbd5ff 50%, transparent 51%), radial-gradient(1px 1px at 85% 15%, #fff 50%, transparent 51%), linear-gradient(180deg, #0b1026 0%, #1b1f3b 100%)" },
  { id: "grid", name: "Grid", css: "linear-gradient(rgb(127 127 127 / 0.12) 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, rgb(127 127 127 / 0.12) 1px, transparent 1px) 0 0 / 28px 28px, var(--bg-solid)" },
];

/** Shrinks a picture to at most 1920 px wide and saves it as JPEG, so it fits in local storage. */
export async function imageToBackground(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a picture (PNG, JPEG, WebP…)");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bitmap.width, 1200 / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const q of [0.85, 0.7, 0.55]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length < 1_800_000) return url;
  }
  throw new Error("That picture is too large even after shrinking it");
}

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
    if (!["none", "preset", "color", "image"].includes(a.background)) a.background = "none";
    if (!BG_PRESETS.some((b) => b.id === a.bgPreset)) a.bgPreset = "aurora";
    if (!HEX.test(String(a.bgColor))) a.bgColor = DEFAULT_APPEARANCE.bgColor;
    if (typeof a.bgImage !== "string" || !a.bgImage.startsWith("data:image/")) a.bgImage = null;
    if (a.background === "image" && !a.bgImage) a.background = "none";
    a.bgDim = clamp(Number(a.bgDim), 0, 90, 55);
    a.bgBlur = clamp(Number(a.bgBlur), 0, 24, 0);
    if (!["sharp", "default", "round"].includes(a.radius)) a.radius = "default";
    if (!["dots", "emoji", "symbols"].includes(a.statusStyle)) a.statusStyle = "dots";
    return a;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** False when the browser refused to store it (a picture too large for storage). */
export function saveAppearance(a: Appearance): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
    return true;
  } catch {
    /* storage unavailable or full: the choice lasts for this session only */
    return false;
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
  set("data-radius", a.radius === "default" ? null : a.radius);
  set("data-status", a.statusStyle === "dots" ? null : a.statusStyle);
  const layer =
    a.background === "preset"
      ? BG_PRESETS.find((b) => b.id === a.bgPreset)?.css
      : a.background === "color"
        ? a.bgColor
        : a.background === "image" && a.bgImage
          ? `url("${a.bgImage}") center / cover no-repeat`
          : undefined;
  set("data-bg", layer ? "on" : null);
  if (layer) {
    root.style.setProperty("--bg-layer", layer);
    root.style.setProperty("--bg-dim", `${a.bgDim}%`);
    root.style.setProperty("--bg-blur", `${a.bgBlur}px`);
  } else for (const v of ["--bg-layer", "--bg-dim", "--bg-blur"]) root.style.removeProperty(v);
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
