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
