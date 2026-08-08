# 弹幕最新优先（Latest-First）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 最新回复的弹幕优先飘出（插队 + 年龄丢弃 + 优先发批），解决积压拖后/单次慢/内容过时/顺序乱四个时效性问题。

**Architecture:** 改动全部集中在 `src/shared/brain.js` 的弹幕缓冲层：`buffer` 元素从 `string` 改为 `{ text, ts }`，`pushBuffer` 由"追加队尾"改为"整批插队首 + 年龄清理 + 上限从队尾截断"（队首=最新，队尾=最旧）；`scheduleEmit(priority)` 在新回复到达且距上次飘出 ≥3s 时打断现有定时器立即发一批。stage 渲染层接口不变。

**Tech Stack:** Node.js（node:test + node:assert/strict，无新依赖），Electron 主进程共享模块。

## Global Constraints

- 只改 `src/shared/brain.js` 与 `tests/brain.test.js` 两个文件，不碰其他文件
- `STALE_BUFFER_MS = 30000`（弹幕年龄上限）、`PRIORITY_GAP_MS = 3000`（优先发批最短间隔）：代码常量，**不新增配置项**
- 不改 `minIntervalSec` / `burstMin` / `burstMax` / `maxEventAgeSec` / `batchIntervalMs` 配置默认值
- `buffer` 元素结构 `{ text, ts }`，ts = 入队时间戳（用 `this.clock()`，可注入 fake clock 测试）
- 测试命令：`npm test`（= `node --test`，现有 153 用例）
- 测试环境注入模式：`makeEnv({ clock: () => fakeNow })`（可变 fakeNow 变量）、`makeEnv({ rng: () => x })`

---

### Task 1: 缓冲数据模型 + 最新优先插队（pushBuffer 重写）

**Files:**
- Modify: `src/shared/brain.js:18`（常量区）、`src/shared/brain.js:80`（字段注释）、`src/shared/brain.js:256-268`（bufferLimit/pushBuffer）、`src/shared/brain.js:288-291`（emit 取 `.text`）
- Test: `tests/brain.test.js:373`、`:523`、`:542`（直接 push 字符串 → 对象）、`:748-762`（缓冲上限测试重写）、文件末尾（2 个新测试）

**Interfaces:**
- Consumes: 现有 `pushBuffer(lines)`（lines 为 string[]，来自 `parseDanmakuJson`）、`this.buffer`（`maybeRefill` 只读 `length`，不变）
- Produces: `pushBuffer(lines)` 签名不变，行为变为：整批 `unshift` 队首 + 队尾方向年龄清理（>30s pop）+ 超限队尾截断；`this.buffer` 元素为 `{ text, ts }`；emit 循环 `shift()` 后取 `.text`；新增常量 `STALE_BUFFER_MS`

- [ ] **Step 1: 写失败测试（新增 2 个 + 重写上限测试）**

在 `tests/brain.test.js` 末尾（`缓冲上限：文字与视觉生成都走 pushBuffer` 测试之后）追加：

```js
test('最新优先：有旧积压时新回复插队首先飘出（批内顺序保持）', () => {
  const { brain, danmaku } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，便于断言
  brain.buffer.push({ text: '旧1', ts: Date.now() }, { text: '旧2', ts: Date.now() });
  brain.pushBuffer(['新1', '新2']);
  assert.equal(brain.buffer[0].text, '新1', '新回复插队首');
  assert.equal(brain.buffer[2].text, '旧1', '旧弹幕退到队尾');
  brain.scheduleEmit();
  assert.equal(danmaku[0].text, '新1', '最新回复先飘出');
  assert.equal(brain.buffer[0].text, '新2', '批内顺序保持（未反转）');
  brain.stop();
});

test('最新优先：新回复到达时丢弃入队超过 30s 的旧弹幕', () => {
  let fakeNow = 1000000;
  const { brain } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.buffer.push({ text: '旧1', ts: fakeNow - 40000 }, { text: '旧2', ts: fakeNow - 10000 });
  brain.pushBuffer(['新1']);
  assert.equal(brain.buffer.length, 2, '入队 40s 的旧弹幕被丢，10s 内的保留');
  assert.equal(brain.buffer[0].text, '新1');
  assert.equal(brain.buffer[1].text, '旧2');
  brain.stop();
});
```

