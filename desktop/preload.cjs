// The only bridge from the page to Electron: the page reports its theme so the window buttons,
// drawn over the app's top bar, match it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("multicodeDesktop", {
  setTheme: (theme) => ipcRenderer.send("multicode:theme", String(theme)),
});
