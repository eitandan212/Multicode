// The desktop window has no native title bar (as in T3 Code): the OS draws its window buttons
// over the app's top bar. This marks the page so CSS can keep content clear of them and make the
// top bars draggable. In a normal browser tab nothing changes.

interface WindowControlsOverlay {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: () => void): void;
}

declare global {
  interface Window {
    multicodeDesktop?: { setTheme(theme: string): void };
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
