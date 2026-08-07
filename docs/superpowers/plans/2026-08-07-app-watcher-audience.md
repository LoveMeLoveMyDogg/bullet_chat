# 前台应用监控与观众群体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 监控前台应用切换/停留/屏幕空闲，按观众群（每个应用自己的观众席）生成多样化弹幕，设置页可配置并带 `？` tooltip 帮助。

**Architecture:** 新增 AppWatcher 事件源（macOS `lsappinfo` / Windows 长驻 PowerShell，均免权限，轮询 2s），事件进现有文字通道（共享缓冲/限速/时间窗）；新观众群模块（内置 5 群 + 自定义覆盖）在生成时注入场景化 prompt；ScreenWatcher 顺带做空闲检测。设置页监控 section 扩展，vanilla + section 拆分，零构建。

**Tech Stack:** Electron、Node 内置模块（child_process、readline、fs）、node:test，零新依赖。

## Global Constraints

- 零构建、零新依赖（只允许 Node 内置模块 + Electron API）
- 双平台：Windows 分支必须平台守卫（macOS 上不执行 PowerShell 代码）；所有平台相关解析函数纯函数化可测
- 新配置键必须有默认值，旧配置加载自动合并（configCore mergeConfig 机制）
- 所有新配置项设置页必须带 `？` tooltip（hint-mark 模式）
- `npm test` 全绿且不挂起（brain 定时器必须 unref）
- 每个任务结束时提交一次

---

### Task 1: configCore monitor 新键

**Files:**
- Modify: `src/shared/configCore.js:8`（KNOWN_KEYS monitor 行）
- Test: `tests/configCore.test.js`（追加）

**Interfaces:**
- Consumes: 无（configCore 现有 defaultConfig/mergeConfig 机制）
- Produces: `config.monitor` 新增键：`appWatch: true`、`stayMinutes: 20`、`idleMinutes: 10`、`appAliases: {}`、`appGroups: {}`、`audienceGroups: {}`。后续所有任务依赖这些默认值

- [ ] **Step 1: 写失败测试**（追加到 `tests/configCore.test.js`）

```js
test('monitor 新增默认值（前台监控/停留/空闲/别名/观众群）', () => {
  const m = defaultConfig().monitor;
  assert.equal(m.appWatch, true);
  assert.equal(m.stayMinutes, 20);
  assert.equal(m.idleMinutes, 10);
  assert.deepEqual(m.appAliases, {});
  assert.deepEqual(m.appGroups, {});
  assert.deepEqual(m.audienceGroups, {});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/configCore.test.js`
Expected: FAIL — `appWatch` 为 undefined

- [ ] **Step 3: 实现**（修改 `src/shared/configCore.js` 的 KNOWN_KEYS）

```js
monitor: { drives: [], noiseRules: [], masks: [], privacyAcknowledged: false, appWatch: true, stayMinutes: 20, idleMinutes: 10, appAliases: {}, appGroups: {}, audienceGroups: {} },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/configCore.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/configCore.js tests/configCore.test.js
git commit -m "feat: monitor 配置新增前台监控/停留/空闲/观众群默认值"
```

---

### Task 2: 应用显示名映射模块

**Files:**
- Create: `src/shared/appNames.js`
- Test: `tests/appNames.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `displayNameFor(appKey, aliases)` → string（appKey 小写匹配，先查用户别名再查内置表，未命中返回原 appKey）；`BUILTIN_DISPLAY_NAMES`（导出于测试）

- [ ] **Step 1: 写失败测试** `tests/appNames.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { displayNameFor } = require('../src/shared/appNames');

