const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RequestLogger } = require('../src/main/requestLogger');

function makeLogger(maxScreenshots = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-reqlog-'));
  const logger = new RequestLogger({ logDir: dir, maxScreenshots });
  return { dir, logger };
}

test('请求写入 JSONL 且内存 ring 保留最近条目', () => {
  const { dir, logger } = makeLogger();
  logger.logRequest({ channel: 'text', input: '用户新建了文件「a.txt」', reply: '["666"]' });
  logger.logRequest({ channel: 'vision', input: '屏幕画面变化截图', reply: '["有变化"]', imageDataUrl: 'data:image/jpeg;base64,AAAA' });

  // 内存读取
  const logs = logger.getLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].channel, 'text');
  assert.equal(logs[0].input, '用户新建了文件「a.txt」');

  // JSONL 落盘
  const lines = fs.readFileSync(path.join(dir, 'requests.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.channel, 'text');
  assert.ok(parsed.ts);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('视觉截图存档（base64 解码落盘）并清理超限', () => {
  const { dir, logger } = makeLogger(3);
  // 1×1 红色 PNG base64
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  for (let i = 0; i < 5; i++) {
    logger.logRequest({ channel: 'vision', input: 's', reply: 'r', imageDataUrl: 'data:image/png;base64,' + png });
  }
  const shots = fs.readdirSync(path.join(dir, 'screenshots'));
  assert.equal(shots.length, 3, '截图最多保留 maxScreenshots 张');
  // 文件内容确为 PNG
  const buf = fs.readFileSync(path.join(dir, 'screenshots', shots[0]));
  assert.equal(buf[0], 0x89); // PNG 魔数
  // 最新一条日志的 image 路径指向存在的文件
  const last = logger.getLogs(1)[0];
  assert.ok(last.image.includes('screenshots'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('失败请求记录 error 字段', () => {
  const { dir, logger } = makeLogger();
  logger.logRequest({ channel: 'text', input: 'x', error: '鉴权失败（401）' });
  const l = logger.getLogs(1)[0];
  assert.equal(l.error, '鉴权失败（401）');
  assert.equal(l.reply, '');
  fs.rmSync(dir, { recursive: true, force: true });
});
