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

const { laneTopFor, laneCountFor } = require('../src/shared/danmakuStyle');

test('laneTopFor 三种位置与默认', () => {
  // 顶部（默认）：固定从 6 开始，间距 78
  assert.equal(laneTopFor('top', 0, 6, 600), 6);
  assert.equal(laneTopFor('top', 2, 6, 600), 6 + 2 * 78);
  assert.equal(laneTopFor(undefined, 1, 6, 600), 6 + 78); // 未知值回退顶部
  // 中间：垂直居中（(600 - 6*78)/2 = 66）
  assert.equal(laneTopFor('middle', 0, 6, 600), 66);
  assert.ok(laneTopFor('middle', 0, 6, 600) >= 6);
  // 全屏：均匀分布
  assert.equal(laneTopFor('full', 0, 6, 600), 6);
  assert.equal(laneTopFor('full', 3, 6, 600), Math.round(600 / 6 * 3) + 6);
});

test('laneCountFor top/middle 收敛到顶部/中部区域（40% 视口高）', () => {
  // 用户场景：maxConcurrent=10、1112px 屏 → 顶部只放得下 5 条（78px 间距）
  assert.equal(laneCountFor('top', 10, 1112), 5);
  assert.equal(laneCountFor('middle', 10, 1112), 5);
  // 默认 600px 视口 → 3 条
  assert.equal(laneCountFor('top', 6, 600), 3);
  // 轨道数小于上限时保持原值
  assert.equal(laneCountFor('top', 2, 1112), 2);
  // 至少 1 条
  assert.equal(laneCountFor('top', 1, 100), 1);
  // 未知位置回退顶部
  assert.equal(laneCountFor(undefined, 6, 600), 3);
});

test('laneCountFor full 全屏：只受屏幕高度约束', () => {
  assert.equal(laneCountFor('full', 10, 1112), 10); // 10 条未超屏
  assert.equal(laneCountFor('full', 20, 1112), 14); // 超过屏高上限截断
});

test('顶部/中间位置：轨道块落在对应区域内', () => {
  const H = 1112;
  // top：末条轨道底部不超出顶部区域（40% 视口高）
  const n = laneCountFor('top', 10, H);
  const lastTop = laneTopFor('top', n - 1, n, H);
  assert.ok(lastTop + 72 <= H * 0.4, '轨道全部落在顶部区域内');
  // middle：轨道块垂直居中（块顶 (H-块高)/2，块底 (H+块高)/2）
  const m = laneCountFor('middle', 10, H);
  const firstMid = laneTopFor('middle', 0, m, H);
  const lastMid = laneTopFor('middle', m - 1, m, H);
  assert.equal(firstMid, Math.round((H - m * 78) / 2), '块顶居中');
  assert.ok(Math.abs((firstMid + lastMid + 72) / 2 - H / 2) <= 10, '轨道块垂直居中');
  assert.ok(lastMid + 72 <= H * 0.7, '不超出中带');
});
