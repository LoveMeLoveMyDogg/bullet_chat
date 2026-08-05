const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiError, chatCompletion, visionCompletion, parseDanmakuJson,
  testTextConnection, testVisionConnection,
} = require('../src/main/generator');

function mockFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

test('chatCompletion 成功返回内容', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(opts.headers.Authorization, 'Bearer sk-test');
    assert.equal(body.messages[0].role, 'system');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["666"]' } }] }) };
  });
  try {
    const out = await chatCompletion({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat', system: 's', user: 'u' });
    assert.equal(out, '["666"]');
  } finally { restore(); }
});

test('chatCompletion 401 报错信息友好', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', user: 'u' }),
      (e) => e instanceof ApiError && e.code === 'auth' && e.message.includes('API Key 无效')
    );
  } finally { restore(); }
});

test('chatCompletion 网络错误归类', async () => {
  const restore = mockFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', user: 'u' }),
      (e) => e instanceof ApiError && e.code === 'network'
    );
  } finally { restore(); }
});

test('visionCompletion 请求带图片', async () => {
  const restore = mockFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.messages[0].content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg')));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["红色"]' } }] }) };
  });
  try {
    await visionCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', imageDataUrl: 'data:image/jpeg;base64,xxx' });
  } finally { restore(); }
});

test('parseDanmakuJson 各种脏格式', () => {
  assert.deepEqual(parseDanmakuJson('["666","新建文件夹不改名"]'), ['666', '新建文件夹不改名']);
  assert.deepEqual(parseDanmakuJson('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseDanmakuJson('好的，弹幕如下：\n["1","2"]\n希望对你有帮助'), ['1', '2']);
  assert.deepEqual(parseDanmakuJson('不是JSON'), []);
  assert.deepEqual(parseDanmakuJson(''), []);
  // 超长截断
  const long = JSON.stringify(['这是一条特别特别特别特别特别长的弹幕内容超过二十个字啦']);
  assert.ok(parseDanmakuJson(long)[0].length <= 24);
});

test('testTextConnection 成功与失败', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '通' } }] }) }));
  try {
    const r = await testTextConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' });
    assert.deepEqual(r, { ok: true, message: '通' });
  } finally { restore(); }
});

test('testVisionConnection 答对颜色才 ok', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: calls === 1 ? '红色' : '蓝色' } }] }) };
  });
  try {
    const ok = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(ok.ok, true);
    const bad = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(bad.ok, false);
    assert.ok(bad.message.includes('视觉'));
  } finally { restore(); }
});
