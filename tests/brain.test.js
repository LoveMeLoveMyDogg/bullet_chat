const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Brain, typeKey } = require('../src/shared/brain');
const { UsageCounter } = require('../src/shared/usageCounter');
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

test('typeKey 应用/空闲事件映射', () => {
  assert.equal(typeKey({ source: 'app', type: 'app_switch' }), 'app_switch');
  assert.equal(typeKey({ source: 'app', type: 'app_enter' }), 'app_enter');
  assert.equal(typeKey({ source: 'app', type: 'app_stay' }), 'app_stay');
  assert.equal(typeKey({ source: 'file', type: 'idle' }), 'idle');
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
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，防随机批量耗尽 buffer
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
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，防随机批量导致 buffer 耗尽二次补充
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
  brain.buffer.push({ text: 'a', ts: Date.now() }, { text: 'b', ts: Date.now() }); // 缓冲只有 2 条
  brain.scheduleEmit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 2, '缓冲余量 2 条，全出');
  brain.stop();
});

test('S1-1 队列级去重：同 path+type 多条入队，一次补充只发一条', async () => {
  const { brain, generator } = makeEnv();
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { generator.textCalls++; lastUser = user; return '["1"]'; };
  brain.config.danmaku.minIntervalSec = 3600; // 缓冲不自动吐
  brain.config.danmaku.batchIntervalMs = 0;   // 不节流，直接补充
  // 同路径 3 条 change 同时积压在内容池（模拟事件风暴：去抖窗口外的连续写入）
  brain.queue = [
    entry('change', { path: 'C:\\a.txt' }),
    entry('change', { path: 'C:\\a.txt' }),
    entry('change', { path: 'C:\\a.txt' }),
  ];
  brain.maybeRefill();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1, '一次补充调用');
  assert.equal((lastUser.match(/用户修改了/g) || []).length, 1, '同路径 change 只发一条描述');
  brain.stop();
});

test('S1-1 队列级去重：不同 type 同路径都保留（新建→修改叙事）', async () => {
  const { brain, generator } = makeEnv();
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { lastUser = user; return '["1"]'; };
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.queue = [
    entry('create', { path: 'C:\\a.txt' }),
    entry('change', { path: 'C:\\a.txt' }),
    entry('create', { path: 'C:\\b.txt' }),
  ];
  brain.maybeRefill();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lastUser.split('\n').length, 3, '不同 type 同路径不合并');
  assert.ok(lastUser.includes('新建') && lastUser.includes('修改'));
  brain.stop();
});

test('S1-1 队列级去重：同键多条时保留最后一条的位置', async () => {
  const { brain, generator } = makeEnv();
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { lastUser = user; return '["1"]'; };
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  // 顺序：change(a) → create(a) → change(a)：同键 change 让位，结果应为 create(a) → change(a)
  brain.queue = [
    entry('change', { path: 'C:\\a.txt' }),
    entry('create', { path: 'C:\\a.txt' }),
    entry('change', { path: 'C:\\a.txt' }),
  ];
  brain.maybeRefill();
  await new Promise((r) => setTimeout(r, 20));
  const lines = lastUser.split('\n');
  assert.equal(lines.length, 2, 'change 只剩最新一条');
  assert.ok(lines[0].includes('新建'), '首条是 create（叙事保留）');
  assert.ok(lines[1].includes('修改'), '末条是最新的 change');
  brain.stop();
});

test('S1-2 changeSeen 剪枝：超限清理 60 秒前的旧条目', () => {
  let fakeNow = 1000000;
  const { brain } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600; // 不触发补充噪声
  // 100 条旧条目（t=0）
  for (let i = 0; i < 100; i++) brain.pushEntry(entry('change', { path: `C:\\old-${i}.txt` }));
  assert.equal(brain.changeSeen.size, 100);
  fakeNow += 100000; // 100 秒后：旧条目全部超龄
  // 再灌 5000 条新条目 → 100 + 5000 = 5100 > 5000 → 剪掉 100 条旧的
  for (let i = 0; i < 5000; i++) brain.pushEntry(entry('change', { path: `C:\\new-${i}.txt` }));
  assert.ok(brain.changeSeen.size <= 5000, '清理后回落至上限内');
  assert.equal(brain.changeSeen.has('C:\\old-0.txt'), false, '超龄条目被清除');
  assert.equal(brain.changeSeen.has('C:\\new-0.txt'), true, '新条目保留');
  brain.stop();
});

