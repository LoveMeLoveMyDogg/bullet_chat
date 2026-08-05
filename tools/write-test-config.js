// 实机测试用配置写入脚本：把测试配置写进 Electron userData
// 用法: node tools/write-test-config.js
// userData = Windows: %APPDATA%/bullet-chat；macOS: ~/Library/Application Support/bullet-chat
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const userData = process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'bullet-chat')
  : path.join(os.homedir(), 'Library', 'Application Support', 'bullet-chat');
const cfgPath = path.join(userData, 'config.json');

const TEST_CONFIG = {
  textModel: { baseUrl: 'http://127.0.0.1:3999', apiKey: 'sk-mock', model: 'mock-model' },
  visionModel: { enabled: true, baseUrl: 'http://127.0.0.1:3999', apiKey: 'sk-mock', model: 'mock-vision', captureIntervalSec: 2 },
  monitor: { drives: [], noiseRules: [], masks: [], privacyAcknowledged: true },
  danmaku: { minIntervalSec: 0, batchIntervalMs: 2000, maxConcurrent: 6, styles: [], animations: ['fly'], fontSizeMin: 30, fontSizeMax: 39, colors: [], speed: 1, localMode: false },
  system: { autostart: false },
};

if (fs.existsSync(cfgPath)) {
  const bak = cfgPath + '.bak-test';
  fs.copyFileSync(cfgPath, bak);
  console.log('已备份现有配置到', bak);
}
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(TEST_CONFIG, null, 2), 'utf8');
console.log('测试配置已写入', cfgPath);