重写现有测试 `缓冲上限：超限丢最旧保留最新（防视觉高频积压）`（当前在第 748 行）为：

```js
test('缓冲上限：超限丢最旧保留最新（防视觉高频积压）', () => {
  const { brain } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600; // 不消耗，纯观察
  brain.config.danmaku.burstMax = 3;          // 上限 = max(10, 3*5) = 15
  brain.pushBuffer(Array.from({ length: 15 }, (_, i) => `弹幕${i}`));
  assert.equal(brain.buffer.length, 15);
  brain.pushBuffer(['新1', '新2']);
  assert.equal(brain.buffer.length, 15, '超限截断');
  assert.ok(brain.buffer.some((b) => b.text === '弹幕0'), '插队模式：最早入队的旧弹幕在队尾仍保留');
  assert.ok(!brain.buffer.some((b) => b.text === '弹幕13') && !brain.buffer.some((b) => b.text === '弹幕14'), '最旧（队尾）被丢');
  assert.ok(brain.buffer.some((b) => b.text === '新2'), '最新保留');
  // 小 burstMax 时下限 10 兜底
  brain.config.danmaku.burstMax = 1;
  assert.equal(brain.bufferLimit(), 10, '上限不低于 10');
  brain.stop();
});
```

- [ ] **Step 2: 运行确认新测试失败**

Run: `npm test 2>&1 | tail -40`
Expected: 新测试 FAIL——旧实现 `pushBuffer` 追加队尾（`buffer[0].text` 为 undefined、`includes` 断言旧语义不满足）。

- [ ] **Step 3: 实现 brain.js 核心改动**

`src/shared/brain.js` 常量区（`FILE_APP_TYPES` 行之后）新增：

```js
const STALE_BUFFER_MS = 30000; // 弹幕缓冲年龄上限：新回复到达时丢弃入队超过 30s 的旧弹幕（积压旧闻不占屏幕）
```

`this.buffer` 字段注释（第 80 行）改为：

```js
    this.buffer = [];         // 弹幕缓冲池：{ text, ts } 元素，最新优先（新回复插队首），按节奏逐条吐出
```

`pushBuffer`（第 264-268 行）整体替换为：

```js
  pushBuffer(lines) {
    const now = this.clock();
    // 最新优先：新回复整批插队首（保持批内顺序），视觉/文字通道统一
    this.buffer.unshift(...lines.map((text) => ({ text, ts: now })));
    // 年龄清理：入队超过 STALE_BUFFER_MS 的旧弹幕直接丢（队尾方向最旧，逐条 pop）
    while (this.buffer.length && now - this.buffer[this.buffer.length - 1].ts > STALE_BUFFER_MS) this.buffer.pop();
    // 上限兜底：仍超限则从队尾截断（丢最旧）
    const limit = this.bufferLimit();
    if (this.buffer.length > limit) this.buffer.splice(limit);
  }
```

`scheduleEmit` 的 emit 循环（第 288-291 行）改为：

```js
      for (let i = 0; i < n; i++) {
        const item = this.buffer.shift();
        if (item === undefined) break;
        this.onDanmaku(item.text, { source: 'ai' });
      }
```

同步更新 `bufferLimit` 上方注释（第 258-259 行）为：

```js
  // 弹幕缓冲上限：防生成速率 > 消耗速率时积压（视觉通道高频场景每 10s +10 条 vs 消耗 2~3 条）。
  // 最新优先：新回复整批插队首（保持批内顺序），队尾方向即最旧；
  // 超限丢最旧保留最新（直播语义：弹幕是即时的，积压的旧弹幕没意义，最新弹幕才有价值）
```

- [ ] **Step 4: 适配现有测试的数据结构**

`tests/brain.test.js` 三处直接 push 字符串改为 push 对象：

第 373 行 `brain.buffer.push('a', 'b'); // 缓冲只有 2 条` →
```js
  brain.buffer.push({ text: 'a', ts: Date.now() }, { text: 'b', ts: Date.now() }); // 缓冲只有 2 条
```

