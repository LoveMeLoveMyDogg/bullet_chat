# BulletChat（桌面弹幕直播）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个 Windows 桌面弹幕软件——监控全盘文件事件和屏幕变化，用用户自配的 LLM API（文字 + 视觉，OpenAI 兼容）生成搞笑弹幕，全屏置顶飘过。

**Architecture:** Electron 单进程三模块：Watcher（FileWatcher 每盘符一个递归 `fs.watch` + ScreenWatcher 定时截屏做像素差异）+ Brain（降噪/攒批/限速/生成，纯 Node 可测）+ Stage（每显示器一个透明置顶穿透窗口）。纯逻辑全部放 `src/shared/` 与 `src/main/` 中不依赖 Electron API 的文件，用 `node:test` 测；Electron 胶水部分手动验收。错误处理原则：**出错即提示用户，绝不静默降级**。

**Tech Stack:** Electron ≥ 37（devDependency）、Node 22+（自带 `fetch`、`node:test`）、纯 JavaScript 无框架、Windows only。

## Global Constraints

- 平台：仅 Windows（`fs.watch` recursive 依赖 Windows 实现）；Node ≥ 22
- 弹幕强制 ≤20 字（生成后 `slice(0, 24)` 保险截断）
- **错误必须可见**：系统通知 + 状态回调 + 日志；出错即停止生成，禁止静默降级/模板顶替
- 本地模式只能手动开关（默认关），弹幕带「【本地】」前缀；永不自动触发
- 出错后每 60 秒自动重试一次；配置保存后立即重试
- 同类错误通知节流 30 秒
- API Key 用 Electron `safeStorage` 加密存储（`enc:` 前缀 + base64），只发往用户配置的 baseUrl
- 默认限速 10 秒/条、攒批 5 秒或 10 条、同路径 change 事件 2 秒内合并
- 视觉默认 4 秒一帧，像素差异阈值 0.2%，截图发送前应用隐私遮罩
- 默认噪音路径：`$Recycle.Bin`、`System Volume Information`、`\Windows\`、`\AppData\`、`node_modules`、`.git`、`__pycache__`、`\Temp\`、`Thumbs.db`、`desktop.ini`
- 测试用 `node --test tests/`，纯逻辑模块不得 import Electron
- 配置默认值：textModel = DeepSeek 官方（`https://api.deepseek.com` + `deepseek-chat`）；visionModel 默认关闭
- 单实例运行；`window-all-closed` 不退出（托盘常驻）

---

## 文件结构

```
bullet_chat/
├── package.json
├── .gitignore
├── assets/tray.png
├── src/
│   ├── main/
│   │   ├── main.js            # 入口：装配一切、IPC、托盘、自启
│   │   ├── tray.js            # 托盘
│   │   ├── config.js          # Electron 胶水：userData 路径 + safeStorage
│   │   ├── fileWatcher.js     # 文件事件源（纯 Node，可测）
│   │   ├── screenWatcher.js   # 屏幕事件源（desktopCapturer + 像素差异 + 遮罩）
│   │   ├── imageProcessor.js  # 隐藏窗口 canvas：涂遮罩 + JPEG 压缩
│   │   ├── stage.js           # 每显示器一个弹幕窗口
│   │   ├── errorReporter.js   # 通知/状态/节流
│   │   ├── generator.js       # OpenAI 兼容 API 客户端（纯 Node，可测）
│   │   ├── demoMode.js        # 假事件生成器（纯 Node，可测）
│   │   └── settingsWindow.js  # 设置窗口
│   ├── shared/
│   │   ├── configCore.js      # 配置默认值/合并/加解密（纯 Node，可测）
│   │   ├── noiseFilter.js     # 降噪 + 事件描述（纯 Node，可测）
│   │   ├── templates.js       # 本地模板库（纯 Node，可测）
│   │   ├── styles.js          # 风格池 + 提示词构造（纯 Node，可测）
│   │   └── brain.js           # 队列/攒批/限速/生成/错误状态（纯 Node，可测）
│   ├── preload/
│   │   └── preload.js         # contextBridge 暴露 IPC
│   └── renderer/
│       ├── stage/danmaku.html + danmaku.css + danmaku.js   # 弹幕动画
│       ├── settings/settings.html + settings.css + settings.js  # 设置表单
│       └── processor/processor.html + processor.js          # 遮罩 canvas
└── tests/
    ├── configCore.test.js
    ├── noiseFilter.test.js
    ├── templates.test.js
    ├── styles.test.js
    ├── generator.test.js
    ├── brain.test.js
    ├── fileWatcher.test.js
    └── demoMode.test.js
```

---

### Task 1: 工程骨架（package.json + 应用生命周期 + 托盘）

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `assets/tray.png`（16×16 PNG，由内嵌 base64 写出）
- Create: `src/main/main.js`
- Create: `src/main/tray.js`

**Interfaces:**
- Produces: `npm start` 启动 Electron；`createTray({ onQuit, onOpenSettings, onTogglePause })` 返回 Tray 实例

- [ ] **Step 1: 写 package.json 和 .gitignore**

`package.json`:
```json
{
  "name": "bullet-chat",
  "version": "0.1.0",
  "description": "桌面弹幕直播：监控你的文件操作，AI 观众发弹幕吐槽",
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test tests/"
  },
  "devDependencies": {
    "electron": "^37.2.0"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: `added N packages`，安装时间可能较长（Electron 二进制 ~100MB），耐心等待。

- [ ] **Step 3: 写托盘图标 assets/tray.png**

用 Node 把内嵌 base64 写出（一个简单的蓝色圆形弹幕图标）：
```bash
node -e "const fs=require('fs');const b=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXklEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglHABgMA9wABUzCwUwAAAABJRU5ErkJggg==','base64');fs.writeFileSync('assets/tray.png',b);console.log('written',fs.statSync('assets/tray.png').size,'bytes')"
```
Expected: `written 160 bytes`，`assets/tray.png` 存在。

- [ ] **Step 4: 写应用入口 src/main/main.js**

```js
const { app } = require('electron');
const { createTray } = require('./tray');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二实例：直接退出（app.exit 在 ready 事件前也生效，quit() 在 Windows 上可能无效）
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 已有实例在运行，保持其存活，不执行任何操作
  });

  app.whenReady().then(() => {
    // 托盘常驻，关闭所有窗口也不退出
    const tray = createTray({
      onQuit: () => app.quit(),
      onOpenSettings: () => {},          // Task 10 接入设置窗口
      onTogglePause: () => {},
      onToggleLocalMode: () => {},
    });
    global.__tray = tray; // 防 GC（Electron 托盘对象需保活）
  });

  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
}
```

- [ ] **Step 5: 写托盘 src/main/tray.js**

```js
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

function createTray({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('BulletChat 桌面弹幕直播');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: false, click: onToggleLocalMode },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]));
  return tray;
}

module.exports = { createTray };
```

- [ ] **Step 6: 手动验证**

Run: `npm start`
Expected: 系统托盘出现 BulletChat 图标；右键菜单可打开/退出；应用没有窗口但进程存活；重复 `npm start` 第二次立即退出（单实例锁生效）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: 工程骨架（package.json/托盘/单实例）"
```

---

### Task 2: 配置模块（configCore 纯逻辑 + config 胶水）

**Files:**
- Create: `src/shared/configCore.js`
- Create: `src/main/config.js`
- Test: `tests/configCore.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `defaultConfig()` → 完整默认配置对象（`structuredClone` 返回新副本）
  - `mergeConfig(base, saved)` → 深合并（按已知键，丢弃未知键）
  - `encryptSecret(plain, encrypter)` / `decryptSecret(stored, decrypter)` → `'enc:' + base64` 形式
  - `serializeConfig(cfg, encrypter)` → 可写盘的纯对象（apiKey 已加密）
  - `parseConfig(json, decrypter)` → 配置对象（apiKey 已解密）
  - `loadConfigFile(file, fsMod, decrypter)` → 不存在则返回默认值
  - `saveConfigFile(file, cfg, fsMod, encrypter)`
  - `src/main/config.js` 导出 `loadConfig()` / `saveConfig(cfg)` / `configPath()`（Electron 胶水）

- [ ] **Step 1: 写失败的测试 tests/configCore.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  defaultConfig, mergeConfig, encryptSecret, decryptSecret,
  serializeConfig, parseConfig, loadConfigFile, saveConfigFile,
} = require('../src/shared/configCore');

const enc = (s) => Buffer.from('X' + s);
const dec = (b) => b.toString('utf8').slice(1);

test('defaultConfig 返回独立副本', () => {
  const a = defaultConfig();
  a.textModel.model = 'changed';
  assert.notEqual(defaultConfig().textModel.model, 'changed');
  assert.equal(defaultConfig().textModel.baseUrl, 'https://api.deepseek.com');
  assert.equal(defaultConfig().textModel.model, 'deepseek-chat');
  assert.equal(defaultConfig().visionModel.enabled, false);
  assert.equal(defaultConfig().danmaku.minIntervalSec, 10);
});

test('mergeConfig 只保留已知键', () => {
  const merged = mergeConfig(defaultConfig(), {
    textModel: { model: 'deepseek-reasoner' },
    unknownKey: 1,
    danmaku: { minIntervalSec: 5 },
  });
  assert.equal(merged.textModel.model, 'deepseek-reasoner');
  assert.equal(merged.textModel.baseUrl, 'https://api.deepseek.com');
  assert.equal(merged.danmaku.minIntervalSec, 5);
  assert.equal(merged.unknownKey, undefined);
});

test('encryptSecret/decryptSecret 往返', () => {
  const stored = encryptSecret('sk-123', enc);
  assert.ok(stored.startsWith('enc:'));
  assert.equal(decryptSecret(stored, dec), 'sk-123');
  assert.equal(encryptSecret('', enc), '');
});

test('serialize/parse 保留明文字段、加密 key 字段', () => {
  const cfg = defaultConfig();
  cfg.textModel.apiKey = 'sk-text';
  cfg.visionModel.apiKey = 'sk-vision';
  const saved = serializeConfig(cfg, enc);
  assert.ok(saved.textModel.apiKey.startsWith('enc:'));
  const back = parseConfig(saved, dec);
  assert.equal(back.textModel.apiKey, 'sk-text');
  assert.equal(back.visionModel.apiKey, 'sk-vision');
});

test('loadConfigFile 缺失文件返回默认', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  const cfg = loadConfigFile(file, fs, dec);
  assert.equal(cfg.textModel.model, 'deepseek-chat');
});

test('saveConfigFile 后 loadConfigFile 往返', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  const cfg = defaultConfig();
  cfg.textModel.apiKey = 'sk-abc';
  cfg.danmaku.localMode = true;
  saveConfigFile(file, cfg, fs, enc);
  const back = loadConfigFile(file, fs, dec);
  assert.equal(back.textModel.apiKey, 'sk-abc');
  assert.equal(back.danmaku.localMode, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/configCore.test.js`
Expected: FAIL（`Cannot find module '../src/shared/configCore'`）

- [ ] **Step 3: 写 src/shared/configCore.js**

