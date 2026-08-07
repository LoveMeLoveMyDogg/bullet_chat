const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMacFront, parseBundleId, parseWinLine, AppWatcher } = require('../src/main/appWatcher');

test('parseMacFront 解析 lsappinfo front 输出', () => {
  assert.equal(parseMacFront('frontASN = ASN:0x0-0x1234:com.microsoft.VSCode'), 'com.microsoft.VSCode');
  assert.equal(parseMacFront('frontASN = ASN:0x0-0x1234:com.google.chrome\n'), 'com.google.chrome');
  assert.equal(parseMacFront('ASN:0x0-0x11011:'), 'ASN:0x0-0x11011', 'macOS 26 裸 ASN 格式（去结尾冒号）');
  assert.equal(parseMacFront('ASN:0x0-0x11011'), 'ASN:0x0-0x11011', '裸 ASN 无结尾冒号');
  assert.equal(parseMacFront(''), null);
  assert.equal(parseMacFront('lsappinfo: no front app'), null);
});

test('parseBundleId 解析 lsappinfo info -only bundleid 输出', () => {
  assert.equal(parseBundleId('"CFBundleIdentifier"="com.apple.finder"'), 'com.apple.finder');
  assert.equal(parseBundleId('"com.apple.finder"'), 'com.apple.finder', '裸引号形式');
  assert.equal(parseBundleId(''), null);
  assert.equal(parseBundleId('(null)'), null);
});

test('parseWinLine 解析 PowerShell 输出', () => {
  assert.deepEqual(parseWinLine('code|main.js - Visual Studio Code'), { appKey: 'code', title: 'main.js - Visual Studio Code' });
  assert.deepEqual(parseWinLine('chrome|'), { appKey: 'chrome', title: '' });
  assert.equal(parseWinLine(''), null);
});

test('AppWatcher 切换检测与停留播报（假时钟）', async () => {
  let now = 1000000;
  const events = [];
  const stays = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => now, platform: 'darwin',
    exec: (_cmd, _args, cb) => cb(null, 'frontASN = ASN:0x0-0x1234:com.microsoft.VSCode'),
    onEvent: (e) => events.push(e),
    onStay: (e) => stays.push(e),
    stayMinutes: 20,
  });
  await fw.poll();
  assert.equal(events.length, 1, '首次探测发切换事件');
  assert.equal(events[0].appKey, 'com.microsoft.VSCode');
  assert.equal(events[0].name, 'VSCode', '显示名映射');
  now += 2 * 60 * 1000; // 2 分钟后同应用
  await fw.poll();
  assert.equal(events.length, 1, '同应用不发切换事件');
  now += 20 * 60 * 1000; // 满 20 分钟
  await fw.poll();
  assert.equal(stays.length, 1, '停留超时播报一次');
  assert.equal(stays[0].minutes, 20);
  assert.equal(events.length, 1, '停留不触发切换事件');
  now += 20 * 60 * 1000; // 再 20 分钟（已重置计时）
  await fw.poll();
  assert.equal(stays.length, 2, '停留重置后再次播报');
});

test('AppWatcher 切应用重置停留计时并二次播报', async () => {
  let now = 1000000;
  let current = 'com.microsoft.VSCode';
  const events = [];
  const stays = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => now, platform: 'darwin',
    exec: (_cmd, _args, cb) => cb(null, `frontASN = ASN:0x0-0x1234:${current}`),
    onEvent: (e) => events.push(e),
    onStay: (e) => stays.push(e),
    stayMinutes: 20,
  });
  await fw.poll();
  now += 25 * 60 * 1000;
  await fw.poll();
  assert.equal(stays.length, 1);
  current = 'com.google.chrome'; // 切到另一个应用
  now += 1000;
  await fw.poll();
  assert.equal(events.length, 2, '切换应用发新事件');
  now += 25 * 60 * 1000;
  await fw.poll();
  assert.equal(stays.length, 2, '新应用停留重新计时');
  assert.equal(stays[1].appKey, 'com.google.chrome');
});

test('AppWatcher 无前台应用跳过（锁屏）', async () => {
  const events = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => 0, platform: 'darwin',
    exec: (_cmd, _args, cb) => cb(null, ''),
    onEvent: (e) => events.push(e), onStay: () => {},
    stayMinutes: 20,
  });
  await fw.poll();
  assert.equal(events.length, 0);
});

test('AppWatcher 两步探测（macOS 26 裸 ASN → lsappinfo info 取 bundle id）', async () => {
  const events = [];
  const calls = [];
  const fw = new AppWatcher({
    pollMs: 1000, clock: () => 1000000, platform: 'darwin',
    exec: (_cmd, args, cb) => {
      calls.push(args);
      if (args[0] === 'front') return cb(null, 'ASN:0x0-0x11011:');
      if (args[0] === 'info') return cb(null, '"CFBundleIdentifier"="com.apple.finder"');
      cb(new Error('unexpected args'));
    },
    onEvent: (e) => events.push(e), onStay: () => {},
    stayMinutes: 20,
  });
  await fw.poll();
  assert.deepEqual(calls, [['front'], ['info', 'ASN:0x0-0x11011', '-only', 'bundleid']], '两次调用：front 后按 ASN 查 bundle id');
  assert.equal(events.length, 1, '切换事件触发');
  assert.equal(events[0].appKey, 'com.apple.finder');
  assert.equal(events[0].name, '访达', '显示名映射');
});
