const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("veilDesktop", {
  onNavigate: (callback) => {
    if (typeof callback !== "function") throw new TypeError("A callback is required.");
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("veil:navigate", listener);
    return () => ipcRenderer.removeListener("veil:navigate", listener);
  },
  onFocusAddress: (callback) => {
    if (typeof callback !== "function") throw new TypeError("A callback is required.");
    const listener = () => callback();
    ipcRenderer.on("veil:focus-address", listener);
    return () => ipcRenderer.removeListener("veil:focus-address", listener);
  },
});
