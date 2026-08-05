const { formatEventDescription } = require('./noiseFilter');
const { pickStyles, buildSystemPrompt } = require('./styles');
const { templateFor, fillTemplate } = require('./templates');
const { parseDanmakuJson, RED_SQUARE_DATA_URL } = require('../main/generator');
const fs = require('node:fs');

const BATCH_SIZE = 10;
const COALESCE_MS = 2000;
const RETRY_MS = 60000;
const MAX_READ_BYTES = 50 * 1024;   // 超过此大小不读内容（大文件/构建产物）
const MAX_CONTENT_CHARS = 200;      // 内容片段最长字符数
const BINARY_PROBE = 4096;          // 二进制检测采样长度

// 读取文本文件内容片段（供 AI 生成"懂内容"的弹幕）。
// 只读小文本文件：超限/二进制/读取失败一律返回空串（保持事件描述不因内容读取而失败）
function readFileSnippet(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return '';
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(st.size, BINARY_PROBE));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    // 二进制检测：采样区含 NUL 或大量非 UTF-8 字节则跳过
    if (buf.includes(0)) return '';
    let nonText = 0;
    for (const b of buf) if (b < 9 || (b > 13 && b < 32)) nonText++;
    if (nonText > buf.length / 10) return '';
    return fs.readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
  } catch { return ''; }
}

// 事件描述 + 可选内容片段：create/change 且开关开启且可读到文本 → 附「内容：…」
function describeEntry(entry, readContent) {
  const base = formatEventDescription(entry);
  if (!readContent || entry.source === 'screen' || !entry.path) return base;
  if (entry.type !== 'create' && entry.type !== 'change') return base;
  const snippet = readFileSnippet(entry.path);
  return snippet ? `${base}（内容：${snippet}）` : base;
}

function typeKey(entry) {
  if (entry.source === 'screen') return 'screen';
  if (entry.type === 'create') return entry.isDir ? 'create_folder' : 'create_file';
  return entry.type || 'default';
}

// 用户自定义风格优先，否则从内置风格池随机挑
function currentStyles(brain) {
  if (brain.config.danmaku.styles && brain.config.danmaku.styles.length) {
    return brain.config.danmaku.styles;
  }
  return pickStyles(3, brain.rng);
}

class Brain {
  constructor({ config, generator, templates, reporter, logger = null, clock = Date.now, rng = Math.random, onDanmaku, onStatus }) {
    this.config = config;
    this.generator = generator;
    this.templates = templates;
    this.reporter = reporter;
    this.logger = logger; // 请求日志（发送给 AI 的内容/截图/回复），可选
    this.clock = clock;
    this.rng = rng;
    this.onDanmaku = onDanmaku;
    this.onStatus = onStatus;
    this.queue = [];
    this.changeSeen = new Map(); // path -> lastChangeTime
    this.lastTextEmit = 0;   // 文字弹幕最后发送时间（本地模式与文字 AI 共用）
    this.lastVisionEmit = 0; // 视觉弹幕最后发送时间（独立限速，避免视觉高频烧额度）
    this.batchTimer = null;
    this.retryTimer = null;
    this.lastVisionImage = null; // 最近一次视觉请求的截图，重试探测用它而非空图
    this.state = { mode: 'idle', paused: false, localMode: !!config.danmaku.localMode, error: { text: null, vision: null } };
  }

  start() {
    this.state.mode = 'running';
    this.scheduleBatch();
    this.scheduleRetry();
    this.emitStatus();
  }

  stop() {
    clearTimeout(this.batchTimer);
    clearTimeout(this.retryTimer);
    this.state.mode = 'idle';
  }

  pushEntry(entry) {
    if (this.state.paused) return;
    if (entry.type === 'change') {
      const now = this.clock();
      const last = this.changeSeen.get(entry.path);
      if (last !== undefined && now - last < COALESCE_MS) {
        this.changeSeen.set(entry.path, now);
        return;
      }
      this.changeSeen.set(entry.path, now);
    }
    if (this.state.localMode) {
      this.emitLocal(entry);
      return;
    }
    entry.ts = this.clock(); // 记录到达时间，供时间窗过滤（积压的旧事件不再播报）
    this.queue.push(entry);
    if (this.queue.length >= BATCH_SIZE) this.flushNow();
  }

  scheduleBatch() {
    this.batchTimer = setTimeout(() => {
      this.flushNow();
      this.scheduleBatch();
    }, this.config.danmaku.batchIntervalMs);
  }

  scheduleRetry() {
    this.retryTimer = setTimeout(() => {
      this.retryNow();
      this.scheduleRetry();
    }, RETRY_MS);
  }

  flushNow() {
    if (this.queue.length === 0) return;
    const now = this.clock();
    // 时间窗过滤：只播报最近 maxEventAgeSec 秒内的改动（弹幕是直播体验，队列积压的旧事件丢弃）
    const maxAgeMs = (this.config.danmaku.maxEventAgeSec || 0) * 1000;
    if (maxAgeMs > 0) {
      this.queue = this.queue.filter((e) => now - (e.ts || now) <= maxAgeMs);
      if (this.queue.length === 0) return;
    }
    const batch = this.queue.splice(0, BATCH_SIZE);
    // 按来源拆批：屏幕条目走视觉、文件条目走文字，互不混串
    const fileEntries = batch.filter((e) => e.source !== 'screen');
    const screenEntries = batch.filter((e) => e.source === 'screen');
    // 文字/视觉各自限速：一通道被限速不影响另一通道（视觉默认 10 秒，防高频烧额度）
    if (fileEntries.length && !this.state.error.text && now - this.lastTextEmit >= this.config.danmaku.minIntervalSec * 1000) {
      this.generateText(fileEntries);
    }
    if (screenEntries.length && !this.state.error.vision && now - this.lastVisionEmit >= this.config.danmaku.minIntervalVisionSec * 1000) {
      this.generateVision(screenEntries);
    }
  }

