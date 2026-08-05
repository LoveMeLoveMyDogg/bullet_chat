const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    chatCompletion: async () => { generator.textCalls++; return '["弹幕1","弹幕2","弹幕3","弹幕4","弹幕5"]'; },
    visionCalls: 0,
    visionCompletion: async () => { generator.visionCalls++; return '["屏幕弹幕"]'; },
  };
  const cfg = defaultConfig();
  cfg.danmaku.batchIntervalMs = 20;
  cfg.danmaku.minIntervalSec = 0;
  cfg.danmaku.minIntervalVisionSec = 0; // 现有视觉测试不受默认 10s 限速影响
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

test('事件风暴：首次补充后缓冲充足，不重复调用', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲不自动吐，保持充足
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，便于断言
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(generator.textCalls, 1, '首次补充一次即可');
  assert.ok(brain.buffer.length >= 4, 'AI 回复进缓冲池（首条已立即吐出）');
  brain.stop();
});

test('缓冲：补充后缓冲充足，新事件不触发调用', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲不自动吐，保持充足
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，便于断言
  generator.chatCompletion = async () => { generator.textCalls++; return '["1","2","3","4","5"]'; }; // 一次补充 5 条
  brain.pushEntry(entry('create')); // 首次：缓冲空 → 补充
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, 1);
  const before = generator.textCalls;
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create')); // 缓冲 5 条 > 阈值 2
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, before, '缓冲充足时不应再调 AI');
  brain.stop();
});

test('change 事件 2 秒内同路径合并为一条描述', async () => {
  const { brain, generator } = makeEnv();
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { generator.textCalls++; lastUser = user; return '["x"]'; };
  for (let i = 0; i < 3; i++) brain.pushEntry(entry('change'));
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
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0);
  brain.stop();
});

test('无错误时成功批次不通知恢复', async () => {
  const { brain, reporter } = makeEnv();
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reporter.recovered.length, 0);
  brain.stop();
});

test('文字补充失败置错：错误期间不补充，恢复后重新补充', async () => {
  const { brain, reporter, generator } = makeEnv();
  let fail = true;
  generator.chatCompletion = async () => { if (fail) throw new Error('挂了'); return '["1","2","3","4","5"]'; };
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲保持，便于断言
  brain.pushEntry(entry('create')); // 首次补充失败
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(brain.getStatus().error);
  assert.equal(brain.getStatus().error.source, 'text');
  const before = generator.textCalls;
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, before, '错误状态期间不补充');
  fail = false;
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(brain.getStatus().error, null);
  assert.ok(reporter.recovered.includes('text'));
  assert.ok(brain.buffer.length > 0, '恢复后立即补充缓冲');
  brain.stop();
});

test('视觉错误不影响文字弹幕', async () => {
  const { brain, danmaku, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲保持充足，文字只补充一次
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，便于断言
  generator.visionCompletion = async () => { throw new Error('视觉挂了'); };
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl: 'data:image/jpeg;base64,TEST' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(brain.getStatus().error);
  assert.equal(brain.getStatus().error.source, 'vision');
  for (let i = 0; i < 10; i++) brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.textCalls, 1); // 文字通道照常生成
  assert.ok(brain.buffer.length > 0, '弹幕进缓冲池（3600s 节奏下尚未吐出）');
  assert.equal(brain.getStatus().error.source, 'vision'); // 视觉错误保持
  brain.stop();
});

test('视觉重试用真实图片', async () => {
  const { brain, generator } = makeEnv();
  let calls = 0;
  let seenImage = '';
  generator.visionCompletion = async ({ imageDataUrl }) => {
    calls++;
    if (calls === 1) throw new Error('第一次失败');
    seenImage = imageDataUrl;
    return '["重试成功"]';
  };
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl: 'data:image/jpeg;base64,TEST' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(brain.getStatus().error);
  assert.equal(brain.getStatus().error.source, 'vision');
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seenImage, 'data:image/jpeg;base64,TEST'); // 重试探测用真实截图而非空图
  assert.equal(brain.getStatus().error, null);
  brain.stop();
});

test('混合批次：屏幕条目与文件条目拆批，视觉用真实截图', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲保持充足，文字只补充一次
  let visionImage = null;
  let lastTextUser = '';
  generator.visionCompletion = async ({ imageDataUrl }) => { visionImage = imageDataUrl; return '["屏幕弹"]'; };
  generator.chatCompletion = async ({ user }) => { generator.textCalls++; lastTextUser = user; return '["文件弹1","文件弹2","文件弹3","文件弹4","文件弹5"]'; };
  // 队列：5 个文件条目在前，1 个屏幕条目在后（模拟真实混合）
  for (let i = 0; i < 5; i++) brain.pushEntry(entry('create'));
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl: 'data:image/jpeg;base64,REALSCREEN' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(visionImage, 'data:image/jpeg;base64,REALSCREEN'); // 不再是 undefined
  assert.ok(!lastTextUser.includes('屏幕'), '文字批次不应包含屏幕条目描述');
  assert.equal(generator.textCalls, 1);
  brain.stop();
});

const { readFileSnippet, describeEntry } = require('../src/shared/brain');

