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
  assert.equal(defaultConfig().visionModel.captureIntervalSec, 8);
  assert.equal(defaultConfig().danmaku.minIntervalSec, 10);
});

test('弹幕外观默认值', () => {
  const d = defaultConfig().danmaku;
  assert.equal(d.fontSizeMin, 30);
  assert.equal(d.fontSizeMax, 39);
  assert.deepEqual(d.colors, []);
  assert.equal(d.speed, 1);
  assert.deepEqual(d.animations, ['fly']); // 默认只保留横飘
  assert.equal(d.readFileContent, true); // 默认读取文件内容片段
  assert.equal(d.minIntervalVisionSec, 10); // 视觉独立限速默认 10s
  assert.equal(d.position, 'top'); // 弹幕默认顶部
  assert.equal(d.replyCount, 10); // 一次 AI 回复条数默认 10
  assert.equal(d.animationsEnabled, undefined); // 旧键已移除
});

test('旧配置 animationsEnabled 被迁移丢弃并回退新默认', () => {
  const merged = mergeConfig(defaultConfig(), { danmaku: { animationsEnabled: true } });
  assert.equal(merged.danmaku.animationsEnabled, undefined);
  assert.deepEqual(merged.danmaku.animations, ['fly']);
  assert.equal(merged.danmaku.fontSizeMin, 30);
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

test('S1-5 损坏 JSON 触发 onCorrupt 且返回默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ 这不是合法 JSON');
  const corrupted = [];
  const cfg = loadConfigFile(file, fs, dec, (info) => corrupted.push(info));
  assert.equal(cfg.textModel.model, 'deepseek-chat', '损坏后回默认配置');
  assert.equal(corrupted.length, 1);
  assert.equal(corrupted[0].file, file);
  assert.ok(corrupted[0].error instanceof Error);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S1-5 正常 JSON 与缺失文件不触发 onCorrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  const corrupted = [];
  // 缺失（首次运行）：不算损坏
  const miss = loadConfigFile(file, fs, dec, () => corrupted.push(1));
  assert.equal(miss.textModel.model, 'deepseek-chat');
  assert.equal(corrupted.length, 0, '缺失文件不触发');
  // 正常内容
  saveConfigFile(file, defaultConfig(), fs, enc);
  loadConfigFile(file, fs, dec, () => corrupted.push(1));
  assert.equal(corrupted.length, 0, '正常 JSON 不触发');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S1-5 解密失败视为损坏（safeStorage 密钥变化场景）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  const cfg = defaultConfig();
  cfg.textModel.apiKey = 'sk-x';
  saveConfigFile(file, cfg, fs, enc);
  const corrupted = [];
  // 用永远抛错的 decrypter 模拟系统密钥变化后旧密文不可解
  const badDec = () => { throw new Error('decrypt failed'); };
  const out = loadConfigFile(file, fs, badDec, (info) => corrupted.push(info));
  assert.equal(corrupted.length, 1, '解密失败走损坏路径');
  assert.equal(out.textModel.apiKey, '', '回默认（明文 key 为空）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S1-5 未传 onCorrupt 时不抛异常（向后兼容）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{bad');
  assert.doesNotThrow(() => {
    const cfg = loadConfigFile(file, fs, dec);
    assert.equal(cfg.textModel.model, 'deepseek-chat');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
