# 调用统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统计每次 AI 调用的"性价比"（次数、估算 token、产出弹幕条数、失败），设置页展示今日汇总与近 7 天趋势，暴露"白浪费 token"，不设上限不做拦截。

**Architecture:** 独立计数器模块 UsageCounter（brain 调用点记录，成功/失败都记，探测请求不计），内存 ring + 每日落盘 `usage-YYYY-MM-DD.jsonl`，跨天惰性切换、保留 7 天；聚合纯函数供设置页展示；设置页新增「调用统计」分区（汇总卡片 + 分通道表 + 纯 CSS 柱状图）。

**Tech Stack:** Electron、Node 内置模块（fs/path）、node:test，零新依赖。

## Global Constraints

- 零构建、零新依赖
- 估算 token 必须标注"估算值"（UI 与文档措辞）
- 计数不依赖 requests.jsonl（日志截断会失真）；落盘失败不影响计数
- 不设预算上限、无拦截逻辑
- `npm test` 全绿不挂起
- 每个任务结束时提交一次

---

### Task 1: UsageCounter 核心（估算 + 记录）

**Files:**
- Create: `src/shared/usageCounter.js`
- Test: `tests/usageCounter.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `estimateTokens({ inputChars, systemChars, outputChars, imageKb })` → `{ input, output }`；`dataUrlKb(dataUrl)` → number；`class UsageCounter({ dir, clock, fsMod, maxMem })`：`record({ channel, inputChars, systemChars, outputChars, imageKb, parsedCount, error })` → entry（含 tokens 估算）；`getToday()`/`getHistory(days)`（Task 3 实现）。Task 4 brain 接线依赖

- [ ] **Step 1: 写失败测试** `tests/usageCounter.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimateTokens, dataUrlKb, UsageCounter } = require('../src/shared/usageCounter');

test('estimateTokens 估算规则', () => {
  assert.deepEqual(estimateTokens({ inputChars: 150, systemChars: 150, outputChars: 150 }), { input: 200, output: 100 });
  assert.equal(estimateTokens({ inputChars: 0, systemChars: 0, outputChars: 0 }).input, 0);
  assert.equal(estimateTokens({ inputChars: 1, systemChars: 0, outputChars: 0 }).input, 1, '至少 1');
  // 视觉：截图 KB 额外计入 input
  assert.equal(estimateTokens({ inputChars: 0, systemChars: 0, outputChars: 0, imageKb: 58 }).input, 696);
});

test('dataUrlKb 估算截图 KB', () => {
  // base64：4 字符 ≈ 3 字节；"AAAA" = 3 字节
  assert.equal(dataUrlKb('data:image/jpeg;base64,AAAA'), 0);
  // 构造 ~10KB 的 dataUrl
  const b64 = 'A'.repeat(Math.ceil(10 * 1024 * 4 / 3));
  assert.equal(dataUrlKb('data:image/jpeg;base64,' + b64), 10);
  assert.equal(dataUrlKb(''), 0);
  assert.equal(dataUrlKb('not-a-data-url'), 0);
});

