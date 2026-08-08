# 设置页日志自动刷新 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页请求日志面板每 5s 自动刷新（仅窗口可见时轮询），新请求高亮，无变化不重建 DOM，滚动位置保持。

**Architecture:** 纯渲染层改动（`src/renderer/settings/settings.js` + `settings.css`）。`setInterval` 5s + `document.visibilityState` 守卫触发 `renderRequestLogs`；函数内加"签名比对跳过 + 滚动位置恢复 + 新条目 key 集合高亮"；CSS 加 `req-flash` 动画。主进程零改动（`getRequestLogs` IPC 已存在，内存 ring ≤100 条，5s 轮询开销可忽略——已实测确认）。

**Tech Stack:** 无新依赖；渲染层无单测（项目惯例 CDP 实机验证）。

## Global Constraints

- 只改 `src/renderer/settings/settings.js` 与 `src/renderer/settings/settings.css` 两个文件（主进程/预加载/HTML 均不动）
- 间隔 5s（常量 `LOG_REFRESH_MS = 5000`）、仅 `document.visibilityState === 'visible'` 时拉取
- 新条目 key = `` `${l.ts}|${l.channel}|${l.error || ''}` ``，key 集合只保留当前渲染的条目（≤100，防无限增长）
- 首屏渲染不高亮；手动"刷新"按钮保留，与自动刷新共用同一渲染函数
- 签名 = `logs.length + '|' + 最新条目 ts`，相同则跳过重建
- 测试命令：`npm test`（= `node --test`，基线 187，本改动无测试文件变更应保持 187）
- 渲染层验证命令：CDP（`npm start -- --remote-debugging-port=9222` + `node tools/cdp.js "<表达式>" --page settings.html`）

---

### Task 1: settings.js + settings.css 自动刷新与高亮

**Files:**
- Modify: `src/renderer/settings/settings.js:261`（renderRequestLogs 重构）、`src/renderer/settings/settings.js:436` 附近（load 初始化处加 interval）、`src/renderer/settings/settings.css:23` 附近（req-log 样式后加高亮动画）
- Test: 无单测（渲染层惯例，Task 2 CDP 实测）

**Interfaces:**
- Consumes: `window.settings.getRequestLogs()`（现有 IPC，返回 ≤100 条 `{ts, channel, input, reply, parsedCount, error, paths, image}` 数组，ring 序 = 旧→新）
- Produces: `renderRequestLogs()`（签名跳过 + 滚动保持 + 新条目 `req-new` 类）；模块级 `LOG_REFRESH_MS = 5000`、`lastLogSignature`、`seenLogKeys`（Set）、`firstRender`（bool）；`setInterval` 5s 可见才轮询

- [ ] **Step 1: 重构 renderRequestLogs（settings.js:261-299 区域）**

`renderRequestLogs` 函数开头与结尾改为：

```js
// 请求日志：发送给文字/视觉模型的内容、回复与截图（5s 自动刷新，无变化不重建）
let lastLogSignature = '';   // 上次渲染的日志签名（数量+最新条目 ts），未变化跳过重建
let seenLogKeys = new Set(); // 已渲染条目 key（ts|channel|error），只保留当前 ≤100 条
let firstRender = true;      // 首屏不高亮（开页时全部算"新"会全闪）

async function renderRequestLogs() {
  const logs = await window.settings.getRequestLogs();
  const sig = logs.length + '|' + (logs.length ? logs[logs.length - 1].ts : '');
  if (sig === lastLogSignature) return; // 无新请求：跳过（避免每 5s 重建 DOM）
  lastLogSignature = sig;
  firstRender = false; // 首次完整渲染（无论空或非空）后不再抑制高亮
  const box = $('req-log');
  const prevScroll = box.scrollTop; // 重建前保存滚动位置（自动刷新时阅读旧日志不跳）
  box.innerHTML = '';
  if (!logs.length) {
    box.textContent = '（暂无请求记录，有 AI 请求后显示）';
    return;
  }
  const currentKeys = new Set();
  for (const l of [...logs].reverse()) {
    const key = `${l.ts}|${l.channel}|${l.error || ''}`;
    currentKeys.add(key);
    const isNew = !firstRender && !seenLogKeys.has(key);
    const row = document.createElement('div');
    row.className = 'req-item ' + (l.error ? 'req-err ' : '') + (isNew ? 'req-new' : '');
```

