const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  openWeb: () => ipcRenderer.invoke('usage:open-web'),
  setSize: (size) => ipcRenderer.invoke('window:set-size', size),
  moveBy: (delta) => ipcRenderer.invoke('window:move-by', delta),
  setDetailOpen: (open) => ipcRenderer.invoke('window:set-detail-open', open),
  quit: () => ipcRenderer.invoke('app:quit'),
  onSnapshot: (callback) => ipcRenderer.on('usage-data', (_event, value) => callback(value))
});