test('readFileSnippet 读取小文本文件内容片段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-content-'));
  const f = path.join(dir, 'note.txt');
  fs.writeFileSync(f, '今天写了一段很长的会议纪要，内容是关于季度汇报的。');
  assert.ok(readFileSnippet(f).includes('会议纪要'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readFileSnippet 跳过二进制与大文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-content-'));
  // 二进制（含 NUL）
  const bin = path.join(dir, 'a.bin');
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  assert.equal(readFileSnippet(bin), '');
  // 超过 50KB
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(60 * 1024));
  assert.equal(readFileSnippet(big), '');
  // 不存在的文件
  assert.equal(readFileSnippet(path.join(dir, 'nope.txt')), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('describeEntry 内容开关与事件类型控制', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-content-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, '秘密配方：三勺糖');
  const entry = { source: 'file', type: 'change', name: 'a.txt', path: f };
  // 开：附内容片段
  const withContent = describeEntry(entry, true);
  assert.ok(withContent.includes('秘密配方'));
  // 关：不附
  assert.equal(describeEntry(entry, false), '用户修改了「a.txt」');
  // 删除事件不读内容（文件已不存在）
  const deleted = { source: 'file', type: 'delete', name: 'a.txt', path: f };
  assert.equal(describeEntry(deleted, true), '用户删除了「a.txt」');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('时间窗：补充调用时超龄事件被过滤', async () => {
  let fakeNow = 1000000;
  let sentUser = '';
  const gen = {
    chatCompletion: async ({ user }) => { sentUser = user; return '["1","2","3","4","5"]'; },
    visionCompletion: async () => '["v"]',
  };
  const { brain } = makeEnv({ generator: gen, clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲不自动吐
  brain.pushEntry(entry('create')); // 首次补充：buffer 5 条
  await new Promise((r) => setTimeout(r, 20));
  brain.pushEntry(entry('create')); // 事件 A 进内容池（缓冲充足不补充）
  fakeNow += 3 * 60 * 1000;         // 3 分钟后：A 超龄
  brain.buffer.length = 0;          // 模拟缓冲耗尽
  brain.pushEntry(entry('delete')); // 事件 B 触发补充
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sentUser.split('\n').length, 1, '超龄事件 A 被过滤，只发新事件 B');
  assert.ok(sentUser.includes('删除'));
  brain.stop();
});

test('时间窗：maxEventAgeSec=0 时超龄事件不过滤', async () => {
  let fakeNow = 1000000;
  let sentUser = '';
  const gen = {
    chatCompletion: async ({ user }) => { sentUser = user; return '["1","2","3","4","5"]'; },
    visionCompletion: async () => '["v"]',
  };
  const { brain } = makeEnv({ generator: gen, clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.maxEventAgeSec = 0; // 不限时
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  brain.pushEntry(entry('create')); // 事件 A
  fakeNow += 10 * 60 * 1000;        // 10 分钟后
  brain.buffer.length = 0;
  brain.pushEntry(entry('delete')); // 事件 B
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sentUser.split('\n').length, 2, 'maxEventAgeSec=0 时新旧事件都发送');
  brain.stop();
});

test('通道限速隔离：视觉被限速不影响文字，文字被限速不影响视觉', async () => {
  const { brain, danmaku, generator } = makeEnv();
  // 视觉限速 1 小时（默认 10s 的极端化），文字不限速
  brain.config.danmaku.minIntervalVisionSec = 3600;
  brain.config.danmaku.minIntervalSec = 0;
  // 先发一条视觉（占用视觉限速窗口）
  brain.pushEntry(entry('screen', { source: 'screen', type: 'screen', name: '屏幕变化', imageDataUrl: 'data:image/jpeg;base64,x' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.visionCalls, 1);
  // 视觉限速窗口内：再发视觉 → 丢弃；同时发文字 → 正常发送（通道隔离）
  brain.pushEntry(entry('screen', { source: 'screen', type: 'screen', name: '屏幕变化', imageDataUrl: 'data:image/jpeg;base64,x' }));
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(generator.visionCalls, 1, '视觉应被限速丢弃');
  assert.equal(generator.textCalls, 1, '文字不应受视觉限速影响');
  brain.stop();
});

test('暂停时 retryNow 不发探测请求，恢复后正常', async () => {
  const { brain, generator } = makeEnv();
  brain.fail('text', new Error('模拟失败'));
  const before = generator.textCalls;
  brain.pause();
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, before, '暂停期间不应发探测请求');
  brain.resume();
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, before + 1, '恢复后重试应发请求');
  brain.stop();
});

test('批量吐出：一批飘出 burstMin~burstMax 条，受缓冲余量约束', async () => {
  const { brain, danmaku, generator } = makeEnv({ rng: () => 0.5 });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 2;
  brain.config.danmaku.burstMax = 8;
  generator.chatCompletion = async () => { generator.textCalls++; return '["1","2","3","4","5","6","7","8","9","10"]'; };
  brain.pushEntry(entry('create')); // 补充 10 条
  await new Promise((r) => setTimeout(r, 30));
  // maxConcurrent=6 约束：max=min(8,6,10)=6 → n = 2 + floor(0.5*(6-2+1)) = 4 条一批
  assert.equal(danmaku.length, 4, '一批应飘出 4 条（rng 固定）');
  assert.equal(brain.buffer.length, 6, '剩余 6 条在缓冲');
  brain.stop();
});

test('批量吐出：批大小不超过同屏上限与缓冲余量', async () => {
  const { brain, danmaku } = makeEnv({ rng: () => 0.99 });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 2;
  brain.config.danmaku.burstMax = 8;
  brain.config.danmaku.maxConcurrent = 3; // 同屏上限 3
  brain.buffer.push('a', 'b'); // 缓冲只有 2 条
  brain.scheduleEmit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 2, '缓冲余量 2 条，全出');
  brain.stop();
});