（`row` 创建后的既有渲染逻辑不变——head/body/paths/reply/image 追加、`box.appendChild(row)` 等；循环结束后在 `for` 之后补两行：）

```js
  seenLogKeys = currentKeys; // 只保留当前渲染的条目（防 Set 无限增长）
  box.scrollTop = prevScroll; // 恢复滚动位置
}
```

（`firstRender = false` 已在函数开头统一推进，空日志分支直接 return 即可，无需重复处理。）

- [ ] **Step 2: 加自动刷新轮询（settings.js 初始化处）**

`settings.js` 末尾 `load().then(...)` 之后（或 `$('btn-refresh-log').onclick = renderRequestLogs;` 附近）追加：

```js
// 日志自动刷新：5s 轮询，仅窗口可见时拉取（隐藏/最小化跳过；窗口销毁即渲染进程销毁，无泄漏）
const LOG_REFRESH_MS = 5000;
setInterval(() => {
  if (document.visibilityState === 'visible') renderRequestLogs();
}, LOG_REFRESH_MS);
```

- [ ] **Step 3: 高亮动画（settings.css）**

`settings.css` 中 `.req-log` 规则之后追加：

```css
/* 新请求高亮：自动刷新出现的新条目闪一次白雾后淡出 */
.req-item.req-new { animation: req-flash 2s ease-out; }
@keyframes req-flash {
  from { background: rgba(255, 255, 255, 0.18); }
  to { background: transparent; }
}
```

- [ ] **Step 4: 语法自检 + 全量测试**

Run: `node --check src/renderer/settings/settings.js`（无输出）且 `npm test 2>&1 | tail -6`
Expected: 语法通过；`tests 187 / pass 187 / fail 0`（本改动无测试文件变更，不增不减）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings/settings.js src/renderer/settings/settings.css
git commit -m "feat: 设置页日志 5s 自动刷新（可见才轮询/无变化跳过/滚动保持/新请求高亮）"
```

---

### Task 2: CDP 实机验证

**Files:** 无代码改动（验证）

**Interfaces:**
- Consumes: Task 1 完成后的 `settings.js` / `settings.css`
- Produces: 验证结论

- [ ] **Step 1: 重启应用**

Run: `pkill -f "node_modules/electron/dist"; sleep 2; npm start -- --remote-debugging-port=9222`（后台）
确认 CDP 目标可用。

- [ ] **Step 2: 打开设置窗口（需用户配合一次）**

请用户点击托盘图标打开设置页（或确认已打开）；随后 `curl -s http://127.0.0.1:9222/json` 应出现 `settings.html` 目标。

- [ ] **Step 3: CDP 断言**

用 `node tools/cdp.js "<表达式>" --page settings.html` 依次验证：
1. 轮询存在：`typeof setInterval !== 'undefined'`（间接）——直接断言渲染函数可调：`typeof renderRequestLogs === 'function'`
2. 触发一次 AI 请求（osascript 切应用）→ 等待 ≤6s → `document.querySelectorAll('#req-log .req-item').length` 增加，且顶部新条目 class 含 `req-new`（高亮）
3. 再触发一次 → 第二次渲染的旧条目不再有 `req-new`（只闪一次）
4. 滚动保持：设置页日志区 `scrollTop` 置为 200 → 触发新请求 → 6s 后 `scrollTop` 仍 ≈200
5. 无变化跳过：连续两次调用 `renderRequestLogs()`（间隔 1s，无新请求）→ DOM 节点引用不变（`box.firstChild` 同一对象）

- [ ] **Step 4: 台账收尾**

```bash
cat >> .superpowers/sdd/progress.md << 'EOF'
设置页日志自动刷新: complete (CDP 实机验证: 5s 轮询/高亮单次/滚动保持/无变化跳过全部通过)
EOF
```