test('S1-2 changeSeen 剪枝：清理后同路径 change 重新计为新事件', () => {
  let fakeNow = 1000000;
  const { brain, generator } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.pushEntry(entry('change', { path: 'C:\\a.txt' }));
  assert.ok(brain.changeSeen.has('C:\\a.txt'));
  fakeNow += 100000; // 超龄
  // 灌满触发剪枝：1 条旧 + 5099 条新 = 5100 > 5000 → 剪掉旧条目（清后 5099 ≤ 上限，不触发全清）
  for (let i = 0; i < 5099; i++) brain.pushEntry(entry('change', { path: `C:\\x-${i}.txt` }));
  assert.equal(brain.changeSeen.has('C:\\a.txt'), false, '超龄条目被清理');
  // 同路径再次 change：应被当作新事件进入队列
  brain.queue.length = 0;
  brain.pushEntry(entry('change', { path: 'C:\\a.txt' }));
  assert.equal(brain.queue.length, 1, '清理后同路径 change 重新入队');
  brain.stop();
});

test('S1-2 changeSeen 剪枝：清后仍超限则全清（优雅降级）', () => {
  let fakeNow = 1000000;
  const { brain } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  // 同一时刻灌入 6000 条全新条目：剪枝删不掉任何条目 → 全清，绝不突破上限
  for (let i = 0; i < 6000; i++) brain.pushEntry(entry('change', { path: `C:\\f-${i}.txt` }));
  assert.ok(brain.changeSeen.size <= 5000, '全清后不突破上限');
  brain.stop();
});

test('S1-3 双 start 只产生一条重试链（守卫防重复调度）', () => {
  const { brain } = makeEnv(); // makeEnv 已 start 一次
  let retrySchedules = 0;
  const orig = brain.scheduleRetry;
  brain.scheduleRetry = () => { retrySchedules++; orig.call(brain); };
  brain.start(); // 重复 start：守卫应直接返回，不再调度
  assert.equal(retrySchedules, 0, '重复 start 不应再次调度重试链');
  brain.stop();
});

test('S1-3 stop 后状态广播为 idle（托盘/设置页即时感知）', () => {
  const { brain, statuses } = makeEnv();
  statuses.length = 0;
  brain.stop();
  assert.equal(statuses[statuses.length - 1].mode, 'idle');
});

test('本地模式完全离线：文件事件不触发 AI 补充，重试探测也不发', async () => {
  const { brain, danmaku, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.setLocalMode(true);
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0, '本地模式不调 AI');
  assert.ok(danmaku.some((d) => d.text.startsWith('【本地】')), '本地模板弹幕直出');
  // 错误状态下 retryNow 也不该发探测请求（省额度）
  brain.state.error.text = { source: 'text', message: 'x', at: 0 };
  brain.state.error.vision = { source: 'vision', message: 'y', at: 0 };
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0, '本地模式重试探测不调 AI');
  assert.equal(generator.visionCalls, 0, '本地模式视觉探测不调 AI');
  brain.stop();
});

test('事件临过期（≥60s）时缓冲充足也强制补充（防时间窗丢弃）', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.config.danmaku.maxEventAgeSec = 120;
  brain.buffer.push({ text: '占位1', ts: Date.now() }, { text: '占位2', ts: Date.now() }, { text: '占位3', ts: Date.now() }); // 缓冲充足（> REFILL_THRESHOLD=2）
  brain.lastEmitAt = Date.now(); // 阻止首条立即吐出（lastEmitAt 为空时首次 emit delay=0，会以 setTimeout 链迅速抽干缓冲，破坏"缓冲充足"前提；Windows 定时器粒度 ~15ms 恰好撑过断言，macOS ~1ms 就挂）
  // 直接构造队列：70 秒前入队的事件（pushEntry 会覆盖 ts，绕过它模拟积压）
  brain.queue.push(entry('create', { ts: Date.now() - 70000 }));
  brain.maybeRefill();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1, '临过期事件无视缓冲水位强制补充');
  // 对照组：新事件 + 缓冲充足 → 不补充
  brain.queue.push(entry('create', { ts: Date.now() }));
  brain.maybeRefill();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1, '新鲜事件缓冲充足不补充');
  brain.stop();
});

