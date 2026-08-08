// 检查更新纯逻辑：版本解析/比较、平台映射、manifest 求值、发布合并、下载器。
// 与 Electron 无关，node --test 直接可测；fetch/fs 可注入（下载器）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

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

// 校验并解析 manifest 文本 → { version, notes, files }；非法 → throw Error
function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('manifest 不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof data.files !== 'object' || data.files === null || Array.isArray(data.files)) {
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
  const cmp = compareVersions(entry.version, ignoredVersion);
  if (ignoredVersion && cmp !== null && cmp <= 0) {
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
    const v = entry && parseVersion(entry.version);
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

// 下载 url 到 dest：先写 dest.part，SHA256 校验通过后 renameSync 为 dest。
// fetchImpl/fsMod 可注入（默认全局 fetch / node:fs）；signal 中止时清理 .part 后 rethrow
async function downloadToFile({ url, dest, sha256, fetchImpl = fetch, fsMod = fs, onProgress, signal }) {
  const part = dest + '.part';
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let downloaded = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      downloaded += chunk.length;
      hash.update(chunk);
      onProgress?.({ percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0, downloaded, total });
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fsMod.createWriteStream(part));
  } catch (err) {
    try { fsMod.unlinkSync(part); } catch { /* 清理失败不覆盖原错误 */ }
    throw err;
  }
  if (hash.digest('hex') !== String(sha256).toLowerCase()) {
    try { fsMod.unlinkSync(part); } catch { /* 同上 */ }
    throw new Error('sha256 校验失败');
  }
  try {
    fsMod.renameSync(part, dest);
  } catch (err) {
    try { fsMod.unlinkSync(part); } catch { /* 清理失败不覆盖原错误 */ }
    throw err;
  }
  return dest;
}

module.exports = {
  parseVersion, compareVersions, platformKey,
  parseManifest, evaluateManifest, maxVersion, mergeForPublish, downloadToFile,
};
