# 打包支持（exe / dmg）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 BulletChat 增加 electron-builder 打包：Windows 出 NSIS 安装包（exe），macOS 出 dmg。

**Architecture:** 用 electron-builder（devDependency + package.json `build` 字段）配置双平台目标；占位应用图标由纯 Node 脚本（手写 PNG 编码，零依赖）生成 `assets/icon.png`，electron-builder 构建时自动转 .ico/.icns；main.js 固定 userData 路径保证打包前后配置目录一致。

**Tech Stack:** electron-builder ^26、Node 22（本机已确认）、node:test 测试框架（已有）

## Global Constraints

- 工具固定 electron-builder（^26.x），不用 electron-forge / electron-packager
- appId 固定 `com.bulletchat.app`，productName 固定 `BulletChat`
- 图标固定 `assets/icon.png`（512×512 PNG），由 `tools/generate-icon.js` 生成；`assets/icon.png` 提交进 git
- macOS 不签名（`mac.identity: null`）；Windows 不做任何签名
- dmg 只能在 macOS 构建、exe 只能在 Windows 构建（平台限制，脚本分开）
- `dist/` 已在 .gitignore 中，构建产物不提交
- 不引入任何运行时/构建期额外依赖（electron-builder 除外）；图标生成必须纯 Node 零依赖
- `npm test` 必须保持全绿

---

### Task 1: 图标生成脚本 + 测试 + 产出 icon.png

**Files:**
- Create: `tools/generate-icon.js`
- Test: `tests/generate-icon.test.js`
- Produce: `assets/icon.png`（生成后提交）

**Interfaces:**
- Produces: `drawIcon(size = 512) → Buffer`（合法 PNG 字节）、`SIZE = 512`（模块导出）
- Consumes: 仅 node 内置模块（`node:zlib`/`node:fs`/`node:path`）

- [ ] **Step 1: 写失败测试** `tests/generate-icon.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { drawIcon, SIZE } = require('../tools/generate-icon');

function chunks(buf) {
  const out = [];
  let off = 8; // 跳过 PNG 签名
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    out.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

test('生成的 PNG 结构合法：签名 + IHDR 尺寸 + IDAT 可解压', () => {
  const buf = drawIcon(SIZE);
  assert.deepStrictEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 签名'
  );
  const parts = chunks(buf);
  assert.deepStrictEqual(parts.map((p) => p.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = parts[0].data;
  assert.strictEqual(ihdr.readUInt32BE(0), SIZE, '宽度');
  assert.strictEqual(ihdr.readUInt32BE(4), SIZE, '高度');
  assert.strictEqual(ihdr[8], 8, '位深');
  assert.strictEqual(ihdr[9], 6, '色彩类型 RGBA');
  const raw = zlib.inflateSync(parts[1].data);
  assert.strictEqual(raw.length, SIZE * (SIZE * 4 + 1), '每行 filter 字节 + RGBA 像素');
  // 非空白：中心像素应落在白色气泡上（#f5f6fa 的 R 通道 = 245）
  const cx = Math.floor(SIZE / 2);
  const idx = cx * (SIZE * 4 + 1) + 1 + cx * 4;
  assert.strictEqual(raw[idx], 245);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/generate-icon.test.js`
Expected: FAIL，`MODULE_NOT_FOUND: Cannot find module '../tools/generate-icon'`

- [ ] **Step 3: 实现生成脚本** `tools/generate-icon.js`（完整代码）

```js
// 生成应用图标（占位）：纯 Node 手写 PNG 编码，零依赖。
// 画面：深色圆角底 + 白色气泡（带小尾巴）+ 三条彩色弹幕条
// 用法：node tools/generate-icon.js [输出路径]（默认 assets/icon.png）
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 色彩类型：RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行前导 filter=0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 图形绘制 ----------
// 圆角矩形包含测试（SDF 思路：夹到内矩形后测角距离）
function roundedRectContains(x, y, rx, ry, rw, rh, r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 点在三角形内（符号法）
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

const BG = hexToRgb('#1e1e2e');    // 深色底
const BUBBLE = hexToRgb('#f5f6fa'); // 白色气泡
const BAR1 = hexToRgb('#ff6b6b');  // 弹幕条（红）
const BAR2 = hexToRgb('#ffd93d');  // 弹幕条（黄）
const BAR3 = hexToRgb('#4dabf7');  // 弹幕条（蓝）

function drawIcon(size = SIZE) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / SIZE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s;
      const py = (y + 0.5) / s;
      let color = null;
      if (roundedRectContains(px, py, 16, 16, 480, 480, 96)) {
        color = BG;
        if (roundedRectContains(px, py, 80, 120, 352, 248, 44)) color = BUBBLE;
        if (pointInTriangle(px, py, 100, 368, 180, 368, 76, 436)) color = BUBBLE;
        if (roundedRectContains(px, py, 110, 180, 260, 34, 17)) color = BAR1;
        if (roundedRectContains(px, py, 110, 236, 220, 34, 17)) color = BAR2;
        if (roundedRectContains(px, py, 110, 292, 280, 34, 17)) color = BAR3;
      }
      const i = (y * size + x) * 4;
      if (color) {
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePng(size, size, rgba);
}

function main() {
  const out = process.argv[2] || path.join(__dirname, '..', 'assets', 'icon.png');
  fs.writeFileSync(out, drawIcon(SIZE));
  console.log('icon written:', out, `(${SIZE}×${SIZE})`);
}

if (require.main === module) main();

module.exports = { drawIcon, SIZE };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/generate-icon.test.js`
Expected: PASS（1 个测试）。再跑 `npm test` 确认全套仍绿（原 76 + 新 1 = 77）

