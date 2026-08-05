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

// macOS 专属噪音路径（Windows 规则在 macOS 路径上匹配不到；路径统一转反斜杠后按子串匹配）
function platformNoiseRules() {
  if (process.platform === 'darwin') {
    return [
      '.DS_Store',
      '\\Library\\',        // ~/Library（缓存/应用数据），也覆盖 /System/Library 等
      '\\.Trash',           // 废纸篓（Finder 删除会在其中产生"新建"，过滤避免重复弹幕）
      '\\.fseventsd',
      '\\.Spotlight-V100',
      '$TemporaryItems',
    ];
  }
  return [];
}

function makeNoiseFilter(extraRules = []) {
  const rules = DEFAULT_NOISE_SUBSTRINGS.concat(platformNoiseRules(), extraRules);
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

module.exports = { DEFAULT_NOISE_SUBSTRINGS, platformNoiseRules, makeNoiseFilter, formatEventDescription };