```js
const fs = require('node:fs');
const path = require('node:path');

const KNOWN_KEYS = {
  textModel: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
  visionModel: { enabled: false, baseUrl: '', apiKey: '', model: '', captureIntervalSec: 4 },
  monitor: { drives: [], noiseRules: [], masks: [] },
  danmaku: { minIntervalSec: 10, batchIntervalMs: 5000, maxConcurrent: 6, styles: [], animationsEnabled: true, localMode: false },
  system: { autostart: false },
};

function defaultConfig() {
  return structuredClone(KNOWN_KEYS);
}

function mergeConfig(base, saved) {
  const out = defaultConfig();
  for (const section of Object.keys(KNOWN_KEYS)) {
    const src = saved && typeof saved[section] === 'object' ? saved[section] : {};
    out[section] = { ...out[section], ...pickKnown(src, KNOWN_KEYS[section]) };
  }
  return out;
}

function pickKnown(src, template) {
  const out = {};
  for (const key of Object.keys(template)) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

function encryptSecret(plain, encrypter) {
  if (!plain) return '';
  return 'enc:' + encrypter(String(plain)).toString('base64');
}

function decryptSecret(stored, decrypter) {
  if (!stored || !stored.startsWith('enc:')) return stored || '';
  return decrypter(Buffer.from(stored.slice(4), 'base64'));
}

function serializeConfig(cfg, encrypter) {
  const out = structuredClone(cfg);
  out.textModel.apiKey = encryptSecret(cfg.textModel.apiKey, encrypter);
  out.visionModel.apiKey = encryptSecret(cfg.visionModel.apiKey, encrypter);
  return out;
}

function parseConfig(json, decrypter) {
  const merged = mergeConfig(defaultConfig(), json);
  merged.textModel.apiKey = decryptSecret(merged.textModel.apiKey, decrypter);
  merged.visionModel.apiKey = decryptSecret(merged.visionModel.apiKey, decrypter);
  return merged;
}

function loadConfigFile(file, fsMod, decrypter) {
  try {
    const raw = fsMod.readFileSync(file, 'utf8');
    return parseConfig(JSON.parse(raw), decrypter);
  } catch {
    return defaultConfig();
  }
}

function saveConfigFile(file, cfg, fsMod, encrypter) {
  fsMod.mkdirSync(path.dirname(file), { recursive: true });
  fsMod.writeFileSync(file, JSON.stringify(serializeConfig(cfg, encrypter), null, 2), 'utf8');
}

module.exports = {
  defaultConfig, mergeConfig, encryptSecret, decryptSecret,
  serializeConfig, parseConfig, loadConfigFile, saveConfigFile,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/configCore.test.js`
Expected: PASS（8 个用例）

- [ ] **Step 5: 写 Electron 胶水 src/main/config.js**

```js
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadConfigFile, saveConfigFile, encryptSecret, decryptSecret,
} = require('../shared/configCore');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// safeStorage 不可用时降级为明文（仅本地文件，仍不联网）
const encrypter = (s) => safeStorage.isEncryptionAvailable()
  ? safeStorage.encryptString(s)
  : Buffer.from(s, 'utf8');
const decrypter = (buf) => safeStorage.isEncryptionAvailable()
  ? safeStorage.decryptString(buf)
  : buf.toString('utf8');

function loadConfig() {
  return loadConfigFile(configPath(), fs, decrypter);
}

function saveConfig(cfg) {
  saveConfigFile(configPath(), cfg, fs, encrypter);
}

module.exports = { loadConfig, saveConfig, configPath };
```

- [ ] **Step 6: 全量测试 + Commit**

Run: `node --test tests/`
Expected: PASS
```bash
git add -A && git commit -m "feat: 配置模块（默认值/合并/safeStorage 加密读写）"
```

---

### Task 3: 降噪过滤器 + 事件描述

**Files:**
- Create: `src/shared/noiseFilter.js`
- Test: `tests/noiseFilter.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_NOISE_SUBSTRINGS: string[]`
  - `makeNoiseFilter(extraRules = [])` → `(entry) => boolean`（true 表示噪音，应丢弃）
  - `formatEventDescription(entry)` → 中文事件描述（喂给 LLM 用）

- [ ] **Step 1: 写失败的测试 tests/noiseFilter.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeNoiseFilter, formatEventDescription } = require('../src/shared/noiseFilter');

const mk = (type, name, p) => ({ source: 'file', type, name, path: p, drive: p.slice(0, 2), isDir: false });

test('系统噪音路径被过滤', () => {
  const f = makeNoiseFilter();
  assert.equal(f(mk('create', 'x', 'C:\\$Recycle.Bin\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\System Volume Information\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\Windows\\System32\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\Users\\me\\AppData\\Local\\Temp\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\proj\\node_modules\\lodash\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\proj\\.git\\HEAD')), true);
});

test('用户可见路径不被过滤', () => {
  const f = makeNoiseFilter();
  assert.equal(f(mk('create', '新建文件夹', 'C:\\Users\\me\\Desktop\\新建文件夹')), false);
  assert.equal(f(mk('create', 'a.txt', 'C:\\Users\\me\\Desktop\\a.txt')), false);
  assert.equal(f(mk('create', 'x', 'C:\\Users\\me\\Documents\\x')), false);
  assert.equal(f(mk('create', 'x', 'D:\\x')), false);
});

test('自定义规则追加生效', () => {
  const f = makeNoiseFilter(['\\Downloads\\']);
  assert.equal(f(mk('create', 'x', 'C:\\Users\\me\\Downloads\\x')), true);
});

test('formatEventDescription 各类型', () => {
  const folder = mk('create', '新建文件夹', 'C:\\Users\\me\\Desktop\\新建文件夹');
  folder.isDir = true;
  assert.equal(formatEventDescription(folder), '用户新建了文件夹「新建文件夹」在C:');
  const file = mk('create', 'a.txt', 'C:\\x\\a.txt');
  assert.equal(formatEventDescription(file), '用户新建了文件「a.txt」在C:');
  assert.equal(formatEventDescription(mk('delete', 'a.txt', 'D:\\a.txt')), '用户删除了「a.txt」在D:');
  assert.equal(formatEventDescription(mk('rename', 'b.txt', 'C:\\b.txt')), '用户把文件改名成「b.txt」在C:');
  assert.equal(formatEventDescription(mk('move', 'a.txt', 'E:\\a.txt')), '用户把「a.txt」移动到了E:');
  assert.equal(formatEventDescription(mk('change', 'a.txt', 'C:\\a.txt')), '用户修改了「a.txt」在C:');
  assert.equal(formatEventDescription({ ...mk('create', 'x', 'C:\\x'), isDir: true }), '用户新建了文件夹「x」在C:');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/noiseFilter.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/shared/noiseFilter.js**

```js
const DEFAULT_NOISE_SUBSTRINGS = [
  '$Recycle.Bin',
  'System Volume Information',
  '\\Windows\\',
  '\\AppData\\',
  'node_modules',
  '\\.git',
  '__pycache__',
  '\\Temp\\',
  'Thumbs.db',
  'desktop.ini',
];

function makeNoiseFilter(extraRules = []) {
  const rules = DEFAULT_NOISE_SUBSTRINGS.concat(extraRules);
  return function isNoise(entry) {
    const p = (entry.path || '').replace(/\//g, '\\');
    const n = entry.name || '';
    return rules.some((r) => p.includes(r) || n.includes(r));
  };
}

function locationLabel(entry) {
  return entry.drive ? `在${entry.drive}` : '';
}

function formatEventDescription(entry) {
  const name = entry.name || '(未知)';
  const loc = locationLabel(entry);
  switch (entry.type) {
    case 'create':
      return entry.isDir
        ? `用户新建了文件夹「${name}」${loc}`
        : `用户新建了文件「${name}」${loc}`;
    case 'delete':
      return `用户删除了「${name}」${loc}`;
    case 'rename':
      return `用户把文件改名成「${name}」${loc}`;
    case 'move':
      return `用户把「${name}」移动到了${entry.drive || ''}`;
    case 'change':
      return `用户修改了「${name}」${loc}`;
    case 'screen':
      return '用户屏幕上的画面发生了变化';
    default:
      return `用户对「${name}」做了什么${loc}`;
  }
}

module.exports = { DEFAULT_NOISE_SUBSTRINGS, makeNoiseFilter, formatEventDescription };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/noiseFilter.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 噪音过滤与事件描述格式化"
```

---

### Task 4: 文件事件源 FileWatcher

**Files:**
- Create: `src/main/fileWatcher.js`
- Test: `tests/fileWatcher.test.js`

**Interfaces:**
- Produces:
  - `listFixedDrives()` → `['C:\\', 'D:\\', ...]`
  - `class FileWatcher`：`constructor({ drives, filter = null, onEvent, onError })`；`start()` / `stop()`；`getStatus()` → `[{ root, watching }]`
  - 事件条目：`{ source: 'file', type: 'create'|'delete'|'change', name, path, drive, isDir }`
  - `classifyEntry(root, full, eventType)`（导出便于测试）

- [ ] **Step 1: 写失败的测试 tests/fileWatcher.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listFixedDrives, FileWatcher, classifyEntry } = require('../src/main/fileWatcher');

function waitFor(fn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(timer); resolve(v); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('waitFor 超时')); }
    }, 50);
  });
}

test('listFixedDrives 包含系统盘', () => {
  const drives = listFixedDrives();
  assert.ok(Array.isArray(drives) && drives.length > 0);
  assert.ok(drives.includes(process.env.SystemDrive + '\\'));
});

test('classifyEntry 区分新建/删除/修改', () => {
  assert.deepEqual(classifyEntry('C:\\', 'C:\\a.txt', 'change'), {
    source: 'file', type: 'change', name: 'a.txt', path: 'C:\\a.txt', drive: 'C:', isDir: false,
  });
});

test('递归监听：新建/删除/修改文件都能收到', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-watch-'));
  const events = [];
  const fw = new FileWatcher({ drives: [root], filter: () => false, onEvent: (e) => events.push(e) });
  fw.start();

  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const file = path.join(sub, 'hello.txt');
  fs.writeFileSync(file, 'hi');
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'create' && e.isDir === false));

  fs.writeFileSync(file, 'hi2');
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'change'));

  fs.unlinkSync(file);
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'delete'));

  const created = events.find((e) => e.name === 'hello.txt' && e.type === 'create');
  assert.equal(created.drive, root.slice(0, 2));
  assert.equal(created.path, file);
  assert.equal(created.isDir, false);

  // 新建文件夹
  fs.mkdirSync(path.join(root, '新文件夹'));
  await waitFor(() => events.some((e) => e.name === '新文件夹' && e.type === 'create' && e.isDir === true));

  fw.stop();
});

test('filter 为 true 的事件被丢弃', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-watch-'));
  const events = [];
  const fw = new FileWatcher({ drives: [root], filter: () => true, onEvent: (e) => events.push(e) });
  fw.start();
  fs.writeFileSync(path.join(root, 'junk.txt'), 'x');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(events.length, 0);
  fw.stop();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/fileWatcher.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/main/fileWatcher.js**

```js
const fs = require('node:fs');
const path = require('node:path');

function listFixedDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c);
    try {
      if (fs.existsSync(d + ':\\')) out.push(d + ':\\');
    } catch { /* 跳过不可访问盘符 */ }
  }
  return out;
}

function classifyEntry(root, full, eventType) {
  const name = path.basename(full);
  let isDir = false;
  if (eventType === 'change') {
    return { source: 'file', type: 'change', name, path: full, drive: root.slice(0, 2), isDir: false };
  }
  // fs.watch 的 rename 事件：存在 → 新建，不存在 → 删除（改名表现为删除+新建两条，可接受）
  let exists = false;
  try { exists = fs.statSync(full); } catch { exists = false; }
  if (exists) {
    try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
    return { source: 'file', type: 'create', name, path: full, drive: root.slice(0, 2), isDir };
  }
  return { source: 'file', type: 'delete', name, path: full, drive: root.slice(0, 2), isDir };
}

class FileWatcher {
  constructor({ drives = listFixedDrives(), filter = null, onEvent, onError }) {
    this.drives = drives;
    this.filter = filter || (() => false);
    this.onEvent = onEvent;
    this.onError = onError;
    this.watchers = new Map(); // root -> fs.FSWatcher
    this.stopped = false;
    this.remountTimer = null;
  }

  start() {
    this.stopped = false;
    for (const root of this.drives) {
      try {
        const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const full = path.join(root, filename.toString());
          const entry = classifyEntry(root, full, eventType);
          if (this.filter(entry)) return;
          this.onEvent(entry);
        });
        w.on('error', (err) => this.remount(root, err));
        this.watchers.set(root, w);
      } catch (err) {
        this.onError?.(new Error(`无法监听 ${root}：${err.message}`));
      }
    }
  }

  remount(root, err) {
    if (this.stopped) return; // stop() 后的重挂窗口内不再重建
    this.onError?.(new Error(`监控 ${root} 失效：${err.message}`));
    try { this.watchers.get(root)?.close(); } catch { /* 已失效 */ }
    this.watchers.delete(root);
    this.remountTimer = setTimeout(() => {
      if (this.stopped) return;
      try {
        const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const full = path.join(root, filename.toString());
          const entry = classifyEntry(root, full, eventType);
          if (this.filter(entry)) return;
          this.onEvent(entry);
        });
        w.on('error', (e2) => this.remount(root, e2));
        this.watchers.set(root, w);
      } catch (e2) {
        this.onError?.(new Error(`重新监听 ${root} 失败：${e2.message}`));
      }
    }, 5000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.remountTimer);
    this.remountTimer = null;
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* 忽略 */ }
    }
    this.watchers.clear();
  }

  getStatus() {
    return this.drives.map((root) => ({ root, watching: this.watchers.has(root) }));
  }
}

module.exports = { listFixedDrives, FileWatcher, classifyEntry };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/fileWatcher.test.js`
Expected: PASS（若偶发超时，重跑一次；Windows 递归 watch 事件稍有延迟属正常）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 文件事件源（盘符递归监控/分类/自动重挂）"
```

---

### Task 5: 本地模板库 + 风格池

**Files:**
- Create: `src/shared/templates.js`
- Create: `src/shared/styles.js`
- Test: `tests/templates.test.js`, `tests/styles.test.js`

**Interfaces:**
- Produces:
  - `TEMPLATES`：`{ create_folder, create_file, delete, rename, move, change, screen, default }` 每个数组 ≥20 条
  - `templateFor(type, rng = Math.random)` → 模板字符串（含 `{name}` `{loc}` 占位符）
  - `fillTemplate(tpl, entry)` → 替换占位符后的字符串
  - `STYLE_POOL`：10+ 风格字符串
  - `pickStyles(n, rng = Math.random)` → 随机不重复子集
  - `buildSystemPrompt(styles)` → LLM system 提示词（含 few-shot 示例与 JSON 格式要求）

- [ ] **Step 1: 写失败的测试**

`tests/templates.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATES, templateFor, fillTemplate } = require('../src/shared/templates');

