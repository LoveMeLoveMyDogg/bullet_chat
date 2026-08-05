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
    this.sourceStates = {}; // 来源 -> 'ok' | 'err'（text/vision/watch/screen）
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
    this.sourceStates[source] = 'err';
    this.refreshStatus();
  }

  reportRecovered(source) {
    this.sourceStates[source] = 'ok';
    this.log(`[INFO] [${source}] 已恢复`);
    const stillErr = Object.values(this.sourceStates).some((v) => v === 'err');
    if (!stillErr) {
      // 所有来源都正常才发"已恢复"通知并回到 running
      this.notify('BulletChat 弹幕已恢复', `${sourceLabel(source)}恢复正常`);
      this.setStatus({ state: 'running', text: '运行中' });
    } else {
      // 仍有其他来源出错：只更新状态文本（去掉已恢复来源），不发恢复通知
      this.refreshStatus();
    }
  }

  // 聚合状态：任一来源 'err' → error，text 列出所有错误来源与最新错误消息
  refreshStatus() {
    const errSources = Object.keys(this.sourceStates).filter((s) => this.sourceStates[s] === 'err');
    if (errSources.length === 0) {
      this.setStatus({ state: 'running', text: '运行中' });
      return;
    }
    const latest = [...this.errors].reverse().find((e) => errSources.includes(e.source));
    this.setStatus({
      state: 'error',
      text: `${errSources.map(sourceLabel).join('、')}出错：${latest?.message || '未知错误'}`,
    });
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
