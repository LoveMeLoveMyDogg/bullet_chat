const { Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

function buildMenu({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode, onToggleDemo, onToggleScreenPause, paused = false, localMode = false, demo = false, screenPaused = false }) {
  return Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: paused ? '继续弹幕' : '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: localMode, click: onToggleLocalMode },
    { label: '暂停屏幕识别', type: 'checkbox', checked: screenPaused, click: onToggleScreenPause },
    { label: '演示模式（模拟事件）', type: 'checkbox', checked: demo, click: onToggleDemo },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
}

function createTray(opts) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('BulletChat 桌面弹幕直播');
  const rebuild = () => {
    const state = opts.getState ? opts.getState() : {};
    tray.setContextMenu(buildMenu({
      onQuit: opts.onQuit,
      onOpenSettings: opts.onOpenSettings,
      onTogglePause: () => { opts.onTogglePause(); rebuild(); },
      onToggleLocalMode: () => { opts.onToggleLocalMode(); rebuild(); },
      onToggleDemo: () => { opts.onToggleDemo(); rebuild(); },
      onToggleScreenPause: () => { opts.onToggleScreenPause(); rebuild(); },
      paused: !!state.paused,
      localMode: !!state.localMode,
      demo: !!state.demo,
      screenPaused: !!state.screenPaused,
    }));
  };
  rebuild();
  return tray;
}

module.exports = { createTray, buildMenu };
