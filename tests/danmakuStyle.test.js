const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickFontSize, pickColor, pickAnimation, durationFor,
  BASE_DURATIONS, DEFAULT_COLOR,
} = require('../src/shared/danmakuStyle');

test('pickFontSize 范围与边界', () => {
  assert.equal(pickFontSize(20, 20, () => 0.99), 20); // min==max 固定
  const v = pickFontSize(30, 39, () => 0.5);
  assert.ok(v >= 30 && v <= 39);
  assert.equal(pickFontSize(40, 30, () => 0), 40); // min>max 校正为 min
  assert.equal(pickFontSize(undefined, undefined, () => 0), 30); // 缺省回退
});

test('pickColor 空列表返回白色，多个随机，过滤空串', () => {
  assert.equal(pickColor([], () => 0), DEFAULT_COLOR);
  assert.equal(pickColor(['red'], () => 0), 'red'); // 一个=全同色
  const c = pickColor(['red', 'blue'], () => 0.9);
  assert.ok(['red', 'blue'].includes(c));
  assert.equal(pickColor(['', '  ', 'green'], () => 0), 'green');
  assert.equal(pickColor(undefined, () => 0), DEFAULT_COLOR);
});

test('pickAnimation 空列表返回 null，过滤未知动画', () => {
  assert.equal(pickAnimation([], () => 0), null);
  assert.equal(pickAnimation(['fly'], () => 0), 'fly');
  assert.equal(pickAnimation(['bogus', 'drop'], () => 0.9), 'drop');
  assert.equal(pickAnimation(undefined, () => 0), null);
});

test('durationFor 倍速缩放与兜底', () => {
  assert.equal(BASE_DURATIONS.fly, 9000);
  assert.equal(durationFor('fly', 1), 9000);
  assert.equal(durationFor('fly', 2), 4500);
  assert.equal(durationFor('drop', 0.5), 12000);
  assert.equal(durationFor('pop', 2), 1500);
  assert.equal(durationFor('shake', 2), 600);
  assert.equal(durationFor('bogus', 1), 3000); // 未知动画兜底
  assert.equal(durationFor('fly', 0), 9000); // 0（非法）回退 1x
  assert.equal(durationFor('fly', 0.1), 90000); // 极慢：0.1 下限生效
});