第 523 行 `brain.buffer.push('占位1', '占位2', '占位3'); // 缓冲充足（> REFILL_THRESHOLD=2）` →
```js
  brain.buffer.push({ text: '占位1', ts: Date.now() }, { text: '占位2', ts: Date.now() }, { text: '占位3', ts: Date.now() }); // 缓冲充足（> REFILL_THRESHOLD=2）
```

第 542 行 `brain.buffer.push('占位1', '占位2', '占位3');  // 缓冲充足，补充不触发` → 同样三对象结构（`// 缓冲充足，补充不触发` 注释保留）。

- [ ] **Step 5: 运行全量测试确认通过**

Run: `npm test 2>&1 | tail -20`
Expected: 全部 PASS（176 现有适配后 + 2 新 = 178，无 FAIL）。

- [ ] **Step 6: 提交**

```bash
git add src/shared/brain.js tests/brain.test.js
git commit -m "feat: 弹幕缓冲最新优先（插队+年龄清理+上限丢最旧）"
```

---

### Task 2: 优先发批（scheduleEmit priority 打断）

**Files:**
- Modify: `src/shared/brain.js:18`（常量区追加）、`src/shared/brain.js:256-297`（scheduleEmit 头部 + 注释）、`src/shared/brain.js:324-325`、`:356-357`（两处调用点加 priority）
- Test: `tests/brain.test.js` 文件末尾（2 个新测试）

**Interfaces:**
- Consumes: Task 1 的 `pushBuffer`（插队语义）、`this.lastEmitAt`（上次飘出时间戳，emit 回调内更新）、`this.emitTimer`
- Produces: `scheduleEmit(priority = false)`——priority 且距上次飘出 ≥ `PRIORITY_GAP_MS` 时清现有定时器立即调度（delay=0）；priority 等待至多 `PRIORITY_GAP_MS`；非 priority 行为与旧版完全一致；`generateText`/`generateVision` 成功后改调 `scheduleEmit(true)`；新增常量 `PRIORITY_GAP_MS`

- [ ] **Step 1: 写失败测试（2 个）**

在 `tests/brain.test.js` 末尾追加：

```js
test('优先发批：距上次飘出 ≥3s 时打断现有定时器立即发', async () => {
  let fakeNow = 1000000;
  const { brain, danmaku } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600; // 常规节奏极慢：模拟"定时器在跑"
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1;
  brain.buffer.push({ text: '旧1', ts: fakeNow }, { text: '旧2', ts: fakeNow });
  brain.scheduleEmit(); // 非优先：起 3600s 定时器（旧1 立即吐出）
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(danmaku.length, 1, '旧1 已出');
  assert.ok(brain.emitTimer, '旧2 的节奏定时器在跑');
  fakeNow += 5000; // 5 秒后：距上次飘出 ≥3s
  brain.pushBuffer(['新1']);
  brain.scheduleEmit(true); // 优先：应打断 3600s 定时器立即发
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(danmaku.length, 2, '新1 立即飘出（不等 3600s 节奏）');
  assert.equal(danmaku[1].text, '新1', '最新回复先出');
  brain.stop();
});

test('优先发批：距上次飘出 <3s 时保留现有定时器（防连发刷屏）', async () => {
  let fakeNow = 1000000;
  const { brain, danmaku } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1;
  brain.buffer.push({ text: '旧1', ts: fakeNow }, { text: '旧2', ts: fakeNow });
  brain.scheduleEmit();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(danmaku.length, 1);
  const timer = brain.emitTimer;
  assert.ok(timer, '节奏定时器在跑');
  fakeNow += 1000; // 1 秒后：距上次飘出 <3s
  brain.pushBuffer(['新1']);
  brain.scheduleEmit(true);
  assert.equal(brain.emitTimer, timer, '现有定时器保留（不打断）');
  brain.stop();
});
```

- [ ] **Step 2: 运行确认新测试失败**

Run: `npm test 2>&1 | tail -30`
Expected: 新测试 FAIL——旧 `scheduleEmit()` 无 priority 参数，`scheduleEmit(true)` 不打断（第一测断言 `danmaku.length === 2` 失败：3600s 定时器未到点，新1 未出）。

- [ ] **Step 3: 实现 scheduleEmit(priority)**

`src/shared/brain.js` 常量区（`STALE_BUFFER_MS` 之后）追加：