- [ ] **Step 5: 生成并提交图标**

Run:
```bash
node tools/generate-icon.js
ls -la assets/icon.png
```
Expected: `assets/icon.png` 存在，512×512（纯色无抗锯齿设计，deflate 压缩后实际仅数 KB——体积小无害，electron-builder 按尺寸转换）

```bash
git add tools/generate-icon.js tests/generate-icon.test.js assets/icon.png
git commit -m "feat: 应用图标生成脚本（纯 Node 手写 PNG，占位气泡弹幕图标）"
```

---

### Task 2: 安装 electron-builder + package.json 打包配置

**Files:**
- Modify: `package.json`
- Produce: `package-lock.json`（npm 自动更新）

**Interfaces:**
- Consumes: Task 1 的 `assets/icon.png`
- Produces: `npm run build:win` / `npm run build:mac` 脚本与 `build` 配置（Task 4 用 `build:win`；单平台脚本各自构建，win/mac 互不交叉）

- [ ] **Step 1: 安装 electron-builder**

Run: `npm install --save-dev electron-builder`
Expected: 安装成功，`node_modules/.bin/electron-builder` 存在。验证：`npx electron-builder --version` 输出 `26.x.x`

- [ ] **Step 2: 改写 package.json**

将 `package.json` 整体替换为：

```json
{
  "name": "bullet-chat",
  "version": "0.1.0",
  "description": "桌面弹幕直播：监控你的文件操作，AI 观众发弹幕吐槽",
  "author": "szp",
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test",
    "build:win": "electron-builder --win",
    "build:mac": "electron-builder --mac"
  },
  "devDependencies": {
    "electron": "^37.2.0",
    "electron-builder": "^26.0.12"
  },
  "build": {
    "appId": "com.bulletchat.app",
    "productName": "BulletChat",
    "icon": "assets/icon.png",
    "files": ["src/**/*", "assets/**/*"],
    "win": {
      "target": ["nsis"]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "installerLanguages": ["zh_CN", "en_US"],
      "shortcutName": "BulletChat"
    },
    "mac": {
      "target": ["dmg"],
      "identity": null,
      "category": "public.app-category.utilities"
    }
  }
}
```

注意：`electron-builder` 实际安装到的版本号若不同（^26 区间内），保留 npm 写入的真实版本，其余字段照抄。

- [ ] **Step 3: 验证配置可解析**

Run:
```bash
node -e "const b = require('./package.json').build; console.log(b.appId, b.productName, b.win.target[0], b.mac.target[0])"
npm test
```
Expected: 输出 `com.bulletchat.app BulletChat nsis dmg`；测试全绿（77）

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json
git commit -m "feat: electron-builder 打包配置（Windows NSIS + macOS dmg + 构建脚本）"
```

---

### Task 3: 固定 userData 路径 + README 打包章节

**Files:**
- Modify: `src/main/main.js`（第 18 行 `const PRELOAD = ...` 之后插入）
- Modify: `README.md`（「## 运行」小节之后插入「## 打包」小节）

**Interfaces:**
- Consumes: 无（纯配置/文档）
- Produces: 打包版与开发版共用 `%APPDATA%/bullet-chat` 配置目录；README 打包指引

- [ ] **Step 1: main.js 插入 userData 固定**

在 `src/main/main.js` 第 18 行 `const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');` 之后插入：

