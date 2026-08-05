const { formatEventDescription } = require('./noiseFilter');
const { pickStyles, buildSystemPrompt } = require('./styles');
const { templateFor, fillTemplate } = require('./templates');
const { parseDanmakuJson, RED_SQUARE_DATA_URL } = require('../main/generator');

const BATCH_SIZE = 10;
const COALESCE_MS = 2000;
const RETRY_MS = 60000;

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
  constructor({ config, generator, templates, reporter, clock = Date.now, rng = Math.random, onDanmaku, onStatus }) {
    this.config = config;
    this.generator = generator;
    this.templates = templates;
    this.reporter = reporter;
    this.clock = clock;
    this.rng = rng;
    this.onDanmaku = onDanmaku;
    this.onStatus = onStatus;
    this.queue = [];
    this.changeSeen = new Map(); // path -> lastChangeTime
    this.lastEmit = 0;
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
    if (now - this.lastEmit < this.config.danmaku.minIntervalSec * 1000) {
      this.queue.length = 0; // 限速未到时间：清空保持弹幕新鲜
      return;
    }
    const batch = this.queue.splice(0, BATCH_SIZE);
    // 错误状态按通道隔离：只有该来源出错才丢弃本批，另一通道照常工作
    const src = batch[0] && batch[0].source === 'screen' ? 'vision' : 'text';
    if (this.state.error[src]) { this.queue.length = 0; return; }
    if (src === 'vision') this.generateVision(batch);
    else this.generateText(batch);
  }

  async generateText(batch) {
    const user = batch.map(formatEventDescription).join('\n');
    const system = buildSystemPrompt(currentStyles(this));
    try {
      const raw = await this.generator.chatCompletion({
        baseUrl: this.config.textModel.baseUrl,
        apiKey: this.config.textModel.apiKey,
        model: this.config.textModel.model,
        system, user,
      });
      this.emitParsed(raw, 'text');
    } catch (err) {
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
      this.emitParsed(raw, 'vision');
    } catch (err) {
      this.fail('vision', err);
    }
  }

  emitParsed(raw, src) {
    const lines = parseDanmakuJson(raw);
    if (lines.length === 0) return;
    this.lastEmit = this.clock();
    for (const line of lines) {
      // meta.source 接口约定为 'ai'|'local'
      this.onDanmaku(line, { source: 'ai' });
    }
    if (this.state.error[src]) this.clearError(src);
    this.emitStatus();
  }

  emitLocal(entry) {
    if (this.clock() - this.lastEmit < this.config.danmaku.minIntervalSec * 1000) return;
    this.lastEmit = this.clock();
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

module.exports = { Brain, typeKey };
