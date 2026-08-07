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

test('updateIdle 状态机：无变化超阈值播报一次，恢复后重新计时', () => {
  const { ScreenWatcher } = require('../src/main/screenWatcher');
  let fakeNow = 1000000;
  const idleEvents = [];
  const sw = new ScreenWatcher({
    config: { visionModel: {} },
    getMasks: () => [], processor: { process: async (d, m) => d },
    onEntry: () => {}, onError: () => {}, onRecovered: () => {},
    idleMinutes: 10, onIdle: (e) => idleEvents.push(e),
    clock: () => fakeNow,
  });
  // 前 9 分钟：无变化但未到阈值
  fakeNow += 9 * 60 * 1000;
  assert.equal(sw.updateIdle(false), null);
  assert.equal(idleEvents.length, 0);
  // 第 11 分钟：触发
  fakeNow += 2 * 60 * 1000;
  const e = sw.updateIdle(false);
  assert.equal(e.type, 'idle');
  assert.equal(idleEvents.length, 1);
  // 已播报：继续无变化不再播
  fakeNow += 60 * 1000;
  assert.equal(sw.updateIdle(false), null);
  assert.equal(idleEvents.length, 1);
  // 画面恢复：重新计时
  sw.updateIdle(true);
  fakeNow += 11 * 60 * 1000;
  assert.equal(sw.updateIdle(false).type, 'idle');
  assert.equal(idleEvents.length, 2);
  // idleMinutes=0 关闭
  const sw0 = new ScreenWatcher({ config: {}, getMasks: () => [], onEntry: () => {}, onError: () => {}, onRecovered: () => {}, idleMinutes: 0, clock: () => fakeNow });
  assert.equal(sw0.updateIdle(false), null);
});
