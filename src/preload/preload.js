const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onDanmaku: (cb) => ipcRenderer.on('danmaku', (_e, payload) => cb(payload)),
  getStageConfig: () => ipcRenderer.invoke('stage:getConfig'),
  onStageConfig: (cb) => ipcRenderer.on('stage-config', (_e, cfg) => cb(cfg)),
});

contextBridge.exposeInMainWorld('settings', {
  getConfig: () => ipcRenderer.invoke('settings:getConfig'),
  saveConfig: (cfg) => ipcRenderer.invoke('settings:saveConfig', cfg),
  testText: (cfg) => ipcRenderer.invoke('settings:testText', cfg),
  testVision: (cfg) => ipcRenderer.invoke('settings:testVision', cfg),
  getStatus: () => ipcRenderer.invoke('settings:getStatus'),
  getDisplays: () => ipcRenderer.invoke('settings:getDisplays'),
  getDisplayPreview: (id) => ipcRenderer.invoke('settings:getDisplayPreview', id),
  onStatus: (cb) => ipcRenderer.on('status-changed', (_e, s) => cb(s)),
});
