const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ErrorReporter } = require('../src/main/errorReporter');

test('日志超限自动轮转并保留归档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-log-'));
  const r = new ErrorReporter({ logDir: dir, maxLogBytes: 200, maxLogFiles: 2 });

  // 写入超过阈值 → 触发第一次轮转
  for (let i = 0; i < 80; i++) r.log('第' + i + '条错误日志内容填充填充');
  let files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('app.log'), '应有当前日志');
  assert.ok(files.includes('app.log.1'), '应有归档');
  // 轮转粒度 = 一条日志：写入后可能略超阈值（下次写入前才触发轮转）
  assert.ok(fs.statSync(path.join(dir, 'app.log')).size <= 200 + 200, '当前日志不应大幅超限');

  // 继续写 → 触发第二次轮转（app.log.1 → app.log.2）
  for (let i = 0; i < 80; i++) r.log('再写' + i + '条错误日志内容填充填充');
  files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('app.log.2'), '应有第二份归档');
  assert.equal(files.filter((f) => f.startsWith('app.log')).length, 3, '至多当前+2 份归档');

  // 再写 → 最旧的归档被删除（始终只保留 maxLogFiles 份）
  for (let i = 0; i < 80; i++) r.log('三写' + i + '条错误日志内容填充填充');
  files = fs.readdirSync(dir).sort();
  assert.equal(files.filter((f) => f.startsWith('app.log')).length, 3, '归档份数有上限');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('日志文件不存在时不报错', () => {
  const r = new ErrorReporter({ logDir: null, maxLogBytes: 100 });
  r.log('无日志目录时静默');
  assert.ok(true);
});
