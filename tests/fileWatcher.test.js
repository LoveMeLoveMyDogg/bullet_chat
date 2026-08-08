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

test('classifyEntry 首次见到 change：Windows 判修改（开机 touch 已存在文件不是新建），macOS 判新建', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-cls-'));
  const file = path.join(root, 'existing.txt');
  fs.writeFileSync(file, 'x'); // 文件已存在（模拟开机时监听器刚启动）
  const entry = classifyEntry(root, file, 'change', new Map()); // 首次见到 + change 事件
  if (isWin) {
    assert.equal(entry.type, 'change', 'Windows 首次见到 change = 已存在文件被修改，非新建（修复开机误报）');
  } else {
    assert.equal(entry.type, 'create', 'macOS 首次见到 change = 新建即被改的合并事件，保持新建');
  }
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

test('S1-4 remount 每 root 独立：两 root 并发失效后都重挂成功', async (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-rm-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-rm-b-'));
  const recovered = [];
  const fw = new FileWatcher({
    drives: [rootA, rootB],
    filter: () => false,
    onEvent: () => {},
    onError: () => {},
    onRecovered: (root) => recovered.push(root),
  });
  t.after(() => fw.stop());
  fw.start();
  await settle();
  // 两个盘符先后失效（旧实现单槽会互相覆盖，先失效的 root 永不重挂）
  fw.remount(rootA, new Error('模拟失效 A'));
  fw.remount(rootB, new Error('模拟失效 B'));
  assert.equal(fw.watchers.size, 0, '失效后两 root 都被移除');
  assert.equal(fw.remountTimers.size, 2, '两个 root 各有独立重挂定时器');
  await new Promise((r) => setTimeout(r, 5200)); // 等 5 秒重挂窗口
  assert.equal(fw.watchers.size, 2, '两个 root 都重挂成功');
  assert.deepEqual([...recovered].sort(), [rootA, rootB].sort(), '两 root 都上报恢复');
  assert.equal(fw.remountTimers.size, 0, '定时器回调触发后从 Map 移除');
});

test('S1-4 stop 清理所有 remount 定时器', (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-rm-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'bct-rm-b-'));
  const fw = new FileWatcher({ drives: [rootA, rootB], filter: () => false, onEvent: () => {} });
  t.after(() => fw.stop());
  fw.start();
  fw.remount(rootA, new Error('x'));
  fw.remount(rootB, new Error('x'));
  assert.equal(fw.remountTimers.size, 2);
  fw.stop();
  assert.equal(fw.remountTimers.size, 0, 'stop 后不残留定时器');
});
