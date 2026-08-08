const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, compareVersions, platformKey } = require('../src/shared/updaterCore');

test('parseVersion 基础解析', () => {
  assert.deepEqual(parseVersion('0.2.0'), [0, 2, 0]);
  assert.deepEqual(parseVersion('v0.2.0'), [0, 2, 0], 'v 前缀被去除');
  assert.deepEqual(parseVersion('V1.2.3'), [1, 2, 3], '大写 V 前缀也去除');
  assert.deepEqual(parseVersion('1.2'), [1, 2], '不足 3 段合法');
  assert.deepEqual(parseVersion('1.2.3.4'), [1, 2, 3], '超过 3 段只取前 3');
  assert.deepEqual(parseVersion('0.9.0'), [0, 9, 0]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0], '两位数段正常');
});

test('parseVersion 非法输入返回 null', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('abc'), null);
  assert.equal(parseVersion('0.2.0-beta'), null, '非数字段非法');
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion(123), null, '非字符串非法');
});

test('compareVersions 数字逐段比较', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1, '逐段数字比较，0.9 < 0.10');
  assert.equal(compareVersions('1.2', '1.2.0'), 0, '缺段补 0');
  assert.equal(compareVersions('1.2', '1.3'), -1);
});

test('compareVersions 非法输入返回 null', () => {
  assert.equal(compareVersions('abc', '0.1.0'), null);
  assert.equal(compareVersions('0.1.0', 'abc'), null);
});

test('platformKey 平台映射', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'mac-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'mac-x64');
  assert.equal(platformKey('win32', 'x64'), 'win-x64');
  assert.equal(platformKey('win32', 'arm64'), null, '未发布的架构组合');
  assert.equal(platformKey('linux', 'x64'), null);
  assert.equal(platformKey('darwin', 'ia32'), null);
});
