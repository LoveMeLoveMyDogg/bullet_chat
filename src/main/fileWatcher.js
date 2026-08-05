const fs = require('node:fs');
const path = require('node:path');

function listFixedDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c);
    try {
      if (fs.existsSync(d + ':\\')) out.push(d + ':\\');
    } catch { /* 跳过不可访问盘符 */ }
  }
  return out;
}

function classifyEntry(root, full, eventType) {
  const name = path.basename(full);
  let isDir = false;
  if (eventType === 'change') {
    return { source: 'file', type: 'change', name, path: full, drive: root.slice(0, 2), isDir: false };
  }
  // fs.watch 的 rename 事件：存在 → 新建，不存在 → 删除（改名表现为删除+新建两条，可接受）
  let exists = false;
  try { exists = fs.statSync(full); } catch { exists = false; }
  if (exists) {
    try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
    return { source: 'file', type: 'create', name, path: full, drive: root.slice(0, 2), isDir };
  }
  return { source: 'file', type: 'delete', name, path: full, drive: root.slice(0, 2), isDir };
}

class FileWatcher {
  constructor({ drives = listFixedDrives(), filter = null, onEvent, onError }) {
    this.drives = drives;
    this.filter = filter || (() => false);
    this.onEvent = onEvent;
    this.onError = onError;
    this.watchers = new Map(); // root -> fs.FSWatcher
  }

  start() {
    for (const root of this.drives) {
      try {
        const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const full = path.join(root, filename.toString());
          const entry = classifyEntry(root, full, eventType);
          if (this.filter(entry)) return;
          this.onEvent(entry);
        });
        w.on('error', (err) => this.remount(root, err));
        this.watchers.set(root, w);
      } catch (err) {
        this.onError?.(new Error(`无法监听 ${root}：${err.message}`));
      }
    }
  }

  remount(root, err) {
    this.onError?.(new Error(`监控 ${root} 失效：${err.message}`));
    try { this.watchers.get(root)?.close(); } catch { /* 已失效 */ }
    this.watchers.delete(root);
    setTimeout(() => {
      try {
        const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const full = path.join(root, filename.toString());
          const entry = classifyEntry(root, full, eventType);
          if (this.filter(entry)) return;
          this.onEvent(entry);
        });
        w.on('error', (e2) => this.remount(root, e2));
        this.watchers.set(root, w);
      } catch (e2) {
        this.onError?.(new Error(`重新监听 ${root} 失败：${e2.message}`));
      }
    }, 5000);
  }

  stop() {
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* 忽略 */ }
    }
    this.watchers.clear();
  }

  getStatus() {
    return this.drives.map((root) => ({ root, watching: this.watchers.has(root) }));
  }
}

module.exports = { listFixedDrives, FileWatcher, classifyEntry };