test('每个事件类型模板 ≥20 条且非空', () => {
  for (const type of ['create_folder', 'create_file', 'delete', 'rename', 'move', 'change', 'screen', 'default']) {
    assert.ok(TEMPLATES[type].length >= 20, `${type} 只有 ${TEMPLATES[type].length} 条`);
    for (const t of TEMPLATES[type]) assert.ok(typeof t === 'string' && t.trim().length > 0);
  }
});

test('templateFor 返回所属列表成员', () => {
  const t = templateFor('create_folder', () => 0);
  assert.ok(TEMPLATES.create_folder.includes(t));
  const fallback = templateFor('unknown_type', () => 0);
  assert.ok(TEMPLATES.default.includes(fallback));
});

test('fillTemplate 替换占位符', () => {
  const out = fillTemplate('「{name}」{loc}？', { name: '新建文件夹', drive: 'C:' });
  assert.equal(out, '「新建文件夹」C:？');
  const noDrive = fillTemplate('「{name}」{loc}', { name: 'x', drive: '' });
  assert.equal(noDrive, '「x」');
});
```

`tests/styles.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STYLE_POOL, pickStyles, buildSystemPrompt } = require('../src/shared/styles');

test('风格池 ≥10 种', () => {
  assert.ok(STYLE_POOL.length >= 10);
});

test('pickStyles 返回不重复子集', () => {
  const picked = pickStyles(3, () => 0);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
});

test('buildSystemPrompt 包含风格与 JSON 要求与示例', () => {
  const p = buildSystemPrompt(['阴阳怪气损友']);
  assert.ok(p.includes('阴阳怪气损友'));
  assert.ok(p.includes('JSON'));
  assert.ok(p.includes('新建了文件夹不改名字吗'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/templates.test.js tests/styles.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/shared/templates.js**（模板文案：每类 ≥20 条，风格多样）

```js
const TEMPLATES = {
  create_folder: [
    '新建了文件夹不改名字吗？',
    '又新建在{loc}……你是有什么执念吗',
    '新建文件夹？这名字取得真有创意',
    '好家伙，新建文件夹了！666',
    '又是一次「新建文件夹」，人类的本质是复读机',
    '猜猜这次文件夹里装的是什么？',
    '新建文件夹 × 1，互联网考古现场+1',
    '文件夹建得这么勤，是要开公司吗',
    '《关于{loc}又多了个文件夹这件事》',
    '建议改名：我的文件夹（1）',
    '新建文件夹，然后呢？然后就没有然后了',
    '这位主播很擅长创建文件夹，观赏性极佳',
    '文件夹+1，空间-1，人生+1',
    '新建文件夹不是目的，改名才是',
    '这波啊，这波是经典起手式',
    '文件夹界的天才出现了',
    '我数了数，这是你第{loc}个文件夹了（乱数）',
    '新建了一个文件夹，一段崭新的故事开始了',
    '专业团队！新建文件夹动作十分流畅',
    '有没有一种可能，你忘了给它起名',
    '文件夹：我的名字呢？主播：忘了',
    '精彩！没有名字的文件夹最自由',
  ],
  create_file: [
    '新建了文件「{name}」{loc}，有内味了',
    '「{name}」？这文件名一看就有故事',
    '好家伙，{name}都来了，事情不简单',
    '新文件+1，截图留念',
    '写文件了写文件了，主播认真起来了',
    '「{name}」新建于{loc}，今日头条',
    '这个文件，我赌它明天还在',
    '文件创建成功，掌声鼓励',
    '《主播创建了{name}》',
    '{name}？取名鬼才，爱了爱了',
    '新建了个{name}，水了一波存在感',
    '666，{name}闪亮登场',
    '这个{name}，一看就是亲生的',
    '电脑内存警告：文件越来越多了',
    '{name}已加入豪华套餐',
    '我听到{loc}传来一声「新建成功」',
    '每次新建文件都是一场豪赌',
    '{name}，今天的排面担当',
    '主播的手速，就为了一个{name}',
    '新文件，新气象，新的一天',
    '{name}：我来了，我存在',
  ],
  delete: [
    '删了？真的删了？我不信',
    '删除成功，心不痛吗',
    '「{name}」没了，就这？',
    '主播亲手终结了{name}的一生',
    '删文件的样子好狠，我都不敢看',
    '{name}：再见，世界',
    '这波删除，干净利落',
    '删了，又少一个证据（不是）',
    '《{name}消失术》',
    '回收站：又有新住户了',
    '删文件一时爽，找回火葬场',
    '我赌五毛，{name}还会回来',
    '主播的删除键好寂寞',
    '啊这，{name}就这样没了',
    '删除，是最快的整理方式（确信）',
    '{name}：明明是我先来的',
    '没了没了，全没了，弹幕心疼',
    '教科书式删除，满分',
    '这手起刀落的，是练过吧',
    '{name}已从{loc}毕业',
  ],
  rename: [
    '改名了改名了，总算开窍了',
    '好名字！这名字起得比刚才强',
    '从{name}到{name}，进步看得见',
    '改名，说明主播终于要正经起来了',
    '这个名字，我给 82 分，剩下 18 分以 666 形式给出',
    '改名成功，身份焕然一新',
    '起名大师又出手了',
    '《改名狂魔の日常》',
    '名字都改了，内容一定很重要吧',
    '这波改名，优雅，太优雅了',
    '改名一时爽，一直改名一直爽',
    '新名字新气象，主播加油',
    '改名了，我差点没认出来',
    '从今天起，请叫我{name}',
    '改名的快乐你不懂',
    '这名字比原来的有文化多了',
    '改名 × 1，仪式感拉满',
    '起名鬼才再次上线',
    '名字是灵魂，这波改名升华了',
    '改得好，下次别改了（不是）',
  ],
  move: [
    '移动文件，空间管理大师',
    '从{loc}搬到{loc}，拆迁了属于是',
    '{name}：我要搬家啦',
    '移动成功，路线规划满分',
    '这波转移，深藏功与名',
    '{name}换了个家，弹幕送去祝福',
    '搬家大戏上演了',
    '移动文件比移动办公还勤快',
    '{name}的流浪记，更新了',
    '这操作，一看就是整理小能手',
    '移动，是为了更好的相遇',
    '文件也会搬家，世界真奇妙',
    '挪了个位置，格局打开',
    '好家伙，这文件长了脚',
    '移动成功，落子无悔',
    '{name}：新家真不错',
    '主播在下一盘大棋（确信）',
    '搬来搬去，最后还是{loc}香',
    '空间整理大师，收下我的膝盖',
    '移动 × 1，桌面整洁度 +1',
  ],
  change: [
    '改文件了改文件了，内容有大新闻',
    '保存成功，主播的努力被系统记录',
    '修改文件？这波是认真工作了',
    '写写改改，一看就是大工程',
    '这个文件被改动了，事情不简单',
    '保存的瞬间，就是进步',
    '又改了又改了，卷起来了',
    '内容更新中，敬请期待',
    '改一下，存一下，稳如老狗',
    '文件：又被改了一刀',
    '认真工作的男人最帅（女也一样）',
    '这波修改，专业',
    '改动频繁，定有大作',
    '写进去了，写进去了',
    '修改保存，一气呵成',
    '文件：我脏了（指内容更新）',
    '改完了？改完了就对了',
    '每次保存都是一次小小胜利',
    '文档在成长，就像我们在成长',
    '改动成功，数据 +1',
  ],
  screen: [
    '屏幕变了！有情况',
    '画面突变，发生了什么',
    '这是切屏了？主播手速惊人',
    '屏幕上又有新剧情了',
    '来了来了，重头戏来了',
    '画面一闪，事情不简单',
    '主播在搞什么大动作',
    '哦？有新画面，弹幕前排围观',
    '这屏幕变化，有内味了',
    '变变变，屏幕七十二变',
    '刚才发生了什么，我没看清',
    '屏幕：我又被折腾了',
    '画面更新，故事继续',
    '这个操作，值得一个特写',
    '屏幕一变，弹幕大军出动',
    '主播又在整活了',
    '新画面解锁，进度 +1',
    '画面变了，但我还没看懂',
    '屏幕前的高能时刻',
    '这一变，变出了新花样',
  ],
  default: [
    '好活！',
    '666',
    '有点东西',
    '这波操作我看不懂但大受震撼',
    '弹幕不知道该说什么，先 666 吧',
    '主播的操作总是这么出人意料',
    '记录一下：今天主播又干了件大事',
    '？发生了什么，求科普',
    '这波，这波是常规操作',
    '哈哈哈哈哈哈（笑到模糊）',
    '收藏了，这就是经典',
    '主播，你是懂操作的',
    '离谱，但合理',
    '我好像错过了什么精彩瞬间',
    '屏幕前的我缓缓打出一个 6',
    '新纪录诞生！',
    '这段操作建议反复观看',
    '主播的日常，我的快乐源泉',
    '没有技巧，全是感情',
    '好好好，这么玩是吧',
  ],
};

function templateFor(type, rng = Math.random) {
  const list = TEMPLATES[type] || TEMPLATES.default;
  return list[Math.floor(rng() * list.length)];
}

function fillTemplate(tpl, entry) {
  const name = entry.name || '这个';
  const loc = entry.drive || '';
  return tpl.replaceAll('{name}', name).replaceAll('{loc}', loc).slice(0, 24);
}

module.exports = { TEMPLATES, templateFor, fillTemplate };
```

- [ ] **Step 4: 写 src/shared/styles.js**

```js
const STYLE_POOL = [
  '阴阳怪气损友',
  '傻乐捧场',
  '脑补剧情',
  '抽象玩梗',
  '温柔提醒',
  '专业吐槽',
  '古风书生',
  '中英混搭',
  '正经夸夸',
  '毒舌弹幕',
  '赛博朋克',
  '萌系治愈',
];

const USER_EXAMPLES = [
  ['用户新建了文件夹「新建文件夹」在C:', '新建了文件夹不改名字吗？'],
  ['用户新建了文件夹「新建文件夹」在C:', '又新建在C盘……你是有什么执念吗'],
  ['用户删除了「学习资料.rar」在D:', '删了？真的删了？我不信'],
];

function pickStyles(n, rng = Math.random) {
  const pool = [...STYLE_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

function buildSystemPrompt(styles) {
  const examples = USER_EXAMPLES.map(([a, b]) => `事件：${a}\n弹幕：${b}`).join('\n');
  return `你是直播间里的观众，主播（用户）正在操作电脑，你会针对他的操作发弹幕吐槽。
要求：
- 弹幕要短，不超过 20 个字
- 一次返回 1~3 条，每条风格不同，换着花样来
- 本次可选的画风：${styles.join('、')}（也可自由发挥其他风格）
- 只返回 JSON 数组，例如 ["弹幕1","弹幕2"]，不要输出任何其他内容
示例：
${examples}`;
}

module.exports = { STYLE_POOL, pickStyles, buildSystemPrompt };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/templates.test.js tests/styles.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: 本地模板库（8类×20+条）与风格池"
```

---

### Task 6: API 客户端 generator（OpenAI 兼容）

**Files:**
- Create: `src/main/generator.js`
- Test: `tests/generator.test.js`

**Interfaces:**
- Produces:
  - `class ApiError extends Error`：`{ code: 'auth'|'balance'|'model'|'rate'|'server'|'http'|'network'|'timeout', message }`
  - `chatCompletion({ baseUrl, apiKey, model, system, user })` → `Promise<string>`（模型回复原文）
  - `visionCompletion({ baseUrl, apiKey, model, system, imageDataUrl })` → `Promise<string>`
  - `parseDanmakuJson(text)` → `string[]`（容错解析，≤3 条，每条 ≤24 字）
  - `testTextConnection(cfg)` → `Promise<{ ok, message }>`
  - `testVisionConnection(cfg, redImageDataUrl)` → `Promise<{ ok, message }>`（答对颜色才 ok）
  - 常量 `RED_SQUARE_DATA_URL`（1×1 红色 PNG 的 data URL，测试连接用）

- [ ] **Step 1: 写失败的测试 tests/generator.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiError, chatCompletion, visionCompletion, parseDanmakuJson,
  testTextConnection, testVisionConnection,
} = require('../src/main/generator');

function mockFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

test('chatCompletion 成功返回内容', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(opts.headers.Authorization, 'Bearer sk-test');
    assert.equal(body.messages[0].role, 'system');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["666"]' } }] }) };
  });
  try {
    const out = await chatCompletion({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat', system: 's', user: 'u' });
    assert.equal(out, '["666"]');
  } finally { restore(); }
});

test('chatCompletion 401 报错信息友好', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', user: 'u' }),
      (e) => e instanceof ApiError && e.code === 'auth' && e.message.includes('API Key 无效')
    );
  } finally { restore(); }
});

