const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onDanmaku: (cb) => ipcRenderer.on('danmaku', (_e, payload) => cb(payload)),
  getStageConfig: () => ipcRenderer.invoke('stage:getConfig'),
  onStageConfig: (cb) => ipcRenderer.on('stage-config', (_e, cfg) => cb(cfg)),
});