test('displayNameFor 内置映射 + 用户别名优先 + 未命中回退', () => {
  assert.equal(displayNameFor('Code'), 'VSCode');      // Windows 进程名（大小写不敏感）
  assert.equal(displayNameFor('code'), 'VSCode');
  assert.equal(displayNameFor('com.microsoft.VSCode'), 'VSCode'); // macOS bundle id
  assert.equal(displayNameFor('com.google.chrome'), '浏览器');
  // 用户别名优先于内置表
  assert.equal(displayNameFor('chrome', { chrome: '大浏览器' }), '大浏览器');
  // 未命中回退原始值
  assert.equal(displayNameFor('weird-app.xyz'), 'weird-app.xyz');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/appNames.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** `src/shared/appNames.js`

```js
// 前台应用显示名映射：Windows 进程名（小写）/ macOS bundle id（小写）→ 中文显示名。
// 探测层只输出稳定 appKey，显示名在这里统一（弹幕文案可读性）
const BUILTIN_DISPLAY_NAMES = {
  // Windows 进程名（小写）
  code: 'VSCode', chrome: '浏览器', msedge: '浏览器', firefox: '浏览器', wechat: '微信',
  dingtalk: '钉钉', outlook: '邮件', thunderbird: '邮件', explorer: '文件资源管理器',
  notepad: '记事本', winword: 'Word', excel: 'Excel', powerpoint: 'PowerPoint',
  obsidian: 'Obsidian', notion: 'Notion', powershell: '终端', windowsterminal: '终端',
  steam: 'Steam', spotify: '音乐', potplayer: '播放器', bilibili: 'B站',
  // macOS bundle id（小写）
  'com.microsoft.vscode': 'VSCode', 'com.google.chrome': '浏览器', 'com.apple.safari': 'Safari',
  'com.tencent.xinwechat': '微信', 'com.apple.finder': '访达', 'com.apple.textedit': '文本编辑',
  'md.obsidian': 'Obsidian', 'com.notion.id': 'Notion', 'com.microsoft.word': 'Word',
  'com.apple.terminal': '终端', 'com.apple.preview': '预览', 'com.apple.notes': '备忘录',
  'com.apple.music': '音乐', 'com.spotify.client': '音乐', 'com.tencent.qq': 'QQ',
  'com.apple.iphonesimulator': '模拟器', 'org.videolan.vlc': '播放器',
};

function displayNameFor(appKey, aliases = {}) {
  const a = String(appKey || '').toLowerCase();
  if (!a) return a;
  if (aliases[a]) return aliases[a];
  return BUILTIN_DISPLAY_NAMES[a] || appKey;
}

module.exports = { BUILTIN_DISPLAY_NAMES, displayNameFor };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/appNames.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/appNames.js tests/appNames.test.js
git commit -m "feat: 前台应用显示名映射（内置表 + 用户别名优先）"
```

---

### Task 3: 观众群模块

**Files:**
- Create: `src/shared/audienceGroups.js`
- Test: `tests/audienceGroups.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `resolveGroup(appKey, appGroups, audienceGroups)` → `null | { name, roles: string[], scene: string, styles: string[] }`（appKey 小写匹配用户映射 → 内置默认绑定；audienceGroups 自定义群覆盖同名内置群）；`BUILTIN_GROUPS`、`DEFAULT_APP_GROUPS`（导出供测试与设置页提示）

- [ ] **Step 1: 写失败测试** `tests/audienceGroups.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveGroup, BUILTIN_GROUPS, DEFAULT_APP_GROUPS } = require('../src/shared/audienceGroups');

test('内置 5 组观众群结构完整', () => {
  assert.equal(Object.keys(BUILTIN_GROUPS).length, 5);
  for (const [name, g] of Object.entries(BUILTIN_GROUPS)) {
    assert.ok(g.roles.length >= 3, `${name} 至少 3 个角色`);
    assert.ok(g.scene.length > 0, `${name} 有场景人设`);
    assert.ok(g.styles.length >= 2, `${name} 至少 2 个风格`);
  }
});

test('resolveGroup 命中默认绑定（大小写不敏感）', () => {
  const g = resolveGroup('Code', {}, {});
  assert.equal(g.name, '程序员天团');
  assert.ok(Array.isArray(g.roles) && g.roles.length >= 3);
  const g2 = resolveGroup('com.microsoft.vscode', {}, {});
  assert.equal(g2.name, '程序员天团');
});

test('resolveGroup 用户映射优先于默认绑定', () => {
  const g = resolveGroup('code', { code: '摸鱼大队' }, {});
  assert.equal(g.name, '摸鱼大队');
});

test('resolveGroup 自定义群覆盖同名内置群', () => {
  const custom = { '程序员天团': { roles: ['转行程序员'], scene: '自定义场景', styles: ['玩梗'] } };
  const g = resolveGroup('code', {}, custom);
  assert.deepEqual(g.roles, ['转行程序员']);
  assert.equal(g.scene, '自定义场景');
});

test('resolveGroup 未命中返回 null', () => {
  assert.equal(resolveGroup('unknown-app', {}, {}), null);
  assert.equal(resolveGroup('', {}, {}), null);
});

test('默认绑定覆盖主流应用', () => {
  for (const key of ['code', 'chrome', 'msedge', 'wechat', 'winword', 'obsidian', 'steam', 'spotify']) {
    assert.ok(DEFAULT_APP_GROUPS[key], `${key} 有默认观众群`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/audienceGroups.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** `src/shared/audienceGroups.js`

```js
// 观众群：群名 + 观众角色 + 场景人设 + 风格标签。命中应用时注入 buildSystemPrompt，
// 让弹幕"像特定观众席"（打开 VSCode 是程序员观众团，切到浏览器变吃瓜群众）
const BUILTIN_GROUPS = {
  '程序员天团': {
    roles: ['秃头架构师', '萌新实习生', '测试老哥', '产品经理'],
    scene: '你是一群程序员观众，正在围观一个程序员干活，会针对他的代码操作吐槽',
    styles: ['专业吐槽', '抽象玩梗', '阴阳怪气损友'],
  },
  '吃瓜群众': {
    roles: ['前排瓜友', '路人大妈', '弹幕侦探'],
    scene: '你是一群吃瓜群众，正在围观主播的屏幕，什么都想看看',
    styles: ['抽象玩梗', '脑补剧情', '傻乐捧场'],
  },
  '摸鱼大队': {
    roles: ['开黑队友', '老板眼线', '隔壁工位老王'],
    scene: '你是一群摸鱼同事，正在围观主播偷偷摸鱼，随时准备帮他望风',
    styles: ['抽象玩梗', '毒舌弹幕', '傻乐捧场'],
  },
  '学习委员': {
    roles: ['三好学生', '学霸同桌', '班主任'],
    scene: '你是一群学习委员，正在监督主播学习，看到学习行为会欣慰',
    styles: ['正经夸夸', '温柔提醒', '萌系治愈'],
  },
  '社畜同僚': {
    roles: ['摸鱼搭子', '甩锅侠', '热心同事'],
    scene: '你是一群社畜同僚，正在围观主播上班摸鱼，深谙打工人的苦',
    styles: ['抽象玩梗', '专业吐槽', '阴阳怪气损友'],
  },
};

// 应用 → 观众群默认绑定：Windows 进程名（小写）/ macOS bundle id（小写）
const DEFAULT_APP_GROUPS = {
  // 程序员
  code: '程序员天团', 'visual studio code': '程序员天团', idea64: '程序员天团',
  intellij: '程序员天团', pycharm64: '程序员天团', goland64: '程序员天团',
  'com.microsoft.vscode': '程序员天团', 'com.jetbrains.intellij': '程序员天团',
  'com.jetbrains.pycharm': '程序员天团', 'com.apple.dt.xcode': '程序员天团',
  // 浏览器
  chrome: '吃瓜群众', msedge: '吃瓜群众', firefox: '吃瓜群众', brave: '吃瓜群众',
  'com.google.chrome': '吃瓜群众', 'com.apple.safari': '吃瓜群众',
  'org.mozilla.firefox': '吃瓜群众', 'com.brave.browser': '吃瓜群众',
  // 聊天/办公
  wechat: '社畜同僚', weixin: '社畜同僚', dingtalk: '社畜同僚', outlook: '社畜同僚',
  thunderbird: '社畜同僚', 'com.tencent.xinwechat': '社畜同僚', 'com.alibaba.dingtalk': '社畜同僚',
  'com.microsoft.outlook': '社畜同僚', 'com.tencent.qq': '社畜同僚', qq: '社畜同僚',
  // 文档/笔记
  winword: '学习委员', wps: '学习委员', obsidian: '学习委员', notion: '学习委员',
  'com.microsoft.word': '学习委员', 'md.obsidian': '学习委员', 'com.notion.id': '学习委员',
  'com.apple.pages': '学习委员', 'com.apple.notes': '学习委员',
  // 娱乐
  steam: '摸鱼大队', spotify: '摸鱼大队', potplayer: '摸鱼大队', bilibili: '摸鱼大队',
  'com.valvesoftware.steam': '摸鱼大队', 'com.spotify.client': '摸鱼大队',
  'com.apple.music': '摸鱼大队', 'com.apple.quicktimeplayer': '摸鱼大队',
};

function resolveGroup(appKey, appGroups = {}, audienceGroups = {}) {
  const a = String(appKey || '').toLowerCase();
  if (!a) return null;
  const name = appGroups[a] || DEFAULT_APP_GROUPS[a];
  if (!name) return null;
  const custom = audienceGroups[name];
  if (custom) return { name, ...custom };
  const builtin = BUILTIN_GROUPS[name];
  return builtin ? { name, ...builtin } : null;
}

module.exports = { BUILTIN_GROUPS, DEFAULT_APP_GROUPS, resolveGroup };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/audienceGroups.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/audienceGroups.js tests/audienceGroups.test.js
git commit -m "feat: 观众群模块（内置 5 群 + 应用绑定 + 自定义覆盖）"
```

---

### Task 4: 事件描述与本地模板（app_switch/app_enter/app_stay/idle）

**Files:**
- Modify: `src/shared/noiseFilter.js:42-66`（formatEventDescription）
- Modify: `src/shared/templates.js`（TEMPLATES 新增 4 类）
- Modify: `src/shared/brain.js:43-47`（typeKey）
- Test: `tests/noiseFilter.test.js`、`tests/templates.test.js`、`tests/brain.test.js`（typeKey）

**Interfaces:**
- Consumes: 无
- Produces: `formatEventDescription` 支持 4 种新 type 的中文描述；`TEMPLATES.app_switch/app_enter/app_stay/idle`（各 20 条）；`typeKey` 返回新类型名。Task 6 的 brain 集成依赖

- [ ] **Step 1: 写失败测试**（追加到 `tests/noiseFilter.test.js`）

```js
test('formatEventDescription 应用/空闲事件描述', () => {
  const app = { source: 'app', type: 'app_switch', name: 'VSCode', drive: '' };
  assert.equal(formatEventDescription(app), '用户打开了「VSCode」');
  const enter = { source: 'app', type: 'app_enter', name: '程序员天团', drive: '' };
  assert.equal(formatEventDescription(enter), '「程序员天团」进入直播间');
  const stay = { source: 'app', type: 'app_stay', name: 'VSCode', drive: '', minutes: 20 };
  assert.equal(formatEventDescription(stay), '用户已在「VSCode」停留 20 分钟');
  const idle = { source: 'file', type: 'idle', name: '', drive: '' };
  assert.equal(formatEventDescription(idle), '屏幕已多分钟没有变化');
});
```

（追加到 `tests/templates.test.js`）

```js
test('应用/空闲事件模板池非空且可填充', () => {
  for (const t of ['app_switch', 'app_enter', 'app_stay', 'idle']) {
    const list = TEMPLATES[t];
    assert.ok(Array.isArray(list) && list.length >= 20, `${t} 模板 ≥20 条`);
    const text = fillTemplate(templateFor(t, () => 0), { name: 'VSCode', drive: '' });
    assert.ok(text.length > 0 && text.length <= 24);
  }
});
```

（追加到 `tests/brain.test.js`）

```js
test('typeKey 应用/空闲事件映射', () => {
  assert.equal(typeKey({ source: 'app', type: 'app_switch' }), 'app_switch');
  assert.equal(typeKey({ source: 'app', type: 'app_enter' }), 'app_enter');
  assert.equal(typeKey({ source: 'app', type: 'app_stay' }), 'app_stay');
  assert.equal(typeKey({ source: 'file', type: 'idle' }), 'idle');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/noiseFilter.test.js tests/templates.test.js tests/brain.test.js`
Expected: FAIL — 新类型无描述/无模板（typeKey 现有实现 `return entry.type` 已覆盖新类型，无需修改）

- [ ] **Step 3: 实现**（noiseFilter.js switch 增加分支）

```js
    case 'app_switch':
      return `用户打开了「${name}」`;
    case 'app_enter':
      return `「${name}」进入直播间`;
    case 'app_stay':
      return `用户已在「${name}」停留 ${entry.minutes || '多'} 分钟`;
    case 'idle':
      return '屏幕已多分钟没有变化';
```

（templates.js TEMPLATES 追加，每类 20 条）

```js
  app_switch: [
    '打开「{name}」了？有正事要干了',
    '切到{name}，看起来要干活了',
    '{name}登场！弹幕就位',
    '哦？{name}，事情开始变得专业',
    '主播打开了{name}，好戏开场',
    '又是{name}，熟悉的操作',
    '{name}一开，整个屏幕都高级了',
    '打开{name}的动作很流畅',
    '《主播与{name}的二三事》',
    '{name}：我来了，都让让',
    '切{name}切得这么熟练，老用户了',
    '{name}启动，新篇章开启',
    '这波{name}打开得猝不及防',
    '有{name}在，今天稳了',
    '{name}：又要陪我多久呢',
    '主播的{name}用得是真勤',
    '哦豁，{name}，专业感拉满',
    '打开{name}，进入专注模式',
    '{name}来了，弹幕安静点（不）',
    '又是你，{name}！',
  ],
  app_enter: [
    '「{name}」进入直播间，就位！',
    '观众「{name}」已就座，弹幕走起',
    '「{name}」进场了，氛围组就位',
    '欢迎「{name}」加入直播间！',
    '「{name}」落座前排，瓜子备好',
    '直播间观众换班，「{name}」上岗',
    '「{name}」带着键盘进场了',
    '新观众「{name}」抵达现场',
    '「{name}」就位，开始锐评',
    '「{name}」已连接，弹幕待命',
    '掌声欢迎「{name}」入场',
    '「{name}」进入房间，弹幕浓度+1',
    '「{name}」来了，这波稳了',
    '「{name}」入场，气氛开始微妙',
    '观众席换人：「{name}」登场',
    '「{name}」空降直播间！',
    '「{name}」已上线，开始上班',
    '「{name}」就座，好戏开演',
    '「{name}」进入直播间，欢迎欢迎',
    '「{name}」加入围观大队',
  ],
  app_stay: [
    '在{name}里待了 {minutes} 分钟了，弹幕已就位',
    '{name} × {minutes} 分钟，这波是沉浸式',
    '在{name}摸了 {minutes} 分钟，快乐',
    '{minutes} 分钟了，{name}真爱无疑',
    '同一界面 {minutes} 分钟，主播很专注',
    '在{name}里 {minutes} 分钟，一动不动',
    '{minutes} 分钟过去，{name}还是那个{name}',
    '坚持{name} {minutes} 分钟，毅力可嘉',
    '在{name}深耕 {minutes} 分钟，弹幕敬礼',
    '{minutes} 分钟了，是不是忘了还有我们',
    '在{name}里沉浸 {minutes} 分钟，好家伙',
    '{minutes} 分钟，主播与{name}难舍难分',
    '在{name}待了 {minutes} 分钟，稳如泰山',
    '{minutes} 分钟过去，画面仿佛静止',
    '主播在{name}待了 {minutes} 分钟了',
    '{name}里 {minutes} 分钟，专注力满分',
    '第 {minutes} 分钟，{name}依然是主场',
    '在{name}里 {minutes} 分钟，弹幕快睡着了',
    '{minutes} 分钟！{name}钉子户认证',
    '在{name}沉浸 {minutes} 分钟，一切安好',
  ],
  idle: [
    '人呢？屏幕都静了',
    '画面静止多分钟，主播是不是睡着了',
    '屏幕半天没动了，卡了吗',
    '安静得弹幕都不敢发（不是）',
    '主播消失了？直播事故？',
    '屏幕：我休息一下',
    '多久没动了，摸鱼摸出境界',
    '静止画面看多了，弹幕开始无聊',
    '主播在思考人生，我们等着',
    '画面不动，弹幕动',
    '这是开了静音模式？',
    '人机分离现场？',
    '屏幕静止多分钟，主播离线中',
    '好安静，安静得有点可怕',
    '主播可能去倒水了，弹幕继续等',
    '画面：我没有变化！',
    '这静止，是暴风雨前的宁静吗',
    '主播不动，弹幕代为活跃',
    '已静止多分钟，建议戳一下屏幕',
    '人还在吗？在的扣 1',
  ],
```

（brain.js typeKey 无需修改——现有 `return entry.type` 已覆盖 app 事件与 idle）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/noiseFilter.test.js tests/templates.test.js tests/brain.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/noiseFilter.js src/shared/templates.js src/shared/brain.js tests/noiseFilter.test.js tests/templates.test.js tests/brain.test.js
git commit -m "feat: 应用/空闲事件描述与本地模板（app_switch/app_enter/app_stay/idle）"
```

---

### Task 5: AppWatcher 探测模块

**Files:**
- Create: `src/main/appWatcher.js`
- Test: `tests/appWatcher.test.js`

**Interfaces:**
- Consumes: `displayNameFor`（Task 2）
- Produces: `parseMacFront(out)` → string|null；`parseWinLine(line)` → `{ appKey, title } | null`；`class AppWatcher({ pollMs, clock, platform, exec, onEvent, onStay, onError })` 方法 `start()/stop()/getCurrent()/updateConfig({ stayMinutes, aliases })`。事件：`onEvent({ source:'app', type:'app_switch', name, appKey, drive:'', isDir:false })`、`onStay({ source:'app', type:'app_stay', name, appKey, minutes, drive:'', isDir:false })`

- [ ] **Step 1: 写失败测试** `tests/appWatcher.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMacFront, parseWinLine, AppWatcher } = require('../src/main/appWatcher');

test('parseMacFront 解析 lsappinfo front 输出', () => {
  assert.equal(parseMacFront('frontASN = ASN:0x0-0x1234:com.microsoft.VSCode'), 'com.microsoft.VSCode');
  assert.equal(parseMacFront('frontASN = ASN:0x0-0x1234:com.google.chrome\n'), 'com.google.chrome');
  assert.equal(parseMacFront(''), null);
  assert.equal(parseMacFront('lsappinfo: no front app'), null);
});

test('parseWinLine 解析 PowerShell 输出', () => {
  assert.deepEqual(parseWinLine('code|main.js - Visual Studio Code'), { appKey: 'code', title: 'main.js - Visual Studio Code' });
  assert.deepEqual(parseWinLine('chrome|'), { appKey: 'chrome', title: '' });
  assert.equal(parseWinLine(''), null);
});

test('AppWatcher 切换检测与停留播报（假时钟）', async () => {
  let now = 1000000;
  const events = [];
  const stays = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => now, platform: 'darwin',
    exec: (_cmd, _args, cb) => cb(null, 'frontASN = ASN:0x0-0x1234:com.microsoft.VSCode'),
    onEvent: (e) => events.push(e),
    onStay: (e) => stays.push(e),
    stayMinutes: 20,
  });
  await fw.poll();
  assert.equal(events.length, 1, '首次探测发切换事件');
  assert.equal(events[0].appKey, 'com.microsoft.VSCode');
  assert.equal(events[0].name, 'VSCode', '显示名映射');
  now += 2 * 60 * 1000; // 2 分钟后同应用
  await fw.poll();
  assert.equal(events.length, 1, '同应用不发切换事件');
  now += 20 * 60 * 1000; // 满 20 分钟
  await fw.poll();
  assert.equal(stays.length, 1, '停留超时播报一次');
  assert.equal(stays[0].minutes, 20);
  assert.equal(events.length, 1, '停留不触发切换事件');
  now += 20 * 60 * 1000; // 再 20 分钟（已重置计时）
  await fw.poll();
  assert.equal(stays.length, 2, '停留重置后再次播报');
});

test('AppWatcher 切应用重置停留计时并二次播报', async () => {
  let now = 1000000;
  let current = 'com.microsoft.VSCode';
  const events = [];
  const stays = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => now, platform: 'darwin',
    exec: (_cmd, _args, cb) => cb(null, `frontASN = ASN:0x0-0x1234:${current}`),
    onEvent: (e) => events.push(e),
    onStay: (e) => stays.push(e),
    stayMinutes: 20,
  });
  await fw.poll();
  now += 25 * 60 * 1000;
  await fw.poll();
  assert.equal(stays.length, 1);
  current = 'com.google.chrome'; // 切到另一个应用
  now += 1000;
  await fw.poll();
  assert.equal(events.length, 2, '切换应用发新事件');
  now += 25 * 60 * 1000;
  await fw.poll();
  assert.equal(stays.length, 2, '新应用停留重新计时');
  assert.equal(stays[1].appKey, 'com.google.chrome');
});