test('UsageCounter record 记录并估算 token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => Date.parse('2026-08-07T10:00:00Z'), fsMod: fs });
  const e = uc.record({ channel: 'text', inputChars: 100, systemChars: 200, outputChars: 300, parsedCount: 5 });
  assert.equal(e.channel, 'text');
  assert.deepEqual(e.tokens, { input: 200, output: 200 });
  assert.equal(e.parsedCount, 5);
  assert.equal(e.error, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UsageCounter 失败也记录（error 字段）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  const e = uc.record({ channel: 'vision', inputChars: 10, systemChars: 10, error: new Error('401') });
  assert.equal(e.error, '401');
  assert.equal(e.parsedCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UsageCounter 未知通道按文字通道处理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  uc.record({ channel: 'weird', inputChars: 1, systemChars: 1 });
  assert.equal(uc.getToday().text.calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/usageCounter.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** `src/shared/usageCounter.js`

```js
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
    return aggregate(this.records);
  }

  getHistory(days = KEEP_DAYS) {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/usageCounter.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/usageCounter.js tests/usageCounter.test.js
git commit -m "feat: 调用统计核心（token 估算 + 记录，成功/失败都记）"
```

---

### Task 2: 跨天切换与 7 天清理

**Files:**
- Modify: `src/shared/usageCounter.js`（已含 ensureDay/prune，本任务补测试验证）
- Test: `tests/usageCounter.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 实现
- Produces: 验证跨天恢复内存、过期文件清理的行为

- [ ] **Step 1: 写失败测试**（追加到 `tests/usageCounter.test.js`）

```js
test('跨天切换：新一天从当日文件恢复计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  let fakeNow = Date.parse('2026-08-07T23:00:00Z');
  const uc = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc.record({ channel: 'text', inputChars: 10, systemChars: 10, parsedCount: 3 });
  assert.equal(uc.getToday().text.calls, 1);
  // 跨天：记录一条 8/8，内存应只剩 8/8 的（7 日记录已落盘）
  fakeNow = Date.parse('2026-08-08T01:00:00Z');
  uc.record({ channel: 'vision', inputChars: 10, systemChars: 10, imageKb: 58 });
  assert.equal(uc.getToday().text.calls, 0, '8/8 内存不含 7/7 记录');
  assert.equal(uc.getToday().vision.calls, 1);
  // 新实例从落盘文件恢复 8/8
  const uc2 = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc2.record({ channel: 'text', inputChars: 1, systemChars: 1 });
  assert.equal(uc2.getToday().vision.calls, 1, '重启后从当日文件恢复');
  assert.equal(uc2.getToday().text.calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('7 天保留：过期文件自动清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  // 伪造 10 天前的文件
  fs.writeFileSync(path.join(dir, 'usage-2026-07-28.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'usage-2026-08-06.jsonl'), '{}\n');
  const uc = new UsageCounter({ dir, clock: () => Date.parse('2026-08-07T10:00:00Z'), fsMod: fs });
  uc.record({ channel: 'text', inputChars: 1, systemChars: 1 });
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('usage-'));
  assert.ok(!files.includes('usage-2026-07-28.jsonl'), '10 天前文件被清理');
  assert.ok(files.includes('usage-2026-08-06.jsonl'), '1 天前文件保留');
  assert.ok(files.includes('usage-2026-08-07.jsonl'), '当日文件存在');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/usageCounter.test.js`
Expected: FAIL — 跨天切换逻辑未实现（record 不换日/不清理）

- [ ] **Step 3: 实现**（Task 1 的 `ensureDay`/`prune` 已实现——若 Step 2 意外全过，则确认行为后直接进入 Step 4）

实现要点（若按 Task 1 代码落地则本任务无需新代码，仅测试验证；若发现缺陷在此修复）：
- `ensureDay` 在日期变化时重载内存并 `prune()`
- `prune` 按 `cutoff = dayOf(now - 6天)` 清理更早文件

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/usageCounter.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/usageCounter.js tests/usageCounter.test.js
git commit -m "feat: 调用统计跨天切换与 7 天文件清理"
```

---

### Task 3: 聚合与历史（getToday/getHistory）

**Files:**
- Modify: `src/shared/usageCounter.js`（已含 aggregate/getToday/getHistory——本任务补测试）
- Test: `tests/usageCounter.test.js`（追加）

**Interfaces:**
- Consumes: Task 1/2
- Produces: `getToday()` 返回 `{ text, vision, total }` 各含 `{ calls, inputTokens, outputTokens, danmaku, failed }`；`getHistory(7)` 返回日期升序数组。Task 5 IPC 依赖

- [ ] **Step 1: 写失败测试**（追加到 `tests/usageCounter.test.js`）

```js
test('aggregate 分通道与合计（含失败与产出）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => Date.parse('2026-08-07T10:00:00Z'), fsMod: fs });
  uc.record({ channel: 'text', inputChars: 100, systemChars: 200, outputChars: 300, parsedCount: 5 });
  uc.record({ channel: 'text', inputChars: 100, systemChars: 100, error: new Error('401') });
  uc.record({ channel: 'vision', inputChars: 0, systemChars: 50, imageKb: 58, outputChars: 100, parsedCount: 3 });
  const t = uc.getToday();
  assert.equal(t.text.calls, 2);
  assert.equal(t.text.failed, 1);
  assert.equal(t.text.danmaku, 5);
  assert.equal(t.vision.calls, 1);
  assert.equal(t.vision.inputTokens, Math.ceil(50 / 1.5) + Math.ceil(58 * 12));
  assert.equal(t.total.calls, 3);
  assert.equal(t.total.failed, 1);
  assert.equal(t.total.danmaku, 8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getHistory 返回近 7 天（含空天）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  let fakeNow = Date.parse('2026-08-07T10:00:00Z');
  const uc = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc.record({ channel: 'text', inputChars: 10, systemChars: 10 });
  const h = uc.getHistory(7);
  assert.equal(h.length, 7);
  assert.equal(h[0].date, '2026-08-01');
  assert.equal(h[6].date, '2026-08-07');
  assert.equal(h[6].calls, 1);
  assert.equal(h[0].calls, 0, '空天为 0');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/usageCounter.test.js`
Expected: 若 Task 1 已实现 aggregate/getToday/getHistory 则 PASS（确认行为）；否则 FAIL 后补齐实现（代码见 Task 1）

- [ ] **Step 3: 实现**（如缺则按 Task 1 代码补齐 aggregate/getToday/getHistory）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/usageCounter.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/usageCounter.js tests/usageCounter.test.js
git commit -m "feat: 调用统计聚合（分通道/合计/近 7 天）"
```

---

### Task 4: brain 接线（成功/失败记录，探测不计数）

**Files:**
- Modify: `src/shared/brain.js`（constructor、generateText、generateVision）
- Test: `tests/brain.test.js`（追加）

**Interfaces:**
- Consumes: UsageCounter（Task 1-3）
- Produces: Brain constructor 新可选参数 `usageCounter`；生成调用（含失败）自动计数；retryNow 探测不计数

- [ ] **Step 1: 写失败测试**（追加到 `tests/brain.test.js`）

```js
const { UsageCounter } = require('../src/shared/usageCounter');

test('调用统计：成功与失败都记录，探测不计数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  const { brain, generator } = makeEnv({ usageCounter: uc });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  // 成功
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  const afterSuccess = uc.getToday().text.calls;
  assert.equal(afterSuccess, 1);
  // 失败
  generator.chatCompletion = async () => { throw new Error('挂了'); };
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(uc.getToday().text.calls, 2, '失败也计数');
  assert.equal(uc.getToday().text.failed, 1);
  // 探测请求不计数
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(uc.getToday().text.calls, 2, 'retryNow 探测不计数');
  brain.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/brain.test.js`
Expected: FAIL — makeEnv 未传 usageCounter 时 uc 计数为 0

- [ ] **Step 3: 实现**（brain.js）

constructor 参数列表加 `usageCounter = null`，并 `this.usageCounter = usageCounter;`

generateText 成功分支（`this.logger?.logRequest(...)` 之后）：

```js
      this.usageCounter?.record({ channel: 'text', inputChars: user.length, systemChars: system.length, outputChars: raw.length, parsedCount: lines.length });
```

generateText catch 分支：

```js
      this.usageCounter?.record({ channel: 'text', inputChars: user.length, systemChars: system.length, error: err });
```

generateVision 成功分支（改造 `emitParsed` 返回条数，避免二次解析）：

```js
  // 视觉弹幕：直接发送（画面弹幕实时性优先）；返回解析条数（调用统计用）
  emitParsed(raw, src) {
    const lines = parseDanmakuJson(raw, this.config.danmaku.replyCount || 10);
    if (lines.length === 0) return 0;
    this.lastVisionEmit = this.clock();
    for (const line of lines) {
      this.onDanmaku(line, { source: 'ai' });
    }
    if (this.state.error[src]) this.clearError(src);
    this.emitStatus();
    return lines.length;
  }
```

```js
      const raw = await this.generator.visionCompletion({...});
      this.logger?.logRequest({...});
      const parsedCount = this.emitParsed(raw, 'vision');
      this.usageCounter?.record({ channel: 'vision', inputChars: system.length, systemChars: system.length, outputChars: raw.length, parsedCount, imageKb: dataUrlKb(entry.imageDataUrl) });
```

generateVision catch 分支：

```js
      this.usageCounter?.record({ channel: 'vision', inputChars: system.length, systemChars: system.length, error: err, imageKb: dataUrlKb(entry.imageDataUrl) });
```

（require 增加 `const { dataUrlKb } = require('./usageCounter');`）

makeEnv 增加透传（tests/brain.test.js 的 makeEnv）：

```js
  const brain = new Brain({
    config: cfg, generator, reporter, templates,
    onDanmaku: (text, meta) => danmaku.push({ text, meta }),
    onStatus: (s) => statuses.push(s),
    ...overrides,
  });
```

（makeEnv 已用 `...overrides` 透传，无需改；usageCounter 经 overrides 传入即可）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/brain.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/brain.js tests/brain.test.js
git commit -m "feat: brain 接线调用统计（成功/失败记录，探测不计数）"
```

---

### Task 5: main.js + preload IPC 装配

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/preload/preload.js`

**Interfaces:**
- Consumes: UsageCounter（Task 1-3）
- Produces: `settings:getUsageStats` IPC → `{ today, history }`（today = getToday()，history = getHistory(7)）；preload `window.settings.getUsageStats()`

- [ ] **Step 1: 实现**（main.js）

require 增加：

```js
const { UsageCounter } = require('../shared/usageCounter');
```

whenReady 内（logger 创建后）：

```js
    // 调用统计：只记录发给 AI 的请求（含失败），探测请求不计
    const usage = new UsageCounter({ dir: path.join(app.getPath('userData'), 'usage') });
```

brain 构造加：

```js
      usageCounter: usage,
```

IPC 注册（`settings:getStatus` 附近）：

```js
    ipcMain.handle('settings:getUsageStats', () => ({ today: usage.getToday(), history: usage.getHistory(7) }));
```

（preload.js settings 对象加）

```js
  getUsageStats: () => ipcRenderer.invoke('settings:getUsageStats'),
```

- [ ] **Step 2: 验证**

Run: `npm test` — 全绿（97 + 本计划新增）
Run: `npm start` 冒烟——设置页 `window.settings.getUsageStats()` 可调用（控制台验证）

- [ ] **Step 3: 提交**

```bash
git add src/main/main.js src/preload/preload.js
git commit -m "feat: 调用统计 IPC 装配（settings:getUsageStats）"
```

---

### Task 6: 设置页「调用统计」分区

**Files:**
- Modify: `src/renderer/settings/settings.html`（新 section）
- Modify: `src/renderer/settings/settings.js`（renderUsageStats + 刷新按钮）
- Modify: `src/renderer/settings/settings.css`（usage 样式）

**Interfaces:**
- Consumes: `window.settings.getUsageStats()`（Task 5）
- Produces: 设置页统计分区（汇总卡片/分通道表/7 天柱状/估算 `？` tooltip），加载与保存后自动刷新

- [ ] **Step 1: 实现 HTML**（日志 section 之前插入）

```html
  <section>
    <h2>调用统计 <span class="hint-mark" data-tip="统计发送给 AI 的请求（含失败）。token 为估算值：按字符数/1.5 粗估（中英混合），视觉按截图大小另加；实际计费以你的 API 服务商为准。本统计不设上限、不拦截请求">？</span></h2>
    <button id="btn-refresh-usage">刷新</button>
    <div id="usage-summary"></div>
    <div id="usage-channels"></div>
    <h3>近 7 天调用次数</h3>
    <div id="usage-chart" class="usage-chart"></div>
  </section>
```

- [ ] **Step 2: 实现 CSS**（settings.css 追加）

```css
.usage-card { font-size: 13px; padding: 8px 10px; background: #16161f; border: 1px solid #444; border-radius: 4px; margin: 6px 0; line-height: 1.7; }
.usage-channels { font-size: 12px; margin: 6px 0; }
.usage-channels table { border-collapse: collapse; }
.usage-channels th, .usage-channels td { border: 1px solid #444; padding: 3px 10px; text-align: center; }
.usage-channels th { background: #2a2a3e; }
.usage-chart { display: flex; align-items: flex-end; gap: 6px; height: 100px; padding: 6px 0; border-bottom: 1px solid #555; }
.usage-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.usage-bar { width: 100%; max-width: 36px; background: #4a6cf7; border-radius: 2px 2px 0 0; min-height: 2px; }
.usage-bar-tokens { background: #ffd93d; }
.usage-bar-label { font-size: 10px; color: #999; }
```

- [ ] **Step 3: 实现 JS**（settings.js 追加）

```js
// 调用统计：今日汇总 + 分通道 + 近 7 天柱状（估算 token 黄色叠加）
async function renderUsageStats() {
  const { today, history } = await window.settings.getUsageStats();
  const sum = $('usage-summary');
  const t = today.total;
  sum.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'usage-card';
  card.innerHTML =
    `今日：调用 <b>${t.calls}</b> 次 · 输入 ≈${t.inputTokens} token · 输出 ≈${t.outputTokens} token` +
    ` · 产出 <b>${t.danmaku}</b> 条弹幕 · 失败 <b>${t.failed}</b> 次` +
    (t.calls ? `（每次调用平均产出 ${(t.danmaku / t.calls).toFixed(1)} 条）` : '');
  sum.appendChild(card);

  const ch = $('usage-channels');
  ch.innerHTML = '';
  const table = document.createElement('table');
  table.innerHTML = `<tr><th>通道</th><th>次数</th><th>输入 token</th><th>输出 token</th><th>产出条数</th><th>失败</th></tr>`;
  for (const [key, label] of [['text', '文字'], ['vision', '视觉']]) {
    const c = today[key];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${c.calls}</td><td>≈${c.inputTokens}</td><td>≈${c.outputTokens}</td><td>${c.danmaku}</td><td>${c.failed}</td>`;
    table.appendChild(tr);
  }
  ch.appendChild(table);

  const chart = $('usage-chart');
  chart.innerHTML = '';
  const max = Math.max(1, ...history.map((d) => d.calls));
  const maxT = Math.max(1, ...history.map((d) => d.tokens));
  for (const d of history) {
    const wrap = document.createElement('div');
    wrap.className = 'usage-bar-wrap';
    const hCalls = Math.max(2, Math.round((d.calls / max) * 80));
    const hTokens = Math.max(2, Math.round((d.tokens / maxT) * 80));
    const col = document.createElement('div');
    col.style.height = hCalls + 'px';
    col.className = 'usage-bar';
    col.title = `${d.date}：${d.calls} 次`;
    const colT = document.createElement('div');
    colT.style.height = hTokens + 'px';
    colT.className = 'usage-bar usage-bar-tokens';
    colT.title = `${d.date}：≈${d.tokens} token`;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:84px;';
    bar.appendChild(colT);
    bar.appendChild(col);
    const label = document.createElement('div');
    label.className = 'usage-bar-label';
    label.textContent = d.date.slice(5);
    wrap.appendChild(bar);
    wrap.appendChild(label);
    chart.appendChild(wrap);
  }
}

$('btn-refresh-usage').onclick = renderUsageStats;
```

（load 完成处追加）

```js
load().then(async () => { await renderRequestLogs(); renderUsageStats(); });
```

- [ ] **Step 4: 验证**

Run: `npm test`（设置页改动不影响测试）
Run: `npm start` 冒烟——设置页调用统计分区：无请求时显示 0；发起一次真实请求后刷新可见数字；`？` tooltip 悬停显示估算说明
Expected: 97+ 全绿；分区正常

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings/settings.html src/renderer/settings/settings.js src/renderer/settings/settings.css
git commit -m "feat: 设置页调用统计分区（汇总/分通道/近 7 天趋势）"
```

---

### Task 7: 冒烟验证与收尾

**Files:** 无（验证 + 文档）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（97 + 新增 ≈ 108）

- [ ] **Step 2: 实机冒烟清单（macOS）**

```bash
npm start
```

逐项验证：
1. 正常使用几分钟（文件操作/切屏）→ 设置页「调用统计」数字增长，含估算 token 与产出条数
2. 故意填错 key 触发一次失败 → 失败计数 +1，弹幕暂停提示正常
3. 重启应用 → 今日统计保留（落盘）；无请求时历史趋势正常显示
4. `？` tooltip 悬停可见估算说明
5. `ls ~/Library/Application\ Support/bullet-chat/usage/` 可见 `usage-2026-08-07.jsonl`

- [ ] **Step 3: 收尾提交**

```bash
git log --oneline -12
git status --short  # 确认无遗漏
```

（本任务无代码提交；如冒烟发现问题，按问题修复后单独提交）
