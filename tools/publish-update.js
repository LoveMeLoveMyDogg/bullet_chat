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
  fs.rmSync(stage, { recursive: true, force: true }); // 清空上次暂存，防止残留文件被重复上传
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

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
