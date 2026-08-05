const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STYLE_POOL, pickStyles, buildSystemPrompt } = require('../src/shared/styles');

test('风格池 ≥10 种', () => {
  assert.ok(STYLE_POOL.length >= 10);
});

test('pickStyles 返回不重复子集', () => {
  const picked = pickStyles(3, () => 0);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
});

test('buildSystemPrompt 包含风格与 JSON 要求与示例', () => {
  const p = buildSystemPrompt(['阴阳怪气损友']);
  assert.ok(p.includes('阴阳怪气损友'));
  assert.ok(p.includes('JSON'));
  assert.ok(p.includes('新建了文件夹不改名字吗'));
});

const { ROLE_POOL, pickRoles } = require('../src/shared/styles');

test('角色池 ≥15 种', () => {
  assert.ok(ROLE_POOL.length >= 15);
});

test('pickRoles 返回来自池子的不重复子集', () => {
  const picked = pickRoles(4, () => 0);
  assert.equal(picked.length, 4);
  assert.equal(new Set(picked).size, 4);
  for (const r of picked) assert.ok(ROLE_POOL.includes(r));
});

test('buildSystemPrompt 含随机角色阵容', () => {
  const p = buildSystemPrompt(['阴阳怪气损友'], ['毒舌', '猫系', '恋爱脑']);
  assert.ok(p.includes('毒舌、猫系、恋爱脑'));
  assert.ok(p.includes('8~10 条'));
});
