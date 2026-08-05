const { app } = require('electron');
const { createTray } = require('./tray');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => app.quit());

  app.whenReady().then(() => {
    // 托盘常驻，关闭所有窗口也不退出
    const tray = createTray({
      onQuit: () => app.quit(),
      onOpenSettings: () => {},          // Task 10 接入设置窗口
      onTogglePause: () => {},
      onToggleLocalMode: () => {},
    });
    global.__tray = tray; // 防 GC（Electron 托盘对象需保活）
  });

  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
}
