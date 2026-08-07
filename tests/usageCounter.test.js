const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimateTokens, dataUrlKb, UsageCounter } = require('../src/shared/usageCounter');

test('estimateTokens 估算规则', () => {
  assert.deepEqual(estimateTokens({ inputChars: 150, systemChars: 150, outputChars: 150 }), { input: 200, output: 100 });
  assert.equal(estimateTokens({ inputChars: 0, systemChars: 0, outputChars: 0 }).input, 0);
  assert.equal(estimateTokens({ inputChars: 1, systemChars: 0, outputChars: 0 }).input, 1, '至少 1');
  // 视觉：截图 KB 额外计入 input
  assert.equal(estimateTokens({ inputChars: 0, systemChars: 0, outputChars: 0, imageKb: 58 }).input, 696);
});

test('dataUrlKb 估算截图 KB', () => {
  // base64：4 字符 ≈ 3 字节；"AAAA" = 3 字节
  assert.equal(dataUrlKb('data:image/jpeg;base64,AAAA'), 0);
  // 构造 ~10KB 的 dataUrl
  const b64 = 'A'.repeat(Math.ceil(10 * 1024 * 4 / 3));
  assert.equal(dataUrlKb('data:image/jpeg;base64,' + b64), 10);
  assert.equal(dataUrlKb(''), 0);
  assert.equal(dataUrlKb('not-a-data-url'), 0);
});

test('UsageCounter record 记录并估算 token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => Date.parse('2026-08-07T10:00:00Z'), fsMod: fs });
  const e = uc.record({ channel: 'text', inputChars: 100, systemChars: 200, outputChars: 300, parsedCount: 5 });
  assert.equal(e.channel, 'text');
  assert.deepEqual(e.tokens, { input: 200, output: 200 });
  assert.equal(e.parsedCount, 5);
  assert.equal(e.error, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UsageCounter 失败也记录（error 字段）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  const e = uc.record({ channel: 'vision', inputChars: 10, systemChars: 10, error: new Error('401') });
  assert.equal(e.error, '401');
  assert.equal(e.parsedCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UsageCounter 未知通道按文字通道处理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  uc.record({ channel: 'weird', inputChars: 1, systemChars: 1 });
  assert.equal(uc.getToday().text.calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
