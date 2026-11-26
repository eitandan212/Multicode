// The desktop window has no native title bar (as in T3 Code): the OS draws its window buttons
// over the app's top bar. This marks the page so CSS can keep content clear of them and make the
// top bars draggable. In a normal browser tab nothing changes.

interface WindowControlsOverlay {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: () => void): void;
}

export interface BrowserViewState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The crew acted in it a moment ago. */
  driving: boolean;
}

declare global {
  interface Window {
    multicodeDesktop?: {
      setTheme(theme: string): void;
      /** The desktop app's native folder picker (undefined in a browser). */
      pickFolder?: () => Promise<string | null>;
      /** The pet's own always-on-top window. */
      setPet?: (on: boolean) => void;
      /** Bring MultiCode to the front on a chat (from the pet). */
      openRun?: (runId: string) => void;
      /** The in-app browser the crew can drive (desktop app). */
      browser?: {
        setBounds: (rect: { x: number; y: number; width: number; height: number } | null) => void;
        go: (action: "back" | "forward" | "reload" | "stop" | { url: string }) => void;
        get: () => Promise<BrowserViewState | null>;
        onState: (fn: (s: BrowserViewState) => void) => () => void;
        onReveal: (fn: () => void) => () => void;
      };
      /** The pet's click: MultiCode to the front. */
      showApp?: () => void;
      /** The pet's drag: move its window by this much. */
      movePet?: (dx: number, dy: number) => void;
      onOpenRun?: (fn: (runId: string) => void) => () => void;
      /** Shows a file or folder in Explorer / Finder. */
      openPath?: (p: string) => Promise<boolean>;
      /** Sleep mode: stop the computer from sleeping while the crew works. */
      keepAwake?: (on: boolean) => void;
      /** In-app updates (desktop app only). */
      update?: {
        check(): Promise<{ current: string; available: boolean; version?: string; size?: number; error?: string } | null>;
        install(): Promise<{ version: string } | null>;
        onProgress(fn: (p: number) => void): () => void;
      };
    };
  }
}

export function installWindowChrome(): void {
  const root = document.documentElement;
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
    .windowControlsOverlay;
  const update = () => root.classList.toggle("wco", Boolean(overlay?.visible));
  update();
  overlay?.addEventListener("geometrychange", update);
  // macOS: the traffic lights sit inset at the top left of the sidebar.
  if (window.multicodeDesktop && /Mac/.test(navigator.platform))
    root.classList.add("desktop-mac");
}

/** Lets the desktop shell match its window buttons to the theme the app shows. */
export function reportTheme(theme: string): void {
  window.multicodeDesktop?.setTheme(theme);
}
