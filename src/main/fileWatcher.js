const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 事件分类辅助：仅 Windows 有盘符概念；macOS 监控的是目录，弹幕文案不显示盘符前缀
function driveOf(root) {
  return process.platform === 'win32' ? root.slice(0, 2) : '';
}

// Windows：枚举固定盘符（A:\ ~ Z:\）
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

// 跨平台监控根：Windows 走盘符；macOS 监控家目录 + 外接卷（/ 全盘监听太大且含系统目录）
function listWatchRoots() {
  if (process.platform === 'darwin') {
    const roots = [];
    const home = os.homedir();
    if (home) roots.push(home);
    let volumes = [];
    try { volumes = fs.readdirSync('/Volumes'); } catch { /* /Volumes 不可读则忽略 */ }
    for (const name of volumes) {
      if (name.startsWith('.')) continue;
      const p = path.join('/Volumes', name);
      let real = p;
      try { real = fs.realpathSync(p); } catch { continue; } // 卷不可达则忽略
      if (real === '/') continue; // 启动盘（常见为指向 / 的符号链接）：内容已被家目录覆盖
      if (home && home.startsWith(real + path.sep)) continue; // 家目录在该卷内（firmlink 等）：监控卷 = 重复监听
      if (home && (p + path.sep).startsWith(home)) continue; // 卷路径在家目录内（罕见），已覆盖
      if (!roots.includes(p)) roots.push(p);
    }
    return roots;
  }
  return listFixedDrives();
}

// 事件分类（stat + mtime，不依赖 fs.watch 的 eventType 语义——macOS 上 FSEvents 把所有事件都报为 rename）：
// - stat 失败 → delete（并从 seen 移除）
// - stat 成功：eventType 为 'change'（Windows 语义准确，直接采信），或 mtime 与上次不同 → change；否则 → create
// - 根目录自身的元数据事件（macOS FSEvents 会报 filename=根目录名且路径不存在）→ 返回 null 跳过
function classifyEntry(root, full, eventType, seen = new Map()) {
  const name = path.basename(full);
  let stats = null;
  try { stats = fs.statSync(full); } catch { stats = null; }
  if (!stats) {
    seen.delete(full);
    // macOS FSEvents 对监视根目录自身发元数据事件（路径不存在）；Windows 盘符根 basename 为空串不会误中。
    // 边角：删除一个与根目录同名的真实文件会被跳过（macOS 上极罕见，可接受）
    if (name === path.basename(root)) return null;
    return { source: 'file', type: 'delete', name, path: full, drive: driveOf(root), isDir: false };
  }
  const mtime = stats.mtimeMs;
  const prev = seen.get(full);
  seen.set(full, mtime);
  // change 判定需要该路径已被见过（首次见到一律 create：Windows 首个事件必为 rename 新建，
  // macOS 上新建即被改的合并事件也可能以 change 类型先到，不能据 eventType 误判）
  if (prev !== undefined && (eventType === 'change' || prev !== mtime)) {
    return { source: 'file', type: 'change', name, path: full, drive: driveOf(root), isDir: stats.isDirectory() };
  }
  return { source: 'file', type: 'create', name, path: full, drive: driveOf(root), isDir: stats.isDirectory() };
}

class FileWatcher {
  constructor({ drives = listWatchRoots(), filter = null, onEvent, onError, onRecovered }) {
    this.drives = drives;
    this.filter = filter || (() => false);
    this.onEvent = onEvent;
    this.onError = onError;
    this.onRecovered = onRecovered;
    this.watchers = new Map(); // root -> fs.FSWatcher
    this.seenMtimes = new Map(); // path -> mtimeMs（区分新建/修改，macOS 全 rename 场景）
    this.stopped = false;
    this.remountTimers = new Map(); // root -> 重挂定时器（每 root 独立，互不覆盖）
  }

  handleEvent(root, eventType, filename) {
    if (!filename) return;
    const full = path.join(root, filename.toString());
    const entry = classifyEntry(root, full, eventType, this.seenMtimes);
    if (!entry) return; // 根目录元数据事件等，跳过
    // 防长期运行内存增长：超限清空（清空后既有路径会短暂误报为新建，可接受的优雅降级）
    if (this.seenMtimes.size > 20000) this.seenMtimes.clear();
    if (this.filter(entry)) return;
    this.onEvent(entry);
  }

  start() {
    this.stopped = false;
    for (const root of this.drives) {
      try {
        const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
          this.handleEvent(root, eventType, filename);
        });
        w.on('error', (err) => this.remount(root, err));
        this.watchers.set(root, w);
      } catch (err) {
        this.onError?.(new Error(`无法监听 ${root}：${err.message}`));
      }
    }
  }

  remount(root, err) {
    if (this.stopped) return; // stop() 后的重挂窗口内不再重建
    this.onError?.(new Error(`监控 ${root} 失效：${err.message}`));
    try { this.watchers.get(root)?.close(); } catch { /* 已失效 */ }
    this.watchers.delete(root);
    // 每 root 独立重挂定时器：两个盘符先后失效互不覆盖（旧实现单槽会丢先失效的根）
    clearTimeout(this.remountTimers.get(root));
    const timer = setTimeout(() => {
      this.remountTimers.delete(root);
      if (this.stopped) return;
      try {
        const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
          this.handleEvent(root, eventType, filename);
        });
        w.on('error', (e2) => this.remount(root, e2));
        this.watchers.set(root, w);
        this.onRecovered?.(root); // 重挂成功：上报恢复
      } catch (e2) {
        this.onError?.(new Error(`重新监听 ${root} 失败：${e2.message}`));
      }
    }, 5000);
    timer.unref?.();
    this.remountTimers.set(root, timer);
  }

  stop() {
    this.stopped = true;
    for (const t of this.remountTimers.values()) clearTimeout(t);
    this.remountTimers.clear();
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* 忽略 */ }
    }
    this.watchers.clear();
  }

  getStatus() {
    return this.drives.map((root) => ({ root, watching: this.watchers.has(root) }));
  }
}

module.exports = { listFixedDrives, listWatchRoots, FileWatcher, classifyEntry };
