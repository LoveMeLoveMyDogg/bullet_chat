const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const {
  parseVersion, compareVersions, platformKey,
  parseManifest, evaluateManifest, maxVersion, mergeForPublish, downloadToFile,
} = require('../src/shared/updaterCore');
const sha = (c) => c.repeat(64);

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

test('parseManifest files 为数组被拒绝', () => {
  assert.throws(() => parseManifest(JSON.stringify({ version: '0.2.0', files: [] })), /files/);
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

test('evaluateManifest 垃圾 ignoredVersion 不误判为 ignored', () => {
  const mk = (files) => ({ version: '0.3.0', notes: 'n', files });
  const r = evaluateManifest({
    manifest: mk({ 'win-x64': { version: '0.2.0', url: 'u', sha256: sha('a') } }),
    currentVersion: '0.1.0', platform: 'win32', arch: 'x64', ignoredVersion: 'abc',
  });
  assert.equal(r.status, 'update-available', '非法忽略值不压制更新提示');
});

test('parseManifest 顶层 v 前缀与全大写 sha256 合法', () => {
  const m = parseManifest(JSON.stringify({
    version: 'v0.2.0', notes: '', files: { 'win-x64': { version: '0.2.0', url: 'u', sha256: 'A'.repeat(64) } },
  }));
  assert.equal(m.version, 'v0.2.0');
});

test('evaluateManifest 条目版本非法返回 error', () => {
  const r = evaluateManifest({
    manifest: { version: '0.2.0', notes: '', files: { 'win-x64': { version: 'bad', url: 'u', sha256: 'a'.repeat(64) } } },
    currentVersion: '0.1.0', platform: 'win32', arch: 'x64',
  });
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

test('downloadToFile 重命名失败：抛错并清理 .part', async () => {
  const { server, url } = await startServer((req, res) => { res.end(payload); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'existing-dir'); // 已存在目录 → renameSync 失败
  fs.mkdirSync(dest);
  try {
    await assert.rejects(downloadToFile({ url: url + 'x', dest, sha256: payloadSha }), /EISDIR|ENOTEMPTY|EEXIST|Error/);
    assert.ok(!fs.existsSync(dest + '.part'), '.part 已清理');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile 写盘错误：rejects 而非崩溃，不留 .part', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-dl-'));
  const dest = path.join(dir, 'pkg.bin');
  const failingFs = {
    ...fs,
    createWriteStream: () => new Writable({
      write(_chunk, _enc, cb) { setImmediate(() => cb(new Error('disk full'))); },
    }),
  };
  try {
    await assert.rejects(downloadToFile({ url: url + 'x', dest, sha256: payloadSha, fsMod: failingFs }), /disk full/);
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
