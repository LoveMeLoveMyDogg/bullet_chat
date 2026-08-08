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
