const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  openWeb: () => ipcRenderer.invoke('usage:open-web'),
  openAbout: () => ipcRenderer.invoke('external:open-repo'),
  prepareAddAccount: () => ipcRenderer.invoke('accounts:prepare-add'),
  importCurrentAccount: () => ipcRenderer.invoke('accounts:import-current'),
  switchAccount: (id, strategy) => ipcRenderer.invoke('accounts:switch', id, strategy),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  refreshLocalTokenSummary: () => ipcRenderer.invoke('local-token-summary:refresh'),
  setSize: (size) => ipcRenderer.invoke('window:set-size', size),
  setPanelHeight: (height) => ipcRenderer.invoke('window:set-panel-height', height),
  moveBy: (delta) => ipcRenderer.invoke('window:move-by', delta),
  setDetailOpen: (open) => ipcRenderer.invoke('window:set-detail-open', open),
  quit: () => ipcRenderer.invoke('app:quit'),
  onSnapshot: (callback) => ipcRenderer.on('usage-data', (_event, value) => callback(value))
});
