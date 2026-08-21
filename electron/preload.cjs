const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumenfold", {
  isDesktop: true,
  ensureRelay: () => ipcRenderer.invoke("relay:ensure"),
  getRelayInfo: () => ipcRenderer.invoke("relay:info"),
});
