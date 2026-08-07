// 请求日志：记录发送给文字/视觉模型的请求与回复，截图存档可查看
// - requests.jsonl：逐行 JSON，含时间/通道/输入/回复/截图路径（与 app.log 错误日志分离）
// - screenshots/：视觉请求的截图（已应用隐私遮罩），保留最近 N 张自动清理
const fs = require('node:fs');
const path = require('node:path');

const MAX_MEMORY = 100;      // 内存 ring 上限（设置页读取）
const MAX_SCREENSHOTS = 100; // 截图保留上限，超出删最旧

class RequestLogger {
  constructor({ logDir, maxScreenshots = MAX_SCREENSHOTS }) {
    this.logDir = logDir;
    this.maxScreenshots = maxScreenshots;
    this.ring = [];
    this.reqFile = path.join(logDir, 'requests.jsonl');
    this.shotDir = path.join(logDir, 'screenshots');
    try { fs.mkdirSync(this.shotDir, { recursive: true }); } catch { /* 目录不可建则跳过截图 */ }
  }

  // channel: 'text' | 'vision'；input: 发送给模型的内容；reply: 模型原始回复；imageDataUrl: 视觉截图（可选）
  // paths: 该批次涉及的操作文件路径（去重、过滤空值）——供设置页对照噪音过滤规则配置
  logRequest({ channel, input, reply, imageDataUrl, error, parsedCount, paths }) {
    const entry = {
      ts: new Date().toISOString(),
      channel,
      input: String(input || '').slice(0, 2000),
      reply: String(reply || '').slice(0, 500),
    };
    const uniqPaths = paths ? [...new Set(paths.filter((p) => p))] : undefined;
    if (uniqPaths && uniqPaths.length) entry.paths = uniqPaths;
    if (imageDataUrl) entry.image = this.saveImage(channel, imageDataUrl);
    if (error) entry.error = String(error).slice(0, 300);
    if (parsedCount !== undefined) entry.parsedCount = parsedCount;
    this.ring.push(entry);
    if (this.ring.length > MAX_MEMORY) this.ring.shift();
    try {
      fs.appendFileSync(this.reqFile, JSON.stringify(entry) + '\n');
    } catch { /* 日志失败不影响主流程 */ }
    return entry;
  }

  saveImage(channel, dataUrl) {
    try {
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(String(dataUrl));
      if (!m) return '';
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      // 时间戳可能同毫秒重复（连续写入），加随机后缀防覆盖
      const name = `${channel}-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const file = path.join(this.shotDir, name);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      this.cleanup();
      return file;
    } catch { return ''; }
  }

  // 截图自动清理：只保留最近 maxScreenshots 张
  cleanup() {
    try {
      const files = fs.readdirSync(this.shotDir)
        .filter((f) => /\.(jpg|png|jpeg)$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(this.shotDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const x of files.slice(this.maxScreenshots)) {
        fs.rmSync(path.join(this.shotDir, x.f), { force: true });
      }
    } catch { /* 清理失败忽略 */ }
  }

  getLogs(limit = 50) {
    return this.ring.slice(-limit);
  }
}

module.exports = { RequestLogger, MAX_MEMORY, MAX_SCREENSHOTS };
