const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

class Stage {
  constructor({ preloadPath }) {
    this.preloadPath = preloadPath;
    this.windows = new Map(); // display.id -> BrowserWindow
    this.config = { maxConcurrent: 6, animationsEnabled: true };
  }

  start() {
    for (const display of screen.getAllDisplays()) this.addWindow(display);
    screen.on('display-added', (_e, display) => this.addWindow(display));
    screen.on('display-removed', (_e, display) => this.removeWindow(display));
    screen.on('display-metrics-changed', (_e, display) => this.syncWindow(display));
  }

  addWindow(display) {
    if (this.windows.has(display.id)) return;
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload 需要 require 本地共享模块（danmakuStyle）
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    // 内容保护：弹幕窗口从屏幕捕获（desktopCapturer/录屏）中排除。
    // 否则弹幕动画会持续触发视觉变化检测 → 截图又生成新弹幕 → 自激循环烧 API 额度
    win.setContentProtection(true);
    // 窗口被销毁（显示器热插拔/睡眠唤醒等 display 事件竞态）时同步清理 Map，
    // 防止 send 打到已销毁的 webContents 抛 "Object has been destroyed"
    win.on('closed', () => {
      if (this.windows.get(display.id) === win) this.windows.delete(display.id);
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'stage', 'danmaku.html'));
    this.windows.set(display.id, win);
  }

  removeWindow(display) {
    const win = this.windows.get(display.id);
    if (win) { win.destroy(); this.windows.delete(display.id); }
  }

  syncWindow(display) {
    const win = this.windows.get(display.id);
    if (win) {
      win.setBounds({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height });
    }
  }

  send(text, meta = {}) {
    // 过滤已销毁窗口（closed 清理之外的第二道防线，防 display 事件竞态）
    const wins = [...this.windows.values()].filter((w) => !w.isDestroyed());
    if (wins.length === 0) return;
    const win = wins[Math.floor(Math.random() * wins.length)];
    win.webContents.send('danmaku', { text, meta });
  }

  updateConfig(danmakuCfg) {
    this.config = { ...this.config, ...danmakuCfg };
    for (const win of this.windows.values()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('stage-config', this.config);
    }
  }

  stop() {
    screen.removeAllListeners();
    for (const win of this.windows.values()) win.destroy();
    this.windows.clear();
  }
}

module.exports = { Stage };
