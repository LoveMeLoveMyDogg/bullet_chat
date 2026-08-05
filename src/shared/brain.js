const { formatEventDescription } = require('./noiseFilter');
const { pickStyles, buildSystemPrompt } = require('./styles');
const { templateFor, fillTemplate } = require('./templates');
const { parseDanmakuJson } = require('../main/generator');

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
    this.state = { mode: 'idle', paused: false, localMode: !!config.danmaku.localMode, error: null };
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
    if (this.state.error) { this.queue.length = 0; return; } // 出错期间不生成，事件丢弃
    const now = this.clock();
    if (now - this.lastEmit < this.config.danmaku.minIntervalSec * 1000) {
      this.queue.length = 0; // 限速未到时间：清空保持弹幕新鲜
      return;
    }
    const batch = this.queue.splice(0, BATCH_SIZE);
    if (batch[0] && batch[0].source === 'screen') this.generateVision(batch);
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
      this.emitParsed(raw, 'ai');
    } catch (err) {
      this.fail('text', err);
    }
  }

  async generateVision(batch) {
    const entry = batch[batch.length - 1];
    const system = buildSystemPrompt(currentStyles(this));
    try {
      const raw = await this.generator.visionCompletion({
        baseUrl: this.config.visionModel.baseUrl,
        apiKey: this.config.visionModel.apiKey,
        model: this.config.visionModel.model,
        system,
        imageDataUrl: entry.imageDataUrl,
      });
      this.emitParsed(raw, 'ai');
    } catch (err) {
      this.fail('vision', err);
    }
  }

  emitParsed(raw, source) {
    const lines = parseDanmakuJson(raw);
    if (lines.length === 0) return;
    this.lastEmit = this.clock();
    for (const line of lines) {
      // meta.source 接口约定为 'ai'|'local'（source 参数在调用处已统一传 'ai'）
      this.onDanmaku(line, { source });
    }
    if (this.state.error) this.clearError();
    else this.reporter?.reportRecovered?.(source);
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
    this.state.error = { source, message: err.message || String(err), at: this.clock() };
    this.reporter?.reportError?.(source, err);
    this.emitStatus();
  }

  clearError() {
    this.state.error = null;
    this.reporter?.reportRecovered?.('text');
    this.emitStatus();
  }

  setLocalMode(on) {
    this.state.localMode = !!on;
    this.queue.length = 0;
    this.emitStatus();
  }

  pause() { this.state.paused = true; this.emitStatus(); }
  resume() { this.state.paused = false; this.emitStatus(); }
  getStatus() { return { ...this.state, mode: this.state.mode }; }

  refreshConfig(config) {
    this.config = config;
    this.state.localMode = !!config.danmaku.localMode;
  }

  retryNow() {
    if (!this.state.error) return;
    const err = this.state.error;
    this.state.error = null; // 临时清除，让 retry 请求走通
    const attempt = err.source === 'vision'
      ? this.generator.visionCompletion({
          baseUrl: this.config.visionModel.baseUrl,
          apiKey: this.config.visionModel.apiKey,
          model: this.config.visionModel.model,
          system: buildSystemPrompt(['正经夸夸']),
          imageDataUrl: '',
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
        this.reporter?.reportRecovered?.(err.source);
        this.emitStatus();
      })
      .catch(() => {
        this.state.error = err; // 仍失败，恢复错误状态等下一次重试
        this.emitStatus();
      });
  }

  emitStatus() {
    this.onStatus?.(this.getStatus());
  }
}

module.exports = { Brain, typeKey };