test('队列限深：超 300 条丢最旧（防系统噪音无限堆积）', async () => {
  const { brain } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 10000; // 节流：限深期间不触发补充
  brain.buffer.push({ text: '占位1', ts: Date.now() }, { text: '占位2', ts: Date.now() }, { text: '占位3', ts: Date.now() });  // 缓冲充足，补充不触发
  for (let i = 0; i < 350; i++) brain.pushEntry(entry('create', { path: `C:\\noise${i}.txt` }));
  assert.equal(brain.queue.length, 300, '队列保持 300 上限');
  assert.ok(!brain.queue.some((e) => e.path === 'C:\\noise0.txt'), '最旧事件被丢');
  assert.ok(brain.queue.some((e) => e.path === 'C:\\noise349.txt'), '最新事件保留');
  brain.stop();
});

test('人为门控：无输入活动时文件事件不发文字模型（系统自动写入被挡）', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.config.monitor.humanFileOnly = true;
  let act = { active: false };
  brain.getHumanActivity = () => act;
  generator.chatCompletion = async () => { generator.textCalls++; return '["1"]'; };
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0, '无输入活动：文件事件被门控，不调 AI');
  assert.equal(brain.queue.length, 0, '被门控事件不进队列');
  act = { active: true }; // 用户开始操作
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1, '有输入活动：文件事件照常发');
  brain.stop();
});

test('人为门控：本地模式不受影响，未注入回调时放行', async () => {
  const { brain, danmaku, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 0;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.config.monitor.humanFileOnly = true;
  // 未注入 getHumanActivity → 放行（宽松）
  generator.chatCompletion = async () => { generator.textCalls++; return '["1"]'; };
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1, '未注入回调不拦截');
  // 本地模式：无输入活动也发模板弹幕（不调 API，无需门控）
  generator.textCalls = 0;
  brain.setLocalMode(true);
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0, '本地模式不调 AI');
  assert.ok(danmaku.some((d) => d.text.startsWith('【本地】')), '本地模板弹幕照常发出');
  brain.stop();
});

test('app 事件实时优先：缓冲充足时也触发补充（不被时间窗饿死）', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  brain.buffer.push({ text: '占位1', ts: Date.now() }, { text: '占位2', ts: Date.now() }, { text: '占位3', ts: Date.now() }); // 缓冲充足（> REFILL_THRESHOLD=2）
  generator.chatCompletion = async () => { generator.textCalls++; return '["1"]'; };
  // 文件事件：缓冲充足 → 不补充
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 0, '文件事件缓冲充足不补充');
  // app 事件：必须绕过缓冲阈值立即补充（否则在队列饿死、超时间窗被丢弃）
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'VSCode', appKey: 'code', drive: '', isDir: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generator.textCalls, 1, 'app 事件缓冲充足仍触发补充');
  brain.stop();
});

const { resolveGroup } = require('../src/shared/audienceGroups');

test('观众群：app_switch 命中不同群补发 app_enter 登场弹幕', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { lastUser = user; return '["1"]'; };
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'VSCode', appKey: 'code', drive: '', isDir: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(brain.currentGroup, '程序员天团');
  assert.ok(lastUser.includes('「程序员天团」进入直播间'), '登场弹幕入批');
  assert.ok(lastUser.includes('用户打开了「VSCode」'), '切换弹幕入批');
  // 同群再切换：不补发登场
  generator.chatCompletion = async ({ user }) => { lastUser = user; return '["1"]'; };
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'IDEA', appKey: 'idea64', drive: '', isDir: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!lastUser.includes('进入直播间'), '同群切换不补发登场');
  brain.stop();
});

test('观众群：场景与角色注入生成 prompt', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let lastSystem = '';
  generator.chatCompletion = async ({ system }) => { lastSystem = system; return '["1"]'; };
  brain.pushEntry({ source: 'file', type: 'create', name: 'a.js', path: 'C:\\a.js', drive: 'C:', isDir: false, appKey: 'code' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastSystem.includes('当前场景：你是一群程序员观众'), '场景注入');
  assert.ok(lastSystem.includes('秃头架构师'), '群角色注入');
  brain.stop();
});

