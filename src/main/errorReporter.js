const { Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const THROTTLE_MS = 30000;
const SOURCE_LABELS = { text: '文字模型', vision: '视觉模型', watch: '监控', screen: '屏幕截图' };

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function defaultNotify(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch { /* 通知失败不阻塞主流程 */ }
}

class ErrorReporter {
  constructor({ notify = defaultNotify, onStatus, logDir = null }) {
    this.notify = notify;
    this.onStatus = onStatus;
    this.logDir = logDir;
    this.lastNotified = new Map();
    this.errors = [];
    this.status = { state: 'running', text: '运行中' };
  }

  reportError(source, err) {
    const message = err?.message || String(err);
    this.errors.push({ source, message, at: new Date().toISOString() });
    if (this.errors.length > 200) this.errors.shift();
    this.log(`[ERROR] [${source}] ${message}`);
    const key = `${source}:${err?.code || message}`;
    const now = Date.now();
    if (now - (this.lastNotified.get(key) || 0) > THROTTLE_MS) {
      this.lastNotified.set(key, now);
      this.notify('BulletChat 弹幕已暂停', `${sourceLabel(source)}出错：${message}`);
    }
    this.setStatus({ state: 'error', text: `${sourceLabel(source)}出错：${message}` });
  }

  reportRecovered(source) {
    this.log(`[INFO] [${source}] 已恢复`);
    this.notify('BulletChat 弹幕已恢复', `${sourceLabel(source)}恢复正常`);
    this.setStatus({ state: 'running', text: '运行中' });
  }

  setStatus(status) {
    this.status = status;
    this.onStatus?.(status);
  }

  getStatus() { return this.status; }
  getErrors() { return [...this.errors]; }

  log(line) {
    if (!this.logDir) return;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* 日志失败忽略 */ }
  }
}

module.exports = { ErrorReporter, sourceLabel, defaultNotify };
