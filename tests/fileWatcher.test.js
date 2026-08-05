const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listFixedDrives, listWatchRoots, FileWatcher, classifyEntry } = require('../src/main/fileWatcher');

const isWin = process.platform === 'win32';
// 各操作之间等 FSEvents 冲刷，防止 macOS 上快速连续事件被合并（Windows 上无副作用）
const settle = () => new Promise((r) => setTimeout(r, 200));

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

test('listWatchRoots 非空且覆盖用户目录', () => {
  const roots = listWatchRoots();
  assert.ok(Array.isArray(roots) && roots.length > 0);
  if (isWin) {
    // Windows：盘符列表包含系统盘
    assert.ok(roots.includes(process.env.SystemDrive + '\\'));
  } else {
    // macOS：包含家目录（用户操作集中地）
    assert.ok(roots.includes(os.homedir()));
  }
});

test('classifyEntry 区分新建/修改/删除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cls-'));
  const file = path.join(root, 'a.txt');
  const seen = new Map();

  fs.writeFileSync(file, 'x');
  const created = classifyEntry(root, file, 'rename', seen);
  assert.deepEqual(created, {
    source: 'file', type: 'create', name: 'a.txt', path: file,
    drive: isWin ? root.slice(0, 2) : '', isDir: false,
  });

  // 修改：伪造旧 mtime（与当前不同）→ change（覆盖 macOS 全 rename 场景）
  seen.set(file, 0);
  const changed = classifyEntry(root, file, 'rename', seen);
  assert.equal(changed.type, 'change');

  // Windows 的 change 事件直接采信
  const changed2 = classifyEntry(root, file, 'change', seen);
  assert.equal(changed2.type, 'change');

  fs.unlinkSync(file);
  const deleted = classifyEntry(root, file, 'rename', seen);
  assert.equal(deleted.type, 'delete');
  assert.equal(seen.has(file), false); // 删除后从 mtime 表移除

  fs.rmSync(root, { recursive: true, force: true });
});

test('classifyEntry 跳过根目录自身元数据事件（macOS FSEvents）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cls-'));
  // FSEvents 会报 filename=根目录名 且路径不存在的事件，必须跳过而非误判为删除
  const ghost = path.join(root, path.basename(root));
  const entry = classifyEntry(root, ghost, 'change', new Map());
  assert.equal(entry, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('递归监听：新建/修改/删除文件都能收到', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-watch-'));
  const events = [];
  const fw = new FileWatcher({ drives: [root], filter: () => false, onEvent: (e) => events.push(e) });
  t.after(() => fw.stop()); // 失败也清理句柄，防进程挂起
  fw.start();
  await settle();

  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const file = path.join(sub, 'hello.txt');
  fs.writeFileSync(file, 'hi');
  // FSEvents 流在进程内大量临时目录增删后可能延迟数秒才激活，期间事件静默丢失；
  // 周期补写直到 create 事件送达（首次送达必判 create——mtime 表里没有该路径）
  const createT0 = Date.now();
  while (!events.some((e) => e.name === 'hello.txt' && e.type === 'create' && e.isDir === false)) {
    if (Date.now() - createT0 > 8000) throw new Error('新建事件未送达');
    if (Date.now() - createT0 > 300) fs.writeFileSync(file, 'new-' + Date.now());
    await new Promise((r) => setTimeout(r, 250));
  }
  await settle();

  fs.writeFileSync(file, 'hi2');
  // 同上：FSEvents 流激活延迟期间事件丢失，周期补写直到 change 事件独立送达
  // （Windows 上首次写入即触发 change，一轮即退出）
  const t0 = Date.now();
  while (!events.some((e) => e.name === 'hello.txt' && e.type === 'change')) {
    if (Date.now() - t0 > 5000) throw new Error('修改事件未送达');
    fs.writeFileSync(file, 'mod-' + Date.now());
    await new Promise((r) => setTimeout(r, 250));
  }
  await settle();

  fs.unlinkSync(file);
  await waitFor(() => events.some((e) => e.name === 'hello.txt' && e.type === 'delete'));
  await settle();

  const created = events.find((e) => e.name === 'hello.txt' && e.type === 'create');
  assert.equal(created.drive, isWin ? root.slice(0, 2) : '');
  assert.equal(created.path, file);
  assert.equal(created.isDir, false);

  // 新建文件夹
  fs.mkdirSync(path.join(root, '新文件夹'));
  await waitFor(() => events.some((e) => e.name === '新文件夹' && e.type === 'create' && e.isDir === true));
});

test('filter 为 true 的事件被丢弃', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-watch-'));
  const events = [];
  const fw = new FileWatcher({ drives: [root], filter: () => true, onEvent: (e) => events.push(e) });
  t.after(() => fw.stop());
  fw.start();
  fs.writeFileSync(path.join(root, 'junk.txt'), 'x');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(events.length, 0);
});
