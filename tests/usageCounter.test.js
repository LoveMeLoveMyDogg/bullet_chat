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

test('跨天切换：新一天从当日文件恢复计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  let fakeNow = Date.parse('2026-08-07T23:00:00Z');
  const uc = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc.record({ channel: 'text', inputChars: 10, systemChars: 10, parsedCount: 3 });
  assert.equal(uc.getToday().text.calls, 1);
  // 跨天：记录一条 8/8，内存应只剩 8/8 的（7 日记录已落盘）
  fakeNow = Date.parse('2026-08-08T01:00:00Z');
  uc.record({ channel: 'vision', inputChars: 10, systemChars: 10, imageKb: 58 });
  assert.equal(uc.getToday().text.calls, 0, '8/8 内存不含 7/7 记录');
  assert.equal(uc.getToday().vision.calls, 1);
  // 新实例从落盘文件恢复 8/8
  const uc2 = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc2.record({ channel: 'text', inputChars: 1, systemChars: 1 });
  assert.equal(uc2.getToday().vision.calls, 1, '重启后从当日文件恢复');
  assert.equal(uc2.getToday().text.calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('7 天保留：过期文件自动清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  // 伪造 10 天前的文件
  fs.writeFileSync(path.join(dir, 'usage-2026-07-28.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'usage-2026-08-06.jsonl'), '{}\n');
  const uc = new UsageCounter({ dir, clock: () => Date.parse('2026-08-07T10:00:00Z'), fsMod: fs });
  uc.record({ channel: 'text', inputChars: 1, systemChars: 1 });
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('usage-'));
  assert.ok(!files.includes('usage-2026-07-28.jsonl'), '10 天前文件被清理');
  assert.ok(files.includes('usage-2026-08-06.jsonl'), '1 天前文件保留');
  assert.ok(files.includes('usage-2026-08-07.jsonl'), '当日文件存在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aggregate 分通道与合计（含失败与产出）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => Date.parse('2026-08-07T10:00:00Z'), fsMod: fs });
  uc.record({ channel: 'text', inputChars: 100, systemChars: 200, outputChars: 300, parsedCount: 5 });
  uc.record({ channel: 'text', inputChars: 100, systemChars: 100, error: new Error('401') });
  uc.record({ channel: 'vision', inputChars: 0, systemChars: 50, imageKb: 58, outputChars: 100, parsedCount: 3 });
  const t = uc.getToday();
  assert.equal(t.text.calls, 2);
  assert.equal(t.text.failed, 1);
  assert.equal(t.text.danmaku, 5);
  assert.equal(t.vision.calls, 1);
  assert.equal(t.vision.inputTokens, Math.ceil(50 / 1.5) + Math.ceil(58 * 12));
  assert.equal(t.total.calls, 3);
  assert.equal(t.total.failed, 1);
  assert.equal(t.total.danmaku, 8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('跨午夜无新记录：getToday/getHistory 主动切日，不显示昨日残留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  let fakeNow = Date.parse('2026-08-07T23:59:00Z');
  const uc = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc.record({ channel: 'text', inputChars: 10, systemChars: 10 });
  assert.equal(uc.getToday().total.calls, 1);
  // 跨午夜后无任何新记录：getToday/getHistory 也应切到新一天（8/8 无记录）
  fakeNow = Date.parse('2026-08-08T00:01:00Z');
  assert.equal(uc.getToday().total.calls, 0, 'getToday 不应显示昨日残留');
  assert.equal(uc.getHistory(1)[0].date, '2026-08-08', 'getHistory 按新一天计算');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getHistory 返回近 7 天（含空天）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  let fakeNow = Date.parse('2026-08-07T10:00:00Z');
  const uc = new UsageCounter({ dir, clock: () => fakeNow, fsMod: fs });
  uc.record({ channel: 'text', inputChars: 10, systemChars: 10 });
  const h = uc.getHistory(7);
  assert.equal(h.length, 7);
  assert.equal(h[0].date, '2026-08-01');
  assert.equal(h[6].date, '2026-08-07');
  assert.equal(h[6].calls, 1);
  assert.equal(h[0].calls, 0, '空天为 0');
  fs.rmSync(dir, { recursive: true, force: true });
});
