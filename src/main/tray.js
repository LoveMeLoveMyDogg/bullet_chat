const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

function createTray({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('BulletChat 桌面弹幕直播');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: false, click: onToggleLocalMode },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]));
  return tray;
}

module.exports = { createTray };
