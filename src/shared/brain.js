const { formatEventDescription } = require('./noiseFilter');
const { pickStyles, pickRoles, buildSystemPrompt } = require('./styles');
const { templateFor, fillTemplate } = require('./templates');
const { resolveGroup } = require('./audienceGroups');
const { parseDanmakuJson, RED_SQUARE_DATA_URL } = require('../main/generator');
const { dataUrlKb } = require('./usageCounter');
const fs = require('node:fs');

const BATCH_SIZE = 10;
const COALESCE_MS = 2000;
const RETRY_MS = 60000;
const REFILL_THRESHOLD = 2; // 缓冲剩余 ≤2 条时触发补充（提前量覆盖一次 API 调用耗时）
const MAX_QUEUE_AGE_MS = 60000; // 队列最旧事件接近此年龄时强制补充：视觉高频时 buffer 常满，文件事件
                                // 等不到"缓冲不足"，靠年龄兜底在时间窗（maxEventAgeSec）内被处理
const QUEUE_LIMIT = 300;        // 文字事件队列限深：盘根级系统噪音持续进入时防无限增长（丢最旧，最旧最接近过期）
const MAX_READ_BYTES = 50 * 1024;   // 超过此大小不读内容（大文件/构建产物）
const MAX_CONTENT_CHARS = 200;      // 内容片段最长字符数
const BINARY_PROBE = 4096;          // 二进制检测采样长度
const FILE_APP_TYPES = ['create', 'change', 'delete', 'rename', 'move']; // 文件操作类型：打前台应用戳

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
  constructor({ config, generator, templates, reporter, logger = null, clock = Date.now, rng = Math.random, onDanmaku, onStatus, getCurrentApp = null, getHumanActivity = null, usageCounter = null }) {
    this.config = config;
    this.generator = generator;
    this.templates = templates;
    this.reporter = reporter;
    this.logger = logger; // 请求日志（发送给 AI 的内容/截图/回复），可选
    this.usageCounter = usageCounter; // 调用统计（成功/失败都记；retryNow 探测不记），可选
    this.clock = clock;
    this.rng = rng;
    this.onDanmaku = onDanmaku;
    this.onStatus = onStatus;
    this.getCurrentApp = getCurrentApp; // 前台应用上下文回调（main 装配注入），事件场景化用
    this.getHumanActivity = getHumanActivity; // 人为活动信号回调（main 注入 AppWatcher.getHumanActivity）
    this.currentGroup = null;  // 当前观众群（登场播报去重用）
    this.queue = [];          // 文字事件内容池（最近事件，供补充调用使用）
    this.visionQueue = [];    // 视觉事件（变化驱动 + 限速）
    this.buffer = [];         // 文字弹幕缓冲池：AI 一次回复多条，按节奏逐条吐出
    this.refilling = false;   // 补充调用进行中标记（防并发补充）
    this.lastRefillAt = 0;    // 上次补充时间（补充节流）
    this.lastEmitAt = 0;      // 上次吐出弹幕时间（首次补充后立即吐出）
    this.refillTimer = null;  // 延迟补充检查定时器
    this.emitTimer = null;    // 弹幕吐出定时器
    this.changeSeen = new Map(); // path -> lastChangeTime
    this.lastTextEmit = 0;   // 本地模式弹幕最后发送时间
    this.lastVisionEmit = 0; // 视觉弹幕最后发送时间（独立限速，避免视觉高频烧额度）
    this.retryTimer = null;
    this.lastVisionImage = null; // 最近一次视觉请求的截图，重试探测用它而非空图
    this.state = { mode: 'idle', paused: false, localMode: !!config.danmaku.localMode, error: { text: null, vision: null } };
  }

  start() {
    if (this.state.mode === 'running') return; // 防重复 start 产生第二条重试定时器链
    this.state.mode = 'running';
    this.scheduleRetry();
    this.emitStatus();
  }

  stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearTimeout(this.refillTimer);
    this.refillTimer = null;
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.state.mode = 'idle';
    this.emitStatus(); // 停止状态即时广播（托盘/设置页感知）
  }

  // app_switch 命中不同观众群 → 补发登场事件（AI 通道入队 / 本地模式直接播）
  maybeEnterGroup(entry) {
    if (entry.type !== 'app_switch') return null;
    const group = resolveGroup(entry.appKey, this.config.monitor.appGroups, this.config.monitor.audienceGroups);
    if (!group || group.name === this.currentGroup) return null;
    this.currentGroup = group.name;
    return { source: 'app', type: 'app_enter', name: group.name, appKey: entry.appKey, drive: '', isDir: false, ts: this.clock() };
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
      // 防长期运行内存增长：超限清理 60 秒前的旧条目；清后仍超限则全清（与 fileWatcher 优雅降级一致）
      if (this.changeSeen.size > 5000) {
        const cutoff = now - 60000;
        for (const [p, t] of this.changeSeen) {
          if (t < cutoff) this.changeSeen.delete(p);
        }
        if (this.changeSeen.size > 5000) this.changeSeen.clear();
      }
    }
    // 事件场景化：文件事件打当时前台应用戳（弹幕评这条时仍是该观众群）。
    // 只对文件操作类型戳；idle/app 事件无应用上下文（用全局观众池）
    if (FILE_APP_TYPES.includes(entry.type) && !entry.appKey) {
      const cur = this.getCurrentApp?.();
      if (cur) entry.appKey = cur.appKey;
    }
    if (this.state.localMode) {
      const enter = this.maybeEnterGroup(entry);
      if (enter) this.emitLocal(enter);
      this.emitLocal(entry);
      return;
    }
    entry.ts = this.clock(); // 记录到达时间，供时间窗过滤（积压的旧事件不再播报）
    if (entry.source === 'screen') {
      // 视觉：变化驱动 + 限速（画面弹幕需要实时性，不缓冲）
      this.visionQueue.push(entry);
      this.flushVision();
    } else {
      // 人为操作门控：开启 humanFileOnly 时，文件事件需要最近有键盘/鼠标输入——
      // 挡掉开机/后台系统进程自动写入（驱动日志、应用更新器等），只有用户在操作时才发文字模型。
      // 本地模式不适用（不调 API，纯模板弹幕）；getHumanActivity 未注入/未就绪时放行（宽松）
      if (this.config.monitor.humanFileOnly && FILE_APP_TYPES.includes(entry.type)) {
        const act = this.getHumanActivity ? this.getHumanActivity() : null;
        if (act && !act.active) return;
      }
      // 文字：进内容池，缓冲不足时才补充调用（弹幕能续上就不打扰 AI）
      const enter = this.maybeEnterGroup(entry);
      if (enter) this.queue.push(enter);
      this.queue.push(entry);
      // 队列限深：盘根级系统噪音持续进入时防无限增长；丢最旧（最早进入，最接近时间窗过期）
      if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
      // app/空闲事件实时优先：绕过缓冲阈值（见 maybeRefill force 注释）
      const isAppEvent = entry.type === 'app_switch' || entry.type === 'app_enter' || entry.type === 'app_stay' || entry.type === 'idle';
      this.maybeRefill(isAppEvent ? { force: true } : {});
    }
  }

  scheduleRetry() {
    this.retryTimer = setTimeout(() => {
      this.retryNow();
      this.scheduleRetry();
    }, RETRY_MS);
    this.retryTimer.unref?.(); // 定时器不阻止进程退出（应用有窗口常驻，无影响）
  }

  // 文字弹幕补充：缓冲剩余 ≤ REFILL_THRESHOLD 且内容池有新事件时才调 AI。
  // force：app/空闲事件实时优先——绕过缓冲阈值立即补充，
  // 否则文件事件频繁时缓冲常充足，app 事件在队列饿死、超时间窗被丢弃（切换应用不播报）
  // 补充节流：距上次补充不足 batchIntervalMs 时安排延迟检查，让事件风暴攒批后再调用
  maybeRefill({ force = false } = {}) {
    if (this.state.paused || this.state.localMode || this.refilling || this.state.error.text) return;
    const now = this.clock();
    // 时间窗过滤：只播报最近 maxEventAgeSec 秒内的改动（积压的旧事件丢弃）
    const maxAgeMs = (this.config.danmaku.maxEventAgeSec || 0) * 1000;
    if (maxAgeMs > 0) {
      this.queue = this.queue.filter((e) => now - (e.ts || now) <= maxAgeMs);
      if (this.queue.length === 0) return;
    }
    // 队列最旧事件年龄：接近过期（时间窗的兜底阈值）时无视缓冲水位强制补充——
    // 视觉通道高频时 buffer 常满（>REFILL_THRESHOLD），文件事件等不到"缓冲不足"，靠年龄兜底不被时间窗丢弃
    let oldestTs = now;
    for (const e of this.queue) if (e.ts !== undefined && e.ts < oldestTs) oldestTs = e.ts;
    const expiring = maxAgeMs > 0 && now - oldestTs >= Math.min(maxAgeMs, MAX_QUEUE_AGE_MS);
    if (!force && !expiring && this.buffer.length > REFILL_THRESHOLD) return;
    const throttled = this.lastRefillAt && now - this.lastRefillAt < this.config.danmaku.batchIntervalMs;
    if (throttled) {
      if (!this.refillTimer) {
        const wait = this.config.danmaku.batchIntervalMs - (now - this.lastRefillAt);
        this.refillTimer = setTimeout(() => {
          this.refillTimer = null;
          this.maybeRefill();
        }, Math.max(0, wait));
        this.refillTimer.unref?.();
      }
      return;
    }
    const raw = this.queue.splice(0, BATCH_SIZE);
    if (raw.length === 0) return;
    // 队列级同路径去重：同 path+type 只留最新一条。
    // describeEntry 读文件当前内容，旧 change 事件描述冗余；不同 type（如"新建→修改"）保留叙事。
    // stable：保留该键最后一次出现的位置，其余条目顺序不变
    const seen = new Map(); // key -> 该键最后出现位置在 batch 中的下标
    const batch = [];
    for (const e of raw) {
      const key = `${e.path}\u0000${e.type}`;
      const prev = seen.get(key);
      if (prev !== undefined) batch[prev] = null; // 旧条目让位给最新一条
      seen.set(key, batch.length);
      batch.push(e);
    }
    const deduped = batch.filter(Boolean);
    if (deduped.length === 0) return;
    this.lastRefillAt = now;
    this.refilling = true;
    this.generateText(deduped).finally(() => {
      this.refilling = false;
      this.maybeRefill(); // 补充完成后再检查（内容池可能又有新事件且缓冲仍不足）
    });
  }

  // 视觉通道：攒批 + 独立限速（一通道被限速不影响另一通道）
  flushVision() {
    if (this.visionQueue.length === 0) return;
    if (this.state.localMode) return; // 本地模式完全离线：不调用 AI（含重试探测）
    const now = this.clock();
    const maxAgeMs = (this.config.danmaku.maxEventAgeSec || 0) * 1000;
    if (maxAgeMs > 0) {
      this.visionQueue = this.visionQueue.filter((e) => now - (e.ts || now) <= maxAgeMs);
      if (this.visionQueue.length === 0) return;
    }
    const batch = this.visionQueue.splice(0, BATCH_SIZE);
    if (this.state.error.vision) return;
    if (now - this.lastVisionEmit < this.config.danmaku.minIntervalVisionSec * 1000) return;
    this.generateVision(batch);
  }

  // 弹幕吐出：按 minIntervalSec 节奏一批批飘（每批 burstMin~burstMax 条随机，像直播间弹幕雨）。
  // 批大小受同屏上限（maxConcurrent）与缓冲余量约束；补充后第一批立即出（不等满间隔）
  // 弹幕缓冲上限：防生成速率 > 消耗速率时积压（视觉通道高频场景每 10s +10 条 vs 消耗 2~3 条）。
  // 超限丢最旧保留最新（直播语义：弹幕是即时的，积压的旧弹幕没意义，最新弹幕才有价值）
  bufferLimit() {
    return Math.max(10, (this.config.danmaku.burstMax || 8) * 5);
  }

  pushBuffer(lines) {
    this.buffer.push(...lines);
    const limit = this.bufferLimit();
    if (this.buffer.length > limit) this.buffer.splice(0, this.buffer.length - limit);
  }

  scheduleEmit() {
    if (this.emitTimer || this.state.paused) return;
    const sinceLast = this.lastEmitAt ? this.clock() - this.lastEmitAt : Infinity;
    const delay = Math.max(0, this.config.danmaku.minIntervalSec * 1000 - sinceLast);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.buffer.length === 0) {
        this.maybeRefill(); // 缓冲空了：看内容池是否需要补充
        return;
      }
      const max = Math.min(
        this.config.danmaku.burstMax || 8,
        this.config.danmaku.maxConcurrent || 6,
        this.buffer.length
      );
      const min = Math.min(this.config.danmaku.burstMin || 2, max);
      const n = min + Math.floor(this.rng() * (max - min + 1));
      this.lastEmitAt = this.clock();
      for (let i = 0; i < n; i++) {
        const text = this.buffer.shift();
        if (text === undefined) break;
        this.onDanmaku(text, { source: 'ai' });
      }
      if (this.buffer.length) this.scheduleEmit();
      else this.maybeRefill();
    }, delay);
    this.emitTimer.unref?.();
  }

  async generateText(batch) {
    const user = batch.map((e) => describeEntry(e, this.config.danmaku.readFileContent)).join('\n');
    // 观众群：按批内事件的前台应用戳选群（无戳用全局池）
    const appEntry = batch.find((e) => e.appKey);
    const group = appEntry
      ? resolveGroup(appEntry.appKey, this.config.monitor.appGroups, this.config.monitor.audienceGroups)
      : null;
    const system = buildSystemPrompt(
      group?.styles?.length ? group.styles : currentStyles(this),
      group?.roles || [],
      this.config.danmaku.replyCount,
      group?.scene || null
    );
    try {
      const raw = await this.generator.chatCompletion({
        baseUrl: this.config.textModel.baseUrl,
        apiKey: this.config.textModel.apiKey,
        model: this.config.textModel.model,
        system, user,
      });
      const lines = parseDanmakuJson(raw, this.config.danmaku.replyCount || 10);
      this.logger?.logRequest({ channel: 'text', input: user, reply: raw, parsedCount: lines.length, paths: batch.map((e) => e.path) });
      this.usageCounter?.record({ channel: 'text', inputChars: user.length, systemChars: system.length, outputChars: raw.length, parsedCount: lines.length });
      // 缓冲模式：解析结果全部进缓冲池，按节奏吐出（不立即全发）；超限丢最旧防积压
      if (lines.length) {
        this.pushBuffer(lines);
        this.scheduleEmit();
      }
      if (this.state.error.text) this.clearError('text');
      this.emitStatus();
    } catch (err) {
      this.logger?.logRequest({ channel: 'text', input: user, error: err.message });
      this.usageCounter?.record({ channel: 'text', inputChars: user.length, systemChars: system.length, error: err });
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
        maxCount: this.config.danmaku.replyCount || 10,
      });
      this.logger?.logRequest({ channel: 'vision', input: '屏幕画面变化截图', reply: raw, imageDataUrl: entry.imageDataUrl });
      const lines = parseDanmakuJson(raw, this.config.danmaku.replyCount || 10);
      this.lastVisionEmit = this.clock(); // 视觉调用限速标记（minIntervalVisionSec 闸门用）
      this.usageCounter?.record({ channel: 'vision', inputChars: 0, systemChars: system.length, outputChars: raw.length, parsedCount: lines.length, imageKb: dataUrlKb(entry.imageDataUrl) });
      // 视觉弹幕也进缓冲：飘出节奏与文字统一（burstMin/burstMax + minIntervalSec 全局生效），
      // 超限丢最旧防积压（旧实现一次回复全部瞬间飘出，且高频画面变化时 buffer 无限增长）
      if (lines.length) {
        this.pushBuffer(lines);
        this.scheduleEmit();
      }
      if (this.state.error.vision) this.clearError('vision');
      this.emitStatus();
    } catch (err) {
      this.logger?.logRequest({ channel: 'vision', input: '屏幕画面变化截图', imageDataUrl: entry.imageDataUrl, error: err.message });
      this.usageCounter?.record({ channel: 'vision', inputChars: 0, systemChars: system.length, error: err, imageKb: dataUrlKb(entry.imageDataUrl) });
      this.fail('vision', err);
    }
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
    this.buffer.length = 0; // 切换本地模式：清掉 AI 缓冲，避免混发
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.emitStatus();
  }

  pause() { this.state.paused = true; this.emitStatus(); }
  resume() {
    this.state.paused = false;
    if (this.buffer.length) this.scheduleEmit(); // 恢复后继续吐缓冲
    this.emitStatus();
  }
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
    if (this.state.paused || this.state.localMode) return; // 暂停弹幕/本地模式时也不发重试探测（省额度）
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
          if (this.state.error[src] === err) {
            this.clearError(src);
            if (src === 'text') this.maybeRefill(); // 恢复后立即补充缓冲
          }
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
