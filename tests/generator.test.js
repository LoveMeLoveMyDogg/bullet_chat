const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiError, chatCompletion, visionCompletion, parseDanmakuJson,
  testTextConnection, testVisionConnection, parseResponsesReply, resetEndpointCache,
} = require('../src/main/generator');

function mockFetch(impl) {
  resetEndpointCache(); // 端点类型缓存是模块级全局，每个用例独立
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

test('chatCompletion 200 但非 JSON 响应报友好错误', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'b', apiKey: 'k', model: 'm', system: 's', user: 'u' }),
      (e) => e instanceof ApiError && e.code === 'bad-response' && e.message.includes('非 JSON')
    );
  } finally { restore(); }
});

test('visionCompletion 请求带图片', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(url, 'b/chat/completions');
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
  // 自定义上限
  assert.equal(parseDanmakuJson('["1","2","3","4","5","6"]', 3).length, 3);
  assert.equal(parseDanmakuJson('["1","2"]', 5).length, 2);
});

test('testTextConnection 成功与失败', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '通' } }] }) }));
  try {
    const r = await testTextConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' });
    assert.deepEqual(r, { ok: true, message: '通' });
  } finally { restore(); }
});

test('testVisionConnection 连接成功不依赖答对颜色', async () => {
  // 答对颜色 → ok；同时校验请求用的是"问颜色"独立 prompt（非弹幕生成 prompt）
  const restore = mockFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const text = body.messages[0].content.find((p) => p.type === 'text').text;
    assert.ok(text.includes('什么颜色'), '测试连接应使用问颜色 prompt');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '这是一个红色方块' } }] }) };
  });
  try {
    const r = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(r.ok, true);
  } finally { restore(); }

  // 答错颜色（模型能看到但描述不同）→ 仍算连接成功
  const restore2 = mockFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '蓝色的正方形' } }] }) }));
  try {
    const r = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(r.ok, true);
    assert.ok(r.message.includes('连接正常'));
  } finally { restore2(); }

  // 回复"看不到图片" → 连接成功但提示可能无视觉能力
  const restore3 = mockFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '我看不到图片，无法识别' } }] }) }));
  try {
    const r = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(r.ok, true);
    assert.ok(r.message.includes('可能不支持图片'));
  } finally { restore3(); }

  // 请求失败 → fail
  const restore4 = mockFetch(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
  try {
    const r = await testVisionConnection({ baseUrl: 'b', apiKey: 'k', model: 'm' }, 'data:image/png;base64,aaa');
    assert.equal(r.ok, false);
  } finally { restore4(); }
});

test('chat/completions 404 自动回退 Responses API 并缓存', async () => {
  // 火山方舟 coding plan 类端点：chat/completions 不存在（404），responses 可用
  let calls = [];
  const restore = mockFetch(async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/chat/completions')) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    // /responses
    const body = JSON.parse(opts.body);
    assert.ok(body.instructions); // system → instructions
    assert.equal(body.input[0].role, 'user');
    assert.ok(typeof body.input[0].content === 'string');
    return { ok: true, json: async () => ({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '["弹幕1"]' }] }],
    }) };
  });
  try {
    const out = await chatCompletion({ baseUrl: 'https://coding.example.com/api/coding/v3', apiKey: 'k', model: 'm', system: '你是系统提示', user: '用户输入' });
    assert.equal(out, '["弹幕1"]');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].endsWith('/chat/completions'));
    assert.ok(calls[1].endsWith('/responses'));

    // 缓存生效：第二次直接走 responses，不再探测
    const out2 = await chatCompletion({ baseUrl: 'https://coding.example.com/api/coding/v3', apiKey: 'k', model: 'm', system: 's', user: 'u' });
    assert.equal(out2, '["弹幕1"]');
    assert.equal(calls.length, 3);
    assert.ok(calls[2].endsWith('/responses'));
  } finally { restore(); }
});

test('chat/completions 404 且 responses 也 404 → 报模型名错误', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 404, text: async () => 'model not found' }));
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'https://bad.example.com', apiKey: 'k', model: '不存在模型', system: 's', user: 'u' }),
      (e) => e instanceof ApiError && e.code === 'model' && e.message.includes('模型名不存在')
    );
  } finally { restore(); }
});

test('visionCompletion 走 Responses API 时图片转 input_image', async () => {
  const restore = mockFetch(async (url, opts) => {
    if (url.endsWith('/chat/completions')) {
      return { ok: false, status: 404, text: async () => 'not found' }; // 先探测
    }
    assert.ok(url.endsWith('/responses'));
    const body = JSON.parse(opts.body);
    const userMsg = body.input.find((m) => m.role === 'user');
    const img = userMsg.content.find((p) => p.type === 'input_image');
    assert.ok(img && img.image_url.startsWith('data:image/jpeg'));
    return { ok: true, json: async () => ({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '["视觉弹幕"]' }] }],
    }) };
  });
  try {
    const out = await visionCompletion({ baseUrl: 'https://coding.example.com/api/coding/v3', apiKey: 'k', model: 'm', system: 's', imageDataUrl: 'data:image/jpeg;base64,xxx' });
    assert.equal(out, '["视觉弹幕"]');
  } finally { restore(); }
});

test('parseResponsesReply 提取 output_text', () => {
  assert.equal(parseResponsesReply({ output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }] }), '你好');
  assert.equal(parseResponsesReply({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }), 'ab');
  assert.equal(parseResponsesReply({ output: [{ type: 'reasoning' }] }), '');
  assert.equal(parseResponsesReply({ output_text: '兜底' }), '兜底');
  assert.equal(parseResponsesReply({}), '');
});
