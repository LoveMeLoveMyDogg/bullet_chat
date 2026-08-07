const fs = require('node:fs');
const path = require('node:path');

const KNOWN_KEYS = {
  textModel: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
  visionModel: { enabled: false, baseUrl: '', apiKey: '', model: '', captureIntervalSec: 8 },
  monitor: { drives: [], noiseRules: [], masks: [], privacyAcknowledged: false },
  danmaku: { minIntervalSec: 10, minIntervalVisionSec: 10, batchIntervalMs: 5000, maxConcurrent: 6, styles: [], fontSizeMin: 30, fontSizeMax: 39, colors: [], speed: 1, animations: ['fly'], localMode: false, readFileContent: true, maxEventAgeSec: 120, position: 'top', burstMin: 2, burstMax: 8, replyCount: 10 },
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

// 读取配置：文件不存在（首次运行）返回默认且不视为损坏；
// JSON 解析失败或解密失败（如 safeStorage 密钥变化）时，若提供 onCorrupt 则回调告知，随后返回默认
function loadConfigFile(file, fsMod, decrypter, onCorrupt = null) {
  try {
    const raw = fsMod.readFileSync(file, 'utf8');
    return parseConfig(JSON.parse(raw), decrypter);
  } catch (err) {
    if (err.code !== 'ENOENT') onCorrupt?.({ file, error: err });
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
