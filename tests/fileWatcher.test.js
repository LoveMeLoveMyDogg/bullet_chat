const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listFixedDrives, FileWatcher, classifyEntry } = require('../src/main/fileWatcher');

function waitFor(fn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(timer); resolve(v); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('waitFor 超时')); }
    }, 50);
  });
}

test('listFixedDrives 包含系统盘', () => {
  const drives = listFixedDrives();
  assert.ok(Array.isArray(drives) && drives.length > 0);
  assert.ok(drives.includes(process.env.SystemDrive + '\\'));
});

test('classifyEntry 区分新建/删除/修改', () => {
  assert.deepEqual(classifyEntry('C:\\', 'C:\\a.txt', 'change'), {
    source: 'file', type: 'change', name: 'a.txt', path: 'C:\\a.txt', drive: 'C:', isDir: false,
  });
});

test('递归监听：新建/删除/修改文件都能收到', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-watch-'));
  const events = [];
  const fw = new FileWatcher({ drives: [root], filter: () => false, onEvent: (e) => events.push(e) });
  fw.start();

  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const file = path.join(sub, 'hello.txt');
  fs.writeFileSync(file, 'hi');
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'create' && e.isDir === false));

  fs.writeFileSync(file, 'hi2');
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'change'));

  fs.unlinkSync(file);
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'delete'));

  const created = events.find((e) => e.name === 'hello.txt' && e.type === 'create');
  assert.equal(created.drive, root.slice(0, 2));
  assert.equal(created.path, file);
  assert.equal(created.isDir, false);

  // 新建文件夹
  fs.mkdirSync(path.join(root, '新文件夹'));
  await waitFor(() => events.some((e) => e.name === '新文件夹' && e.type === 'create' && e.isDir === true));

  fw.stop();
});

test('filter 为 true 的事件被丢弃', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-watch-'));
  const events = [];
  const fw = new FileWatcher({ drives: [root], filter: () => true, onEvent: (e) => events.push(e) });
  fw.start();
  fs.writeFileSync(path.join(root, 'junk.txt'), 'x');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(events.length, 0);
  fw.stop();
});
