const { BrowserWindow } = require('electron');
const path = require('node:path');

class ImageProcessor {
  constructor({ preloadPath }) {
    this.preloadPath = preloadPath;
    this.win = null;
    this.pending = new Map(); // id -> {resolve, reject}
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
      this.pending.set(id, { resolve, reject });
      this.win.webContents.send('process:image', { id, dataUrl, masks });
    });
  }

  resolve(id, result) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.resolve(result); }
  }

  reject(id, err) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.reject(err); }
  }
}

module.exports = { ImageProcessor };