test('chatCompletion 网络错误归类', async () => {
  const restore = mockFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', user: 'u' }),
      (e) => e instanceof ApiError && e.code === 'network'
    );
  } finally { restore(); }
});

test('visionCompletion 请求带图片', async () => {
  const restore = mockFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.messages[0].content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg')));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["红色"]' } }] }) };
  });
  try {
    await visionCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', imageDataUrl: 'data:image/jpeg;base64,xxx' });
  } finally { restore(); }
});

test('parseDanmakuJson 各种脏格式', () => {
  assert.deepEqual(parseDanmakuJson('["666","新建文件夹不改名"]'), ['666', '新建文件夹不改名']);
  assert.deepEqual(parseDanmakuJson('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseDanmakuJson('好的，弹幕如下：\n["1","2"]\n希望对你有帮助'), ['1', '2']);
  assert.deepEqual(parseDanmakuJson('不是JSON'), []);
  assert.deepEqual(parseDanmakuJson(''), []);
  // 超长截断
  const long = JSON.stringify(['这是一条特别特别特别特别特别长的弹幕内容超过二十个字啦']);
  assert.ok(parseDanmakuJson(long)[0].length <= 24);
});

test('testTextConnection 成功与失败', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '通' } }] }) }));
  try {
    const r = await testTextConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' });
    assert.deepEqual(r, { ok: true, message: '通' });
  } finally { restore(); }
});

test('testVisionConnection 答对颜色才 ok', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: calls === 1 ? '红色' : '蓝色' } }] }) };
  });
  try {
    const ok = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(ok.ok, true);
    const bad = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(bad.ok, false);
    assert.ok(bad.message.includes('视觉'));
  } finally { restore(); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/generator.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/main/generator.js**

```js
const TIMEOUT_MS = 30000;
const MAX_DANMAKU = 3;
const MAX_LEN = 24;

// 1×1 红色 PNG
const RED_SQUARE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function friendlyError(status) {
  if (status === 401) return new ApiError('auth', '鉴权失败：API Key 无效（401）');
  if (status === 402) return new ApiError('balance', '余额不足或额度用尽（402）');
  if (status === 404) return new ApiError('model', '模型名不存在（404），检查模型名是否正确');
  if (status === 429) return new ApiError('rate', '请求过于频繁（429），请稍后再试');
  if (status >= 500) return new ApiError('server', `服务端错误（HTTP ${status}）`);
  return new ApiError('http', `HTTP 错误（${status}）`);
}

async function postChat({ baseUrl, apiKey, body }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ApiError('timeout', '请求超时（30 秒无响应）');
    throw new ApiError('network', `网络错误：${err.message}`);
  }
  if (!res.ok) throw friendlyError(res.status);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function chatCompletion({ baseUrl, apiKey, model, system, user }) {
  return postChat({ baseUrl, apiKey, body: {
    model, temperature: 1.1, max_tokens: 120,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  } });
}

async function visionCompletion({ baseUrl, apiKey, model, system, imageDataUrl }) {
  return postChat({ baseUrl, apiKey, body: {
    model, temperature: 1.1, max_tokens: 120,
    messages: [
      // 单条 user 消息（含图片），兼容不支持 system+图片的端点
      { role: 'user', content: [
        { type: 'text', text: `${system}\n请根据这张截图发 1~2 条弹幕吐槽，每条不超过 20 个字。只返回 JSON 数组。` },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] },
    ],
  } });
}

function parseDanmakuJson(text) {
  if (!text) return [];
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, MAX_LEN))
      .slice(0, MAX_DANMAKU);
  } catch {
    // JSON 解析失败：手工提取所有双引号字符串
    const items = [...cleaned.slice(start + 1, end).matchAll(/"([^"]*)"/g)]
      .map((m) => m[1].trim()).filter(Boolean).slice(0, MAX_DANMAKU);
    return items.map((s) => s.slice(0, MAX_LEN));
  }
}

async function testTextConnection(cfg) {
  try {
    const reply = await chatCompletion({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      system: '你是连接测试助手', user: '只回复一个字：通',
    });
    const first = (reply || '').trim().split(/\s+/)[0] || '(无回复)';
    return { ok: true, message: first };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function testVisionConnection(cfg, redImageDataUrl = RED_SQUARE_DATA_URL) {
  try {
    const reply = await visionCompletion({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      system: '你是连接测试助手', imageDataUrl: redImageDataUrl,
    });
    if (/红|red|赤/i.test(reply)) return { ok: true, message: '视觉能力正常' };
    return { ok: false, message: `视觉测试未通过：模型回复「${(reply || '').trim().slice(0, 30)}」，未能识别红色` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = {
  ApiError, chatCompletion, visionCompletion, parseDanmakuJson,
  testTextConnection, testVisionConnection, RED_SQUARE_DATA_URL,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/generator.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: OpenAI 兼容 API 客户端（文字/视觉/测试连接/容错解析）"
```

---

### Task 7: 弹幕大脑 Brain（攒批/限速/错误状态/本地模式）

**Files:**
- Create: `src/shared/brain.js`
- Test: `tests/brain.test.js`

**Interfaces:**
- Consumes: `generator.chatCompletion`、`templates.templateFor/fillTemplate`、`noiseFilter.formatEventDescription`、`styles.pickStyles/buildSystemPrompt`（全部来自 Task 5/6，通过注入传入）
- Produces:
  - `class Brain`：
    - `constructor({ config, generator, templates, reporter, clock = Date.now, rng = Math.random, onDanmaku, onStatus })`
    - `start()` / `stop()`
    - `pushEntry(entry)`（文件或屏幕事件；屏幕事件由 `entry.source === 'screen'` 识别）
    - `flushNow()`（立即触发攒批，测试与手动重试用）
    - `setLocalMode(on)`、`pause()` / `resume()`、`retryNow()`、`refreshConfig(config)`
    - `getStatus()` → `{ mode: 'running'|'idle', paused, localMode, error: null | { source, message, at } }`
  - `typeKey(entry)` → `'create_folder'|'create_file'|'delete'|'rename'|'move'|'change'|'screen'`
  - 弹幕回调：`onDanmaku(text, meta)`，meta = `{ source: 'ai'|'local' }`

- [ ] **Step 1: 写失败的测试 tests/brain.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Brain, typeKey } = require('../src/shared/brain');
const { defaultConfig } = require('../src/shared/configCore');
const templates = require('../src/shared/templates');

function makeEnv(overrides = {}) {
  const danmaku = [];
  const statuses = [];
  const reporter = {
    errors: [],
    recovered: [],
    reportError(source, err) { this.errors.push({ source, message: err.message }); },
    reportRecovered(source) { this.recovered.push(source); },
  };
  const generator = {
    textCalls: 0,
    chatCompletion: async () => { generator.textCalls++; return '["弹幕1","弹幕2"]'; },
    visionCalls: 0,
    visionCompletion: async () => { generator.visionCalls++; return '["屏幕弹幕"]'; },
  };
  const cfg = defaultConfig();
  cfg.danmaku.batchIntervalMs = 20;
  cfg.danmaku.minIntervalSec = 0;
  const brain = new Brain({
    config: cfg, generator, reporter, templates,
    onDanmaku: (text, meta) => danmaku.push({ text, meta }),
    onStatus: (s) => statuses.push(s),
    ...overrides,
  });
  brain.start();
  return { brain, danmaku, statuses, reporter, generator, cfg };
}

const entry = (type, extra = {}) => ({ source: 'file', type, name: 'x.txt', path: 'C:\\x.txt', drive: 'C:', isDir: false, ...extra });

test('typeKey 映射', () => {
  assert.equal(typeKey({ type: 'create', isDir: true }), 'create_folder');
  assert.equal(typeKey({ type: 'create', isDir: false }), 'create_file');
  assert.equal(typeKey({ type: 'delete' }), 'delete');
  assert.equal(typeKey({ type: 'rename' }), 'rename');
  assert.equal(typeKey({ type: 'move' }), 'move');
  assert.equal(typeKey({ type: 'change' }), 'change');
  assert.equal(typeKey({ type: 'screen', source: 'screen' }), 'screen');
});

test('攒批：10 条事件触发一次生成，弹幕≤3 条', async () => {
  const { brain, danmaku, generator } = makeEnv();
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, 1);
  assert.equal(danmaku.length, 2);
  assert.equal(danmaku[0].meta.source, 'ai');
  brain.stop();
});

test('限速：minIntervalSec 内第二次 flush 被丢弃', async () => {
  const { brain, danmaku, generator } = makeEnv();
  const cfg2 = defaultConfig();
  cfg2.danmaku.minIntervalSec = 3600;
  brain.refreshConfig(cfg2);
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, 1);
  assert.equal(danmaku.length, 2);
  brain.stop();
});

test('change 事件 2 秒内同路径合并为一条描述', async () => {
  const { brain, generator } = makeEnv();
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { generator.textCalls++; lastUser = user; return '["x"]'; };
  for (let i = 0; i < 3; i++) brain.pushEntry(entry('change'));
  brain.flushNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1);
  assert.equal((lastUser.match(/用户修改了/g) || []).length, 1); // 3 条合并成 1 条
  brain.stop();
});

test('生成失败：状态置错、报错给 reporter、不产出弹幕', async () => {
  const { brain, danmaku, reporter } = makeEnv();
  const orig = brain.generator.chatCompletion;
  brain.generator.chatCompletion = async () => { throw new Error('测试错误'); };
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reporter.errors.length, 1);
  assert.equal(reporter.errors[0].message, '测试错误');
  assert.equal(danmaku.length, 0);
  assert.equal(brain.getStatus().error.source, 'text');
  brain.generator.chatCompletion = orig;
  brain.stop();
});

test('恢复：retryNow 成功后清除错误并通知', async () => {
  const { brain, reporter } = makeEnv();
  brain.generator.chatCompletion = async () => { throw new Error('先挂一下'); };
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(brain.getStatus().error);
  brain.generator.chatCompletion = async () => '通';
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(brain.getStatus().error, null);
  assert.ok(reporter.recovered.includes('text'));
  brain.stop();
});

test('本地模式：不走 API，弹幕带【本地】前缀', async () => {
  const { brain, danmaku, generator } = makeEnv();
  brain.setLocalMode(true);
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0);
  assert.equal(danmaku.length, 1);
  assert.ok(danmaku[0].text.startsWith('【本地】'));
  assert.equal(danmaku[0].meta.source, 'local');
  brain.stop();
});