test('AppWatcher 无前台应用跳过（锁屏）', async () => {
  const events = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => 0, platform: 'darwin',
    exec: (_cmd, _args, cb) => cb(null, ''),
    onEvent: (e) => events.push(e), onStay: () => {},
    stayMinutes: 20,
  });
  await fw.poll();
  assert.equal(events.length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/appWatcher.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现** `src/main/appWatcher.js`

```js
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const { displayNameFor } = require('../shared/appNames');

const POLL_MS = 2000; // 轮询间隔：变化才发事件，几乎不占 CPU

// lsappinfo front 输出："frontASN = ASN:0x0-0x1234:com.microsoft.VSCode"
function parseMacFront(out) {
  const m = /:([A-Za-z0-9.-]+)\s*$/.exec(String(out || '').trim());
  return m ? m[1] : null;
}

// PowerShell 长驻脚本 stdout 行："进程名小写|窗口标题"；空行 = 无前台窗口
function parseWinLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const i = s.indexOf('|');
  if (i <= 0) return null;
  return { appKey: s.slice(0, i).toLowerCase(), title: s.slice(i + 1) };
}

const WIN_POLL_SCRIPT = `
while ($true) {
  $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object MainWindowHandle | Select-Object -Last 1
  if ($p) { Write-Output ($p.ProcessName.ToLower() + '|' + $p.MainWindowTitle) } else { Write-Output '' }
  Start-Sleep -Milliseconds ${POLL_MS}
}`;

class AppWatcher {
  constructor({ pollMs = POLL_MS, clock = Date.now, platform = process.platform, exec = execFile, onEvent, onStay, onError, stayMinutes = 20, aliases = {} }) {
    this.pollMs = pollMs;
    this.clock = clock;
    this.platform = platform;
    this.exec = exec;
    this.onEvent = onEvent;
    this.onStay = onStay;
    this.onError = onError;
    this.stayMinutes = stayMinutes;
    this.aliases = aliases;
    this.current = null; // { appKey, since }
    this.timer = null;
    this.winProc = null;
  }

  updateConfig({ stayMinutes, aliases } = {}) {
    if (stayMinutes !== undefined) this.stayMinutes = stayMinutes;
    if (aliases !== undefined) this.aliases = aliases;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.winProc?.kill();
    this.winProc = null;
  }

  getCurrent() {
    return this.current ? { appKey: this.current.appKey } : null;
  }

  async poll() {
    try {
      const app = await this.probe();
      if (!app) return; // 无前台窗口（锁屏/刚启动）：跳过
      const now = this.clock();
      const prev = this.current;
      if (!prev || prev.appKey !== app.appKey) {
        this.current = { appKey: app.appKey, since: now };
        this.onEvent?.({
          source: 'app', type: 'app_switch', name: displayNameFor(app.appKey, this.aliases),
          appKey: app.appKey, drive: '', isDir: false,
        });
      } else if (this.stayMinutes > 0 && now - prev.since >= this.stayMinutes * 60000) {
        this.current.since = now; // 播报后重置计时（离开再回来由切换自然重置）
        this.onStay?.({
          source: 'app', type: 'app_stay', name: displayNameFor(app.appKey, this.aliases),
          appKey: app.appKey, minutes: this.stayMinutes, drive: '', isDir: false,
        });
      }
    } catch (err) {
      this.onError?.(new Error(`前台应用探测失败：${err.message}`));
    }
  }

  probe() {
    if (this.platform === 'darwin') {
      return new Promise((resolve) => {
        this.exec('lsappinfo', ['front'], (err, stdout) => {
          if (err) return resolve(null);
          const key = parseMacFront(stdout);
          resolve(key ? { appKey: key } : null);
        });
      });
    }
    // Windows：长驻 PowerShell 进程，stdout 逐行输出前台窗口（避免每次 spawn 的开销）
    return new Promise((resolve) => {
      if (!this.winProc) {
        this.winProc = spawn('powershell', ['-NoProfile', '-Command', WIN_POLL_SCRIPT], { stdio: ['ignore', 'pipe', 'inherit'] });
        this.winProc.on('error', (err) => this.onError?.(new Error(`PowerShell 启动失败：${err.message}`)));
        this.winProc.on('exit', () => { this.winProc = null; });
        this.winLineBuf = null;
        readline.createInterface({ input: this.winProc.stdout }).on('line', (line) => {
          const app = parseWinLine(line);
          this.winLineBuf = app ? { appKey: app.appKey } : null;
        });
      }
      resolve(this.winLineBuf || null);
    });
  }
}

module.exports = { POLL_MS, parseMacFront, parseWinLine, AppWatcher };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/appWatcher.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/appWatcher.js tests/appWatcher.test.js
git commit -m "feat: AppWatcher 前台应用探测（macOS lsappinfo / Windows 长驻 PowerShell）"
```

---

### Task 6: brain 集成（appKey 戳 / 观众群登场 / 场景化 prompt / 停留空闲入队）

**Files:**
- Modify: `src/shared/brain.js`（constructor、pushEntry、generateText、maybeRefill 场景注入）
- Modify: `src/shared/styles.js:47`（buildSystemPrompt 增加 scene 参数）
- Test: `tests/brain.test.js`、`tests/styles.test.js`

**Interfaces:**
- Consumes: `resolveGroup`（Task 3）、`typeKey`（Task 4）、Task 5 的事件形状
- Produces: Brain constructor 新可选参数 `getCurrentApp`（返回 `{ appKey } | null`）；`brain.currentGroup`（群名状态）；app_switch 事件自动补发 app_enter（入队/本地模式直接播）；文件事件自动打 appKey 戳；`generateText` 按批内 appKey 注入观众群场景与角色。styles 的 `buildSystemPrompt(styles, roles, replyCount, scene)` 第 4 参

- [ ] **Step 1: 写失败测试**（追加到 `tests/styles.test.js`）

```js
test('buildSystemPrompt 场景注入', () => {
  const noScene = buildSystemPrompt(['玩梗'], [], 10);
  assert.ok(!noScene.includes('当前场景'));
  const withScene = buildSystemPrompt(['玩梗'], ['秃头架构师'], 10, '你是一群程序员观众');
  assert.ok(withScene.includes('当前场景：你是一群程序员观众'));
  assert.ok(withScene.includes('秃头架构师'));
});
```

（追加到 `tests/brain.test.js`）

```js
const { resolveGroup } = require('../src/shared/audienceGroups');

test('观众群：app_switch 命中不同群补发 app_enter 登场弹幕', () => {
  const { brain } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.buffer.push('占位1', '占位2', '占位3'); // 缓冲充足：不触发补充，观察队列
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'VSCode', appKey: 'code', drive: '', isDir: false });
  assert.equal(brain.currentGroup, '程序员天团');
  assert.deepEqual(brain.queue.map((e) => e.type), ['app_enter', 'app_switch'], '登场 + 切换先后入队');
  assert.equal(brain.queue[0].name, '程序员天团');
  // 同群再切换：不补发登场
  brain.queue.length = 0;
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'IDEA', appKey: 'idea64', drive: '', isDir: false });
  assert.equal(brain.queue.length, 1, '同群切换只入 app_switch');
  brain.stop();
});

test('观众群：场景与角色注入生成 prompt', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let lastSystem = '';
  generator.chatCompletion = async ({ system }) => { lastSystem = system; return '["1"]'; };
  brain.pushEntry({ source: 'file', type: 'create', name: 'a.js', path: 'C:\\a.js', drive: 'C:', isDir: false, appKey: 'code' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastSystem.includes('当前场景：你是一群程序员观众'), '场景注入');
  assert.ok(lastSystem.includes('秃头架构师'), '群角色注入');
  brain.stop();
});

test('事件场景化：文件事件自动打前台应用戳', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let lastSystem = '';
  generator.chatCompletion = async ({ system }) => { lastSystem = system; return '["1"]'; };
  brain.getCurrentApp = () => ({ appKey: 'chrome' });
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastSystem.includes('当前场景：你是一群吃瓜群众'), '按事件到达时前台应用选群');
  brain.stop();
});

test('本地模式：app_switch 登场走模板兜底', async () => {
  const { brain, danmaku } = makeEnv();
  brain.setLocalMode(true);
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'VSCode', appKey: 'code', drive: '', isDir: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 2, '切换 + 登场两条本地弹幕');
  assert.equal(brain.currentGroup, '程序员天团');
  brain.stop();
});

test('停留/空闲事件进文字队列并带时间戳', async () => {
  const { brain } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.pushEntry({ source: 'app', type: 'app_stay', name: 'VSCode', appKey: 'code', minutes: 20, drive: '', isDir: false });
  brain.pushEntry({ source: 'file', type: 'idle', name: '', drive: '' });
  assert.equal(brain.queue.length, 2);
  assert.ok(brain.queue[0].ts > 0, '带到达时间戳（时间窗过滤用）');
  brain.stop();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/brain.test.js tests/styles.test.js`
Expected: FAIL — currentGroup 不存在 / buildSystemPrompt 无 scene 参数

- [ ] **Step 3: 实现**

（styles.js — buildSystemPrompt 增加 scene 参数）

```js
function buildSystemPrompt(styles, roles = [], replyCount = 10, scene = null) {
  const examples = USER_EXAMPLES.map(([a, b]) => `事件：${a}\n弹幕：${b}`).join('\n');
  const roleText = roles.length
    ? `本次的观众阵容：${roles.join('、')}`
    : '观众性格随机多样（毒舌、捧场、脑补、温柔、玩梗、古风、中英混搭、学术、佛系、杠精、夸夸、二次元等）';
  const sceneText = scene ? `\n当前场景：${scene}` : '';
  return `你是直播间里的观众，主播（用户）正在操作电脑，你会针对他的操作发弹幕吐槽。${sceneText}
要求：
- 弹幕要短，不超过 20 个字
- 一次返回 ${replyCount} 条：扮演多个不同性格的观众，每人发一条，每条风格不同，换着花样来
- ${roleText}
- 本次可选的画风：${styles.join('、')}（也可自由发挥其他风格）
- 只返回 JSON 数组，例如 ["弹幕1","弹幕2"]，不要输出任何其他内容
示例：
${examples}`;
}
```

（brain.js — constructor 增加 getCurrentApp 与 currentGroup）

```js
    this.getCurrentApp = null; // 前台应用上下文回调（main 装配注入），事件场景化用
    this.currentGroup = null;  // 当前观众群（登场播报去重用）
```
在 constructor 参数列表加 `getCurrentApp = null`，并 `this.getCurrentApp = getCurrentApp;`。

（brain.js — pushEntry：登场检测 + appKey 戳）

```js
  // app_switch 命中不同观众群 → 补发登场事件（AI 通道入队 / 本地模式直接播）
  maybeEnterGroup(entry) {
    if (entry.type !== 'app_switch') return null;
    const group = resolveGroup(entry.appKey, this.config.monitor.appGroups, this.config.monitor.audienceGroups);
    if (!group || group.name === this.currentGroup) return null;
    this.currentGroup = group.name;
    return { source: 'app', type: 'app_enter', name: group.name, appKey: entry.appKey, drive: '', isDir: false, ts: this.clock() };
  }
```

```js
  // 事件场景化：文件事件打当时前台应用戳（弹幕评这条时仍是该观众群）。
  // 只对文件操作类型戳；idle/app 事件无应用上下文（用全局观众池）
  FILE_APP_TYPES = ['create', 'change', 'delete', 'rename', 'move']; // 类字段，或放模块常量

  pushEntry(entry) {
    if (this.state.paused) return;
    if (entry.type === 'change') { /* 现有 changeSeen 逻辑不变 */ }
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
    entry.ts = this.clock();
    if (entry.source === 'screen') {
      this.visionQueue.push(entry);
      this.flushVision();
    } else {
      const enter = this.maybeEnterGroup(entry);
      if (enter) this.queue.push(enter);
      this.queue.push(entry);
      this.maybeRefill();
    }
  }
```

（模块顶部常量区加 `const FILE_APP_TYPES = ['create', 'change', 'delete', 'rename', 'move'];`，pushEntry 内使用；不用类字段避免语法差异。）

（brain.js — generateText 场景注入）

```js
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
    ...（其余不变）
  }
```

require 行加 `const { resolveGroup } = require('./audienceGroups');`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/brain.test.js tests/styles.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/brain.js src/shared/styles.js tests/brain.test.js tests/styles.test.js
git commit -m "feat: brain 集成观众群（登场播报/事件场景化/场景 prompt 注入）"
```

---

### Task 7: ScreenWatcher 空闲检测

**Files:**
- Modify: `src/main/screenWatcher.js`
- Test: `tests/screenWatcher.test.js`

**Interfaces:**
- Consumes: 现有 tick 的 diff 计算
- Produces: constructor 新参数 `idleMinutes`、`onIdle`、`clock`；新方法 `updateIdle(hasChanged)` → `null | { source:'file', type:'idle', name:'', drive:'', isDir:false }`（纯状态机，可测）；tick 中 diff < 阈值时调用并转 onIdle。仅 visionModel.enabled（ScreenWatcher 启动）时生效

- [ ] **Step 1: 写失败测试**（追加到 `tests/screenWatcher.test.js`）

```js
test('updateIdle 状态机：无变化超阈值播报一次，恢复后重新计时', () => {
  const { ScreenWatcher } = require('../src/main/screenWatcher');
  let fakeNow = 1000000;
  const idleEvents = [];
  const sw = new ScreenWatcher({
    config: { visionModel: {} },
    getMasks: () => [], processor: { process: async (d, m) => d },
    onEntry: () => {}, onError: () => {}, onRecovered: () => {},
    idleMinutes: 10, onIdle: (e) => idleEvents.push(e),
    clock: () => fakeNow,
  });
  // 前 9 分钟：无变化但未到阈值
  fakeNow += 9 * 60 * 1000;
  assert.equal(sw.updateIdle(false), null);
  assert.equal(idleEvents.length, 0);
  // 第 11 分钟：触发
  fakeNow += 2 * 60 * 1000;
  const e = sw.updateIdle(false);
  assert.equal(e.type, 'idle');
  assert.equal(idleEvents.length, 1);
  // 已播报：继续无变化不再播
  fakeNow += 60 * 1000;
  assert.equal(sw.updateIdle(false), null);
  assert.equal(idleEvents.length, 1);
  // 画面恢复：重新计时
  sw.updateIdle(true);
  fakeNow += 11 * 60 * 1000;
  assert.equal(sw.updateIdle(false).type, 'idle');
  assert.equal(idleEvents.length, 2);
  // idleMinutes=0 关闭
  const sw0 = new ScreenWatcher({ config: {}, getMasks: () => [], onEntry: () => {}, onError: () => {}, onRecovered: () => {}, idleMinutes: 0, clock: () => fakeNow });
  assert.equal(sw0.updateIdle(false), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/screenWatcher.test.js`
Expected: FAIL — 需要新增计时状态逻辑

- [ ] **Step 3: 实现**（screenWatcher.js 修改）

constructor 参数与字段：

```js
  constructor({ config, getMasks, onEntry, onError, onRecovered, processor, idleMinutes = 0, onIdle = null, clock = Date.now }) {
    ...（现有字段不变）...
    this.idleMinutes = idleMinutes; // 0 = 关闭空闲播报
    this.onIdle = onIdle;
    this.clock = clock;
    this.idleSince = 0;    // 最后一次画面变化时刻
    this.idleSent = false; // 本段空闲已播报（只播一次）
  }

  // 空闲计时状态机（纯逻辑，可测）：画面有变化重置；无变化累计超 idleMinutes 播报一次
  updateIdle(hasChanged) {
    if (this.idleMinutes <= 0) return null;
    if (hasChanged) {
      this.idleSince = 0;
      this.idleSent = false;
      return null;
    }
    if (this.idleSent) return null;
    if (!this.idleSince) this.idleSince = this.clock();
    if (this.clock() - this.idleSince >= this.idleMinutes * 60000) {
      this.idleSent = true;
      return { source: 'file', type: 'idle', name: '', drive: '', isDir: false };
    }
    return null;
  }
```

tick 内变化检测处（`if (diff < DIFF_THRESHOLD) continue;` 之前，`this.last.set(...)` 之后）插入：

```js
        if (diff < DIFF_THRESHOLD) {
          const idleEntry = this.updateIdle(false);
          if (idleEntry) this.onIdle?.(idleEntry);
          continue;
        }
        this.updateIdle(true);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/screenWatcher.test.js`
Expected: PASS（新增测试 + 现有测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/main/screenWatcher.js tests/screenWatcher.test.js
git commit -m "feat: 屏幕空闲检测（超阈值播报一次，画面恢复重置）"
```

---

### Task 8: main.js 装配接线

**Files:**
- Modify: `src/main/main.js`

**Interfaces:**
- Consumes: AppWatcher（Task 5）、ScreenWatcher idle（Task 7）、Brain getCurrentApp/onStay/onIdle 事件流
- Produces: 运行时完整链路：applyConfig 创建/重启 AppWatcher（appWatch 开关）、brain 注入 getCurrentApp、app_switch/app_stay 进 brain、idle 进 brain、屏幕事件源同步 idleMinutes

- [ ] **Step 1: 实现**（main.js）

require 增加：

```js
const { AppWatcher } = require('./appWatcher');
```

模块作用域加 `let appWatcher = null;`

applyConfig 内（watcher.start() 之后）加：

```js
  // 前台应用监控：切换/停留事件进 brain（观众群体系的事件源）
  if (appWatcher) appWatcher.stop();
  appWatcher = new AppWatcher({
    stayMinutes: config.monitor.stayMinutes,
    aliases: config.monitor.appAliases,
    onEvent: (e) => brain?.pushEntry(e),
    onStay: (e) => brain?.pushEntry(e),
    onError: (err) => reporter?.reportError('watch', err),
  });
  if (config.monitor.appWatch) appWatcher.start();
```

applyScreenWatcher 内 ScreenWatcher 构造参数增加：

```js
    idleMinutes: config.monitor.idleMinutes,
    onIdle: (e) => brain?.pushEntry(e),
```

brain 构造增加：

```js
      getCurrentApp: () => appWatcher?.getCurrent() || null,
```

（brain 构造在 appWatcher 声明之后——main.js 中 brain 在 whenReady 内创建，appWatcher 在 applyConfig 内创建，applyConfig 在 brain 创建之后调用，顺序 OK：getCurrentApp 闭包引用模块级 appWatcher。）

- [ ] **Step 2: 验证语法与现有测试**

Run: `npm test`
Expected: 97 pass（无新测试，装配不影响既有行为）

- [ ] **Step 3: 冒烟启动**

Run: `npm start` 后检查无报错日志，托盘运行正常
Expected: 启动无异常；`~/.zcode` 无关

- [ ] **Step 4: 提交**

```bash
git add src/main/main.js
git commit -m "feat: main 装配 AppWatcher（切换/停留/空闲事件进 brain）"
```

---

### Task 9: 设置页监控 section（配置项 + 噪音规则编辑 + ？tooltip 通用模式）

**Files:**
- Modify: `src/renderer/settings/settings.html`（监控 section）
- Modify: `src/renderer/settings/settings.js`（load/保存 + 噪音规则 textarea）
- Modify: `src/renderer/settings/settings.css`（textarea 样式 + hint-mark tooltip）

**Interfaces:**
- Consumes: config.monitor 新键（Task 1）
- Produces: 设置页完整配置能力（含 `？` tooltip）；`hint-mark` 通用组件（后续分区复用）

- [ ] **Step 1: 实现 HTML**（settings.html 监控 section 内、`<h3>隐私遮罩` 之前插入）

```html
    <h3>前台应用监控（观众群弹幕）</h3>
    <label class="label-row"><input id="mon-app-watch" type="checkbox" /> 开启前台应用监控 <span class="hint-mark" data-tip="开启后轮询前台应用变化，弹幕会根据你正在用的应用选择观众群（如打开 VSCode 是程序员观众团）。轮询每 2 秒一次，几乎不占 CPU">？</span></label>
    <label class="label-row">停留播报阈值（分钟，0=关） <input id="mon-stay" type="number" min="0" max="600" style="width:80px" /> <span class="hint-mark" data-tip="在同一应用停留超过该分钟数时播报一次。默认 20。填 0 关闭">？</span></label>
    <label class="label-row">空闲播报阈值（分钟，0=关） <input id="mon-idle" type="number" min="0" max="600" style="width:80px" /> <span class="hint-mark" data-tip="屏幕画面超过该分钟数无变化时播报一次（需要开启屏幕识别）。默认 10。填 0 关闭">？</span></label>
    <label class="label-row">应用→观众群映射 <span class="hint-mark" data-tip="每行一个：应用: 观众群，如 Code: 程序员天团。应用用英文名（进程名/bundle id）。未列出的应用用全局观众池。内置群：程序员天团/吃瓜群众/摸鱼大队/学习委员/社畜同僚">？</span></label>
    <textarea id="mon-app-groups" rows="4" placeholder="Code: 程序员天团&#10;chrome: 吃瓜群众"></textarea>
    <label class="label-row">自定义观众群 <span class="hint-mark" data-tip="每行一个群：群名: 角色1｜角色2｜场景描述。场景描述会注入 AI 提示词；自定义群可覆盖同名内置群。示例：我的群: 嘴替｜杠精｜你是一群主播的嘴替">？</span></label>
    <textarea id="mon-audience-groups" rows="4" placeholder="我的群: 嘴替｜杠精｜你是一群主播的嘴替"></textarea>
    <label class="label-row">应用别名（显示名） <span class="hint-mark" data-tip="每行一个：应用: 显示名，如 chrome: 浏览器。用于弹幕文案显示；不配则用内置映射表">？</span></label>
    <textarea id="mon-app-aliases" rows="3" placeholder="chrome: 浏览器"></textarea>
    <h3>噪音过滤规则（忽略这些路径/文件名的操作事件）<span class="hint-mark" data-tip="每行一个子串，路径或文件名包含即忽略。内置规则（AppData、node_modules、.git 等）始终生效，这里追加你的规则">？</span></h3>
    <textarea id="mon-noise-rules" rows="4" placeholder=".zcode&#10;build/"></textarea>
```

（监控 section 末尾，遮罩之后）

同时给现有复杂项补 `？`（spec 要求：帮助提示模式统一到整个设置页）：
- `dm-styles` label：「每行/逗号分隔一个风格名；留空则从内置风格池随机挑（阴阳怪气/捧场/脑补/玩梗等 12 种）」
- `dm-colors` label：「逗号分隔颜色（支持 #hex / 中文色名）。留空=白色；填一个=全同色；填多个=随机轮换」
- 隐私遮罩 h3：「在下方预览图上拖拽矩形，截图发送前会涂黑这些区域。每个显示器可分别绘制」
- 视觉模型「截图间隔」label：「每隔多少秒截屏比对一次画面变化，变化时才调用视觉 API。间隔越大越省额度，但响应越慢」

（对应 HTML：在 `dm-styles`/`dm-colors` label 文本后、`隐私遮罩` h3 标题后、`vision-interval` label 文本后各加一个 `<span class="hint-mark" data-tip="...">？</span>`，注意 label 内嵌 hint-mark 需包 `<label class="label-row">` 结构或直接内联，保持现有布局不变。）

- [ ] **Step 2: 实现 CSS**（settings.css 追加）

```css
textarea { width: 460px; margin: 4px 0; background: #2a2a3e; color: #eee; border: 1px solid #555; padding: 6px; font-family: inherit; font-size: 12px; border-radius: 3px; resize: vertical; display: block; }
.hint-mark { display: inline-flex; width: 14px; height: 14px; border-radius: 50%; background: #555; color: #fff; font-size: 11px; line-height: 14px; align-items: center; justify-content: center; cursor: help; margin-left: 5px; position: relative; user-select: none; }
.hint-mark:hover { background: #4a6cf7; }
.hint-mark:hover::after { content: attr(data-tip); position: absolute; left: 20px; top: -6px; width: 260px; padding: 6px 8px; background: #16161f; border: 1px solid #555; border-radius: 4px; font-size: 12px; line-height: 1.5; color: #ddd; white-space: normal; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.5); }
```

- [ ] **Step 3: 实现 JS**（settings.js — load 内追加）

```js
  $('mon-app-watch').checked = config.monitor.appWatch;
  $('mon-stay').value = config.monitor.stayMinutes;
  $('mon-idle').value = config.monitor.idleMinutes;
  $('mon-app-groups').value = Object.entries(config.monitor.appGroups || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('mon-audience-groups').value = Object.entries(config.monitor.audienceGroups || {}).map(([k, v]) => `${k}: ${[v.roles.join('｜'), v.scene].filter(Boolean).join('｜')}`).join('\n');
  $('mon-app-aliases').value = Object.entries(config.monitor.appAliases || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('mon-noise-rules').value = (config.monitor.noiseRules || []).join('\n');
```

（btn-save 内追加，`config.monitor.masks = maskState.masks;` 之前）

```js
  config.monitor.appWatch = $('mon-app-watch').checked;
  config.monitor.stayMinutes = Math.max(0, Number($('mon-stay').value) || 20);
  config.monitor.idleMinutes = Math.max(0, Number($('mon-idle').value) || 10);
  config.monitor.appGroups = parseMap($('mon-app-groups').value);
  config.monitor.appAliases = parseMap($('mon-app-aliases').value);
  config.monitor.audienceGroups = parseGroups($('mon-audience-groups').value);
  config.monitor.noiseRules = $('mon-noise-rules').value.split('\n').map((s) => s.trim()).filter(Boolean);
```

（文件顶部工具函数区追加）

```js
// 每行 "key: value" → { key: value }（去空白）
function parseMap(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// 每行 "群名: 角色1｜角色2｜场景描述" → { 群名: { roles, scene, styles: [] } }
function parseGroups(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const parts = line.slice(i + 1).split('｜').map((s) => s.trim()).filter(Boolean);
    if (!name || parts.length === 0) continue;
    out[name] = { roles: parts.slice(0, -1), scene: parts[parts.length - 1], styles: [] };
  }
  return out;
}
```

注：`｜` 是分隔符；最后一段视为场景描述（即使没有角色也至少 1 段）。设置页保存后 applyConfig → brain.refreshConfig 更新 audienceGroups，热更新即时生效。

- [ ] **Step 4: 验证**

Run: `npm test`（确认设置页改动不影响测试）
Run: `npm start` 冒烟——打开设置页，确认 ？tooltip 悬停显示、新配置项读写正常
Expected: 97 pass；设置页正常

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings/settings.html src/renderer/settings/settings.js src/renderer/settings/settings.css
git commit -m "feat: 设置页前台监控配置（观众群/别名/阈值/噪音规则 + ？tooltip 帮助）"
```

---

### Task 10: 冒烟验证与收尾

**Files:** 无（验证 + 文档）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（97 + 新增 ≈ 115）

- [ ] **Step 2: 实机冒烟清单（macOS）**

```bash
npm start
```

逐项验证：
1. 切换应用（VSCode ↔ Chrome ↔ 微信）→ 出"用户打开了「VSCode」"弹幕；首次切换有"「程序员天团」进入直播间"登场弹幕；同群切换不再出登场
2. 在 VSCode 里新建/修改文件 → 弹幕是程序员观众群风格（场景注入）
3. 停留阈值临时调小（如 1 分钟）→ 停留播报
4. 屏幕识别开启 + idleMinutes 调小 → 空闲播报
5. 设置页所有 ？tooltip 悬停可见；观众群映射改动保存后立即生效
6. `ps aux | grep lsappinfo` 相关——确认 AppWatcher 轮询运行正常

- [ ] **Step 3: 收尾提交**

```bash
git log --oneline -10
git status --short  # 确认无遗漏
```

（本任务无代码提交；如冒烟发现问题，按问题修复后单独提交）
