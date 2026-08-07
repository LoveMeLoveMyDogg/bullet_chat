const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeNoiseFilter, formatEventDescription } = require('../src/shared/noiseFilter');

const mk = (type, name, p) => ({ source: 'file', type, name, path: p, drive: p.slice(0, 2), isDir: false });

test('系统噪音路径被过滤', () => {
  const f = makeNoiseFilter();
  assert.equal(f(mk('create', 'x', 'C:\\$Recycle.Bin\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\System Volume Information\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\Windows\\System32\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\Users\\me\\AppData\\Local\\Temp\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\proj\\node_modules\\lodash\\x')), true);
  assert.equal(f(mk('create', 'x', 'C:\\proj\\.git\\HEAD')), true);
});

test('用户可见路径不被过滤', () => {
  const f = makeNoiseFilter();
  assert.equal(f(mk('create', '新建文件夹', 'C:\\Users\\me\\Desktop\\新建文件夹')), false);
  assert.equal(f(mk('create', 'a.txt', 'C:\\Users\\me\\Desktop\\a.txt')), false);
  assert.equal(f(mk('create', 'x', 'C:\\Users\\me\\Documents\\x')), false);
  assert.equal(f(mk('create', 'x', 'D:\\x')), false);
});

test('自定义规则追加生效', () => {
  const f = makeNoiseFilter(['\\Downloads\\']);
  assert.equal(f(mk('create', 'x', 'C:\\Users\\me\\Downloads\\x')), true);
});

test('formatEventDescription 各类型', () => {
  const folder = mk('create', '新建文件夹', 'C:\\Users\\me\\Desktop\\新建文件夹');
  folder.isDir = true;
  assert.equal(formatEventDescription(folder), '用户新建了文件夹「新建文件夹」在C:');
  const file = mk('create', 'a.txt', 'C:\\x\\a.txt');
  assert.equal(formatEventDescription(file), '用户新建了文件「a.txt」在C:');
  assert.equal(formatEventDescription(mk('delete', 'a.txt', 'D:\\a.txt')), '用户删除了「a.txt」在D:');
  assert.equal(formatEventDescription(mk('rename', 'b.txt', 'C:\\b.txt')), '用户把文件改名成「b.txt」在C:');
  assert.equal(formatEventDescription(mk('move', 'a.txt', 'E:\\a.txt')), '用户把「a.txt」移动到了E:');
  assert.equal(formatEventDescription(mk('change', 'a.txt', 'C:\\a.txt')), '用户修改了「a.txt」在C:');
  assert.equal(formatEventDescription({ ...mk('create', 'x', 'C:\\x'), isDir: true }), '用户新建了文件夹「x」在C:');
});

test('formatEventDescription 应用/空闲事件描述', () => {
  const app = { source: 'app', type: 'app_switch', name: 'VSCode', drive: '' };
  assert.equal(formatEventDescription(app), '用户打开了「VSCode」');
  const enter = { source: 'app', type: 'app_enter', name: '程序员天团', drive: '' };
  assert.equal(formatEventDescription(enter), '「程序员天团」进入直播间');
  const stay = { source: 'app', type: 'app_stay', name: 'VSCode', drive: '', minutes: 20 };
  assert.equal(formatEventDescription(stay), '用户已在「VSCode」停留 20 分钟');
  const idle = { source: 'file', type: 'idle', name: '', drive: '' };
  assert.equal(formatEventDescription(idle), '屏幕已多分钟没有变化');
});
