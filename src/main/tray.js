const { Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

function buildMenu({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode, onToggleDemo, onToggleScreenPause, onCheckUpdate, paused = false, localMode = false, demo = false, screenPaused = false }) {
  return Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: paused ? '继续弹幕' : '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: localMode, click: onToggleLocalMode },
    { label: '暂停屏幕识别', type: 'checkbox', checked: screenPaused, click: onToggleScreenPause },
    { label: '演示模式（模拟事件）', type: 'checkbox', checked: demo, click: onToggleDemo },
    { label: '检查更新', click: onCheckUpdate },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
}

function createTray(opts) {
  // 图标：macOS 用黑色 template（系统自动适配深浅色菜单栏）；
  // Windows 无 template 机制，纯黑气泡在深色任务栏不可见，用彩色版
  const iconName = process.platform === 'darwin' ? 'tray.png' : 'tray-win.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', iconName));
  // macOS 菜单栏用 template image（黑色+透明），系统自动适配深浅色模式
  if (process.platform === 'darwin') icon.setTemplateImage(true);
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
      onCheckUpdate: opts.onCheckUpdate,
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
