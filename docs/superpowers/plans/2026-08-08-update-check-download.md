# 检查更新 + 下载安装包 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打包产物内置「检查更新」：启动静默检查 + 托盘/设置页手动检查，发现新版下载完整安装包到下载目录、校验 SHA256、自动打开手动安装。

**Architecture:** 纯逻辑（版本解析/平台映射/manifest 求值/发布合并/下载器）放 `src/shared/updaterCore.js`（与 Electron 无关，`node --test` 直接可测，fetch/fs 可注入）；Electron 胶水 `src/main/updater.js` 管状态机/通知/单飞；设置页新增「更新」区块；发布脚本 `tools/publish-update.js` 单平台上传（rsync/scp 自动选择）；服务器 Nginx 静态站点。

**Tech Stack:** Node.js（CommonJS）、Electron 37（Node 22，web stream async iteration 可用）、electron-builder、node:test、node:http（测试用）。

## Global Constraints

- 零构建、零框架、主进程零新依赖（沿用项目约定；不用 electron-updater、不用 semver 库）
- 版本号按 `x.y.z` 数字逐段比较；允许 `v` 前缀；任一段非数字 → 非法
- 客户端比较用 `files.<平台>.version`（平台条目自己的版本），不用顶层 version
- 新配置项必须有默认值：`system.ignoredUpdateVersion: ''`（进 KNOWN_KEYS）
- 更新 URL 常量：`https://updates.zhipengcoding.com/version.json`；拉取超时 10s
- 下载到 `.part` 临时文件 → SHA256 校验通过 → 重命名；失败/取消删 `.part`
- 检查与下载各设单飞锁；`before-quit` 中止下载
- 启动自检失败完全静默；发现新版才通知（点击通知打开设置页）
- 双平台：Windows（win-x64）+ macOS（mac-arm64/mac-x64）
- 现有 153 测试必须保持全绿；新增测试文件 `tests/updaterCore.test.js`（node --test 自动发现）
- UI 文案中文，与现有设置页风格一致（.result/.ok/.err 类）

---

### Task 1: updaterCore 版本解析/比较与平台映射

**Files:**
- Create: `src/shared/updaterCore.js`（本任务只加这三个函数）
- Test: `tests/updaterCore.test.js`

**Interfaces:**
- Produces:
  - `parseVersion(v) → [n,n,n] | null`（`v` 前缀去除、取前 3 段、任一段非数字 → null）
  - `compareVersions(a, b) → -1|0|1|null`（数字逐段比较；任一非法 → null）
  - `platformKey(platform, arch) → 'win-x64'|'mac-arm64'|'mac-x64'|null`

- [ ] **Step 1: 写失败测试**

创建 `tests/updaterCore.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, compareVersions, platformKey } = require('../src/shared/updaterCore');

test('parseVersion 基础解析', () => {
  assert.deepEqual(parseVersion('0.2.0'), [0, 2, 0]);
  assert.deepEqual(parseVersion('v0.2.0'), [0, 2, 0], 'v 前缀被去除');
  assert.deepEqual(parseVersion('V1.2.3'), [1, 2, 3], '大写 V 前缀也去除');
  assert.deepEqual(parseVersion('1.2'), [1, 2], '不足 3 段合法');
  assert.deepEqual(parseVersion('1.2.3.4'), [1, 2, 3], '超过 3 段只取前 3');
  assert.deepEqual(parseVersion('0.9.0'), [0, 9, 0]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0], '两位数段正常');
});

test('parseVersion 非法输入返回 null', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('abc'), null);
  assert.equal(parseVersion('0.2.0-beta'), null, '非数字段非法');
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion(123), null, '非字符串非法');
});

test('compareVersions 数字逐段比较', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1, '逐段数字比较，0.9 < 0.10');
  assert.equal(compareVersions('1.2', '1.2.0'), 0, '缺段补 0');
  assert.equal(compareVersions('1.2', '1.3'), -1);
});

test('compareVersions 非法输入返回 null', () => {
  assert.equal(compareVersions('abc', '0.1.0'), null);
  assert.equal(compareVersions('0.1.0', 'abc'), null);
});

test('platformKey 平台映射', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'mac-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'mac-x64');
  assert.equal(platformKey('win32', 'x64'), 'win-x64');
  assert.equal(platformKey('win32', 'arm64'), null, '未发布的架构组合');
  assert.equal(platformKey('linux', 'x64'), null);
  assert.equal(platformKey('darwin', 'ia32'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/szp/project/bullet_chat && node --test tests/updaterCore.test.js`
Expected: FAIL，报 `Cannot find module '../src/shared/updaterCore'`

- [ ] **Step 3: 实现**

创建 `src/shared/updaterCore.js`：

```js
// 检查更新纯逻辑：版本解析/比较、平台映射、manifest 求值、发布合并、下载器。
// 与 Electron 无关，node --test 直接可测；fetch/fs 可注入（下载器）。

// "x.y.z" → [x,y,z]；允许 v 前缀；取前 3 段；任一段非数字 → null（非法）
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/i, '');
  if (!s) return null;
  const nums = [];
  for (const part of s.split('.').slice(0, 3)) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return nums.length ? nums : null;
}

// 数字逐段比较：a < b → -1，相等 → 0，a > b → 1；任一非法 → null
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// process.platform + process.arch → version.json 的 files 键；未知组合 → null
function platformKey(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

module.exports = { parseVersion, compareVersions, platformKey };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/szp/project/bullet_chat && node --test tests/updaterCore.test.js`
Expected: PASS（8 个测试）

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd /Users/szp/project/bullet_chat && npm test`
Expected: 153 + 8 = 161 全绿

```bash
cd /Users/szp/project/bullet_chat
git add src/shared/updaterCore.js tests/updaterCore.test.js
git commit -m "feat: updater 版本解析/比较与平台映射纯逻辑 + 测试"
```

---

### Task 2: manifest 解析/求值与发布合并

**Files:**
- Modify: `src/shared/updaterCore.js`（追加四个函数）
- Test: `tests/updaterCore.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `parseVersion` / `compareVersions` / `platformKey`
- Produces:
  - `parseManifest(text) → { version, notes, files }`（非法 → throw Error）
  - `evaluateManifest({ manifest, currentVersion, platform, arch, ignoredVersion }) → { status, latestVersion, notes, entry }`；`status: 'up-to-date'|'update-available'|'no-installer'|'ignored'|'error'`
  - `maxVersion(files) → string`（各平台条目最大版本，顶层 version 用）
  - `mergeForPublish({ remoteManifest, platform, version, notes, url, sha256 }) → manifest`（remote 为 null → 新建；否则只更新本平台条目、保留其他平台）

- [ ] **Step 1: 写失败测试（追加到 tests/updaterCore.test.js 末尾）**