test('事件场景化：文件事件自动打前台应用戳', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let lastSystem = '';
  generator.chatCompletion = async ({ system }) => { lastSystem = system; return '["1"]'; };
  brain.getCurrentApp = () => ({ appKey: 'chrome' });
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastSystem.includes('当前场景：你是一群吃瓜群众'), '按事件到达时前台应用选群');
  brain.stop();
});

test('本地模式：app_switch 登场走模板兜底', async () => {
  const { brain, danmaku } = makeEnv();
  brain.setLocalMode(true);
  brain.pushEntry({ source: 'app', type: 'app_switch', name: 'VSCode', appKey: 'code', drive: '', isDir: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 2, '切换 + 登场两条本地弹幕');
  assert.equal(brain.currentGroup, '程序员天团');
  brain.stop();
});

test('停留/空闲事件进文字通道并触发补充', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  let lastUser = '';
  generator.chatCompletion = async ({ user }) => { lastUser = user; return '["1"]'; };
  brain.pushEntry({ source: 'app', type: 'app_stay', name: 'VSCode', appKey: 'code', minutes: 20, drive: '', isDir: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastUser.includes('用户已在「VSCode」停留 20 分钟'), '停留事件描述入批');
  generator.chatCompletion = async ({ user }) => { lastUser = user; return '["1"]'; };
  brain.pushEntry({ source: 'file', type: 'idle', name: '', drive: '' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastUser.includes('屏幕已多分钟没有变化'), '空闲事件描述入批');
  brain.stop();
});

test('调用统计：成功与失败都记录，探测不计数', async () => {
  // 等待异步生成完成：轮询条件而非固定延时（防全量跑时负载导致的 flake）
  async function waitForCalls(uc, n, timeoutMs = 2000) {
    const t0 = Date.now();
    while (uc.getToday().text.calls < n) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等待调用计数 ${n} 超时（当前 ${uc.getToday().text.calls}）`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  // rng 固定为 0.99：首次补充吐出全部 5 条，缓冲清空 → 第二次 pushEntry 必触发补充（
  // 默认 Math.random 时吐 2 条留 3 条（>REFILL_THRESHOLD=2）的概率 25%，第二次调用永不发生）
  const { brain, generator } = makeEnv({ usageCounter: uc, rng: () => 0.99 });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  // 成功
  brain.pushEntry(entry('create'));
  await waitForCalls(uc, 1);
  const afterSuccess = uc.getToday().text.calls;
  assert.equal(afterSuccess, 1);
  // 失败
  generator.chatCompletion = async () => { throw new Error('挂了'); };
  brain.pushEntry(entry('create'));
  await waitForCalls(uc, 2);
  assert.equal(uc.getToday().text.calls, 2, '失败也计数');
  assert.equal(uc.getToday().text.failed, 1);
  // 探测请求不计数（缺失的增量无法被等待，负断言保留短固定延时）
  brain.retryNow();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(uc.getToday().text.calls, 2, 'retryNow 探测不计数');
  brain.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const { buildSystemPrompt } = require('../src/shared/styles');

test('调用统计：视觉通道计数（system 不重复计、截图 KB 计 token）', async () => {
  // 等待异步视觉调用完成：轮询条件而非固定延时（防全量跑时负载导致的 flake）
  async function waitForVisionCalls(uc, n, timeoutMs = 2000) {
    const t0 = Date.now();
    while (uc.getToday().vision.calls < n) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等待视觉调用计数 ${n} 超时（当前 ${uc.getToday().vision.calls}）`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-usage-'));
  const uc = new UsageCounter({ dir, clock: () => 0, fsMod: fs });
  const { brain, generator } = makeEnv({ usageCounter: uc });
  brain.config.danmaku.styles = ['正经夸夸']; // 固定画风：system prompt 长度可在测试里复算
  const imageDataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(4096); // ≈3KB（4096*3/4/1024）
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl });
  await waitForVisionCalls(uc, 1);
  assert.equal(generator.visionCalls, 1);
  const v = uc.getToday().vision;
  assert.equal(v.calls, 1);
  assert.equal(v.danmaku, 1, '["屏幕弹幕"] 解析出 1 条');
  // 视觉无事件描述输入：inputChars=0，system 只计一次 + 截图 KB
  const systemLen = buildSystemPrompt(brain.config.danmaku.styles).length;
  assert.equal(v.inputTokens, Math.ceil(systemLen / 1.5) + Math.ceil(3 * 12), 'inputChars=0，system 不重复计');
  assert.equal(v.outputTokens, Math.ceil('["屏幕弹幕"]'.length / 1.5));
  brain.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缓冲上限：超限丢最旧保留最新（防视觉高频积压）', () => {
  const { brain } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600; // 不消耗，纯观察
  brain.config.danmaku.burstMax = 3;          // 上限 = max(10, 3*5) = 15
  brain.pushBuffer(Array.from({ length: 15 }, (_, i) => `弹幕${i}`));
  assert.equal(brain.buffer.length, 15);
  brain.pushBuffer(['新1', '新2']);
  assert.equal(brain.buffer.length, 15, '超限截断');
  assert.ok(brain.buffer.some((b) => b.text === '弹幕0'), '插队模式：最早入队的旧弹幕在队尾仍保留');
  assert.ok(!brain.buffer.some((b) => b.text === '弹幕13') && !brain.buffer.some((b) => b.text === '弹幕14'), '最旧（队尾）被丢');
  assert.ok(brain.buffer.some((b) => b.text === '新2'), '最新保留');
  // 小 burstMax 时下限 10 兜底
  brain.config.danmaku.burstMax = 1;
  assert.equal(brain.bufferLimit(), 10, '上限不低于 10');
  brain.stop();
});

test('缓冲上限：文字与视觉生成都走 pushBuffer', async () => {
  const { brain, generator } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.batchIntervalMs = 0;
  const calls = [];
  const orig = brain.pushBuffer.bind(brain);
  brain.pushBuffer = (lines) => { calls.push([...lines]); orig(lines); };
  // 文字通道
  generator.chatCompletion = async () => '["文字1"]';
  brain.pushEntry(entry('create'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls[0], ['文字1'], '文字生成走 pushBuffer');
  // 视觉通道
  generator.visionCompletion = async () => '["视觉1"]';
  brain.pushEntry({ source: 'screen', type: 'screen', name: '屏幕变化', path: '', drive: '', imageDataUrl: 'data:image/jpeg;base64,TEST' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls[1], ['视觉1'], '视觉生成走 pushBuffer');
  brain.stop();
});

test('最新优先：有旧积压时新回复插队首先飘出（批内顺序保持）', async () => {
  const { brain, danmaku } = makeEnv();
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1; // 逐条吐，便于断言
  brain.buffer.push({ text: '旧1', ts: Date.now() }, { text: '旧2', ts: Date.now() });
  brain.pushBuffer(['新1', '新2']);
  assert.equal(brain.buffer[0].text, '新1', '新回复插队首');
  assert.equal(brain.buffer[2].text, '旧1', '旧弹幕退到队尾');
  brain.scheduleEmit(); // emit 走 setTimeout（delay=0 也异步），需等待定时器触发
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku[0].text, '新1', '最新回复先飘出');
  assert.equal(brain.buffer[0].text, '新2', '批内顺序保持（未反转）');
  brain.stop();
});

test('最新优先：新回复到达时丢弃入队超过 30s 的旧弹幕', () => {
  let fakeNow = 1000000;
  const { brain } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  // 新模型队首=最新：10s 内的在队首，40s 的在队尾（队尾=最旧）
  brain.buffer.push({ text: '旧2', ts: fakeNow - 10000 }, { text: '旧1', ts: fakeNow - 40000 });
  brain.pushBuffer(['新1']);
  assert.equal(brain.buffer.length, 2, '入队 40s 的旧弹幕被丢，10s 内的保留');
  assert.equal(brain.buffer[0].text, '新1');
  assert.equal(brain.buffer[1].text, '旧2');
  brain.stop();
});

test('优先发批：距上次飘出 ≥3s 时打断现有定时器立即发', async () => {
  let fakeNow = 1000000;
  const { brain, danmaku } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600; // 常规节奏极慢：模拟"定时器在跑"
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1;
  brain.buffer.push({ text: '旧1', ts: fakeNow }, { text: '旧2', ts: fakeNow });
  brain.scheduleEmit(); // 非优先：起 3600s 定时器（旧1 立即吐出）
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 1, '旧1 已出');
  assert.ok(brain.emitTimer, '旧2 的节奏定时器在跑');
  fakeNow += 5000; // 5 秒后：距上次飘出 ≥3s
  brain.pushBuffer(['新1']);
  brain.scheduleEmit(true); // 优先：应打断 3600s 定时器立即发
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 2, '新1 立即飘出（不等 3600s 节奏）');
  assert.equal(danmaku[1].text, '新1', '最新回复先出');
  brain.stop();
});

