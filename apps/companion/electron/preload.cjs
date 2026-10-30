const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("companion", {
  isDesktop: true,
  ring: (on) => ipcRenderer.send("ring", Boolean(on)),
  info: () => ipcRenderer.invoke("app-info"),
  setAutostart: (on) => ipcRenderer.invoke("set-autostart", Boolean(on)),
});
