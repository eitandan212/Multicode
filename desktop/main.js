// MultiCode desktop: starts the local MultiCode server inside Electron and shows it in a
// window. Everything stays on this computer; the window only ever loads the local app.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerSaveBlocker, safeStorage, screen, shell } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate, installUpdate } from "./updater.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png");

// As in T3 Code: no native title bar. The window buttons are drawn over the app's own top bar
// (Windows/Linux: a transparent caption-button overlay; macOS: inset traffic lights).
const TOPBAR_HEIGHT = 52;
const TITLEBAR_COLOR = "#01000000"; // fully transparent #00000000 misbehaves on Linux
const SYMBOL_LIGHT = "#1f2937";
const SYMBOL_DARK = "#f8fafc";

function titleBarOptions(dark) {
  if (process.platform === "darwin")
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: TOPBAR_HEIGHT / 2 - 6 } };
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: TITLEBAR_COLOR, height: TOPBAR_HEIGHT, symbolColor: dark ? SYMBOL_DARK : SYMBOL_LIGHT },
  };
}

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

/**
 * The key that encrypts saved API keys lives in the OS keychain (Windows DPAPI, macOS Keychain,
 * Linux secret service), not in a readable file. The server gets it through the environment.
 */
function secretKeyFromKeychain() {
  if (!safeStorage.isEncryptionAvailable()) return;
  const dir = process.env.MULTICODE_HOME ?? path.join(os.homedir(), ".multicode");
  const sealed = path.join(dir, "secret.key.sealed");
  const plain = path.join(dir, "secret.key");
  let key;
  if (existsSync(sealed)) key = safeStorage.decryptString(readFileSync(sealed));
  else {
    // A key made before (by the server alone) moves into the keychain; otherwise a new one.
    key = existsSync(plain) ? readFileSync(plain, "utf8").trim() : randomBytes(32).toString("base64");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(sealed, safeStorage.encryptString(key), { mode: 0o600 });
  }
  if (existsSync(plain)) rmSync(plain, { force: true });
  process.env.MULTICODE_SECRET_KEY = key;
}

