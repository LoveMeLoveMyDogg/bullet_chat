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

test('应用/空闲事件模板池非空且可填充', () => {
  for (const t of ['app_switch', 'app_enter', 'app_stay', 'idle']) {
    const list = TEMPLATES[t];
    assert.ok(Array.isArray(list) && list.length >= 20, `${t} 模板 ≥20 条`);
    const text = fillTemplate(templateFor(t, () => 0), { name: 'VSCode', drive: '' });
    assert.ok(text.length > 0 && text.length <= 24);
  }
});

test('fillTemplate 兜底占位符：全部模板填充后不留 { 残留', () => {
  const realistic = { name: 'VSCode', drive: '', minutes: 20 };
  for (const [type, list] of Object.entries(TEMPLATES)) {
    for (const t of list) {
      const out = fillTemplate(t, realistic);
      assert.ok(!out.includes('{'), `${type} 模板残留占位符：${t} → ${out}`);
    }
  }
});

test('app_stay 模板渲染停留分钟数', () => {
  const out = fillTemplate(templateFor('app_stay', () => 0), { name: 'VSCode', drive: '', minutes: 20 });
  assert.ok(out.includes('20 分钟'), `应渲染分钟数，实际：${out}`);
});