test('优先发批：距上次飘出 <3s 时保留现有定时器（防连发刷屏）', async () => {
  let fakeNow = 1000000;
  const { brain, danmaku } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1;
  brain.buffer.push({ text: '旧1', ts: fakeNow }, { text: '旧2', ts: fakeNow });
  brain.scheduleEmit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 1);
  const timer = brain.emitTimer;
  assert.ok(timer, '节奏定时器在跑');
  fakeNow += 1000; // 1 秒后：距上次飘出 <3s
  brain.pushBuffer(['新1']);
  brain.scheduleEmit(true);
  assert.equal(brain.emitTimer, timer, '现有定时器保留（不打断）');
  brain.stop();
});

test('最新优先：年龄清理严格边界——恰好 30s 保留，30001ms 丢弃', () => {
  let fakeNow = 1000000;
  const { brain } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600; // 不触发补充噪声
  // 入队恰好 30000ms：不超龄，新回复到达时保留（> 30s 才丢，= 30s 不丢）
  brain.buffer.push({ text: '正好30s', ts: fakeNow - 30000 });
  brain.pushBuffer(['新1']);
  assert.equal(brain.buffer.length, 2, '恰好 30s 的旧弹幕保留');
  assert.equal(brain.buffer[1].text, '正好30s', '旧弹幕在队尾（最旧侧）');
  // 入队 30001ms：超龄 1ms，新回复到达时丢弃
  brain.buffer.push({ text: '超1ms', ts: fakeNow - 30001 });
  brain.pushBuffer(['新2']);
  assert.equal(brain.buffer.length, 3, '30001ms 的旧弹幕被丢，其余保留');
  assert.ok(!brain.buffer.some((b) => b.text === '超1ms'), '超龄 1ms 的旧弹幕被丢弃');
  assert.ok(brain.buffer.some((b) => b.text === '新2'), '新回复保留');
  brain.stop();
});

