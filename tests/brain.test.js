const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Brain, typeKey } = require('../src/shared/brain');
const { defaultConfig } = require('../src/shared/configCore');
const templates = require('../src/shared/templates');

function makeEnv(overrides = {}) {
  const danmaku = [];
  const statuses = [];
  const reporter = {
    errors: [],
    recovered: [],
    reportError(source, err) { this.errors.push({ source, message: err.message }); },
    reportRecovered(source) { this.recovered.push(source); },
  };
  const generator = {
    textCalls: 0,
    chatCompletion: async () => { generator.textCalls++; return '["弹幕1","弹幕2"]'; },
    visionCalls: 0,
    visionCompletion: async () => { generator.visionCalls++; return '["屏幕弹幕"]'; },
  };
  const cfg = defaultConfig();
  cfg.danmaku.batchIntervalMs = 20;
  cfg.danmaku.minIntervalSec = 0;
  const brain = new Brain({
    config: cfg, generator, reporter, templates,
    onDanmaku: (text, meta) => danmaku.push({ text, meta }),
    onStatus: (s) => statuses.push(s),
    ...overrides,
  });
  brain.start();
  return { brain, danmaku, statuses, reporter, generator, cfg };
}

const entry = (type, extra = {}) => ({ source: 'file', type, name: 'x.txt', path: 'C:\\x.txt', drive: 'C:', isDir: false, ...extra });

test('typeKey 映射', () => {
  assert.equal(typeKey({ type: 'create', isDir: true }), 'create_folder');
  assert.equal(typeKey({ type: 'create', isDir: false }), 'create_file');
  assert.equal(typeKey({ type: 'delete' }), 'delete');
  assert.equal(typeKey({ type: 'rename' }), 'rename');
  assert.equal(typeKey({ type: 'move' }), 'move');
  assert.equal(typeKey({ type: 'change' }), 'change');
  assert.equal(typeKey({ type: 'screen', source: 'screen' }), 'screen');
});

test('攒批：10 条事件触发一次生成，弹幕≤3 条', async () => {
  const { brain, danmaku, generator } = makeEnv();
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, 1);
  assert.equal(danmaku.length, 2);
  assert.equal(danmaku[0].meta.source, 'ai');
  brain.stop();
});

test('限速：minIntervalSec 内第二次 flush 被丢弃', async () => {
  const { brain, danmaku, generator } = makeEnv();
  const cfg2 = defaultConfig();
  cfg2.danmaku.minIntervalSec = 3600;
  brain.refreshConfig(cfg2);
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, 1);
  assert.equal(danmaku.length, 2);
  brain.stop();
});

test('change 事件 2 秒内同路径合并为一条描述', async () => {
  const { brain, generator } = makeEnv();
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { generator.textCalls++; lastUser = user; return '["x"]'; };
  for (let i = 0; i < 3; i++) brain.pushEntry(entry('change'));
  brain.flushNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1);
  assert.equal((lastUser.match(/用户修改了/g) || []).length, 1); // 3 条合并成 1 条
  brain.stop();
});

test('生成失败：状态置错、报错给 reporter、不产出弹幕', async () => {
  const { brain, danmaku, reporter } = makeEnv();
  const orig = brain.generator.chatCompletion;
  brain.generator.chatCompletion = async () => { throw new Error('测试错误'); };
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reporter.errors.length, 1);
  assert.equal(reporter.errors[0].message, '测试错误');
  assert.equal(danmaku.length, 0);
  assert.equal(brain.getStatus().error.source, 'text');
  brain.generator.chatCompletion = orig;
  brain.stop();
});

test('恢复：retryNow 成功后清除错误并通知', async () => {
  const { brain, reporter } = makeEnv();
  brain.generator.chatCompletion = async () => { throw new Error('先挂一下'); };
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(brain.getStatus().error);
  brain.generator.chatCompletion = async () => '通';
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(brain.getStatus().error, null);
  assert.ok(reporter.recovered.includes('text'));
  brain.stop();
});

test('本地模式：不走 API，弹幕带【本地】前缀', async () => {
  const { brain, danmaku, generator } = makeEnv();
  brain.setLocalMode(true);
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0);
  assert.equal(danmaku.length, 1);
  assert.ok(danmaku[0].text.startsWith('【本地】'));
  assert.equal(danmaku[0].meta.source, 'local');
  brain.stop();
});

test('暂停：pushEntry 不生效', async () => {
  const { brain, generator } = makeEnv();
  brain.pause();
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  brain.flushNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0);
  brain.stop();
});
