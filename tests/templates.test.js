const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATES, templateFor, fillTemplate } = require('../src/shared/templates');

test('每个事件类型模板 ≥20 条且非空', () => {
  for (const type of ['create_folder', 'create_file', 'delete', 'rename', 'move', 'change', 'screen', 'default']) {
    assert.ok(TEMPLATES[type].length >= 20, `${type} 只有 ${TEMPLATES[type].length} 条`);
    for (const t of TEMPLATES[type]) assert.ok(typeof t === 'string' && t.trim().length > 0);
  }
});

test('templateFor 返回所属列表成员', () => {
  const t = templateFor('create_folder', () => 0);
  assert.ok(TEMPLATES.create_folder.includes(t));
  const fallback = templateFor('unknown_type', () => 0);
  assert.ok(TEMPLATES.default.includes(fallback));
});

test('fillTemplate 替换占位符', () => {
  const out = fillTemplate('「{name}」{loc}？', { name: '新建文件夹', drive: 'C:' });
  assert.equal(out, '「新建文件夹」C:？');
  const noDrive = fillTemplate('「{name}」{loc}', { name: 'x', drive: '' });
  assert.equal(noDrive, '「x」');
});
