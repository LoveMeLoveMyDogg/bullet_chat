const { Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { parseManifest, evaluateManifest, downloadToFile } = require('../shared/updaterCore');

const UPDATE_URL = 'https://updates.zhipengcoding.com/version.json';
const FETCH_TIMEOUT_MS = 10000;
const STARTUP_CHECK_DELAY_MS = 5000;

// Notification 必须保留实例，否则被 GC 后 click 事件丢失（Electron 已知行为）
const liveNotifications = new Set();

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return p;
}

class Updater {
  constructor({ version, getDownloadsDir, openPath, getIgnoredVersion, setIgnoredVersion, onOpenSettings }) {
    this.version = version;
    this.getDownloadsDir = getDownloadsDir;
    this.openPath = openPath;
    this.getIgnoredVersion = getIgnoredVersion;
    this.setIgnoredVersion = setIgnoredVersion;
    this.onOpenSettings = onOpenSettings;
    this.state = 'idle';
    this.lastResult = null;
    this.message = '';
    this.progress = null;
    this.checking = false;
    this.downloading = false;
    this.abortController = null;
    this._progressCbs = [];
  }

  onProgress(cb) { this._progressCbs.push(cb); }
  _emitProgress(p) { this.progress = p; for (const cb of this._progressCbs) cb(p); }

  showNotification(title, body, onClick) {
    try {
      const n = new Notification({ title, body });
      liveNotifications.add(n);
      n.on('close', () => liveNotifications.delete(n));
      if (onClick) n.on('click', onClick);
      n.show();
    } catch { /* 通知失败忽略（如无通知权限） */ }
  }

  async check({ silent = false } = {}) {
    if (this.checking || this.downloading) return { status: 'checking' };
    this.checking = true;
    this.state = 'checking';
    try {
      const res = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = parseManifest(await res.text());
      const result = evaluateManifest({
        manifest,
        currentVersion: this.version,
        platform: process.platform,
        arch: process.arch,
        ignoredVersion: this.getIgnoredVersion() || '',
      });
      this.lastResult = result;
      this.message = result.message || '';
      const s = result.status;
      this.state = s === 'update-available' ? 'available' : s === 'up-to-date' ? 'idle' : s;
      return result;
    } catch (err) {
      this.state = 'error';
      this.message = err.message;
      this.lastResult = { status: 'error', message: err.message };
      if (!silent) this.showNotification('检查更新失败', err.message);
      return this.lastResult;
    } finally {
      this.checking = false;
    }
  }

  async download() {
    if (this.downloading) return { ok: false, message: '下载已在进行' };
    if (this.state !== 'available' || !this.lastResult?.entry) return { ok: false, message: '没有可下载的版本' };
    this.downloading = true;
    this.abortController = new AbortController();
    this.state = 'downloading';
    this.message = '';
    this.progress = { percent: 0, downloaded: 0, total: 0 };
    const entry = this.lastResult.entry;
    try {
      const dir = await this.getDownloadsDir();
      const baseName = path.basename(new URL(entry.url).pathname) || 'BulletChat-installer';
      const dest = uniquePath(path.join(dir, baseName));
      this.showNotification('更新下载', `开始下载 v${this.lastResult.latestVersion}（${baseName}）`);
      await downloadToFile({
        url: entry.url,
        dest,
        sha256: entry.sha256,
        signal: this.abortController.signal,
        onProgress: (p) => this._emitProgress(p),
      });
      this.state = 'done';
      this.message = '已下载，正在打开安装包';
      this.openPath(dest).catch(() => { /* 打开失败不阻塞状态 */ });
      this.showNotification('更新下载完成', `${baseName} 已保存，正在打开安装包`);
      return { ok: true, dest };
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        this.state = 'idle';
        this.message = '已取消';
      } else {
        this.state = 'error';
        this.message = /sha256/.test(err.message || '') ? '校验失败，请重试' : '下载失败，请重试';
      }
      return { ok: false, message: this.message };
    } finally {
      this.downloading = false;
      this.abortController = null;
    }
  }

  cancel() {
    this.abortController?.abort();
  }

  ignoreVersion(version) {
    this.setIgnoredVersion(version);
    this.state = 'ignored';
    if (this.lastResult) this.lastResult = { ...this.lastResult, status: 'ignored' };
  }

  getState() {
    return {
      state: this.state,
      currentVersion: this.version,
      latestVersion: this.lastResult?.latestVersion || null,
      notes: this.lastResult?.notes || null,
      message: this.message,
      progress: this.progress,
    };
  }

  startupCheck() {
    setTimeout(() => {
      this.check({ silent: true }).then((r) => {
        if (r.status === 'update-available') {
          this.showNotification(`发现新版本 v${r.latestVersion}`, r.notes ? r.notes.split('\n')[0] : '点击打开设置页下载安装包', () => this.onOpenSettings?.());
        }
      });
    }, STARTUP_CHECK_DELAY_MS);
  }
}

module.exports = { Updater, UPDATE_URL, FETCH_TIMEOUT_MS, STARTUP_CHECK_DELAY_MS };
