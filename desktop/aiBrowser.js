// The in-app browser: a real browser view laid over the Browser tab of MultiCode's window.
// You browse in it yourself; the crew drives it through MultiCode's /mcp/browser server, and
// you watch every step. It has its own storage (cookies, logins), apart from the app's.
import { ipcMain, session, WebContentsView } from "electron";

const SAFE = /^(https?:|about:blank$)/i;
const MAX_CONSOLE = 300;

/**
 * @param {() => import("electron").BrowserWindow | null} getWin
 * @param {(driver: object) => void} register
 * @param {{ origin: string; cookie: string; pass: string }} previewPass MultiCode's previews, without signing in
 */
export function setupAiBrowser(getWin, register, previewPass) {
  const PARTITION = "persist:multicode-browser";
  // The previews open here without a sign-in (the pass reaches previews only).
  if (previewPass)
    for (const host of ["localhost", "127.0.0.1"])
      void session
        .fromPartition(PARTITION)
        .cookies.set({
          url: previewPass.origin.replace("localhost", host),
          name: previewPass.cookie,
          value: previewPass.pass,
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        })
        .catch(() => {});
  /** @type {WebContentsView | null} */
  let view = null;
  let attachedTo = null;
  let bounds = null;
  let driving = false;
  let drivingTimer = null;
  const consoleLines = [];

  const win = () => {
    const w = getWin();
    return w && !w.isDestroyed() ? w : null;
  };
  const sendState = () => {
    const w = win();
    if (!w || !view) return;
    const wc = view.webContents;
    w.webContents.send("multicode:browser-state", {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      driving,
    });
  };
  // "The crew is driving" shows for a moment after each of its actions.
  const drove = () => {
    driving = true;
    clearTimeout(drivingTimer);
    drivingTimer = setTimeout(() => {
      driving = false;
      sendState();
    }, 4000);
    sendState();
  };

  function ensure() {
    if (!view || view.webContents.isDestroyed()) {
      view = new WebContentsView({
        webPreferences: {
          partition: PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const wc = view.webContents;
      // New windows open in the same view; only web addresses load.
      wc.setWindowOpenHandler(({ url }) => {
        if (SAFE.test(url)) void wc.loadURL(url);
        return { action: "deny" };
      });
      wc.on("will-navigate", (event, url) => {
        if (!SAFE.test(url)) event.preventDefault();
      });
      wc.on("console-message", (event, legacyLevel, legacyMessage) => {
        const level = event?.level ?? ["log", "warning", "error", "debug"][legacyLevel] ?? "log";
        const message = event?.message ?? legacyMessage ?? "";
        consoleLines.push(`${level}: ${String(message).slice(0, 500)}`);
        if (consoleLines.length > MAX_CONSOLE) consoleLines.splice(0, consoleLines.length - MAX_CONSOLE);
      });
      for (const ev of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"])
        wc.on(ev, sendState);
      attachedTo = null;
    }
    const w = win();
    if (w && attachedTo !== w) {
      w.contentView.addChildView(view);
      attachedTo = w;
      w.on("closed", () => {
        attachedTo = null;
      });
    }
    apply();
    return view;
  }
  function apply() {
    if (!view) return;
    if (bounds) {
      view.setBounds(bounds);
      view.setVisible(true);
    } else view.setVisible(false);
  }
  const settled = (wc, ms = 8000) =>
    new Promise((resolve) => {
      if (!wc.isLoading()) return setTimeout(resolve, 150);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        wc.off("did-stop-loading", done);
        resolve();
      }, ms);
      wc.once("did-stop-loading", done);
    });

  // ---- From the Browser tab ----
  ipcMain.on("multicode:browser-bounds", (event, rect) => {
    const w = win();
    if (!w || event.sender !== w.webContents) return;
    bounds =
      rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 20 && rect.height > 20
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null;
    if (bounds || view) ensure();
  });
  ipcMain.on("multicode:browser-go", (event, action) => {
    const w = win();
    if (!w || event.sender !== w.webContents) return;
    const wc = ensure().webContents;
    if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else if (action === "stop") wc.stop();
    else if (typeof action === "object" && action && typeof action.url === "string") {
      let url = action.url.trim();
      if (!/^[a-z]+:/i.test(url)) url = /^(localhost|127\.|\[::1\])/.test(url) || !url.includes(" ") && url.includes(".") ? `http${/^(localhost|127\.)/.test(url) ? "" : "s"}://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
      if (SAFE.test(url)) void wc.loadURL(url).catch(() => {});
    }
  });
  ipcMain.handle("multicode:browser-get", (event) => {
    const w = win();
    if (!w || event.sender !== w.webContents || !view) return null;
    const wc = view.webContents;
    return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), driving };
  });

  // ---- For the crew (MultiCode's MCP server calls these) ----
  register({
    async navigate(url) {
      const wc = ensure().webContents;
      drove();
      await wc.loadURL(url).catch(() => {});
      await settled(wc);
    },
    async back() {
      const wc = ensure().webContents;
      drove();
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      await settled(wc);
    },
    evaluate(script) {
      return ensure().webContents.executeJavaScript(script, true);
    },
    async click(x, y) {
      const wc = ensure().webContents;
      drove();
      const at = { x: Math.round(x), y: Math.round(y) };
      wc.sendInputEvent({ type: "mouseMove", ...at });
      wc.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
      await settled(wc, 4000);
    },
    async type(text) {
      drove();
      await ensure().webContents.insertText(text);
    },
    async key(name) {
      const wc = ensure().webContents;
      drove();
      wc.sendInputEvent({ type: "keyDown", keyCode: name });
      if (name === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
      else if (name.length === 1) wc.sendInputEvent({ type: "char", keyCode: name });
      wc.sendInputEvent({ type: "keyUp", keyCode: name });
      await settled(wc, 4000);
    },
    async scroll(dy) {
      drove();
      await ensure().webContents.executeJavaScript(`window.scrollBy({ top: ${Number(dy) || 0}, behavior: "smooth" })`, true);
    },
    async screenshot() {
      const image = await ensure().webContents.capturePage();
      return image.toPNG();
    },
    console() {
      return [...consoleLines];
    },
    state() {
      const wc = view?.webContents;
      return { url: wc?.getURL() ?? "", title: wc?.getTitle() ?? "" };
    },
    reveal() {
      win()?.webContents.send("multicode:browser-reveal");
    },
  });
}