```js
const PRIORITY_GAP_MS = 3000;  // 优先发批最短间隔：距上次飘出 ≥3s 时新回复立即发一批（防连发刷屏）
```

`scheduleEmit`（第 270-297 行）整体替换为：

```js
  // 弹幕吐出：按 minIntervalSec 节奏一批批飘（每批 burstMin~burstMax 条随机，像直播间弹幕雨）。
  // priority（AI 新回复到达）：距上次飘出 ≥ PRIORITY_GAP_MS 时打断现有定时器立即发一批，
  // 最新回复不等满节奏；< PRIORITY_GAP_MS（刚飘完）保留现有定时器防连发刷屏。
  // 批大小受同屏上限（maxConcurrent）与缓冲余量约束；补充后第一批立即出（不等满间隔）
  scheduleEmit(priority = false) {
    if (this.emitTimer) {
      if (priority && (this.lastEmitAt ? this.clock() - this.lastEmitAt >= PRIORITY_GAP_MS : true)) {
        clearTimeout(this.emitTimer); // 优先：打断现有定时器，立即发最新回复
        this.emitTimer = null;
      } else {
        return; // 非优先或刚飘过一批：保留现有定时器
      }
    }
    if (this.state.paused) return;
    const sinceLast = this.lastEmitAt ? this.clock() - this.lastEmitAt : Infinity;
    // priority 发批等待至多 PRIORITY_GAP_MS（间隔已满足则立即）；普通节奏补足 minIntervalSec
    const delay = priority ? Math.max(0, PRIORITY_GAP_MS - sinceLast) : Math.max(0, this.config.danmaku.minIntervalSec * 1000 - sinceLast);
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
        const item = this.buffer.shift();
        if (item === undefined) break;
        this.onDanmaku(item.text, { source: 'ai' });
      }
      if (this.buffer.length) this.scheduleEmit();
      else this.maybeRefill();
    }, delay);
    this.emitTimer.unref?.();
  }
```

- [ ] **Step 4: 两处调用点加 priority**

`generateText` 内（第 324-325 行）：

```js
      if (lines.length) {
        this.pushBuffer(lines);
        this.scheduleEmit(true); // 优先发批：新回复立即（或 ≤3s 内）飘出，不等满节奏
      }
```

`generateVision` 内（第 356-357 行）同样改为 `this.scheduleEmit(true);`（上方注释同步改为"视觉弹幕也进缓冲，最新优先插队：……"）。

- [ ] **Step 5: 运行全量测试确认通过**

Run: `npm test 2>&1 | tail -20`
Expected: 全部 PASS（178 + 2 新 = 180，无 FAIL）。重点确认 `批量吐出` / `事件风暴` / `补充闸门` 主题用例不回归（priority 路径 delay 计算在这些场景下仍为 0 或与原行为等价）。

- [ ] **Step 6: 提交**

```bash
git add src/shared/brain.js tests/brain.test.js
git commit -m "feat: 新回复优先发批（scheduleEmit priority，打断节奏立即飘出）"
```

---

### Task 3: 全量回归 + 冒烟验证

**Files:** 无代码改动

**Interfaces:**
- Consumes: Task 1+2 完成后的 `src/shared/brain.js`
- Produces: 验证结论

- [ ] **Step 1: 全量测试 + 计数核对**

Run: `npm test 2>&1 | tail -30`
Expected: 全部 PASS；末尾统计显示 `tests 180`（176 旧 + 4 新）。

- [ ] **Step 2: git 状态核对**

Run: `git status --short && git log --oneline -3`
Expected: 工作区干净；最近 3 条 commit 为 `feat: 新回复优先发批…`、`feat: 弹幕缓冲最新优先…`、`docs: 弹幕最新优先设计…`。

- [ ] **Step 3: 冒烟（可选，需用户在场）**

Run: `npm start`（Electron 应用窗口打开）
手动验证：
1. 触发视觉高频场景（如播放视频/滚动页面）让缓冲积压，然后立刻操作文件或切换应用 → 相关弹幕应在 3 秒内飘出（旧行为：等积压排空）
2. 观察弹幕雨节奏仍存在（连续多批，每批 2~8 条）
3. 本地模式（设置页切换）弹幕行为不变

结论记录在提交信息或会话中；不满足预期则回到对应 Task 修。