```js
const { parseManifest, evaluateManifest, maxVersion, mergeForPublish } = require('../src/shared/updaterCore');
const sha = (c) => c.repeat(64);

test('parseManifest 校验', () => {
  const ok = parseManifest(JSON.stringify({
    version: '0.2.0', notes: 'x', files: { 'win-x64': { version: '0.2.0', url: 'u', sha256: sha('a') } },
  }));
  assert.equal(ok.version, '0.2.0');
  assert.equal(ok.files['win-x64'].sha256, sha('a'));
  assert.throws(() => parseManifest('not json'), /JSON/);
  assert.throws(() => parseManifest('{}'), /files/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 'abc', files: {} })), /version/);
  assert.throws(() => parseManifest(JSON.stringify({ version: '0.2.0', files: { 'win-x64': { version: '0.2.0', url: 'u', sha256: '短' } } })), /sha256/);
  assert.throws(() => parseManifest(JSON.stringify({ version: '0.2.0', files: { 'win-x64': { version: 'bad', url: 'u', sha256: sha('a') } } })), /version/);
});

test('evaluateManifest 状态判定', () => {
  const mk = (files) => ({ version: '0.3.0', notes: 'n', files });
  const base = { currentVersion: '0.1.0', platform: 'win32', arch: 'x64' };
  // 有新版
  let r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.2.0', url: 'u', sha256: sha('a') } }), ...base });
  assert.equal(r.status, 'update-available');
  assert.equal(r.latestVersion, '0.2.0');
  // 条目 notes 优先于顶层
  r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.2.0', notes: '条目说明', url: 'u', sha256: sha('a') } }), ...base });
  assert.equal(r.notes, '条目说明');
  // 已是最新（等于与落后都算）
  r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.1.0', url: 'u', sha256: sha('a') } }), ...base });
  assert.equal(r.status, 'up-to-date');
  // 本平台没有条目
  r = evaluateManifest({ manifest: mk({ 'mac-arm64': { version: '0.2.0', url: 'u', sha256: sha('a') } }), ...base });
  assert.equal(r.status, 'no-installer');
  // 未知平台
  r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.2.0', url: 'u', sha256: sha('a') } }), currentVersion: '0.1.0', platform: 'linux', arch: 'x64' });
  assert.equal(r.status, 'no-installer');
  // 忽略：同版本被跳过，更高版本重新提醒
  r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.2.0', url: 'u', sha256: sha('a') } }), ...base, ignoredVersion: '0.2.0' });
  assert.equal(r.status, 'ignored');
  r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.3.0', url: 'u', sha256: sha('a') } }), ...base, ignoredVersion: '0.2.0' });
  assert.equal(r.status, 'update-available', '更高版本重新提醒');
  // 当前版本非法
  r = evaluateManifest({ manifest: mk({ 'win-x64': { version: '0.2.0', url: 'u', sha256: sha('a') } }), currentVersion: 'bad', platform: 'win32', arch: 'x64' });
  assert.equal(r.status, 'error');
});

test('maxVersion 取各平台最大', () => {
  assert.equal(maxVersion({ 'win-x64': { version: '0.2.0' }, 'mac-arm64': { version: '0.3.0' } }), '0.3.0');
  assert.equal(maxVersion({ 'win-x64': { version: '0.10.0' }, 'mac-arm64': { version: '0.9.0' } }), '0.10.0');
  assert.equal(maxVersion({}), '0.0.0');
  assert.equal(maxVersion({ 'win-x64': { version: 'bad' } }), '0.0.0', '非法版本忽略');
});

test('mergeForPublish 首次发布（remote 为 null）', () => {
  const m = mergeForPublish({ remoteManifest: null, platform: 'mac-arm64', version: '0.2.0', notes: 'x', url: 'u.dmg', sha256: sha('a') });
  assert.deepEqual(m.files, { 'mac-arm64': { version: '0.2.0', url: 'u.dmg', sha256: sha('a'), notes: 'x' } });
  assert.equal(m.version, '0.2.0');
  assert.equal(m.notes, 'x');
});

test('mergeForPublish 保留另一平台条目', () => {
  const remote = { version: '0.2.0', notes: 'old', files: { 'win-x64': { version: '0.2.0', url: 'w.exe', sha256: sha('b') } } };
  const m = mergeForPublish({ remoteManifest: remote, platform: 'mac-arm64', version: '0.3.0', notes: 'new', url: 'm.dmg', sha256: sha('c') });
  assert.deepEqual(m.files['win-x64'], remote.files['win-x64'], '另一平台条目原样保留');
  assert.equal(m.files['mac-arm64'].version, '0.3.0');
  assert.equal(m.version, '0.3.0', '顶层取最大值');
  assert.equal(m.notes, 'new');
});

test('mergeForPublish 本平台版本落后时顶层仍取最大', () => {
  const remote = { version: '0.3.0', notes: '', files: { 'win-x64': { version: '0.3.0', url: 'w', sha256: sha('b') } } };
  const m = mergeForPublish({ remoteManifest: remote, platform: 'mac-arm64', version: '0.2.0', notes: '', url: 'm', sha256: sha('c') });
  assert.equal(m.version, '0.3.0');
  assert.equal(m.files['mac-arm64'].version, '0.2.0');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/szp/project/bullet_chat && node --test tests/updaterCore.test.js`
Expected: FAIL，报 `parseManifest is not a function`

- [ ] **Step 3: 实现（追加到 src/shared/updaterCore.js，`module.exports` 前）**

```js
// 校验并解析 manifest 文本 → { version, notes, files }；非法 → throw Error
function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('manifest 不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || typeof data.files !== 'object' || data.files === null) {
    throw new Error('manifest 缺少 files');
  }
  if (parseVersion(data.version) === null) throw new Error('manifest 顶层 version 非法');
  for (const [key, entry] of Object.entries(data.files)) {
    if (!entry || typeof entry !== 'object') throw new Error(`files.${key} 不是对象`);
    if (parseVersion(entry.version) === null) throw new Error(`files.${key}.version 非法`);
    if (typeof entry.url !== 'string' || !entry.url) throw new Error(`files.${key}.url 缺失`);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw new Error(`files.${key}.sha256 非法`);
  }
  return data;
}

// 求值：当前版本 + 本平台条目 → 状态。status: up-to-date|update-available|no-installer|ignored|error
function evaluateManifest({ manifest, currentVersion, platform, arch, ignoredVersion = '' }) {
  if (parseVersion(currentVersion) === null) return { status: 'error', message: '当前版本号非法' };
  const key = platformKey(platform, arch);
  const entry = key ? manifest.files[key] : undefined;
  if (!entry) return { status: 'no-installer', latestVersion: manifest.version };
  if (parseVersion(entry.version) === null) return { status: 'error', message: '本平台版本号非法' };
  const notes = entry.notes || manifest.notes || '';
  if (ignoredVersion && compareVersions(entry.version, ignoredVersion) <= 0) {
    return { status: 'ignored', latestVersion: entry.version, notes, entry };
  }
  if (compareVersions(entry.version, currentVersion) <= 0) {
    return { status: 'up-to-date', latestVersion: entry.version, notes, entry };
  }
  return { status: 'update-available', latestVersion: entry.version, notes, entry };
}

// 所有平台条目版本的最大值（顶层 version 用；非法版本忽略）
function maxVersion(files) {
  let best = null;
  for (const entry of Object.values(files)) {
    const v = parseVersion(entry.version);
    if (v && (!best || compareVersions(v.join('.'), best) > 0)) best = v.join('.');
  }
  return best || '0.0.0';
}

// 发布合并：remoteManifest 为 null（首次发布）→ 新建；否则只更新本平台条目、保留其他平台
function mergeForPublish({ remoteManifest, platform, version, notes, url, sha256 }) {
  const files = remoteManifest && typeof remoteManifest.files === 'object' ? { ...remoteManifest.files } : {};
  files[platform] = { version, url, sha256, ...(notes ? { notes } : {}) };
  return { version: maxVersion(files), notes: notes || remoteManifest?.notes || '', files };
}
```

