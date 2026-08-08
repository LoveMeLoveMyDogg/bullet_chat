const { BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('node:path');

let win = null;
let handlers = null;

function createSettingsWindow({ preloadPath }) {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
  win = new BrowserWindow({
    width: 760,
    height: 640,
    title: 'BulletChat 设置',
    resizable: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'settings.html'));
  win.on('closed', () => { win = null; });
  return win;
}

function registerSettingsIpc({ getConfig, saveConfig, onConfigSaved, updater }) {
  handlers = { getConfig, saveConfig, onConfigSaved };
  ipcMain.handle('settings:getConfig', () => handlers.getConfig());
  ipcMain.handle('settings:saveConfig', (_e, cfg) => {
    // 忽略版本由主进程单独管理，设置页快照可能过期：保存时合并回写，防止把「忽略」清掉
    cfg.system.ignoredUpdateVersion = handlers.getConfig().system.ignoredUpdateVersion;
    const saved = handlers.saveConfig(cfg);
    handlers.onConfigSaved(saved);
    return saved;
  });
  ipcMain.handle('settings:getDisplays', () =>
    screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, label: `显示器 ${d.id}` }))
  );
  ipcMain.handle('settings:getDisplayPreview', async (_e, displayId) => {
    // screen.getAllDisplays 与 desktopCapturer sources 顺序一致（主屏在前），按序号对应
    const displays = screen.getAllDisplays();
    const idx = displays.findIndex((d) => String(d.id) === String(displayId));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 640, height: 360 },
    });
    const src = sources[idx] || sources[0];
    return src ? { displayId: src.display_id, dataUrl: src.thumbnail.toDataURL() } : null;
  });
  if (updater) {
    ipcMain.handle('updater:check', () => updater.check({ silent: false }));
    ipcMain.handle('updater:download', () => updater.download());
    ipcMain.handle('updater:cancel', () => updater.cancel());
    ipcMain.handle('updater:ignoreVersion', (_e, v) => updater.ignoreVersion(v));
    ipcMain.handle('updater:getState', () => updater.getState());
    updater.onProgress((p) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updater:progress', p);
    });
  }
}

module.exports = { createSettingsWindow, registerSettingsIpc };
