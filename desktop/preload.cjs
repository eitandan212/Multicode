// The only bridge from the page to Electron: the page reports its theme so the window buttons,
// drawn over the app's top bar, match it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("multicodeDesktop", {
  setTheme: (theme) => ipcRenderer.send("multicode:theme", String(theme)),
  pickFolder: () => ipcRenderer.invoke("multicode:pick-folder"),
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
