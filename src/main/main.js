const { app } = require('electron');
const { createTray } = require('./tray');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0); // app.exit 在 ready 前也生效；quit() 在 Windows/Electron 37 上失效
} else {
  app.on('second-instance', () => { /* 已有实例在运行，保持存活 */ });

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
