import { useEffect, useRef, useState } from "react";
import type { BrowserViewState } from "../windowChrome";
import { Icon } from "./Icon";

// Anything drawn over the page (dialogs, menus, cards) would sit under the native browser view,
// so the view steps aside while one is open.
const OVERLAYS = "dialog[open], .menu-pop, .sb-peek, .lightbox, .palette, .toast-stack .toast";

/**
 * The Browser tab: a real browser inside MultiCode (desktop app). Browse in it yourself; when
 * the crew uses the browser, it drives this one and you watch.
 */
export function BrowserPanel({ previewUrl }: { previewUrl: string }) {
  const b = window.multicodeDesktop?.browser;
  const area = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserViewState | null>(null);
  const [address, setAddress] = useState("");
  const editing = useRef(false);
  // Until a page is open, our own welcome shows instead of the empty view.
  const blankRef = useRef(true);
  blankRef.current = !state || !state.url || state.url === "about:blank";

  useEffect(() => {
    if (!b) return;
    void b.get().then((s) => s && setState(s));
    return b.onState((s) => {
      setState(s);
      if (!editing.current) setAddress(s.url === "about:blank" ? "" : s.url);
    });
  }, [b]);

  // Keep the native view over our area: follow its size and place, and step aside for overlays.
  useEffect(() => {
    if (!b) return;
    let last = "";
    const sync = () => {
      const el = area.current;
      const r = el?.getBoundingClientRect();
      const covered = Boolean(document.querySelector(OVERLAYS));
      const visible = r && r.width > 20 && r.height > 20 && !covered && !blankRef.current && document.visibilityState === "visible";
      const next = visible ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
      const key = JSON.stringify(next && { x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.width), h: Math.round(next.height) });
      if (key !== last) {
        last = key;
        b.setBounds(next);
      }
    };
    sync();
    const t = window.setInterval(sync, 120);
    const ro = new ResizeObserver(sync);
    if (area.current) ro.observe(area.current);
    window.addEventListener("resize", sync);
    return () => {
      window.clearInterval(t);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      b.setBounds(null);
    };
  }, [b]);

  if (!b)
    return (
      <p className="ws-empty">
        The built-in browser is part of the MultiCode desktop app. Here, the crew uses its own headless browser to check
        your app.
      </p>
    );

  const blank = !state || !state.url || state.url === "about:blank";
  return (
    <div className="aib">
      <form
        className="aib-bar"
        onSubmit={(e) => {
          e.preventDefault();
          editing.current = false;
          if (address.trim()) b.go({ url: address.trim() });
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <button type="button" className="icon-btn" aria-label="Back" disabled={!state?.canGoBack} onClick={() => b.go("back")}>
          <Icon name="arrowLeft" size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Forward" disabled={!state?.canGoForward} onClick={() => b.go("forward")}>
          <Icon name="arrowRight" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={state?.loading ? "Stop" : "Reload"}
          disabled={blank}
          onClick={() => b.go(state?.loading ? "stop" : "reload")}
        >
          <Icon name={state?.loading ? "x" : "refresh"} size={14} />
        </button>
        <input
          className="aib-url"
          value={address}
          placeholder="Search or type an address"
          aria-label="Address"
          spellCheck={false}
          onFocus={(e) => {
            editing.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => (editing.current = false)}
          onChange={(e) => setAddress(e.target.value)}
        />
        {state?.driving && (
          <span className="aib-driving" title="The crew is using the browser">
            <span className="aib-dot" /> Crew driving
          </span>
        )}
      </form>
      <div ref={area} className={`aib-view ${state?.loading ? "is-loading" : ""}`}>
        {blank && (
          <div className="aib-empty">
            <Icon name="globe" size={22} />
            <p>A browser inside MultiCode. When the crew checks your app in a browser, it uses this one and you watch.</p>
            <button className="btn small" onClick={() => b.go({ url: previewUrl })}>
              Open the preview here
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
