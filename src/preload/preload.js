const { contextBridge, ipcRenderer } = require('electron');
const danmakuStyle = require('../shared/danmakuStyle');

contextBridge.exposeInMainWorld('danmakuStyle', danmakuStyle);

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
  getUsageStats: () => ipcRenderer.invoke('settings:getUsageStats'),
  getDisplays: () => ipcRenderer.invoke('settings:getDisplays'),
  getDisplayPreview: (id) => ipcRenderer.invoke('settings:getDisplayPreview', id),
  getRequestLogs: () => ipcRenderer.invoke('settings:getRequestLogs'),
  openLogDir: () => ipcRenderer.invoke('settings:openLogDir'),
  onStatus: (cb) => ipcRenderer.on('status-changed', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('processor', {
  onProcess: (cb) => ipcRenderer.on('process:image', (_e, payload) => cb(payload)),
  resolveProcess: (id, dataUrl) => ipcRenderer.send('process:resolve', { id, dataUrl }),
  errorProcess: (id, message) => ipcRenderer.send('process:error', { id, message }),
});

contextBridge.exposeInMainWorld('updater', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  cancel: () => ipcRenderer.invoke('updater:cancel'),
  ignoreVersion: (v) => ipcRenderer.invoke('updater:ignoreVersion', v),
  getState: () => ipcRenderer.invoke('updater:getState'),
  onProgress: (cb) => ipcRenderer.on('updater:progress', (_e, p) => cb(p)),
});