test('暂停：pushEntry 不生效', async () => {
  const { brain, generator } = makeEnv();
  brain.pause();
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  brain.flushNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0);
  brain.stop();
});

test('无错误时成功批次不通知恢复', async () => {
  const { brain, reporter } = makeEnv();
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reporter.recovered.length, 0);
  brain.stop();
});

test('错误后成功批次恢复并报告正确来源', async () => {
  const { brain, reporter } = makeEnv();
  // 在途竞态：批次 1 慢请求在途时，批次 2 快速失败置错；批次 1 成功后经 emitParsed→clearError 恢复
  let call = 0;
  brain.generator.chatCompletion = async () => {
    call++;
    if (call === 1) return new Promise((r) => setTimeout(() => r('["恢复啦"]'), 40));
    throw new Error('第二个挂了');
  };
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create')); // 批次 1：慢请求在途
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create')); // 批次 2：快失败置错
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(brain.getStatus().error);
  await new Promise((r) => setTimeout(r, 60)); // 批次 1 成功返回 → 恢复
  assert.equal(brain.getStatus().error, null);
  assert.ok(reporter.recovered.includes('text'));
  brain.stop();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/brain.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/shared/brain.js（完整实现）**

```js
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
    this.retryTimer = setTimeout(() => this.retryNow(), RETRY_MS);
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
      this.emitParsed(raw);
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
      this.emitParsed(raw);
    } catch (err) {
      this.fail('vision', err);
    }
  }

  emitParsed(raw) {
    const lines = parseDanmakuJson(raw);
    if (lines.length === 0) return;
    this.lastEmit = this.clock();
    for (const line of lines) {
      this.onDanmaku(line, { source: 'ai' });
    }
    if (this.state.error) this.clearError();
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
    // 只在实际错误→成功转换时通知恢复，并报告被记住的错误来源
    const src = this.state.error ? this.state.error.source : 'text';
    this.state.error = null;
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
        // 探测窗口内若又发生新错误（并发批次失败），则不误报恢复
        if (!this.state.error) this.reporter?.reportRecovered?.(err.source);
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
```

- [ ] **Step 4: 用上述完整实现覆盖 src/shared/brain.js，运行测试确认通过**

Run: `node --test tests/brain.test.js`
Expected: PASS（8 个用例）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 弹幕大脑（攒批/限速/错误状态/本地模式/自动重试）"
```

---

### Task 8: 演出层 Stage（多屏透明弹幕窗口 + 动画）

**Files:**
- Create: `src/main/stage.js`
- Create: `src/preload/preload.js`（stage 部分）
- Create: `src/renderer/stage/danmaku.html`
- Create: `src/renderer/stage/danmaku.css`
- Create: `src/renderer/stage/danmaku.js`

**Interfaces:**
- Produces:
  - `class Stage`：`constructor({ preloadPath })`；`start()`（枚举显示器建窗口 + 热插拔监听）；`send(text, meta)`；`updateConfig(danmakuCfg)`；`stop()`
  - preload 暴露：`window.api.onDanmaku(cb)`、`window.api.getStageConfig()`、`window.api.onStageConfig(cb)`
  - 渲染层：`show(text, meta)` 分道 + 随机动画

- [ ] **Step 1: 写 src/main/stage.js**

```js
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

class Stage {
  constructor({ preloadPath }) {
    this.preloadPath = preloadPath;
    this.windows = new Map(); // display.id -> BrowserWindow
    this.config = { maxConcurrent: 6, animationsEnabled: true };
  }

  start() {
    for (const display of screen.getAllDisplays()) this.addWindow(display);
    screen.on('display-added', (_e, display) => this.addWindow(display));
    screen.on('display-removed', (_e, display) => this.removeWindow(display));
    screen.on('display-metrics-changed', (_e, display) => this.syncWindow(display));
  }

  addWindow(display) {
    if (this.windows.has(display.id)) return;
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'stage', 'danmaku.html'));
    this.windows.set(display.id, win);
  }

  removeWindow(display) {
    const win = this.windows.get(display.id);
    if (win) { win.destroy(); this.windows.delete(display.id); }
  }

  syncWindow(display) {
    const win = this.windows.get(display.id);
    if (win) {
      win.setBounds({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height });
    }
  }

  send(text, meta = {}) {
    const wins = [...this.windows.values()];
    if (wins.length === 0) return;
    const win = wins[Math.floor(Math.random() * wins.length)];
    win.webContents.send('danmaku', { text, meta });
  }

  updateConfig(danmakuCfg) {
    this.config = { ...this.config, ...danmakuCfg };
    for (const win of this.windows.values()) {
      win.webContents.send('stage-config', this.config);
    }
  }

  stop() {
    screen.removeAllListeners();
    for (const win of this.windows.values()) win.destroy();
    this.windows.clear();
  }
}

module.exports = { Stage };
```

- [ ] **Step 2: 写 src/preload/preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onDanmaku: (cb) => ipcRenderer.on('danmaku', (_e, payload) => cb(payload)),
  getStageConfig: () => ipcRenderer.invoke('stage:getConfig'),
  onStageConfig: (cb) => ipcRenderer.on('stage-config', (_e, cfg) => cb(cfg)),
});
```

- [ ] **Step 3: 写渲染层三件套**

`src/renderer/stage/danmaku.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="danmaku.css" />
</head>
<body>
  <div id="lanes"></div>
  <script src="danmaku.js"></script>
</body>
</html>
```

`src/renderer/stage/danmaku.css`:
```css
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
#lanes { position: absolute; inset: 0; }
.lane { position: absolute; left: 0; right: 0; height: 72px; }
.danmaku {
  position: absolute;
  white-space: nowrap;
  font-family: "Microsoft YaHei", sans-serif;
  font-weight: bold;
  text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.8);
  user-select: none;
  pointer-events: none;
  will-change: transform;
}
@keyframes fly {
  from { transform: translateX(100vw); }
  to { transform: translateX(-110%); }
}
@keyframes drop {
  from { transform: translateY(-20vh); }
  to { transform: translateY(90vh); }
}
@keyframes pop {
  0% { transform: scale(0.2); opacity: 0; }
  30% { transform: scale(1.3); opacity: 1; }
  80% { transform: scale(1); opacity: 1; }
  100% { transform: scale(1); opacity: 0; }
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-10px); }
  40% { transform: translateX(10px); }
  60% { transform: translateX(-6px); }
  80% { transform: translateX(6px); }
}
.anim-fly { animation: fly 9s linear forwards; }
.anim-drop { animation: drop 6s ease-in forwards; }
.anim-pop { animation: pop 3s ease-out forwards; }
.anim-shake { animation: shake 1.2s ease-in-out infinite; }
```

`src/renderer/stage/danmaku.js`:
```js
const COLORS = ['#fff', '#ffd700', '#7cfc00', '#00e5ff', '#ff69b4', '#ffa500', '#b388ff', '#ff5252'];
const ANIMS = ['anim-fly', 'anim-drop', 'anim-pop', 'anim-shake'];
let config = { maxConcurrent: 6, animationsEnabled: true };

function buildLanes() {
  const lanesEl = document.getElementById('lanes');
  lanesEl.innerHTML = '';
  config.lanes = [];
  for (let i = 0; i < config.maxConcurrent; i++) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.top = (6 + i * 78) + 'px';
    lanesEl.appendChild(lane);
    config.lanes.push({ el: lane, busy: false });
  }
}

function freeLane() {
  for (const lane of config.lanes) if (!lane.busy) return lane;
  return config.lanes[Math.floor(Math.random() * config.lanes.length)]; // 全忙则随机复用
}

function show(text, meta = {}) {
  if (!config.lanes) buildLanes();
  const lane = freeLane();
  lane.busy = true;
  const el = document.createElement('div');
  el.className = 'danmaku';
  if (config.animationsEnabled) el.classList.add(ANIMS[Math.floor(Math.random() * ANIMS.length)]);
  el.textContent = text;
  el.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];
  el.style.fontSize = (meta.source === 'local' ? 26 : 30 + Math.floor(Math.random() * 10)) + 'px';
  if (!config.animationsEnabled) el.style.left = '20px';
  lane.el.appendChild(el);
  const duration = 9000; // 与 .anim-fly 的 9s 对齐，避免弹幕中途被移除
  setTimeout(() => { el.remove(); lane.busy = false; }, duration);
}

window.api.onStageConfig((cfg) => {
  config = { ...config, ...cfg };
  buildLanes();
});
window.api.getStageConfig().then((cfg) => { config = { ...config, ...cfg }; buildLanes(); }).catch(() => {});
window.api.onDanmaku(({ text, meta }) => show(text, meta));

// 开发辅助：看不到弹幕时在控制台手动试 window.show('测试弹幕')
window.show = show;
```

- [ ] **Step 4: 手动验证**

在 `src/main/main.js` 临时加调试（验证后删除）：
```js
const { Stage } = require('./stage');
const stage = new Stage({ preloadPath: require('node:path').join(__dirname, '..', 'preload', 'preload.js') });
stage.start();
stage.updateConfig({ maxConcurrent: 6, animationsEnabled: true });
setInterval(() => stage.send('【本地】测试弹幕 666 ' + Math.random().toFixed(2).slice(2)), 2000);
```
Run: `npm start`
Expected: 每个显示器上出现透明弹幕窗口，彩色弹幕每 2 秒随机动画飘过；鼠标点击弹幕区域无任何反应（穿透生效）；任务栏无窗口；拔插显示器弹幕窗口跟随（如有条件可测）。

- [ ] **Step 5: 移除调试代码并 Commit**

```bash
git add -A && git commit -m "feat: 演出层（多屏透明弹幕窗口/动画池/分道）"
```

---

### Task 9: 错误上报 ErrorReporter

**Files:**
- Create: `src/main/errorReporter.js`

**Interfaces:**
- Produces:
  - `class ErrorReporter`：`constructor({ notify = defaultNotify, onStatus })`；`reportError(source, err)`（节流 30 秒同类通知）；`reportRecovered(source)`；`getStatus()`；`getErrors()`
  - `sourceLabel(source)` → `'文字模型' | '视觉模型' | '监控' | '截图'`
  - `defaultNotify(title, body)`：用 Electron `Notification` 发系统通知

- [ ] **Step 1: 写 src/main/errorReporter.js**

```js
const { Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const THROTTLE_MS = 30000;
const SOURCE_LABELS = { text: '文字模型', vision: '视觉模型', watch: '监控', screen: '屏幕截图' };

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function defaultNotify(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch { /* 通知失败不阻塞主流程 */ }
}

class ErrorReporter {
  constructor({ notify = defaultNotify, onStatus, logDir = null }) {
    this.notify = notify;
    this.onStatus = onStatus;
    this.logDir = logDir;
    this.lastNotified = new Map();
    this.errors = [];
    this.status = { state: 'running', text: '运行中' };
  }

  reportError(source, err) {
    const message = err?.message || String(err);
    this.errors.push({ source, message, at: new Date().toISOString() });
    if (this.errors.length > 200) this.errors.shift();
    this.log(`[ERROR] [${source}] ${message}`);
    const key = `${source}:${err?.code || message}`;
    const now = Date.now();
    if (now - (this.lastNotified.get(key) || 0) > THROTTLE_MS) {
      this.lastNotified.set(key, now);
      this.notify('BulletChat 弹幕已暂停', `${sourceLabel(source)}出错：${message}`);
    }
    this.setStatus({ state: 'error', text: `${sourceLabel(source)}出错：${message}` });
  }

  reportRecovered(source) {
    this.log(`[INFO] [${source}] 已恢复`);
    this.notify('BulletChat 弹幕已恢复', `${sourceLabel(source)}恢复正常`);
    this.setStatus({ state: 'running', text: '运行中' });
  }

  setStatus(status) {
    this.status = status;
    this.onStatus?.(status);
  }

  getStatus() { return this.status; }
  getErrors() { return [...this.errors]; }

  log(line) {
    if (!this.logDir) return;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* 日志失败忽略 */ }
  }
}

module.exports = { ErrorReporter, sourceLabel, defaultNotify };
```

- [ ] **Step 2: 手动验证（并入 Task 11 端到端验证时一并做）**

