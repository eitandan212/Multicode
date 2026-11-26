// The only bridge from the page to Electron: the page reports its theme so the window buttons,
// drawn over the app's top bar, match it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("multicodeDesktop", {
  setTheme: (theme) => ipcRenderer.send("multicode:theme", String(theme)),
  pickFolder: () => ipcRenderer.invoke("multicode:pick-folder"),
  openPath: (p) => ipcRenderer.invoke("multicode:open-path", String(p)),
  setPet: (on) => ipcRenderer.send("multicode:set-pet", on === true),
  openRun: (runId) => ipcRenderer.send("multicode:open-run", String(runId)),
  showApp: () => ipcRenderer.send("multicode:show-app"),
  // The in-app browser (Browser tab).
  browser: {
    setBounds: (rect) => ipcRenderer.send("multicode:browser-bounds", rect ? { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) } : null),
    go: (action) => ipcRenderer.send("multicode:browser-go", typeof action === "string" ? action : { url: String(action?.url ?? "") }),
    get: () => ipcRenderer.invoke("multicode:browser-get"),
    onState: (fn) => {
      const listener = (_e, s) => fn(s);
      ipcRenderer.on("multicode:browser-state", listener);
      return () => ipcRenderer.removeListener("multicode:browser-state", listener);
    },
    onReveal: (fn) => {
      const listener = () => fn();
      ipcRenderer.on("multicode:browser-reveal", listener);
      return () => ipcRenderer.removeListener("multicode:browser-reveal", listener);
    },
  },
  movePet: (dx, dy) => ipcRenderer.send("multicode:pet-move", Number(dx), Number(dy)),
  onOpenRun: (fn) => {
    const listener = (_e, id) => fn(String(id));
    ipcRenderer.on("multicode:open-run", listener);
    return () => ipcRenderer.removeListener("multicode:open-run", listener);
  },
  keepAwake: (on) => ipcRenderer.send("multicode:keep-awake", Boolean(on)),
  update: {
    check: () => ipcRenderer.invoke("multicode:update-check"),
    install: () => ipcRenderer.invoke("multicode:update-install"),
    onProgress: (fn) => {
      const listener = (_e, p) => fn(Number(p));
      ipcRenderer.on("multicode:update-progress", listener);
      return () => ipcRenderer.removeListener("multicode:update-progress", listener);
    },
  },
});
