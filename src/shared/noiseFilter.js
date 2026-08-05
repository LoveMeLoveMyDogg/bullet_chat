const DEFAULT_NOISE_SUBSTRINGS = [
  '$Recycle.Bin',
  'System Volume Information',
  '\\Windows\\',
  '\\AppData\\',
  'node_modules',
  '\\.git',
  '__pycache__',
  '\\Temp\\',
  'Thumbs.db',
  'desktop.ini',
];

function makeNoiseFilter(extraRules = []) {
  const rules = DEFAULT_NOISE_SUBSTRINGS.concat(extraRules);
  return function isNoise(entry) {
    const p = (entry.path || '').replace(/\//g, '\\');
    const n = entry.name || '';
    return rules.some((r) => p.includes(r) || n.includes(r));
  };
}

function locationLabel(entry) {
  return entry.drive ? `在${entry.drive}` : '';
}

function formatEventDescription(entry) {
  const name = entry.name || '(未知)';
  const loc = locationLabel(entry);
  switch (entry.type) {
    case 'create':
      return entry.isDir
        ? `用户新建了文件夹「${name}」${loc}`
        : `用户新建了文件「${name}」${loc}`;
    case 'delete':
      return `用户删除了「${name}」${loc}`;
    case 'rename':
      return `用户把文件改名成「${name}」${loc}`;
    case 'move':
      return entry.drive
        ? `用户把「${name}」移动到了${entry.drive}`
        : `用户把「${name}」移动到了`;
    case 'change':
      return `用户修改了「${name}」${loc}`;
    case 'screen':
      return '用户屏幕上的画面发生了变化';
    default:
      return `用户对「${name}」做了什么${loc}`;
  }
}

module.exports = { DEFAULT_NOISE_SUBSTRINGS, makeNoiseFilter, formatEventDescription };