更新 `module.exports` 为：

```js
module.exports = {
  parseVersion, compareVersions, platformKey,
  parseManifest, evaluateManifest, maxVersion, mergeForPublish,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/szp/project/bullet_chat && node --test tests/updaterCore.test.js`
Expected: PASS（14 个测试）

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd /Users/szp/project/bullet_chat && npm test`
Expected: 167 全绿

```bash
cd /Users/szp/project/bullet_chat
git add src/shared/updaterCore.js tests/updaterCore.test.js
git commit -m "feat: updater manifest 解析/求值与发布合并纯逻辑 + 测试"
```

---

### Task 3: 下载器 downloadToFile

**Files:**
- Modify: `src/shared/updaterCore.js`（追加 `downloadToFile`）
- Test: `tests/updaterCore.test.js`（追加）

**Interfaces:**
- Produces: `downloadToFile({ url, dest, sha256, fetchImpl, fsMod, onProgress, signal }) → Promise<dest>`
  - 先写 `dest + '.part'`，SHA256 校验通过后 `renameSync` 为 `dest`；失败/取消删 `.part` 后 rethrow
  - `onProgress({ percent, downloaded, total })`（total 取 content-length，未知则 0/percent 0）
  - `signal`（AbortSignal）：中止时 fetch/body 抛 AbortError，同样清理
  - 依赖 Node 18+（web stream `for await`），Electron 37 = Node 22 可用

- [ ] **Step 1: 写失败测试（追加）**

```js
const http = require('node:http');
const crypto = require('node:crypto');
const { downloadToFile } = require('../src/shared/updaterCore');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

const payload = Buffer.from('fake installer content 1234567890');
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

