// 调用统计：记录每次 AI 调用（成功/失败都记），估算 token 供设置页展示。
// 不做预算拦截——用户明确"不缺 token，只是不想白浪费"，统计是为了暴露浪费（0 产出/失败/重复输入）
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_PER_CHAR = 1.5; // 中英混合粗估：字符数 / 1.5 ≈ token
const TOKEN_PER_KB = 12;    // 视觉截图粗估：KB × 12 ≈ token（~58KB 截图 ≈ 700 token 量级）
const KEEP_DAYS = 7;        // 历史保留天数

// 估算 token（估算值，实际计费以 API 服务商为准）
function estimateTokens({ inputChars = 0, systemChars = 0, outputChars = 0, imageKb = 0 }) {
  const input = Math.max(0, Math.ceil((inputChars + systemChars) / TOKEN_PER_CHAR) + Math.ceil(imageKb * TOKEN_PER_KB));
  const output = Math.max(0, Math.ceil(outputChars / TOKEN_PER_CHAR));
  return { input, output };
}

// data URL → 解码后大小（KB）：base64 每 4 字符 ≈ 3 字节
function dataUrlKb(dataUrl) {
  const m = /^data:[^;]+;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return 0;
  return Math.round((m[1].length * 3) / 4 / 1024);
}

class UsageCounter {
  constructor({ dir, clock = Date.now, fsMod = fs, maxMem = 2000 }) {
    this.dir = dir;
    this.clock = clock;
    this.fsMod = fsMod;
    this.maxMem = maxMem;
    this.records = []; // 当日内存记录（聚合用，避免每次读文件）
    this.day = null;   // 当前记录日期 YYYY-MM-DD
  }

  dayOf(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  fileFor(day) {
    return path.join(this.dir, `usage-${day}.jsonl`);
  }

  record({ channel, inputChars = 0, systemChars = 0, outputChars = 0, imageKb = 0, parsedCount = 0, error = null }) {
    const now = this.clock();
    this.ensureDay(now);
    const entry = {
      ts: new Date(now).toISOString(),
      channel: channel === 'vision' ? 'vision' : 'text',
      inputChars, systemChars, outputChars, imageKb,
      parsedCount: parsedCount || 0,
      error: error ? String(error.message || error) : null,
      tokens: estimateTokens({ inputChars, systemChars, outputChars, imageKb }),
    };
    this.records.push(entry);
    if (this.records.length > this.maxMem) this.records.shift();
    this.append(entry);
    return entry;
  }

  // 跨天惰性切换：记录时发现日期变化 → 读当日文件恢复内存，并清理过期文件
  ensureDay(now) {
    const d = this.dayOf(now);
    if (d === this.day) return;
    this.day = d;
    this.records = this.loadDay(d);
    this.prune();
  }

  loadDay(day) {
    try {
      const raw = this.fsMod.readFileSync(this.fileFor(day), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  append(entry) {
    try {
      this.fsMod.mkdirSync(this.dir, { recursive: true });
      this.fsMod.appendFileSync(this.fileFor(this.day), JSON.stringify(entry) + '\n');
    } catch { /* 落盘失败不影响计数 */ }
  }

  // 保留最近 KEEP_DAYS 天文件，超出删除（清理失败忽略）
  prune() {
    try {
      const cutoff = this.dayOf(this.clock() - (KEEP_DAYS - 1) * 86400000);
      for (const f of this.fsMod.readdirSync(this.dir)) {
        const m = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && m[1] < cutoff) this.fsMod.rmSync(path.join(this.dir, f), { force: true });
      }
    } catch { /* 清理失败忽略 */ }
  }

  getToday() {
    this.ensureDay(this.clock()); // 跨午夜无新记录时也主动切日，不显示昨日残留
    return aggregate(this.records);
  }

  getHistory(days = KEEP_DAYS) {
    this.ensureDay(this.clock()); // 同上：读取前先切到当前日（7 天窗口按新一天计算）
    const out = [];
    const now = this.clock();
    for (let i = days - 1; i >= 0; i--) {
      const ts = now - i * 86400000;
      const day = this.dayOf(ts);
      const recs = day === this.day ? this.records : this.loadDay(day);
      const a = aggregate(recs);
      out.push({
        date: day,
        calls: a.total.calls,
        tokens: a.total.inputTokens + a.total.outputTokens,
        danmaku: a.total.danmaku,
        failed: a.total.failed,
      });
    }
    return out;
  }
}

// 聚合：分通道 + 合计。未知通道并入 text
function aggregate(records) {
  const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, danmaku: 0, failed: 0 });
  const out = { text: zero(), vision: zero(), total: zero() };
  for (const r of records) {
    const c = r.channel === 'vision' ? out.vision : out.text;
    c.calls++;
    c.inputTokens += r.tokens.input;
    c.outputTokens += r.tokens.output;
    c.danmaku += r.parsedCount || 0;
    if (r.error) c.failed++;
    out.total.calls++;
    out.total.inputTokens += r.tokens.input;
    out.total.outputTokens += r.tokens.output;
    out.total.danmaku += r.parsedCount || 0;
    if (r.error) out.total.failed++;
  }
  return out;
}

module.exports = { TOKEN_PER_CHAR, TOKEN_PER_KB, KEEP_DAYS, estimateTokens, dataUrlKb, UsageCounter, aggregate };