async function launch() {
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
  try {
    secretKeyFromKeychain();
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
    backgroundColor: dark ? "#000000" : "#fcfcfc",
    autoHideMenuBar: true,
    ...titleBarOptions(dark),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
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

  // The app's own theme choice drives the window buttons' colour.
  const syncTitleBar = () => {
    if (!win || win.isDestroyed()) return;
    const isDark = nativeTheme.shouldUseDarkColors;
    win.setBackgroundColor(isDark ? "#000000" : "#fcfcfc");
    const { titleBarOverlay } = titleBarOptions(isDark);
    if (titleBarOverlay) win.setTitleBarOverlay(titleBarOverlay);
  };
  nativeTheme.on("updated", syncTitleBar);
  win.on("closed", () => nativeTheme.off("updated", syncTitleBar));

  win.once("ready-to-show", () => win?.show());
  // The pet appears when MultiCode goes out of sight, and steps aside when it's back.
  for (const ev of ["minimize", "restore", "show", "hide"]) win.on(ev, () => refreshPet());
  win.on("closed", () => {
    win = null;
    refreshPet();
  });
  void win.loadURL(started.url);
}

// ---- The pet: a small always-on-top window in the corner of the screen ----
// It keeps you company only while MultiCode itself is out of sight (minimized or hidden):
// with the app open on screen, the app shows everything and the pet steps aside.
let pet = null;
let petWanted = false;
const PET_W = 360;
const PET_H = 340;
function mainOnScreen() {
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}
function refreshPet() {
  if (!petWanted) {
    if (pet && !pet.isDestroyed()) pet.close();
    pet = null;
    return;
  }
  if (!pet || pet.isDestroyed()) createPet();
  if (mainOnScreen()) pet.hide();
  else if (!pet.isVisible() && pet.webContents.getURL()) pet.showInactive();
}
function setPet(on) {
  petWanted = on;
  refreshPet();
}
function createPet() {
  const area = screen.getPrimaryDisplay().workArea;
  pet = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x: area.x + area.width - PET_W - 12,
    y: area.y + area.height - PET_H - 12,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    title: "MultiCode pet",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pet.setAlwaysOnTop(true, "floating");
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pet.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pet.webContents.on("will-navigate", (event) => event.preventDefault());
  pet.once("ready-to-show", () => {
    if (pet && !mainOnScreen()) pet.showInactive();
  });
  pet.on("closed", () => {
    pet = null;
  });
  void pet.loadURL(`${started.url.replace(/\/$/, "")}/?pet=1`);
}
/** MultiCode to the front (from the pet). */
function showApp() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const fromApp = (event) =>
  (win && event.sender === win.webContents) || (pet && !pet.isDestroyed() && event.sender === pet.webContents);

ipcMain.on("multicode:set-pet", (event, on) => {
  if (!win || event.sender !== win.webContents) return;
  setPet(on === true);
});
// The pet's "Open": bring MultiCode to the front on that chat.
ipcMain.on("multicode:open-run", (event, runId) => {
  if (!fromApp(event) || typeof runId !== "string" || !/^[0-9a-f-]{36}$/.test(runId)) return;
  showApp();
  win.webContents.send("multicode:open-run", runId);
});
const fromPet = (event) => pet && !pet.isDestroyed() && event.sender === pet.webContents;
// A click on the pet opens MultiCode.
ipcMain.on("multicode:show-app", (event) => {
  if (fromPet(event)) showApp();
});
// Dragging the pet moves its window (a drag region would swallow the click).
ipcMain.on("multicode:pet-move", (event, dx, dy) => {
  if (!fromPet(event) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = pet.getPosition();
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  const nx = Math.round(Math.min(Math.max(x + dx, area.x - PET_W + 80), area.x + area.width - 80));
  const ny = Math.round(Math.min(Math.max(y + dy, area.y - PET_H + 80), area.y + area.height - 80));
  pet.setPosition(nx, ny);
});

// The page tells us the theme it shows ("system", "light" or "dark").
ipcMain.on("multicode:theme", (event, theme) => {
  if (!win || event.sender !== win.webContents) return;
  if (theme === "system" || theme === "light" || theme === "dark") nativeTheme.themeSource = theme;
});

// Updates: the page asks; progress goes back to it.
ipcMain.handle("multicode:update-check", async (event) => {
  if (!win || event.sender !== win.webContents) return null;
  const { latest: _l, ...info } = await checkForUpdate();
  return info;
});
ipcMain.handle("multicode:update-install", async (event) => {
  if (!win || event.sender !== win.webContents) return null;
  const r = await installUpdate((p) => {
    if (win && !win.isDestroyed()) win.webContents.send("multicode:update-progress", p);
  });
  return { version: r.version };
});

// Sleep mode: while the crew works on its own, the computer must not go to sleep (the screen
// may still turn off).
let awakeId = -1;
ipcMain.on("multicode:keep-awake", (event, on) => {
  if (!win || event.sender !== win.webContents) return;
  if (on && awakeId < 0) awakeId = powerSaveBlocker.start("prevent-app-suspension");
  if (!on && awakeId >= 0) {
    powerSaveBlocker.stop(awakeId);
    awakeId = -1;
  }
});

// "Show in folder": opens a path in Explorer / Finder (it must exist).
ipcMain.handle("multicode:open-path", async (event, target) => {
  if (!win || event.sender !== win.webContents || typeof target !== "string" || !target) return false;
  const { existsSync } = await import("node:fs");
  if (!existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});

// "Open folder": the native folder picker.
ipcMain.handle("multicode:pick-folder", async (event) => {
  if (!win || event.sender !== win.webContents) return null;
  const r = await dialog.showOpenDialog(win, { title: "Open a project folder", properties: ["openDirectory"] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  started?.server.close();
});
