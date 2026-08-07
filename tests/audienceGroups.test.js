const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveGroup, BUILTIN_GROUPS, DEFAULT_APP_GROUPS } = require('../src/shared/audienceGroups');

test('内置 5 组观众群结构完整', () => {
  assert.equal(Object.keys(BUILTIN_GROUPS).length, 5);
  for (const [name, g] of Object.entries(BUILTIN_GROUPS)) {
    assert.ok(g.roles.length >= 3, `${name} 至少 3 个角色`);
    assert.ok(g.scene.length > 0, `${name} 有场景人设`);
    assert.ok(g.styles.length >= 2, `${name} 至少 2 个风格`);
  }
});

test('resolveGroup 命中默认绑定（大小写不敏感）', () => {
  const g = resolveGroup('Code', {}, {});
  assert.equal(g.name, '程序员天团');
  assert.ok(Array.isArray(g.roles) && g.roles.length >= 3);
  const g2 = resolveGroup('com.microsoft.vscode', {}, {});
  assert.equal(g2.name, '程序员天团');
});

test('resolveGroup 用户映射优先于默认绑定', () => {
  const g = resolveGroup('code', { code: '摸鱼大队' }, {});
  assert.equal(g.name, '摸鱼大队');
});

test('resolveGroup 自定义群覆盖同名内置群', () => {
  const custom = { '程序员天团': { roles: ['转行程序员'], scene: '自定义场景', styles: ['玩梗'] } };
  const g = resolveGroup('code', {}, custom);
  assert.deepEqual(g.roles, ['转行程序员']);
  assert.equal(g.scene, '自定义场景');
});

test('resolveGroup 未命中返回 null', () => {
  assert.equal(resolveGroup('unknown-app', {}, {}), null);
  assert.equal(resolveGroup('', {}, {}), null);
});

test('默认绑定覆盖主流应用', () => {
  for (const key of ['code', 'chrome', 'msedge', 'wechat', 'winword', 'obsidian', 'steam', 'spotify']) {
    assert.ok(DEFAULT_APP_GROUPS[key], `${key} 有默认观众群`);
  }
});
