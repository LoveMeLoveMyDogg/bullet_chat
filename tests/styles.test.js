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

test('buildSystemPrompt 含随机角色阵容与可配回复条数', () => {
  const p = buildSystemPrompt(['阴阳怪气损友'], ['毒舌', '猫系', '恋爱脑'], 10);
  assert.ok(p.includes('毒舌、猫系、恋爱脑'));
  assert.ok(p.includes('一次返回 10 条'));
  const p5 = buildSystemPrompt(['阴阳怪气损友'], [], 5);
  assert.ok(p5.includes('一次返回 5 条'));
});

test('buildSystemPrompt 场景注入', () => {
  const noScene = buildSystemPrompt(['玩梗'], [], 10);
  assert.ok(!noScene.includes('当前场景'));
  const withScene = buildSystemPrompt(['玩梗'], ['秃头架构师'], 10, '你是一群程序员观众');
  assert.ok(withScene.includes('当前场景：你是一群程序员观众'));
  assert.ok(withScene.includes('秃头架构师'));
});