test('downloadToFile 下载并校验成功（.part → 重命名，进度回调）', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'pkg.bin');
  const events = [];
  try {
    const got = await downloadToFile({
      url: url + 'pkg.bin', dest, sha256: payloadSha,
      onProgress: (p) => events.push(p),
    });
    assert.equal(got, dest);
    assert.ok(fs.existsSync(dest), '最终文件存在');
    assert.ok(!fs.existsSync(dest + '.part'), '.part 已清理');
    assert.deepEqual(fs.readFileSync(dest), payload);
    assert.equal(events.at(-1).percent, 100);
    assert.equal(events.at(-1).downloaded, payload.length);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile sha256 不符：抛错、删 .part、不留最终文件', async () => {
  const { server, url } = await startServer((req, res) => { res.end(payload); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'pkg.bin');
  try {
    await assert.rejects(downloadToFile({ url: url + 'x', dest, sha256: '0'.repeat(64) }), /sha256/);
    assert.ok(!fs.existsSync(dest + '.part'));
    assert.ok(!fs.existsSync(dest));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile HTTP 错误：抛错并清理', async () => {
  const { server, url } = await startServer((req, res) => { res.writeHead(500); res.end(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'pkg.bin');
  try {
    await assert.rejects(downloadToFile({ url: url + 'x', dest, sha256: payloadSha }), /500/);
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile 中止：AbortError 并清理 .part', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': 100000 });
    res.write(Buffer.alloc(1000));
    // 不再写，等待客户端断开
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'pkg.bin');
  try {
    const ac = new AbortController();
    const p = downloadToFile({ url: url + 'x', dest, sha256: payloadSha, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p, (err) => err.name === 'AbortError');
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile 超时（AbortSignal.timeout）', async () => {
  const { server, url } = await startServer(() => { /* 永不响应 */ });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'pkg.bin');
  try {
    await assert.rejects(
      downloadToFile({ url: url + 'x', dest, sha256: payloadSha, signal: AbortSignal.timeout(300) }),
      (err) => err.name === 'TimeoutError' || err.name === 'AbortError'
    );
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/szp/project/bullet_chat && node --test tests/updaterCore.test.js`
Expected: FAIL，报 `downloadToFile is not a function`

- [ ] **Step 3: 实现（追加到 src/shared/updaterCore.js）**

```js
const crypto = require('node:crypto');
const fs = require('node:fs');

// 下载 url 到 dest：先写 dest.part，SHA256 校验通过后 renameSync 为 dest。
// fetchImpl/fsMod 可注入（默认全局 fetch / node:fs）；signal 中止时清理 .part 后 rethrow
async function downloadToFile({ url, dest, sha256, fetchImpl = fetch, fsMod = fs, onProgress, signal }) {
  const part = dest + '.part';
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let downloaded = 0;
  const out = fsMod.createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      downloaded += chunk.length;
      hash.update(chunk);
      out.write(chunk);
      onProgress?.({ percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0, downloaded, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    try { fsMod.unlinkSync(part); } catch { /* 清理失败不覆盖原错误 */ }
    throw err;
  }
  if (hash.digest('hex') !== String(sha256).toLowerCase()) {
    try { fsMod.unlinkSync(part); } catch { /* 同上 */ }
    throw new Error('sha256 校验失败');
  }
  try { fsMod.renameSync(part, dest); } catch { /* 重命名失败：不残留 .part */ }
  return dest;
}
```

`module.exports` 追加 `downloadToFile`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/szp/project/bullet_chat && node --test tests/updaterCore.test.js`
Expected: PASS（19 个测试）。若 `for await (const chunk of res.body)` 报 `res.body is not async iterable`，说明本机 Node < 18.4——用 `for await (const chunk of res.body.stream ? res.body : res.body)` 无意义，正确做法：确认 `node --version` ≥ 18.4（本项目 Electron 37 无此问题，测试跑在系统 Node 上，需系统 Node ≥ 18.4）

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd /Users/szp/project/bullet_chat && npm test`
Expected: 172 全绿

```bash
cd /Users/szp/project/bullet_chat
git add src/shared/updaterCore.js tests/updaterCore.test.js
git commit -m "feat: updater 下载器（.part + sha256 校验 + 中止清理）+ 测试"
```

---

### Task 4: 主进程 Updater 服务

**Files:**
- Create: `src/main/updater.js`

**Interfaces:**
- Consumes: Task 1-3 的 `parseManifest` / `evaluateManifest` / `downloadToFile`
- Produces: `class Updater`，构造函数 `new Updater({ version, getDownloadsDir, openPath, getIgnoredVersion, setIgnoredVersion, onOpenSettings })`
  - `check({ silent }) → Promise<result>`（result 形状同 evaluateManifest；单飞：进行中返回 `{ status: 'checking' }`）
  - `download() → Promise<{ ok, message, dest? }>`（单飞；失败 message 按原因区分「校验失败，请重试」/「下载失败，请重试」）
  - `cancel()`（中止进行中的下载）
  - `ignoreVersion(v)`（写入配置，state → 'ignored'）
  - `getState() → { state, currentVersion, latestVersion, notes, message, progress }`（state: idle|checking|available|downloading|done|ignored|error）
  - `startupCheck()`（5s 延迟静默检查，发现新版 → 可点击通知）
  - `onProgress(cb)`（下载进度订阅：`{ percent, downloaded, total }`）
  - 常量导出：`UPDATE_URL`、`FETCH_TIMEOUT_MS`、`STARTUP_CHECK_DELAY_MS`

行为约定（供 Task 5 接线参照）：
- `check()` 内部**不弹通知**；发现新版时由调用方决定是否通知。`startupCheck` 发现新版 → 弹「发现新版本 vX」通知，点击调 `onOpenSettings`；`check({ silent: false })` 由托盘/设置页调用并自行展示结果
- 下载开始/完成弹通知（「开始下载」/「下载完成，正在打开安装包」）
- Notification 实例必须保留在局部变量上挂 `click`（被 GC 后 click 失效）

- [ ] **Step 1: 实现 updater.js**

创建 `src/main/updater.js`（Electron 胶水，无单测——与 tray.js/main.js 同类，靠 Task 9 实机验证）：

```js
const { Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { parseManifest, evaluateManifest, downloadToFile } = require('../shared/updaterCore');

const UPDATE_URL = 'https://updates.zhipengcoding.com/version.json';
const FETCH_TIMEOUT_MS = 10000;
const STARTUP_CHECK_DELAY_MS = 5000;

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return p;
}

class Updater {
  constructor({ version, getDownloadsDir, openPath, getIgnoredVersion, setIgnoredVersion, onOpenSettings }) {
    this.version = version;
    this.getDownloadsDir = getDownloadsDir;
    this.openPath = openPath;
    this.getIgnoredVersion = getIgnoredVersion;
    this.setIgnoredVersion = setIgnoredVersion;
    this.onOpenSettings = onOpenSettings;
    this.state = 'idle';
    this.lastResult = null;
    this.message = '';
    this.progress = null;
    this.checking = false;
    this.downloading = false;
    this.abortController = null;
    this._progressCbs = [];
  }

  onProgress(cb) { this._progressCbs.push(cb); }
  _emitProgress(p) { this.progress = p; for (const cb of this._progressCbs) cb(p); }

  // Notification 必须保留实例，否则被 GC 后 click 事件丢失
  showNotification(title, body, onClick) {
    try {
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
    } catch { /* 通知失败忽略（如无通知权限） */ }
  }

  async check({ silent = false } = {}) {
    if (this.checking) return { status: 'checking' };
    this.checking = true;
    this.state = 'checking';
    try {
      const res = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = parseManifest(await res.text());
      const result = evaluateManifest({
        manifest,
        currentVersion: this.version,
        platform: process.platform,
        arch: process.arch,
        ignoredVersion: this.getIgnoredVersion() || '',
      });
      this.lastResult = result;
      this.message = result.message || '';
      this.state = result.status === 'update-available' ? 'available' : result.status;
      return result;
    } catch (err) {
      this.state = 'error';
      this.message = err.message;
      this.lastResult = { status: 'error', message: err.message };
      if (!silent) this.showNotification('检查更新失败', err.message);
      return this.lastResult;
    } finally {
      this.checking = false;
    }
  }

  async download() {
    if (this.downloading) return { ok: false, message: '下载已在进行' };
    if (this.state !== 'available' || !this.lastResult?.entry) return { ok: false, message: '没有可下载的版本' };
    this.downloading = true;
    this.abortController = new AbortController();
    this.state = 'downloading';
    this.message = '';
    this.progress = { percent: 0, downloaded: 0, total: 0 };
    const entry = this.lastResult.entry;
    const dir = await this.getDownloadsDir();
    const baseName = path.basename(new URL(entry.url).pathname) || 'BulletChat-installer';
    const dest = uniquePath(path.join(dir, baseName));
    this.showNotification('更新下载', `开始下载 v${this.lastResult.latestVersion}（${baseName}）`);
    try {
      await downloadToFile({
        url: entry.url,
        dest,
        sha256: entry.sha256,
        signal: this.abortController.signal,
        onProgress: (p) => this._emitProgress(p),
      });
      this.state = 'done';
      this.message = '已下载，正在打开安装包';
      this.openPath(dest).catch(() => { /* 打开失败不阻塞状态 */ });
      this.showNotification('更新下载完成', `${baseName} 已保存，正在打开安装包`);
      return { ok: true, dest };
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        this.state = 'idle';
        this.message = '已取消';
      } else {
        this.state = 'error';
        this.message = /sha256/.test(err.message) ? '校验失败，请重试' : '下载失败，请重试';
      }
      return { ok: false, message: this.message };
    } finally {
      this.downloading = false;
      this.abortController = null;
    }
  }

  cancel() {
    this.abortController?.abort();
  }

  ignoreVersion(version) {
    this.setIgnoredVersion(version);
    this.state = 'ignored';
    if (this.lastResult) this.lastResult = { ...this.lastResult, status: 'ignored' };
  }

  getState() {
    return {
      state: this.state,
      currentVersion: this.version,
      latestVersion: this.lastResult?.latestVersion || null,
      notes: this.lastResult?.notes || null,
      message: this.message,
      progress: this.progress,
    };
  }

  startupCheck() {
    setTimeout(() => {
      this.check({ silent: true }).then((r) => {
        if (r.status === 'update-available') {
          this.showNotification(`发现新版本 v${r.latestVersion}`, r.notes ? r.notes.split('\n')[0] : '点击打开设置页下载安装包', () => this.onOpenSettings?.());
        }
      });
    }, STARTUP_CHECK_DELAY_MS);
  }
}

module.exports = { Updater, UPDATE_URL, FETCH_TIMEOUT_MS, STARTUP_CHECK_DELAY_MS };
```

- [ ] **Step 2: 语法检查**

Run: `cd /Users/szp/project/bullet_chat && node --check src/main/updater.js`
Expected: 无输出（语法 OK）

- [ ] **Step 3: 全量回归 + 提交**

Run: `cd /Users/szp/project/bullet_chat && npm test`
Expected: 172 全绿（无新增测试，回归确认）

```bash
cd /Users/szp/project/bullet_chat
git add src/main/updater.js
git commit -m "feat: 主进程 Updater 服务（检查/下载/取消/忽略/单飞/启动自检）"
```

---

### Task 5: 接线（main.js / settingsWindow.js / preload / tray / configCore）

**Files:**
- Modify: `src/main/main.js`（导入 Updater、实例化、startupCheck、before-quit cancel、抽 openSettings 复用）
- Modify: `src/main/settingsWindow.js`（注册 updater IPC + saveConfig 合并回写 ignoredUpdateVersion）
- Modify: `src/preload/preload.js`（暴露 window.updater）
- Modify: `src/main/tray.js`（「检查更新」菜单项）
- Modify: `src/shared/configCore.js`（`system.ignoredUpdateVersion: ''`）
- Test: `tests/configCore.test.js`（追加默认值与往返测试）

**Interfaces:**
- Consumes: Task 4 的 `Updater`
- Produces:
  - IPC：`updater:check` / `updater:download` / `updater:cancel` / `updater:ignoreVersion` / `updater:getState`（invoke）；`updater:progress`（主进程 → 渲染进程推送）
  - preload：`window.updater = { check, download, cancel, ignoreVersion, getState, onProgress }`
  - tray：`buildMenu` 新增 `onCheckUpdate` 参数与「检查更新」菜单项

- [ ] **Step 1: configCore 加配置项 + 测试**

`src/shared/configCore.js` 第 9 行改为：

```js
  system: { autostart: false, ignoredUpdateVersion: '' },
```

`tests/configCore.test.js` 追加：

```js
test('system.ignoredUpdateVersion 默认空串且可保存往返', () => {
  assert.equal(defaultConfig().system.ignoredUpdateVersion, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    const cfg = defaultConfig();
    cfg.system.ignoredUpdateVersion = '0.2.0';
    saveConfigFile(file, cfg, fs, enc);
    const loaded = loadConfigFile(file, fs, dec);
    assert.equal(loaded.system.ignoredUpdateVersion, '0.2.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

Run: `cd /Users/szp/project/bullet_chat && node --test tests/configCore.test.js`
Expected: PASS

- [ ] **Step 2: settingsWindow.js 注册 updater IPC + 保存合并回写**

`src/main/settingsWindow.js`：

```js
function registerSettingsIpc({ getConfig, saveConfig, onConfigSaved, updater }) {
  handlers = { getConfig, saveConfig, onConfigSaved };
  ipcMain.handle('settings:getConfig', () => handlers.getConfig());
  ipcMain.handle('settings:saveConfig', (_e, cfg) => {
    // 忽略版本由主进程单独管理，设置页快照可能过期：保存时合并回写，防止把「忽略」清掉
    cfg.system.ignoredUpdateVersion = handlers.getConfig().system.ignoredUpdateVersion;
    const saved = handlers.saveConfig(cfg);
    handlers.onConfigSaved(saved);
    return saved;
  });
  // ...保留原有 getDisplays / getDisplayPreview 不变...
  if (updater) {
    ipcMain.handle('updater:check', () => updater.check({ silent: false }));
    ipcMain.handle('updater:download', () => updater.download());
    ipcMain.handle('updater:cancel', () => updater.cancel());
    ipcMain.handle('updater:ignoreVersion', (_e, v) => updater.ignoreVersion(v));
    ipcMain.handle('updater:getState', () => updater.getState());
    updater.onProgress((p) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updater:progress', p);
    });
  }
}
```

- [ ] **Step 3: preload.js 暴露 updater API**

`src/preload/preload.js` 追加：

```js
contextBridge.exposeInMainWorld('updater', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  cancel: () => ipcRenderer.invoke('updater:cancel'),
  ignoreVersion: (v) => ipcRenderer.invoke('updater:ignoreVersion', v),
  getState: () => ipcRenderer.invoke('updater:getState'),
  onProgress: (cb) => ipcRenderer.on('updater:progress', (_e, p) => cb(p)),
});
```

- [ ] **Step 4: tray.js 加「检查更新」**

`src/main/tray.js` `buildMenu` 签名加 `onCheckUpdate`，菜单在「演示模式」后加一项：

```js
function buildMenu({ onQuit, onOpenSettings, onTogglePause, onToggleLocalMode, onToggleDemo, onToggleScreenPause, onCheckUpdate, paused = false, localMode = false, demo = false, screenPaused = false }) {
  return Menu.buildFromTemplate([
    { label: '打开设置', click: onOpenSettings },
    { type: 'separator' },
    { label: paused ? '继续弹幕' : '暂停弹幕', click: onTogglePause },
    { label: '本地模式', type: 'checkbox', checked: localMode, click: onToggleLocalMode },
    { label: '暂停屏幕识别', type: 'checkbox', checked: screenPaused, click: onToggleScreenPause },
    { label: '演示模式（模拟事件）', type: 'checkbox', checked: demo, click: onToggleDemo },
    { label: '检查更新', click: onCheckUpdate },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
}
```

`createTray` 的 rebuild 里补：`onCheckUpdate: opts.onCheckUpdate,`（不改其余逻辑）。

- [ ] **Step 5: main.js 接线**

改动点（按现有代码位置）：

a) 顶部导入：`const { Updater } = require('./updater');`

b) 抽公共 openSettings（托盘与更新通知共用）。把 `whenReady` 里 `onOpenSettings` 的实参逻辑提为模块级函数：

```js
function openSettings() {
  const settingsWin = createSettingsWindow({ preloadPath: PRELOAD });
  const pushStatus = () => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('status-changed', reporter.getStatus());
  };
  settingsWin?.webContents.once('did-finish-load', pushStatus);
  if (!settingsWin?.webContents.isLoading()) pushStatus();
}
```

托盘 `onOpenSettings: openSettings`。

c) `registerSettingsIpc` 调用处传入 updater（在 config 加载后、applyConfig 前实例化）：

```js
const updater = new Updater({
  version: app.getVersion(),
  getDownloadsDir: async () => {
    try { return app.getPath('downloads'); } catch { return path.join(app.getPath('userData'), 'downloads'); }
  },
  openPath: (p) => shell.openPath(p),
  getIgnoredVersion: () => config?.system?.ignoredUpdateVersion || '',
  setIgnoredVersion: (v) => { config.system.ignoredUpdateVersion = v; saveConfig(config); },
  onOpenSettings: openSettings,
});

registerSettingsIpc({
  getConfig: () => config,
  saveConfig: (cfg) => { saveConfig(cfg); config = cfg; return config; },
  onConfigSaved: applyConfig,
  updater,
});
```

d) 托盘新增 `onCheckUpdate`：

```js
onCheckUpdate: async () => {
  const r = await updater.check({ silent: false });
  if (r.status === 'up-to-date') notify('BulletChat', '已是最新版本');
  else if (r.status === 'no-installer') notify('BulletChat', '此平台暂无安装包');
  else if (r.status === 'ignored') notify('BulletChat', `已忽略 v${r.latestVersion}，更高版本将重新提醒`);
  // error 时 check() 已弹失败通知；update-available / checking 无需额外通知
},
```

e) `applyConfig` 结束后启动自检（在 `applyConfig(config, { silent: true }); brain.start();` 之后）：

```js
updater.startupCheck();
```

f) `before-quit` 加：`updater?.cancel();`

注意：`updater` 变量在 whenReady 回调内声明，`before-quit` 与 `openSettings` 在模块作用域——`openSettings` 通过闭包引用 `reporter` 时需注意：现有 `notify`/`applyScreenWatcher` 都是模块级函数引用模块级变量，`openSettings` 引用 `reporter`（whenReady 内赋值）可以工作（模块级变量）。`before-quit` 引用 whenReady 内的 `updater` 不行——**把 updater 提为模块级变量 `let updater = null;`**，whenReady 内赋值，before-quit 里 `updater?.cancel()`。

- [ ] **Step 6: 语法检查 + 全量回归**

Run: `cd /Users/szp/project/bullet_chat && node --check src/main/main.js && node --check src/main/settingsWindow.js && node --check src/preload/preload.js && node --check src/main/tray.js && npm test`
Expected: 语法全部通过；173 全绿（configCore 新增 1 个测试）

- [ ] **Step 7: 提交**

```bash
cd /Users/szp/project/bullet_chat
git add src/main/main.js src/main/settingsWindow.js src/preload/preload.js src/main/tray.js src/shared/configCore.js tests/configCore.test.js
git commit -m "feat: 更新功能接线（IPC/preload/托盘菜单/忽略版本配置项与保存竞态修复）"
```

---

### Task 6: 设置页「更新」区块

**Files:**
- Modify: `src/renderer/settings/settings.html`（新增 section）
- Modify: `src/renderer/settings/settings.js`（渲染 + 按钮 + 进度订阅）
- Modify: `src/renderer/settings/settings.css`（进度条样式）

**Interfaces:**
- Consumes: Task 5 的 `window.updater` API 与 `updater:progress` 事件

- [ ] **Step 1: HTML 加「更新」section**

`settings.html` 在「系统」section 之后、`<footer>` 之前插入：

```html
  <section>
    <h2>更新 <span class="hint-mark" data-tip="启动时自动检查一次，也可手动检查。发现新版本后下载完整安装包（下载目录），校验通过后自动打开，手动安装覆盖旧版">？</span></h2>
    <div class="label-row">当前版本 v<span id="update-current"></span>
      <button id="btn-update-check">检查更新</button>
    </div>
    <div id="update-status"></div>
    <div id="update-actions" hidden>
      <button id="btn-update-download">去下载</button>
      <button id="btn-update-ignore">忽略此版本</button>
      <button id="btn-update-cancel">取消</button>
    </div>
    <div id="update-progress-wrap" class="update-progress-wrap" hidden><div id="update-progress-bar"></div></div>
  </section>
```

- [ ] **Step 2: CSS 加进度条样式**

`settings.css` 末尾追加：

```css
.update-progress-wrap { height: 8px; background: #eee; border-radius: 4px; margin: 8px 0; overflow: hidden; }
#update-progress-bar { height: 100%; width: 0; background: #4caf50; transition: width .2s; }
```

- [ ] **Step 3: settings.js 渲染与交互**

`settings.js` 追加（放在 `load()` 之前，最后一行 load() 里补 `renderUpdate()`）：

```js
// 更新区块：状态来自主进程（检查/下载都在主进程执行，渲染进程只展示与发指令）
async function renderUpdate() {
  const s = await window.updater.getState();
  $('update-current').textContent = s.currentVersion;
  const status = $('update-status');
  const actions = $('update-actions');
  const wrap = $('update-progress-wrap');
  $('btn-update-download').hidden = true;
  $('btn-update-ignore').hidden = true;
  $('btn-update-cancel').hidden = true;
  wrap.hidden = true;
  switch (s.state) {
    case 'available':
      status.textContent = `发现新版本 v${s.latestVersion}${s.notes ? '：' + s.notes.split('\n')[0] : ''}`;
      status.className = 'result ok';
      $('btn-update-download').hidden = false;
      $('btn-update-ignore').hidden = false;
      break;
    case 'downloading':
      status.textContent = `正在下载 v${s.latestVersion}… ${s.progress ? s.progress.percent + '%' : ''}`;
      status.className = 'result ok';
      wrap.hidden = false;
      $('update-progress-bar').style.width = (s.progress ? s.progress.percent : 0) + '%';
      $('btn-update-cancel').hidden = false;
      break;
    case 'done':
      status.textContent = `已下载 v${s.latestVersion}，正在打开安装包`;
      status.className = 'result ok';
      break;
    case 'ignored':
      status.textContent = `已忽略 v${s.latestVersion}，更高版本将重新提醒`;
      status.className = 'result ok';
      break;
    case 'error':
      status.textContent = `更新失败：${s.message || '网络错误'}`;
      status.className = 'result err';
      break;
    case 'checking':
      status.textContent = '正在检查…';
      status.className = 'result ok';
      break;
    default: // idle / up-to-date
      status.textContent = '已是最新版本';
      status.className = 'result ok';
  }
}

$('btn-update-check').onclick = async () => {
  $('btn-update-check').disabled = true;
  await window.updater.check();
  $('btn-update-check').disabled = false;
  renderUpdate();
};

$('btn-update-download').onclick = async () => { await window.updater.download(); renderUpdate(); };
$('btn-update-cancel').onclick = async () => { await window.updater.cancel(); renderUpdate(); };
$('btn-update-ignore').onclick = async () => {
  const s = await window.updater.getState();
  if (s.latestVersion) await window.updater.ignoreVersion(s.latestVersion);
  renderUpdate();
};

window.updater.onProgress(() => renderUpdate());
```

`load()` 末尾（第 367 行）改为：

```js
load().then(async () => { await renderRequestLogs(); renderUsageStats(); renderUpdate(); });
```

注意：settings.js 顶部 `$('btn-update-...')` 的事件绑定必须在 DOM 就绪后——settings.js 是 `<script src>` 放在 `</body>` 前（settings.html 第 117 行），现有代码已直接绑 onclick，保持一致即可。

- [ ] **Step 4: 语法检查**

Run: `cd /Users/szp/project/bullet_chat && node --check src/renderer/settings/settings.js`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
cd /Users/szp/project/bullet_chat
git add src/renderer/settings/settings.html src/renderer/settings/settings.js src/renderer/settings/settings.css
git commit -m "feat: 设置页更新区块（检查/下载/进度/忽略）"
```

---

### Task 7: 打包产物命名 + deploy.env

**Files:**
- Modify: `package.json`（win/mac artifactName）
- Modify: `.gitignore`（排除 deploy.env）
- Create: `deploy.env.example`

- [ ] **Step 1: package.json 加 artifactName**

`package.json` 的 build.win / build.mac 改为：

```json
  "win": {
    "target": [
      "nsis"
    ],
    "artifactName": "${productName}-${version}-win-${arch}.${ext}"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "installerLanguages": [
      "zh_CN",
      "en_US"
    ],
    "shortcutName": "BulletChat"
  },
  "mac": {
    "target": [
      "dmg"
    ],
    "artifactName": "${productName}-${version}-mac-${arch}.${ext}",
    "identity": null,
    "category": "public.app-category.utilities"
  }
```

- [ ] **Step 2: .gitignore 排除 deploy.env**

`.gitignore` 改为：

```
node_modules/
dist/
deploy.env
```

- [ ] **Step 3: 创建 deploy.env.example**

```env
# 复制为 deploy.env 并填写真实值（deploy.env 不入库）
DEPLOY_HOST=your-server-ip
DEPLOY_USER=root
DEPLOY_SSH_KEY=/path/to/your-ssh-key.pem
DEPLOY_PATH=/www/wwwroot/updates.zhipengcoding.com
```

- [ ] **Step 4: 提交**

```bash
cd /Users/szp/project/bullet_chat
git add package.json .gitignore deploy.env.example
git commit -m "chore: 产物名 artifactName 统一（含平台/架构）+ deploy.env 不入库"
```

---

### Task 8: 发布脚本 tools/publish-update.js

**Files:**
- Create: `tools/publish-update.js`

**Interfaces:**
- Consumes: Task 2 的 `mergeForPublish` / `parseManifest`、Task 7 的 deploy.env 与 artifactName 约定
- Produces: CLI `node tools/publish-update.js --platform win-x64|mac-arm64|mac-x64 [--notes "说明"]`
  - 校验 `dist/<artifactName>` 存在 → sha256 → 拉远程 manifest（404 → null，其他错误 → 中止不上传）→ mergeForPublish → 写 `dist/updates/`（version.json + 安装包副本）→ rsync（有则用）或 scp（Windows）上传 → 远程 `chown -R www:www`

- [ ] **Step 1: 实现**

创建 `tools/publish-update.js`：

```js
#!/usr/bin/env node
// 发布更新：单平台上传「安装包 + version.json」到更新服务器（静态站点根目录）。
// 用法：node tools/publish-update.js --platform win-x64|mac-arm64|mac-x64 [--notes "更新说明"]
// 前置：deploy.env（见 deploy.env.example）；dist/ 下有当前版本对应平台的产物（artifactName 命名）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mergeForPublish, parseManifest } = require('../src/shared/updaterCore');

const UPDATE_URL = 'https://updates.zhipengcoding.com/version.json';
const VALID_PLATFORMS = ['win-x64', 'mac-arm64', 'mac-x64'];

function parseArgs(argv) {
  const out = { notes: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--platform') out.platform = argv[++i];
    else if (argv[i] === '--notes') out.notes = argv[++i];
  }
  return out;
}

function loadEnv() {
  const p = path.join(__dirname, '..', 'deploy.env');
  if (!fs.existsSync(p)) throw new Error('缺少 deploy.env（复制 deploy.env.example 并填写 SSH 参数）');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_PATH']) {
    if (!env[key]) throw new Error(`deploy.env 缺少 ${key}`);
  }
  return env;
}

function artifactName(platform, version) {
  const ext = platform.startsWith('win') ? 'exe' : 'dmg';
  return `BulletChat-${version}-${platform}.${ext}`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchRemoteManifest() {
  try {
    const res = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return null; // 首次发布
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseManifest(await res.text());
  } catch (err) {
    // 网络错误/超时/解析失败：中止，防止把另一平台条目误删成空 manifest
    throw new Error(`拉取远程 version.json 失败（${err.message}），已中止，未上传任何文件`);
  }
}

function hasRsync() {
  try { execFileSync('rsync', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function main() {
  const { platform, notes } = parseArgs(process.argv);
  if (!VALID_PLATFORMS.includes(platform)) {
    console.error(`用法：node tools/publish-update.js --platform ${VALID_PLATFORMS.join('|')} [--notes "说明"]`);
    process.exit(1);
  }
  const env = loadEnv();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const name = artifactName(platform, pkg.version);
  const src = path.join(__dirname, '..', 'dist', name);
  if (!fs.existsSync(src)) {
    console.error(`未找到产物：dist/${name}（先构建：npm run build:${platform.startsWith('win') ? 'win' : 'mac'}，mac-x64 需 --x64）`);
    process.exit(1);
  }
  const sha256 = sha256File(src);
  const stage = path.join(__dirname, '..', 'dist', 'updates');
  fs.mkdirSync(stage, { recursive: true });

  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
  const sshBase = ['-i', env.DEPLOY_SSH_KEY, '-o', 'StrictHostKeyChecking=accept-new'];

  fetchRemoteManifest().then((remoteManifest) => {
    const url = UPDATE_URL.replace(/version\.json$/, '') + name;
    const manifest = mergeForPublish({ remoteManifest, platform, version: pkg.version, notes, url, sha256 });
    fs.writeFileSync(path.join(stage, 'version.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.copyFileSync(src, path.join(stage, name));
    console.log(`已生成：version.json（version=${manifest.version}）+ ${name}（sha256 ${sha256.slice(0, 12)}…）`);

    const dest = `${env.DEPLOY_USER}@${env.DEPLOY_HOST}:${env.DEPLOY_PATH}`;
    if (hasRsync()) {
      // macOS：rsync 整目录（含 version.json + 安装包），-e 传 ssh 参数
      run('rsync', ['-az', '-e', `ssh ${sshBase.join(' ')}`, stage + '/', dest + '/']);
    } else {
      // Windows 无 rsync：scp 按文件逐个传
      for (const f of ['version.json', name]) {
        run('scp', [...sshBase, path.join(stage, f), `${env.DEPLOY_USER}@${env.DEPLOY_HOST}:${env.DEPLOY_PATH}/${f}`]);
      }
    }
    run('ssh', [...sshBase, `${env.DEPLOY_USER}@${env.DEPLOY_HOST}`, `chown -R www:www ${env.DEPLOY_PATH}`]);
    console.log(`已发布 → https://updates.zhipengcoding.com/${name}`);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

main();
```

- [ ] **Step 2: 语法检查 + 试运行（不带 --platform 应报用法）**

Run: `cd /Users/szp/project/bullet_chat && node --check tools/publish-update.js && node tools/publish-update.js`
Expected: `--check` 无输出；试运行打印用法并 exit 1（`用法：node tools/publish-update.js --platform win-x64|mac-arm64|mac-x64 ...`）

- [ ] **Step 3: 本地复制 deploy.env 并验证产物检测**

Run: `cd /Users/szp/project/bullet_chat && cp deploy.env.example deploy.env && node tools/publish-update.js --platform mac-arm64`
Expected: 报 `未找到产物：dist/BulletChat-0.1.0-mac-arm64.dmg`（dist/ 下当前是旧的 `BulletChat Setup 0.1.0.exe` 等，属预期——验证了产物名匹配逻辑）

- [ ] **Step 4: 全量回归 + 提交**

Run: `cd /Users/szp/project/bullet_chat && npm test`
Expected: 173 全绿

```bash
cd /Users/szp/project/bullet_chat
git add tools/publish-update.js
git commit -m "feat: 发布脚本单平台上传（sha256/manifest 合并/rsync-scp 自动选择）"
```

---

### Task 9: 服务器部署 updates.zhipengcoding.com + README

**Files:**
- Modify: `README.md`（发布新版说明）
- 服务器（SSH 操作，按 `~/Documents/个人/baota-subdomain-deployment-sop.md` 执行）：Nginx 静态站点 + 泛域名证书 + 宝塔 site.db 登记

**Interfaces:**
- Consumes: 服务器 your-server-ip（root + `/path/to/your-ssh-key.pem`）、已生效 DNS（`updates.zhipengcoding.com` A → your-server-ip，2026-08-08 已验证）
- Produces: `https://updates.zhipengcoding.com/` 静态站点（version.json 与安装包根目录直放）、宝塔面板可见站点

- [ ] **Step 1: 检查 SSH 连通与现有环境**

```bash
ssh -i /path/to/your-ssh-key.pem -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new root@your-server-ip "ls /www/server/panel/vhost/cert/zhipengcoding.com/ && ls /www/wwwroot/ | head -20"
```
Expected: 列出证书目录文件（记录实际证书文件名，Step 2 用）与现有站点目录

- [ ] **Step 2: 创建目录 + 写 Nginx 配置**

```bash
ssh -i /path/to/your-ssh-key.pem root@your-server-ip "mkdir -p /www/wwwroot/updates.zhipengcoding.com /www/server/panel/vhost/nginx/well-known/updates.zhipengcoding.com.conf.d /www/server/panel/vhost/nginx/extension/updates.zhipengcoding.com"
```

用 heredoc 写入 `/www/server/panel/vhost/nginx/updates.zhipengcoding.com.conf`（证书文件名以 Step 1 实际 ls 结果为准，宝塔泛域名证书通常是 `fullchain.pem` + `privkey.pem`）：

```nginx
server {
    listen 80;
    listen 443 ssl http2;
    server_name updates.zhipengcoding.com;
    root /www/wwwroot/updates.zhipengcoding.com;
    index index.html;
    ssl_certificate /www/server/panel/vhost/cert/zhipengcoding.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/zhipengcoding.com/privkey.pem;
    location / {
        try_files $uri =404;
    }
    # version.json 不缓存：客户端每次检查都拿最新
    location = /version.json {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    #CERT-APPLY-CHECK--START
    include /www/server/panel/vhost/nginx/well-known/updates.zhipengcoding.com.conf;
    #CERT-APPLY-CHECK--END
    include /www/server/panel/vhost/nginx/extension/updates.zhipengcoding.com/*.conf;
    location ~ \.well-known{
        allow all;
    }
    if ( $uri ~ "^/\.well-known/.*\.(php|jsp|py|js|css|lua|ts|go|zip|tar\.gz|rar|7z|sql|bak)$" ) {
        return 403;
    }
}
```

然后：`nginx -t && nginx -s reload`（Expected: `syntax is ok` + `test is successful`）

- [ ] **Step 3: 宝塔登记（先备份 site.db，查重后插入）**

```bash
ssh -i /path/to/your-ssh-key.pem root@your-server-ip "cp /www/server/panel/data/db/site.db /www/server/panel/data/db/site.db.bak.$(date +%Y%m%d%H%M%S) && sqlite3 /www/server/panel/data/db/site.db '.tables'"
```

Expected: 备份成功；列出表（确认 `sites` / `domain` 存在）。若 sqlite3 命令缺失：`yum install -y sqlite` 或 `apt install -y sqlite3` 后重试。

先查后插（避免重复登记；SQL 里的表结构以 `.schema sites` / `.schema domain` 实际输出为准，字段名按 SOP 第 9.4 节）:

```bash
ssh -i /path/to/your-ssh-key.pem root@your-server-ip "sqlite3 /www/server/panel/data/db/site.db \"SELECT id FROM sites WHERE name='updates.zhipengcoding.com'\""
```

- 无输出 → 插入 sites（`INSERT INTO sites (name, path, status, ps, addtime, project_type) VALUES ('updates.zhipengcoding.com', '/www/wwwroot/updates.zhipengcoding.com', '1', '更新下载站', strftime('%s','now'), '0')`，字段名以 .schema 为准）
- 再查 domain（`SELECT id FROM domain WHERE name='updates.zhipengcoding.com' AND port='80'`），无 → 插入（pid 取刚插入的 sites.id，`INSERT INTO domain (pid, name, port, addtime) VALUES (<sites.id>, 'updates.zhipengcoding.com', '80', strftime('%s','now'))`）
- 补配套文件（open_basedir / rewrite / well-known / extension 目录，内容按 SOP 第 9.5 节最小可用）
- `nginx -t && nginx -s reload`

- [ ] **Step 4: 公网验证**

```bash
curl -Iks https://updates.zhipengcoding.com/
curl -Iks https://updates.zhipengcoding.com/version.json
```
Expected: 两者返回 HTTP 404（目录无文件属正常）且 TLS 正常（无证书告警）；`Cache-Control: no-cache` 头在首次发布 version.json 后出现（Step 5 后复验）

- [ ] **Step 5: README 补「发布新版」章节**

`README.md` 在「## 打包」之后追加：

```markdown
## 发布新版（检查更新）

应用内「检查更新」读取 `https://updates.zhipengcoding.com/version.json`（阿里云服务器 Nginx 静态站点，复用泛域名证书）。

发布步骤（各平台在自己电脑上操作）：

1. 升级版本号：`npm version patch`（或手改 package.json）
2. 构建：Windows 包 `npm run build:win`；macOS 包 `npm run build:mac`（Intel 包加 `--x64`）
3. 首次使用先复制 `deploy.env.example` 为 `deploy.env` 并填写 SSH 参数
4. 发布：`node tools/publish-update.js --platform win-x64 --notes "更新说明"`（mac 用 `mac-arm64`/`mac-x64`）

脚本只更新当前平台条目、保留另一平台条目；自动计算 SHA256、上传安装包 + version.json 并修正属主。用户在应用内「检查更新」→ 下载完整安装包 → 手动安装覆盖旧版。
```

- [ ] **Step 6: 提交**

```bash
cd /Users/szp/project/bullet_chat
git add README.md
git commit -m "docs: README 发布新版（检查更新）说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 架构（updater.js + IPC）→ Task 4/5；§3 协议（per-platform version/notes、sha256、v 前缀解析、超时 10s）→ Task 1/2/3；§4 交互（托盘/设置页/启动自检/忽略/下载 .part+单飞+before-quit）→ Task 4/5/6；§5 服务器 → Task 9；§6 发布脚本（--platform 架构感知、404 新建/错误中止、暂存目录整体上传、rsync/scp、deploy.env）→ Task 7/8；§7 错误表 → Task 4（message 映射）；§8 测试清单 → Task 1/2/3/5；§9 文件清单 → 全部覆盖（含 main.js notify 保留实例——Task 4 的 showNotification；Cache-Control——Task 9）
- **注意点**：Task 5 Step 5e 已处理 updater 变量作用域（模块级 let）；Task 8 已标注删掉占位样板；系统 Node 需 ≥18.4（web stream async iteration），macOS 当前 Node 版本在 Step 4 失败时核对