test('优先发批：暂停时不调度（保留残留定时器），恢复后重新调度', async () => {
  let fakeNow = 1000000;
  const { brain, danmaku } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1;
  // 建立残留节奏定时器：旧1 已飘出，旧2 的 3600s 定时器在跑
  brain.buffer.push({ text: '旧1', ts: fakeNow }, { text: '旧2', ts: fakeNow });
  brain.scheduleEmit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 1, '旧1 已出');
  const residual = brain.emitTimer;
  assert.ok(residual, '旧2 的节奏定时器在跑');
  // 暂停后 priority 发批：不清残留定时器、不新调度（pause 时不调度）
  brain.pause();
  fakeNow += 1000; // 距上次飘出 1s < 3s：priority 保留现有定时器（防连发）
  brain.pushBuffer(['新1']);
  brain.scheduleEmit(true);
  assert.equal(brain.emitTimer, residual, '暂停时保留残留定时器');
  assert.equal(danmaku.length, 1, '暂停期间不飘出');
  // 恢复：buffer 有货，resume 重新 scheduleEmit（emitTimer 非空，缓冲继续吐）
  brain.resume();
  assert.ok(brain.emitTimer, 'resume 后恢复调度');
  brain.stop();
});

test('优先发批：无定时器且距上次飘出 <3s 时补足间隔（不立即发）', async () => {
  let fakeNow = 1000000;
  const { brain, danmaku } = makeEnv({ clock: () => fakeNow });
  brain.config.danmaku.minIntervalSec = 3600;
  brain.config.danmaku.burstMin = 1;
  brain.config.danmaku.burstMax = 1;
  brain.buffer.push({ text: '新1', ts: fakeNow });
  brain.lastEmitAt = fakeNow; // 无定时器，但刚飘完一批（距上次 <3s）
  brain.scheduleEmit(true);
  assert.ok(brain.emitTimer, '补足 3s 间隔的定时器已排程');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(danmaku.length, 0, '3s 间隔未到，不提前飘出');
  brain.stop();
});