无独立验证；验收标准见 Task 11 Step 5（故意填错 key → 系统通知 + 状态 error + 弹幕暂停；改对后 60 秒内或保存配置后恢复）。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: 错误上报（系统通知/状态/节流/日志）"
```

---

### Task 10: 设置窗口 + IPC（表单/测试连接/隐私遮罩绘制）

**Files:**
- Create: `src/main/settingsWindow.js`
- Modify: `src/preload/preload.js`
- Create: `src/renderer/settings/settings.html`
- Create: `src/renderer/settings/settings.css`
- Create: `src/renderer/settings/settings.js`

**Interfaces:**
- Consumes: `loadConfig()/saveConfig()`（Task 2）、`testTextConnection/testVisionConnection`（Task 6）
- Produces:
  - `createSettingsWindow({ preloadPath })` → 单例窗口
  - preload 新增：`getConfig()`、`saveConfig(cfg)`、`testText()`、`testVision()`、`getStatus()`、`getDisplays()`、`getDisplayPreview(displayId)`、`onStatus(cb)`
  - IPC 处理器注册：`settings:getConfig` / `settings:saveConfig` / `settings:testText` / `settings:testVision` / `settings:getStatus` / `settings:getDisplays` / `settings:getDisplayPreview`（全部注册在 `registerSettingsIpc({ getConfig, saveConfig, onConfigSaved })` 中，供 main.js 装配）

- [ ] **Step 1: 写 src/main/settingsWindow.js**

```js
const { BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('node:path');

let win = null;
let handlers = null;

function createSettingsWindow({ preloadPath }) {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
  win = new BrowserWindow({
    width: 760,
    height: 640,
    title: 'BulletChat 设置',
    resizable: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'settings.html'));
  win.on('closed', () => { win = null; });
  return win;
}

function registerSettingsIpc({ getConfig, saveConfig, onConfigSaved }) {
  handlers = { getConfig, saveConfig, onConfigSaved };
  ipcMain.handle('settings:getConfig', () => handlers.getConfig());
  ipcMain.handle('settings:saveConfig', (_e, cfg) => {
    const saved = handlers.saveConfig(cfg);
    handlers.onConfigSaved(saved);
    return saved;
  });
  ipcMain.handle('settings:getDisplays', () =>
    screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, label: `显示器 ${d.id}` }))
  );
  ipcMain.handle('settings:getDisplayPreview', async (_e, displayId) => {
    // screen.getAllDisplays 与 desktopCapturer sources 顺序一致（主屏在前），按序号对应
    const displays = screen.getAllDisplays();
    const idx = displays.findIndex((d) => String(d.id) === String(displayId));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 640, height: 360 },
    });
    const src = sources[idx] || sources[0];
    return src ? { displayId: src.display_id, dataUrl: src.thumbnail.toDataURL() } : null;
  });
}

module.exports = { createSettingsWindow, registerSettingsIpc };
```

- [ ] **Step 2: 扩充 preload（src/preload/preload.js 追加）**

```js
contextBridge.exposeInMainWorld('settings', {
  getConfig: () => ipcRenderer.invoke('settings:getConfig'),
  saveConfig: (cfg) => ipcRenderer.invoke('settings:saveConfig', cfg),
  testText: (cfg) => ipcRenderer.invoke('settings:testText', cfg),
  testVision: (cfg) => ipcRenderer.invoke('settings:testVision', cfg),
  getStatus: () => ipcRenderer.invoke('settings:getStatus'),
  getDisplays: () => ipcRenderer.invoke('settings:getDisplays'),
  getDisplayPreview: (id) => ipcRenderer.invoke('settings:getDisplayPreview', id),
  onStatus: (cb) => ipcRenderer.on('status-changed', (_e, s) => cb(s)),
});
```

`settings:testText` / `settings:testVision` / `settings:getStatus` 的 handle 在 Task 11 的 main.js 装配时注册（见 Task 11 Step 1）。

- [ ] **Step 3: 写设置界面 HTML/CSS/JS**

`src/renderer/settings/settings.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="settings.css" />
</head>
<body>
  <header>
    <h1>BulletChat 设置</h1>
    <div id="status-bar">状态：加载中…</div>
  </header>

  <section>
    <h2>文字模型（文件弹幕）</h2>
    <label>接口地址 <input id="text-baseUrl" placeholder="https://api.deepseek.com" /></label>
    <label>API Key <input id="text-apiKey" type="password" placeholder="sk-..." /></label>
    <label>模型名 <input id="text-model" placeholder="deepseek-chat" /></label>
    <button id="btn-test-text">测试连接</button>
    <div id="text-test-result"></div>
  </section>

  <section>
    <h2>视觉模型（屏幕弹幕）</h2>
    <label><input id="vision-enabled" type="checkbox" /> 启用屏幕识别</label>
    <label>接口地址 <input id="vision-baseUrl" placeholder="https://..." /></label>
    <label>API Key <input id="vision-apiKey" type="password" placeholder="sk-..." /></label>
    <label>模型名 <input id="vision-model" placeholder="qwen-vl-max" /></label>
    <label>截图间隔（秒） <input id="vision-interval" type="number" min="2" max="60" /></label>
    <button id="btn-test-vision">测试连接</button>
    <div id="vision-test-result"></div>
  </section>

  <section>
    <h2>监控</h2>
    <div id="drives"></div>
    <h3>隐私遮罩（截图发送前涂黑的区域）</h3>
    <select id="mask-display"></select>
    <div id="mask-canvas-wrap"><canvas id="mask-canvas" width="640" height="360"></canvas></div>
    <button id="btn-mask-clear">清空遮罩</button>
  </section>

  <section>
    <h2>弹幕</h2>
    <label>最小间隔（秒） <input id="dm-interval" type="number" min="0" max="300" /></label>
    <label>同屏上限 <input id="dm-max" type="number" min="1" max="12" /></label>
    <label><input id="dm-anim" type="checkbox" /> 动画</label>
    <label><input id="dm-local" type="checkbox" /> 本地模式（不调 API，用内置模板）</label>
    <label>风格池（逗号分隔） <input id="dm-styles" /></label>
  </section>

  <section>
    <h2>系统</h2>
    <label><input id="sys-autostart" type="checkbox" /> 开机自启</label>
  </section>

  <footer>
    <button id="btn-save">保存</button>
    <span id="save-result"></span>
  </footer>

  <script src="settings.js"></script>
