const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pixelDiffRatio } = require('../src/main/screenWatcher');

function makeBuf(w, h, fill) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = fill;
  return buf;
}

test('相同画面差异为 0', () => {
  const a = makeBuf(100, 100, 128);
  assert.equal(pixelDiffRatio(a, Buffer.from(a)), 0);
});

test('完全不同画面差异为 1', () => {
  const a = makeBuf(100, 100, 0);
  const b = makeBuf(100, 100, 255);
  assert.equal(pixelDiffRatio(a, b), 1);
});

test('尺寸不同视为 1（必然变化）', () => {
  assert.equal(pixelDiffRatio(makeBuf(10, 10, 0), makeBuf(20, 20, 0)), 1);
});

test('少数像素变化低于阈值', () => {
  const a = makeBuf(100, 100, 0);
  const b = Buffer.from(a);
  // SAMPLE_STEP=64，采样点索引为 0, 256, 512...；改第一个采样点（i=256 的 BGR 三通道）
  b[256] = 200;
  b[257] = 200;
  b[258] = 200;
  assert.ok(pixelDiffRatio(a, b) > 0);
  assert.ok(pixelDiffRatio(a, b) < 0.01);
});
