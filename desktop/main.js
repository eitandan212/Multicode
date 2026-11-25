// MultiCode desktop: starts the local MultiCode server inside Electron and shows it in a
// window. Everything stays on this computer; the window only ever loads the local app.
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png");

/** @type {BrowserWindow | null} */
let win = null;
/** @type {{ url: string, server: import("node:http").Server } | null} */
let started = null;

// One MultiCode at a time: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(launch);
}

app.setAppUserModelId("com.multicode.desktop");

async function launch() {
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
  try {
    const { startServer } = await import("../dist/server/start.js");
    started = await startServer({ port: 4317 });
  } catch (err) {
    dialog.showErrorBox("MultiCode couldn't start", String(err?.stack ?? err));
    app.quit();
    return;
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: "MultiCode",
    icon: ICON,
    show: false,
    backgroundColor: dark ? "#0b0d0c" : "#f5f5ef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  const origin = new URL(started.url).origin;
  const isOwn = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  // Links that open a new window (previews, docs) go to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window itself never navigates away from MultiCode.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isOwn(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });
  void win.loadURL(started.url);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  started?.server.close();
});