</body>
</html>
```

`src/renderer/settings/settings.css`:
```css
body { font-family: "Microsoft YaHei", sans-serif; margin: 16px; background: #1e1e2e; color: #eee; }
h1 { font-size: 18px; margin: 0 0 8px; }
h2 { font-size: 14px; border-bottom: 1px solid #444; padding-bottom: 4px; margin-top: 18px; }
h3 { font-size: 12px; margin: 12px 0 4px; }
section { margin-bottom: 8px; }
label { display: block; margin: 6px 0; font-size: 13px; }
input[type="text"], input[type="password"], input[type="number"] { width: 300px; margin-left: 8px; background: #2a2a3e; color: #eee; border: 1px solid #555; padding: 4px 6px; }
input[type="checkbox"] { margin-right: 6px; }
button { margin: 6px 6px 6px 0; padding: 6px 14px; background: #4a6cf7; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
button:disabled { background: #666; cursor: default; }
#status-bar { font-size: 12px; padding: 4px 8px; border-radius: 4px; display: inline-block; }
#status-bar.ok { background: #1b5e20; }
#status-bar.err { background: #b71c1c; }
.result { font-size: 12px; margin: 4px 0; }
.result.ok { color: #7cfc00; }
.result.err { color: #ff5252; }
#mask-canvas { border: 1px solid #555; background: #111; cursor: crosshair; max-width: 100%; }
footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #444; }
```

`src/renderer/settings/settings.js`:
```js
const $ = (id) => document.getElementById(id);

let config = null;
let maskState = { displayId: null, masks: [], dragging: null, preview: null };

async function load() {
  config = await window.settings.getConfig();
  $('text-baseUrl').value = config.textModel.baseUrl;
  $('text-apiKey').value = config.textModel.apiKey;
  $('text-model').value = config.textModel.model;
  $('vision-enabled').checked = config.visionModel.enabled;
  $('vision-baseUrl').value = config.visionModel.baseUrl;
  $('vision-apiKey').value = config.visionModel.apiKey;
  $('vision-model').value = config.visionModel.model;
  $('vision-interval').value = config.visionModel.captureIntervalSec;
  $('dm-interval').value = config.danmaku.minIntervalSec;
  $('dm-max').value = config.danmaku.maxConcurrent;
  $('dm-anim').checked = config.danmaku.animationsEnabled;
  $('dm-local').checked = config.danmaku.localMode;
  $('dm-styles').value = config.danmaku.styles.join(',');
  $('sys-autostart').checked = config.system.autostart;
  maskState.masks = config.monitor.masks || [];

  const displays = await window.settings.getDisplays();
  const sel = $('mask-display');
  sel.innerHTML = '';
  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.label;
    sel.appendChild(opt);
  }
  if (displays.length) {
    sel.onchange = () => loadMaskPreview(sel.value);
    await loadMaskPreview(sel.value);
  }
}

async function loadMaskPreview(displayId) {
  maskState.dragging = null;
  const preview = await window.settings.getDisplayPreview(displayId);
  if (!preview) return;
  maskState.displayId = preview.displayId; // 以 desktopCapturer 的 display_id 为准（与 ScreenWatcher 遮罩过滤一致）
  const img = new Image();
  preview.image = img; // 先挂引用，onload 后再绘制
  maskState.preview = preview;
  img.onload = redrawMasks;
  img.src = preview.dataUrl;
}

function redrawMasks() {
  const canvas = $('mask-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (maskState.preview) {
    ctx.drawImage(maskState.preview.image, 0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  for (const m of maskState.masks.filter((m) => String(m.displayId) === String(maskState.displayId))) {
    ctx.fillRect(m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height);
  }
  if (maskState.dragging) {
    const d = maskState.dragging;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    ctx.fillRect(x * canvas.width, y * canvas.height, Math.abs(d.x1 - d.x0) * canvas.width, Math.abs(d.y1 - d.y0) * canvas.height);
  }
}

function norm(p) {
  const rect = $('mask-canvas').getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (p.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (p.clientY - rect.top) / rect.height)) };
}

$('mask-canvas').addEventListener('mousedown', (e) => {
  const p = norm(e);
  maskState.dragging = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});
$('mask-canvas').addEventListener('mousemove', (e) => {
  if (!maskState.dragging) return;
  const p = norm(e);
  maskState.dragging.x1 = p.x;
  maskState.dragging.y1 = p.y;
  redrawMasks();
});
$('mask-canvas').addEventListener('mouseup', () => {
  if (!maskState.dragging) return;
  const d = maskState.dragging;
  if (Math.abs(d.x1 - d.x0) > 0.01 && Math.abs(d.y1 - d.y0) > 0.01) {
    maskState.masks.push({
      displayId: maskState.displayId,
      x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
      w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
    });
  }
  maskState.dragging = null;
  redrawMasks();
});
$('btn-mask-clear').onclick = () => {
  maskState.masks = maskState.masks.filter((m) => String(m.displayId) !== String(maskState.displayId));
  redrawMasks();
};

function showResult(elId, ok, text) {
  const el = $(elId);
  el.textContent = text;
  el.className = 'result ' + (ok ? 'ok' : 'err');
}

// 从表单收集当前值（测试按钮测的是表单里填的，不是已保存的）
function formTextModel() {
  return {
    baseUrl: $('text-baseUrl').value.trim(),
    apiKey: $('text-apiKey').value.trim(),
    model: $('text-model').value.trim(),
  };
}

function formVisionModel() {
  return {
    enabled: $('vision-enabled').checked,
    baseUrl: $('vision-baseUrl').value.trim(),
    apiKey: $('vision-apiKey').value.trim(),
    model: $('vision-model').value.trim(),
    captureIntervalSec: Math.max(2, Number($('vision-interval').value) || 4),
  };
}

$('btn-test-text').onclick = async () => {
  const btn = $('btn-test-text');
  btn.disabled = true;
  showResult('text-test-result', true, '测试中…');
  const r = await window.settings.testText(formTextModel());
  showResult('text-test-result', r.ok, (r.ok ? '✓ ' : '✗ ') + r.message);
  btn.disabled = false;
};

$('btn-test-vision').onclick = async () => {
  const btn = $('btn-test-vision');
  btn.disabled = true;
  showResult('vision-test-result', true, '测试中…');
  const r = await window.settings.testVision(formVisionModel());
  showResult('vision-test-result', r.ok, (r.ok ? '✓ ' : '✗ ') + r.message);
  btn.disabled = false;
};

$('btn-save').onclick = async () => {
  config.textModel.baseUrl = $('text-baseUrl').value.trim();
  config.textModel.apiKey = $('text-apiKey').value.trim();
  config.textModel.model = $('text-model').value.trim();
  config.visionModel.enabled = $('vision-enabled').checked;
  config.visionModel.baseUrl = $('vision-baseUrl').value.trim();
  config.visionModel.apiKey = $('vision-apiKey').value.trim();
  config.visionModel.model = $('vision-model').value.trim();
  config.visionModel.captureIntervalSec = Math.max(2, Number($('vision-interval').value) || 4);
  config.danmaku.minIntervalSec = Math.max(0, Number($('dm-interval').value) || 10);
  config.danmaku.maxConcurrent = Math.min(12, Math.max(1, Number($('dm-max').value) || 6));
  config.danmaku.animationsEnabled = $('dm-anim').checked;
  config.danmaku.localMode = $('dm-local').checked;
  config.danmaku.styles = $('dm-styles').value.split(',').map((s) => s.trim()).filter(Boolean);
  config.system.autostart = $('sys-autostart').checked;
  config.monitor.masks = maskState.masks;
  await window.settings.saveConfig(config);
  $('save-result').textContent = '已保存 ✓';
  setTimeout(() => { $('save-result').textContent = ''; }, 2000);
};

window.settings.onStatus((s) => {
  const bar = $('status-bar');
  bar.className = s.state === 'error' ? 'err' : 'ok';
  bar.textContent = `状态：${s.text}`;
});

load();
```

- [ ] **Step 4: 手动验证（需要先有 Task 11 的 IPC 装配；此步与 Task 11 验证合并）**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 设置窗口（表单/测试连接/隐私遮罩绘制）"
```

---

### Task 11: 主装配 main.js（端到端：文件事件 → 弹幕）

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/tray.js`
- Modify: `src/preload/preload.js`（补 `settings:testText` 等剩余 IPC 由本任务注册，preload 已在 Task 10 写好）

**Interfaces:**
- Consumes: FileWatcher、Brain、Stage、ErrorReporter、config、generator、templates、settingsWindow（全部已有）
- Produces: 端到端可运行程序；`applyConfig(cfg)` 装配逻辑（保存→重载→应用→立即重试→自启→Stage 配置同步）

- [ ] **Step 1: 重写 src/main/main.js**

```js
const { app, ipcMain, Notification, BrowserWindow } = require('electron');
const path = require('node:path');
const { createTray } = require('./tray');
const { loadConfig, saveConfig } = require('./config');
const { FileWatcher, listFixedDrives } = require('./fileWatcher');
const { Brain } = require('../shared/brain');
const { makeNoiseFilter } = require('../shared/noiseFilter');
const templates = require('../shared/templates');
const { testTextConnection, testVisionConnection } = require('./generator');
const { Stage } = require('./stage');
const { ErrorReporter, sourceLabel } = require('./errorReporter');
const { createSettingsWindow, registerSettingsIpc } = require('./settingsWindow');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

let brain = null;
let watcher = null;
let stage = null;
let reporter = null;
let config = null;
let paused = false;

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch { /* 忽略 */ }
}

function applyConfig(saved, { silent = false } = {}) {
  config = saved;
  if (brain) brain.refreshConfig(config);
  // 开机自启
  app.setLoginItemSettings({ openAtLogin: !!config.system.autostart });
  // 重启文件监控（盘符可能变化）
  if (watcher) watcher.stop();
  watcher = new FileWatcher({
    drives: config.monitor.drives.length ? config.monitor.drives : listFixedDrives(),
    filter: makeNoiseFilter(config.monitor.noiseRules),
    onEvent: (entry) => brain?.pushEntry(entry),
    onError: (err) => reporter?.reportError('watch', err),
  });
  watcher.start();
  // 同步演出层配置
  if (stage) stage.updateConfig(config.danmaku);
  // 配置保存后立即重试
  if (brain && brain.getStatus().error) brain.retryNow();
  if (!silent) notify('BulletChat', '配置已应用');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二实例：直接退出（app.exit 在 ready 事件前也生效，quit() 在 Windows 上可能无效）
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 已有实例在运行，保持其存活，不执行任何操作
  });

  app.whenReady().then(() => {
    config = loadConfig();
    // 状态广播：以 ErrorReporter 的 {state, text} 形状为准（设置窗口状态条消费）
    const broadcastStatus = (s) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('status-changed', s);
    };
    reporter = new ErrorReporter({ notify, logDir: path.join(app.getPath('userData'), 'logs'), onStatus: broadcastStatus });

    brain = new Brain({
      config,
      generator: require('./generator'),
      templates,
      reporter,
      onDanmaku: (text, meta) => stage?.send(text, meta),
    });

    stage = new Stage({ preloadPath: PRELOAD });
    stage.start();
    stage.updateConfig(config.danmaku);

    registerSettingsIpc({
      getConfig: () => config,
      saveConfig: (cfg) => { saveConfig(cfg); config = cfg; return config; },
      onConfigSaved: applyConfig,
    });
    ipcMain.handle('settings:testText', (_e, cfg) => testTextConnection(cfg || config.textModel));
    ipcMain.handle('settings:testVision', (_e, cfg) => testVisionConnection(cfg || config.visionModel));
    ipcMain.handle('settings:getStatus', () => reporter.getStatus());
    ipcMain.handle('stage:getConfig', () => config.danmaku);

    applyConfig(config, { silent: true }); // 初次装配（含自启与监控启动），不弹通知
    brain.start();

    createTray({
      getState: () => ({ paused, localMode: brain.getStatus().localMode }),
      onQuit: () => app.quit(),
      onOpenSettings: () => createSettingsWindow({ preloadPath: PRELOAD }),
      onTogglePause: () => {
        paused = !paused;
        if (paused) brain.pause();
        else brain.resume();
        notify('BulletChat', paused ? '弹幕已暂停' : '弹幕已恢复');
      },
      onToggleLocalMode: () => {
        brain.setLocalMode(!brain.getStatus().localMode);
        notify('BulletChat', brain.getStatus().localMode ? '已切换到本地模式（弹幕将带【本地】标记）' : '已退出本地模式');
      },
    });
  });

  app.on('window-all-closed', () => { /* 常驻托盘 */ });
}
```

- [ ] **Step 2: 更新托盘 src/main/tray.js（每次操作后重建菜单，保证文案与状态一致）**

```js
const { Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

function buildMenu({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode, paused = false, localMode = false }) {
  return Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: paused ? '继续弹幕' : '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: localMode, click: onToggleLocalMode },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
}

function createTray(opts) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('BulletChat 桌面弹幕直播');
  const rebuild = () => {
    const state = opts.getState ? opts.getState() : {};
    tray.setContextMenu(buildMenu({
      onQuit: opts.onQuit,
      onOpenSettings: opts.onOpenSettings,
      onTogglePause: () => { opts.onTogglePause(); rebuild(); },
      onToggleLocalMode: () => { opts.onToggleLocalMode(); rebuild(); },
      paused: !!state.paused,
      localMode: !!state.localMode,
    }));
  };
  rebuild();
  return tray;
}

module.exports = { createTray, buildMenu };
```

- [ ] **Step 3: 端到端手动验证**

Run: `npm start`
步骤与期望：
1. 设置 → 勾选「本地模式」→ 保存
2. 在桌面新建一个文件夹 → 数秒内屏幕上飘过「【本地】…」弹幕
3. 新建文件、删除文件、改名 → 都有对应模板弹幕
4. 托盘「暂停弹幕」→ 再操作文件，无弹幕；「继续弹幕」→ 恢复
5. 设置里把文字 API Key 填成错误值（非本地模式）→ 保存 → 造一个文件事件 → 收到系统通知"文字模型出错" + 状态栏变红 + 弹幕暂停
6. 把 Key 改对 → 保存 → 通知"弹幕已恢复"，造事件 → 弹幕恢复（AI 生成）
7. 打开设置窗口测试连接 → ✓/✗ 显示正确
8. 勾选开机自启 → 注册表写入（`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` 出现 BulletChat 条目，用 `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 验证）

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: 主装配（文件事件端到端/托盘全功能/配置热应用/自启）"
```

---

### Task 12: 屏幕事件源 ScreenWatcher（截屏 + 像素差异 + 遮罩 + 视觉弹幕）

**Files:**
- Create: `src/main/screenWatcher.js`
- Create: `src/main/imageProcessor.js`
- Create: `src/renderer/processor/processor.html`
- Create: `src/renderer/processor/processor.js`
- Modify: `src/main/main.js`（装配 ScreenWatcher + `settings:testVision` 不变）
- Test: `tests/screenWatcher.test.js`（纯函数部分：`pixelDiffRatio`）

**Interfaces:**
- Produces:
  - `pixelDiffRatio(a, b)` → 0~1（BGRA buffer 采样比对，阈值默认 `DIFF_THRESHOLD = 0.002`）
  - `class ScreenWatcher`：`constructor({ config, getMasks, onEntry, onError, processor })`；`start()` / `stop()`
  - `class ImageProcessor`：`constructor({ preloadPath, app })`；`process(dataUrl, masks)` → `Promise<string>`（遮罩涂黑 + JPEG 0.8 压缩的 dataURL）；内部用隐藏 BrowserWindow + canvas
  - 屏幕条目：`{ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl }`

- [ ] **Step 1: 写失败的测试 tests/screenWatcher.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pixelDiffRatio } = require('../src/main/screenWatcher');

function makeBuf(w, h, fill) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = fill;
  return buf;
}

test('相同画面差异为 0', () => {
  const a = makeBuf(100, 100, 128);
  assert.equal(pixelDiffRatio(a, Buffer.from(a)), 0);
});

test('完全不同画面差异为 1', () => {
  const a = makeBuf(100, 100, 0);
  const b = makeBuf(100, 100, 255);
  assert.equal(pixelDiffRatio(a, b), 1);
});

test('尺寸不同视为 1（必然变化）', () => {
  assert.equal(pixelDiffRatio(makeBuf(10, 10, 0), makeBuf(20, 20, 0)), 1);
});

test('少数像素变化低于阈值', () => {
  const a = makeBuf(100, 100, 0);
  const b = Buffer.from(a);
  // SAMPLE_STEP=64，采样点索引为 0, 256, 512...；改第一个采样点（i=256 的 BGR 三通道）
  b[256] = 200;
  b[257] = 200;
  b[258] = 200;
  assert.ok(pixelDiffRatio(a, b) > 0);
  assert.ok(pixelDiffRatio(a, b) < 0.01);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/screenWatcher.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/main/screenWatcher.js**

```js
const { desktopCapturer } = require('electron');

const DIFF_THRESHOLD = 0.002;   // 画面变化率阈值
const SAMPLE_STEP = 64;         // 每 64 像素采样一次
const PREVIEW_W = 480;
const PREVIEW_H = 270;
const FULL_W = 1280;

function pixelDiffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let diff = 0;
  let n = 0;
  for (let i = 0; i + 2 < a.length; i += 4 * SAMPLE_STEP) {
    n++;
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 60) diff++;
  }
  return n === 0 ? 1 : diff / n;
}

class ScreenWatcher {
  constructor({ config, getMasks, onEntry, onError, processor }) {
    this.config = config;
    this.getMasks = getMasks;
    this.onEntry = onEntry;
    this.onError = onError;
    this.processor = processor;
    this.timer = null;
    this.last = new Map(); // display_id -> { bits }
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.visionModel.captureIntervalSec * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.last.clear();
  }

