const NAMES = ['新建文件夹', '报告.pdf', '老板.zip', '游戏.rar', '会议记录.docx', '期末论文', '密码本.txt', '表情包合集'];
const DRIVES = ['C:', 'D:', 'E:', '桌面'];

const TYPE_MAP = { create_folder: 'create', create_file: 'create', delete: 'delete', rename: 'rename', move: 'move' };
const TYPE_KEYS = Object.keys(TYPE_MAP);

function makeDemoEntry(rng = Math.random) {
  const typeKey = TYPE_KEYS[Math.floor(rng() * TYPE_KEYS.length)];
  const name = NAMES[Math.floor(rng() * NAMES.length)];
  const drive = DRIVES[Math.floor(rng() * DRIVES.length)];
  return {
    source: 'file',
    type: TYPE_MAP[typeKey],
    name,
    path: `${drive}\\${name}`,
    drive: drive === '桌面' ? '' : drive,
    isDir: typeKey === 'create_folder',
  };
}

function startDemo({ onEntry, intervalMs = 4000, rng = Math.random }) {
  return setInterval(() => onEntry(makeDemoEntry(rng)), intervalMs);
}

function stopDemo(handle) {
  clearInterval(handle);
}

module.exports = { makeDemoEntry, startDemo, stopDemo };
