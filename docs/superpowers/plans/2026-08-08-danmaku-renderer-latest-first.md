# 渲染层最新优先 + 视觉源头降产 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐"弹幕最新优先"的渲染层环节：视觉源头降产（每次回复 ≤3 条，匹配舞台容量）+ 渲染层批次插队（新批队首、批内保序、上限丢最旧），实机压力测试下文字回复 ≤3s 上屏、视觉弹幕持续显示不丢弃。

**Architecture:** 改动两个文件。`src/shared/brain.js`：新增 `VISION_MAX_COUNT = 3` 常量并用于视觉 `maxCount`（源头降产）；每次 burst 递增 `burstId` 并随 emit meta 传给渲染层（`{ source: 'ai', burst: id }`，同批共享）。`src/renderer/stage/danmaku.js`：`pending` 从单条 FIFO 改为批次队列（新批 `unshift` 队首、批内追加保序、dequeue 从队首批取、`PENDING_LIMIT = 15` 超限从队尾丢最旧批）—— 与脑侧"队首=最新、队尾=最旧、丢最旧"完全同构。本地模式无 burst 字段，每条自成一批同样最新优先。

**Tech Stack:** Node.js（node:test + node:assert/strict），Electron 渲染层无单测（项目惯例 CDP 实机验证）。

## Global Constraints

- 只改 `src/shared/brain.js`、`src/renderer/stage/danmaku.js`、`tests/brain.test.js` 三个文件
- `VISION_MAX_COUNT = 3`（视觉单次回复条数上限）、`PENDING_LIMIT = 15`（渲染层队列上限）：代码常量，**不新增配置项**
- 不改文字 `replyCount` / `burstMin` / `burstMax` / `minIntervalSec` / `maxConcurrent` 配置默认值；不改 `parseDanmakuJson` 的解析上限（仍用 replyCount，模型产出已 ≤3 无影响）
- 不区分文字/视觉优先级 —— 两通道统一最新优先（用户拍板）
- 测试命令：`npm test`（= `node --test`，当前基线 185 用例）
- 渲染层验证命令：CDP（`npm start -- --remote-debugging-port=9222` + `node tools/cdp.js "<表达式>" --page danmaku.html`），压测脚本在 Task 3 给出

---

### Task 1: brain.js —— 视觉源头降产 + burst 批标记

**Files:**
- Modify: `src/shared/brain.js:20`（常量区）、`src/shared/brain.js:80` 附近（constructor 字段）、`src/shared/brain.js:306-314`（emit 循环 meta）、`src/shared/brain.js:360-372`（generateVision maxCount）
- Test: `tests/brain.test.js` 文件末尾（2 个新测试）

**Interfaces:**
- Consumes: 现有 `scheduleEmit` 回调（`this.lastEmitAt = now` 后）、`generateVision`（`maxCount` 传参）、`this.config.danmaku.replyCount`
- Produces: 常量 `VISION_MAX_COUNT = 3`；constructor 字段 `this.burstId = 0`（每次 burst 递增）；emit meta `{ source: 'ai', burst: this.burstId }`（同批共享 id）；`generateVision` 的 `maxCount = Math.min(replyCount || 10, VISION_MAX_COUNT)`。Task 2 的渲染层依赖 meta.burst 分组

- [ ] **Step 1: 写失败测试（2 个）**

在 `tests/brain.test.js` 末尾追加：

```js
test('批标记：同批弹幕共享 burst id，不同批递增', async () => {
  const { brain, danmaku } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 2;
  brain.config.danmaku.burstMax = 2; // 一批 2 条
  brain.pushBuffer(['一', '二']);
  brain.scheduleEmit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 2, '一批 2 条全出');
  assert.equal(danmaku[0].meta.burst, danmaku[1].meta.burst, '同批共享批标记');
  assert.ok(danmaku[0].meta.burst >= 1, '有递增批标记');
  brain.stop();
});

test('视觉源头降产：maxCount = min(replyCount, 3)', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let got = null;
  generator.visionCompletion = async (args) => { got = args; return '["v1"]'; };
  brain.config.danmaku.replyCount = 10;
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl: 'data:image/jpeg;base64,TEST' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.maxCount, 3, 'replyCount=10 时视觉降产到 3');
  brain.config.danmaku.replyCount = 2;
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化2', path: '', drive: '', imageDataUrl: 'data:image/jpeg;base64,TEST2' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.maxCount, 2, 'replyCount < 3 时用 replyCount');
  brain.stop();
});
```

