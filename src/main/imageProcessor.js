const { BrowserWindow } = require('electron');
const path = require('node:path');

const PROCESS_TIMEOUT_MS = 15000; // 隐藏窗口处理挂死时兜底，避免 Brain 一直等

class ImageProcessor {
  constructor({ preloadPath }) {
    this.preloadPath = preloadPath;
    this.win = null;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.nextId = 1;
  }

  async init() {
    if (this.win && !this.win.isDestroyed()) return;
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { preload: this.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    await this.win.loadFile(path.join(__dirname, '..', 'renderer', 'processor', 'processor.html'));
  }

  async process(dataUrl, masks) {
    if (!this.win || this.win.isDestroyed()) await this.init();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`图片处理超时（${PROCESS_TIMEOUT_MS / 1000} 秒）`));
      }, PROCESS_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.win.webContents.send('process:image', { id, dataUrl, masks });
    });
  }

  resolve(id, result) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); clearTimeout(p.timer); p.resolve(result); }
  }

  reject(id, err) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); clearTimeout(p.timer); p.reject(err); }
  }
}

module.exports = { ImageProcessor };