  async generateText(batch) {
    const user = batch.map((e) => describeEntry(e, this.config.danmaku.readFileContent)).join('\n');
    const system = buildSystemPrompt(currentStyles(this));
    try {
      const raw = await this.generator.chatCompletion({
        baseUrl: this.config.textModel.baseUrl,
        apiKey: this.config.textModel.apiKey,
        model: this.config.textModel.model,
        system, user,
      });
      this.logger?.logRequest({ channel: 'text', input: user, reply: raw });
      this.emitParsed(raw, 'text');
    } catch (err) {
      this.logger?.logRequest({ channel: 'text', input: user, error: err.message });
      this.fail('text', err);
    }
  }

  async generateVision(batch) {
    const entry = batch[batch.length - 1];
    this.lastVisionImage = entry.imageDataUrl;
    const system = buildSystemPrompt(currentStyles(this));
    try {
      const raw = await this.generator.visionCompletion({
        baseUrl: this.config.visionModel.baseUrl,
        apiKey: this.config.visionModel.apiKey,
        model: this.config.visionModel.model,
        system,
        imageDataUrl: entry.imageDataUrl,
      });
      this.logger?.logRequest({ channel: 'vision', input: '屏幕画面变化截图', reply: raw, imageDataUrl: entry.imageDataUrl });
      this.emitParsed(raw, 'vision');
    } catch (err) {
      this.logger?.logRequest({ channel: 'vision', input: '屏幕画面变化截图', imageDataUrl: entry.imageDataUrl, error: err.message });
      this.fail('vision', err);
    }
  }

  emitParsed(raw, src) {
    const lines = parseDanmakuJson(raw);
    if (lines.length === 0) return;
    if (src === 'vision') this.lastVisionEmit = this.clock();
    else this.lastTextEmit = this.clock();
    for (const line of lines) {
      // meta.source 接口约定为 'ai'|'local'
      this.onDanmaku(line, { source: 'ai' });
    }
    if (this.state.error[src]) this.clearError(src);
    this.emitStatus();
  }

  emitLocal(entry) {
    if (this.clock() - this.lastTextEmit < this.config.danmaku.minIntervalSec * 1000) return;
    this.lastTextEmit = this.clock();
    const tpl = this.templates.templateFor(typeKey(entry), this.rng);
    const text = '【本地】' + this.templates.fillTemplate(tpl, entry);
    this.onDanmaku(text, { source: 'local' });
  }

  fail(source, err) {
    this.state.error[source] = { source, message: err.message || String(err), at: this.clock() };
    this.reporter?.reportError?.(source, err);
    this.emitStatus();
  }

  clearError(src) {
    if (!this.state.error[src]) return; // 该来源本无错误：不通知恢复
    this.state.error[src] = null;
    this.reporter?.reportRecovered?.(src);
    this.emitStatus();
  }

  setLocalMode(on) {
    this.state.localMode = !!on;
    this.queue.length = 0;
    this.emitStatus();
  }

  pause() { this.state.paused = true; this.emitStatus(); }
  resume() { this.state.paused = false; this.emitStatus(); }
  getStatus() {
    // 对外保持旧形状：null 或 { source, message, at }
    const error = this.state.error.text || this.state.error.vision || null;
    return { ...this.state, mode: this.state.mode, error };
  }

  refreshConfig(config) {
    this.config = config;
    this.state.localMode = !!config.danmaku.localMode;
  }

  retryNow() {
    for (const src of ['text', 'vision']) {
      const err = this.state.error[src];
      if (!err) continue;
      // 视觉探测用最近一次真实截图（或红方块占位），空图片 URL 多数端点直接 400
      const attempt = src === 'vision'
        ? this.generator.visionCompletion({
            baseUrl: this.config.visionModel.baseUrl,
            apiKey: this.config.visionModel.apiKey,
            model: this.config.visionModel.model,
            system: buildSystemPrompt(['正经夸夸']),
            imageDataUrl: this.lastVisionImage || RED_SQUARE_DATA_URL,
          })
        : this.generator.chatCompletion({
            baseUrl: this.config.textModel.baseUrl,
            apiKey: this.config.textModel.apiKey,
            model: this.config.textModel.model,
            system: '你是连接测试助手',
            user: '只回复一个字：通',
          });
      attempt
        .then(() => {
          // 重试窗口期内若该来源已发生新的失败（错误对象被替换），不误报恢复
          if (this.state.error[src] === err) this.clearError(src);
        })
        .catch(() => {
          // 仍失败，恢复该来源错误状态等下一次重试；不触碰其他来源的状态
          if (this.state.error[src] === err) {
            this.state.error[src] = err;
            this.emitStatus();
          }
        });
    }
  }

  emitStatus() {
    this.onStatus?.(this.getStatus());
  }
}

module.exports = { Brain, typeKey, readFileSnippet, describeEntry };