  async tick() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: PREVIEW_W, height: PREVIEW_H },
      });
      for (const src of sources) {
        const bits = src.thumbnail.toBitmap();
        const prev = this.last.get(src.display_id);
        if (!prev) {
          this.last.set(src.display_id, { bits });
          continue;
        }
        const diff = pixelDiffRatio(prev.bits, bits);
        this.last.set(src.display_id, { bits });
        if (diff < DIFF_THRESHOLD) continue;

        // 有变化：抓大图 → 应用遮罩 → 交给 Brain
        const full = await this.captureFull(src.display_id);
        const masks = (this.getMasks() || []).filter((m) => String(m.displayId) === String(src.display_id));
        const dataUrl = await this.processor.process(full, masks);
        this.onEntry({
          source: 'screen',
          type: 'screen',
          name: '屏幕变化',
          path: '',
          drive: '',
          imageDataUrl: dataUrl,
        });
      }
    } catch (err) {
      this.onError?.(new Error(`屏幕识别失败：${err.message}`));
    }
  }

  async captureFull(displayId) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: FULL_W, height: Math.round(FULL_W * 9 / 16) },
    });
    const src = sources.find((s) => s.display_id === displayId) || sources[0];
    return src.thumbnail.toDataURL();
  }
}

module.exports = { ScreenWatcher, pixelDiffRatio, DIFF_THRESHOLD };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/screenWatcher.test.js`
Expected: PASS

- [ ] **Step 5: 写图像处理器（隐藏窗口 + canvas）**

`src/main/imageProcessor.js`:
```js
const { BrowserWindow } = require('electron');
const path = require('node:path');

class ImageProcessor {
  constructor({ preloadPath }) {
    this.preloadPath = preloadPath;
    this.win = null;
    this.pending = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
  }

  async init() {
    if (this.win && !this.win.isDestroyed()) return;
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { preload: this.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    await this.win.loadFile(path.join(__dirname, '..', 'renderer', 'processor', 'processor.html'));
  }

  async process(dataUrl, masks) {
    if (!this.win || this.win.isDestroyed()) await this.init();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.win.webContents.send('process:image', { id, dataUrl, masks });
    });
  }

  resolve(id, result) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.resolve(result); }
  }

  reject(id, err) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.reject(err); }
  }
}

module.exports = { ImageProcessor };
```

`src/preload/preload.js` 追加：
```js
contextBridge.exposeInMainWorld('processor', {
  onProcess: (cb) => ipcRenderer.on('process:image', (_e, payload) => cb(payload)),
  resolveProcess: (id, dataUrl) => ipcRenderer.send('process:resolve', { id, dataUrl }),
  errorProcess: (id, message) => ipcRenderer.send('process:error', { id, message }),
});
```

`src/renderer/processor/processor.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /></head>
<body>
  <canvas id="cv" width="1280" height="720" style="display:none"></canvas>
  <script src="processor.js"></script>
</body>
</html>
```

`src/renderer/processor/processor.js`（渲染层无 nodeIntegration，必须走 preload 暴露的 API）:
```js
window.processor.onProcess(async (payload) => {
  const { id, dataUrl, masks } = payload;
  try {
    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    const cv = document.getElementById('cv');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = '#000000';
    for (const m of masks || []) {
      ctx.fillRect(m.x * cv.width, m.y * cv.height, m.w * cv.width, m.h * cv.height);
    }
    window.processor.resolveProcess(id, cv.toDataURL('image/jpeg', 0.8));
  } catch (err) {
    window.processor.errorProcess(id, String(err));
  }
});
```

`src/preload/preload.js` 追加 `onProcessError` 并在 main.js 里监听 `process:resolve` / `process:error` 回掉（Step 6 中与装配一起做）。

- [ ] **Step 6: 装配到 main.js（追加）**

```js
// 顶部 require
const { ScreenWatcher } = require('./screenWatcher');
const { ImageProcessor } = require('./imageProcessor');

// 模块作用域（与 watcher/stage 并列，applyConfig 定义之前）——applyConfig 会调用它，
// 若声明在 whenReady 回调内会因作用域不可见而抛 ReferenceError
let screenWatcher = null;
function applyScreenWatcher() {
  if (screenWatcher) screenWatcher.stop();
  if (!config.visionModel.enabled) return;
  if (!config.visionModel.baseUrl || !config.visionModel.apiKey || !config.visionModel.model) {
    // 未配置完整：普通提示，不进入错误状态（文件弹幕照常）
    notify('BulletChat', '视觉模型未配置完整，屏幕弹幕未启用（文件弹幕不受影响）');
    return;
  }
  screenWatcher = new ScreenWatcher({
    config,
    getMasks: () => config.monitor.masks,
    onEntry: (entry) => brain?.pushEntry(entry),
    onError: (err) => reporter?.reportError('screen', err),
    processor,
  });
  screenWatcher.start();
}
```

whenReady 内、brain 创建后追加（processor 初始化与 IPC 监听注册一次）：
```js
const processor = new ImageProcessor({ preloadPath: PRELOAD });
processor.init().catch((err) => reporter.reportError('screen', err));
ipcMain.on('process:resolve', (_e, { id, dataUrl }) => processor.resolve(id, dataUrl));
ipcMain.on('process:error', (_e, { id, message }) => processor.reject(id, new Error(message)));
```
（`processor` 变量在 whenReady 内创建后，模块级 applyScreenWatcher 引用它——把 `let processor = null;` 声明在模块级、whenReady 内赋值，保证引用合法。）

- [ ] **Step 7: 手动验证（需要视觉模型 key）**

1. 设置中填好视觉模型（可用 opencode-go 的视觉模型）→ 保存
2. 打开浏览器随便操作 → 数秒内弹出屏幕相关弹幕（AI 生成，内容与屏幕内容相关）
3. 设置中画一个遮罩盖住屏幕一角 → 视觉弹幕不再"看见"该区域内容（用视觉模型描述来验证）
4. 停用视觉模型 → 文件弹幕不受影响
5. 断网后 → 通知"网络错误"、屏幕弹幕暂停；恢复网络 60 秒内自动恢复

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: 屏幕事件源（截屏/像素差异/隐私遮罩/视觉弹幕）"
```

---

### Task 13: Demo 模式 + 全量测试 + README + 打磨

**Files:**
- Create: `src/main/demoMode.js`
- Test: `tests/demoMode.test.js`
- Modify: `src/main/main.js`（托盘 Demo 开关）
- Create: `README.md`

**Interfaces:**
- Produces:
  - `makeDemoEntry(rng = Math.random)` → 假文件事件
  - `startDemo({ onEntry, intervalMs = 4000, rng })` → `setInterval` 句柄；`stopDemo(handle)`

- [ ] **Step 1: 写失败的测试 tests/demoMode.test.js**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDemoEntry } = require('../src/main/demoMode');

test('20 次采样覆盖全部 5 种事件类型', () => {
  const types = new Set();
  for (let i = 0; i < 20; i++) types.add(makeDemoEntry(() => (i * 7) % 10 / 10).type);
  for (const t of ['create', 'delete', 'rename', 'move']) assert.ok(types.has(t));
  // change 事件不产生（demo 聚焦用户可见操作）
});

test('条目字段完整', () => {
  const e = makeDemoEntry(() => 0.5);
  assert.equal(e.source, 'file');
  assert.ok(typeof e.name === 'string' && e.name.length > 0);
  assert.ok(e.path.startsWith(e.drive + '\\'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/demoMode.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 写 src/main/demoMode.js**

```js
const NAMES = ['新建文件夹', '报告.pdf', '老板.zip', '游戏.rar', '会议记录.docx', '期末论文', '密码本.txt', '表情包合集'];
const DRIVES = ['C:', 'D:', 'E:', '桌面'];

const TYPE_MAP = { create_folder: 'create', create_file: 'create', delete: 'delete', rename: 'rename', move: 'move' };
const TYPE_KEYS = Object.keys(TYPE_MAP);

function makeDemoEntry(rng = Math.random) {
  const typeKey = TYPE_KEYS[Math.floor(rng() * TYPE_KEYS.length)];
  const name = NAMES[Math.floor(rng() * NAMES.length)];
  const drive = DRIVES[Math.floor(rng() * DRIVES.length)];
  return {
    source: 'file',
    type: TYPE_MAP[typeKey],
    name,
    path: `${drive}\\${name}`,
    drive: drive === '桌面' ? '' : drive,
    isDir: typeKey === 'create_folder',
  };
}

function startDemo({ onEntry, intervalMs = 4000, rng = Math.random }) {
  return setInterval(() => onEntry(makeDemoEntry(rng)), intervalMs);
}

function stopDemo(handle) {
  clearInterval(handle);
}

module.exports = { makeDemoEntry, startDemo, stopDemo };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/demoMode.test.js`
Expected: PASS

- [ ] **Step 5: main.js 接入 Demo 开关（托盘菜单追加 + 装配）**

`src/main/tray.js` 的 `buildMenu` 在「本地模式」下方追加一行，并给 `createTray` 的 rebuild 透传：
```js
function buildMenu({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode, onToggleDemo, paused = false, localMode = false, demo = false }) {
  return Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: paused ? '继续弹幕' : '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: localMode, click: onToggleLocalMode },
    { label: '演示模式（模拟事件）', type: 'checkbox', checked: demo, click: onToggleDemo },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
}
```
rebuild 中对应追加：
```js
      onToggleDemo: () => { opts.onToggleDemo(); rebuild(); },
      demo: !!state.demo,
```

`src/main/main.js`：
- 顶部 require 追加：`const { startDemo, stopDemo } = require('./demoMode');`
- 模块级追加：`let demoHandle = null;`
- whenReady 内 createTray 的 opts 追加：
```js
      getState: () => ({ paused, localMode: brain.getStatus().localMode, demo: !!demoHandle }),
      onToggleDemo: () => {
        if (demoHandle) {
          stopDemo(demoHandle);
          demoHandle = null;
          notify('BulletChat', '演示模式已关闭');
        } else {
          demoHandle = startDemo({ onEntry: (e) => brain?.pushEntry(e) });
          notify('BulletChat', '演示模式已开启（模拟事件流）');
        }
      },
```

- [ ] **Step 6: 写 README.md**

```markdown
# BulletChat 桌面弹幕直播

像直播观众一样盯着你的电脑：文件操作、屏幕变化都会飘出 AI 生成的弹幕吐槽。

## 运行

```bash
npm install
npm start
```

## 使用

1. 托盘图标 → 打开设置
2. 填文字模型（默认 DeepSeek 官方地址），点「测试连接」
3. （可选）填视觉模型（OpenAI 兼容 + 视觉能力，如 opencode-go 中转），勾选启用，可绘制隐私遮罩
4. 保存 → 正常操作电脑，弹幕开飘

没有 API Key 也能玩：设置里勾选「本地模式」，用内置模板弹。

## 隐私

- API Key 仅存本机（系统加密），只发送给你填写的接口地址
- 屏幕识别会把截图发送给你配置的视觉模型 API；可用「隐私遮罩」涂黑敏感区域
- 可随时在托盘暂停屏幕识别或整个弹幕

## 错误处理

出错即提示：系统通知 + 设置页状态条 + 日志（`userData/logs/app.log`），弹幕暂停，60 秒自动重试。
```

- [ ] **Step 7: 全量测试 + 全流程回归**

Run: `node --test tests/`
Expected: 全部 PASS
再按 Task 11 Step 3 与 Task 12 Step 7 的手动清单全流程回归一遍。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: Demo 模式/README/全量回归"
```

---

## Self-Review 结果

- **规格覆盖**：规格 §4.1（FileWatcher=Task 4）、§4.2（ScreenWatcher=Task 12）、§4.3（Brain=Task 7，模板/风格=Task 5，降噪=Task 3）、§4.4（Stage=Task 8）、§4.5（设置=Task 10，测试连接=Task 6+10）、§4.6（配置=Task 2）、§4.7/4.8（托盘=Task 1+11，自启=Task 11）、§5（错误提示=Task 9+11）、§6（测试：单元测试贯穿，Demo=Task 13，手动清单=Task 11/12/13）。**无遗漏。**
- **占位符扫描**：无 TBD/TODO；所有步骤含完整代码。
- **类型一致性**：`pushEntry`/`flushNow`/`retryNow`/`refreshConfig`/`setLocalMode`/`getStatus` 在各任务间签名一致；`pixelDiffRatio` 在测试与实现一致；`templateFor(type, rng)` 与 `fillTemplate(tpl, entry)` 在 Task 5/7 一致；preload 暴露的 IPC 通道名（`settings:getConfig` 等、`stage:getConfig`、`process:image`）与 main 注册的 handle/on 一致。
