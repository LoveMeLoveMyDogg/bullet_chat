const { test } = require('node:test');
const assert = require('node:assert/strict');
const { displayNameFor } = require('../src/shared/appNames');

test('displayNameFor 内置映射 + 用户别名优先 + 未命中回退', () => {
  assert.equal(displayNameFor('Code'), 'VSCode');      // Windows 进程名（大小写不敏感）
  assert.equal(displayNameFor('code'), 'VSCode');
  assert.equal(displayNameFor('com.microsoft.VSCode'), 'VSCode'); // macOS bundle id
  assert.equal(displayNameFor('com.google.chrome'), '浏览器');
  // 用户别名优先于内置表
  assert.equal(displayNameFor('chrome', { chrome: '大浏览器' }), '大浏览器');
  // 未命中回退原始值
  assert.equal(displayNameFor('weird-app.xyz'), 'weird-app.xyz');
});