- [ ] **Step 2: 运行确认新测试失败**

Run: `npm test 2>&1 | tail -30`
Expected: 2 个新测试 FAIL（旧实现 meta 无 burst 字段 → `meta.burst` undefined；视觉 maxCount 恒为 replyCount）。

- [ ] **Step 3: 实现 brain.js**

常量区（`PRIORITY_GAP_MS` 之后）新增：

```js
const VISION_MAX_COUNT = 3; // 视觉弹幕单次回复条数上限：源头降产（视觉 ~0.3/s < 舞台容量 ~0.625/s），
                            // 防渲染层排队超载；输出 token 减少也直接省钱
```

constructor 字段（`this.emitTimer = null;` 之后）新增：

```js
    this.burstId = 0;        // 弹幕批标记：每次 burst 递增，渲染层批间最新优先、批内保序
```

`scheduleEmit` 回调（第 309-313 行）改为：

```js
      this.lastEmitAt = now;
      this.burstId += 1; // 批标记：同批共享 id，渲染层按批插队且批内保序
      for (let i = 0; i < n; i++) {
        const item = this.buffer.shift();
        if (item === undefined) break;
        this.onDanmaku(item.text, { source: 'ai', burst: this.burstId });
      }
```

`generateVision`（第 360-372 行附近）改为：

```js
      const maxCount = Math.min(this.config.danmaku.replyCount || 10, VISION_MAX_COUNT);
      const raw = await this.generator.visionCompletion({
        baseUrl: this.config.visionModel.baseUrl,
        apiKey: this.config.visionModel.apiKey,
        model: this.config.visionModel.model,
        system,
        imageDataUrl: entry.imageDataUrl,
        maxCount,
      });
```

（原 `maxCount: this.config.danmaku.replyCount || 10,` 一行替换为上面两处。）

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm test 2>&1 | tail -8`
Expected: 全部 PASS（185 + 2 新 = 187）。重点确认现有视觉测试（usageCounter inputTokens 断言、`缓冲上限：文字与视觉生成都走 pushBuffer`）不回归。

- [ ] **Step 5: 提交**

```bash
git add src/shared/brain.js tests/brain.test.js
git commit -m "feat: 视觉源头降产（maxCount≤3）+ emit 批标记（渲染层插队前置）"
```

---

### Task 2: danmaku.js —— 批次队列（新批插队 + 上限丢最旧）

**Files:**
- Modify: `src/renderer/stage/danmaku.js:27-41`（pending/dequeue/show 入队逻辑）
- Test: 无单测（渲染层项目惯例 CDP 验证，Task 3 执行）

**Interfaces:**
- Consumes: Task 1 的 emit meta `{ source: 'ai', burst: id }`（同批共享 id；本地模式/`window.show` 无 burst 字段）
- Produces: `pending` 为批次队列 `[{ burst, lines: [{text, meta}, ...] }, ...]`（队首=最新批）；`pushPending(text, meta)`（同批追加、新批 unshift、超 `PENDING_LIMIT` 从队尾丢最旧批）；`dequeue()`（从队首批取第一条，批空移除）；`show(text, meta)` 无 freeLane 时改调 `pushPending`

- [ ] **Step 1: 实现 danmaku.js 队列改造**

`src/renderer/stage/danmaku.js` 第 27-41 行替换为：

```js
// 同屏上限：轨道全忙时新弹幕排队，轨道释放后补发（防重叠）。
// 批间最新优先：新到达的批插队首（与主进程缓冲同构，最新弹幕先飘），批内顺序保持；
// 队列上限：超限从队尾丢最旧批（防视觉高频时无限积压）
const pending = []; // 批次队列：队首=最新批，每批 { burst, lines: [{text, meta}, ...] }
const PENDING_LIMIT = 15;
function pushPending(text, meta) {
  const burst = meta && meta.burst;
  const front = pending[0];
  if (burst !== undefined && front && front.burst === burst) {
    front.lines.push({ text, meta }); // 同一批：追加保持批内顺序
    return;
  }
  pending.unshift({ burst, lines: [{ text, meta }] }); // 新批：插队首
  let total = 0;
  for (const b of pending) total += b.lines.length;
  while (total > PENDING_LIMIT && pending.length > 1) {
    const dropped = pending.pop(); // 队尾最旧批
    total -= dropped.lines.length;
  }
}
function dequeue() {
  if (!pending.length) return;
  const batch = pending[0];
  const next = batch.lines.shift();
  if (batch.lines.length === 0) pending.shift(); // 批空了移除
  show(next.text, next.meta);
}