```js
// 固定配置目录：打包后默认 userData 会变成 %APPDATA%/BulletChat（productName），
// 与开发版 %APPDATA%/bullet-chat 不一致会"丢配置"。必须在 app ready 之前设置
app.setPath('userData', path.join(app.getPath('appData'), 'bullet-chat'));
```

- [ ] **Step 2: README 增加打包章节**

在 `README.md` 的「## 运行」小节（`npm start` 代码块之后）插入：

```markdown
## 打包

Windows 上打 exe（NSIS 安装包）：
```bash
npm run build:win
```
macOS 上打 dmg：
```bash
npm run build:mac
```
产物在 `dist/` 目录。平台限制：exe 只能在 Windows 构建，dmg 只能在 macOS 构建。

自用分发（未签名）说明：
- Windows：首次运行安装包会提示「未知发布者」，点「更多信息 → 仍要运行」
- macOS：首次打开需右键应用 →「打开」；屏幕识别需重新授权（系统设置 → 隐私与安全性 → 屏幕录制，权限按应用独立）

应用图标：默认是 `tools/generate-icon.js` 生成的占位图（`assets/icon.png`），想换图标直接替换该文件后重新构建即可。
```

- [ ] **Step 3: 验证**

Run: `npm test`
Expected: 全绿（77）。再跑 `node -e "require('./src/main/main.js')"` 不行（Electron 主进程不可脱离 electron 运行），此变更靠代码审查确认：`app.setPath` 位于模块顶层、任何 `whenReady` 回调之前（grep 确认 main.js 中所有 `app.getPath('userData')` 调用点都在 whenReady 回调内，共 3 处：config.js:9、main.js:106/111/142）

- [ ] **Step 4: 提交**

```bash
git add src/main/main.js README.md
git commit -m "fix: 固定 userData 路径（打包前后配置目录一致）+ README 打包章节"
```

---

### Task 4: Windows 实构建验证（本机）

**Files:**
- 无代码变更（若构建暴露问题则修复并提交）

**Interfaces:**
- Consumes: Task 1 的 `assets/icon.png`、Task 2 的 build 配置与脚本、Task 3 的 main.js
- Produces: `dist/BulletChat Setup 0.1.0.exe`（NSIS 安装包，gitignore 不提交）

- [ ] **Step 1: 执行构建**

Run: `npm run build:win`
Expected: electron-builder 首次会自动下载 winCodeSign/nsis 工具（需要网络，耗时数分钟），最终输出：
- `dist/BulletChat Setup 0.1.0.exe`
- `dist/win-unpacked/BulletChat.exe`
- `dist/builder-effective-config.yaml`

若 winCodeSign/nsis 下载失败（网络问题），设置镜像后重试：
```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run build:win
```

- [ ] **Step 2: 验证产物**

Run:
```bash
ls -la dist/
du -h "dist/BulletChat Setup 0.1.0.exe"
```
Expected: exe 存在且 > 50MB（Electron 应用体积）。`dist/builder-effective-config.yaml` 中 appId 为 `com.bulletchat.app`、productName 为 `BulletChat`

- [ ] **Step 3: 启动冒烟测试**

Run（Git Bash 语法，双斜杠转义 Windows 参数）：
```bash
./dist/win-unpacked/BulletChat.exe &
sleep 8
tasklist //FI "IMAGENAME eq BulletChat.exe" | grep -i BulletChat
taskkill //IM BulletChat.exe //F
```
Expected: tasklist 能看到 BulletChat.exe 进程（启动 8 秒未崩溃即通过），随后被 taskkill 清理。若进程立即退出，查看 `%APPDATA%/bullet-chat/logs/app.log` 或控制台输出定位原因

- [ ] **Step 4: 回归测试 + 收尾**

Run: `npm test`
Expected: 全绿（77）。`git status` 应无未提交变更（dist/ 已被 gitignore）。如有构建期修复，单独提交并注明原因

---

## Self-Review 结论

- **Spec 覆盖**：electron-builder 依赖与 build 配置（Task 2）✓；NSIS 非一键/可改目录/中文（Task 2 nsis 配置）✓；mac dmg + identity null（Task 2 mac 配置）✓；图标脚本与 icon.png（Task 1）✓；userData 一致性（Task 3）✓；README 打包章节含未签名提示与屏幕录制重新授权（Task 3）✓；Windows 实构建验证（Task 4）✓；macOS 侧脚本就绪由用户在 Mac 验证（Task 2 脚本 + Task 3 README）✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码 ✓
- **类型一致性**：`drawIcon(size)`/`SIZE` 在 Task 1 测试与实现中一致；`build:win` 在 Task 2 定义、Task 4 使用一致 ✓
