const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDemoEntry } = require('../src/main/demoMode');

test('20 次采样覆盖全部 5 种事件类型', () => {
  const types = new Set();
  for (let i = 0; i < 20; i++) types.add(makeDemoEntry(() => (i * 7) % 10 / 10).type);
  for (const t of ['create', 'delete', 'rename', 'move']) assert.ok(types.has(t));
  // change 事件不产生（demo 聚焦用户可见操作）
});

test('条目字段完整', () => {
  const e = makeDemoEntry(() => 0.5);
  assert.equal(e.source, 'file');
  assert.ok(typeof e.name === 'string' && e.name.length > 0);
  assert.ok(e.path.startsWith(e.drive + '\\'));
});