function show(text, meta = {}) {
  if (!config.lanes) buildLanes();
  const lane = freeLane();
  if (!lane) {
    pushPending(text, meta);
    return;
  }
```

（`show` 函数其余部分不变；`window.show = show` 开发辅助保留。）

- [ ] **Step 2: 语法自检**

Run: `node --check src/renderer/stage/danmaku.js`
Expected: 无输出（语法通过）。渲染层无单测，行为正确性由 Task 3 CDP 实测验证。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/stage/danmaku.js
git commit -m "feat: 渲染层批次插队（新批队首/批内保序/上限丢最旧）"
```

---

### Task 3: 全量回归 + CDP 压力测试

**Files:** 无代码改动（验证）

**Interfaces:**
- Consumes: Task 1+2 完成后的 `src/shared/brain.js` + `src/renderer/stage/danmaku.js`
- Produces: 验证结论（pending 峰值 / 文字回复上屏延迟 / 视觉弹幕持续出现）

- [ ] **Step 1: 全量测试**

Run: `npm test 2>&1 | tail -8`
Expected: 全部 PASS，`tests 187`。

- [ ] **Step 2: 重启应用（加载新代码）**

Run: `pkill -f "electron/dist/Electron" ; sleep 1; npm start -- --remote-debugging-port=9222`（后台）
Expected: 启动后 `curl -s http://127.0.0.1:9222/json` 能看到 danmaku.html 目标。

- [ ] **Step 3: 压测脚本（后台采样 + 高频切应用 30s）**

采样器（每 400ms 读渲染层 pending 深度与在途弹幕数，perl 取毫秒）：

```bash
cat > /tmp/pending-probe2.sh << 'EOF'
#!/bin/bash
for i in $(seq 1 75); do
  line=$(node tools/cdp.js "({p: pending.length, on: document.querySelectorAll('.danmaku').length, front: pending[0] ? pending[0].lines.length : 0})" --page danmaku.html 2>/dev/null | tail -1 | sed 's/^\[danmaku.html\] //')
  echo "$(perl -MTime::HiRes -e 'print int(Time::HiRes::time*1000)') $line" >> /tmp/pending-probe2.log
  sleep 0.4
done
EOF
```

切换序列（已安装应用，每 3s 一切）：
`osascript -e 'tell application "Google Chrome" to activate'` / `Safari` / `WeChat` / `Finder` 循环 8 轮。

- [ ] **Step 4: 数据分析（通过标准）**

Run: 复用第一轮的关联脚本（requests.jsonl channel=text 时间戳 ↔ DOM 首次出现），加上：
1. **pending 峰值 ≤ 10**（旧实现 28）
2. **文字回复首次上屏延迟 ≤ 3s**（旧实现最差 32.7s；含 AI 回复到达后的优先发批）
3. **视觉弹幕持续出现**：窗口内 channel=vision 请求的回复行，至少 80% 在 DOM 采样中出现过（源头降产后总速率 < 容量，基本不丢）
4. **队列有界**：压测结束后 pending 回落 ≤ 5

不满足任何一条 → 回到对应 Task 修；满足则记录结论。

- [ ] **Step 5: 台账收尾**

```bash
cat >> .superpowers/sdd/progress.md << 'EOF'
S3 渲染层最新优先: complete (CDP 压测: pending 峰值 X / 文字上屏 ≤Y s / 视觉出现率 Z%, 全部达标)
EOF
```
