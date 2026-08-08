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

// 平台专属噪音路径（Windows 规则在 macOS 路径上匹配不到；路径统一转反斜杠后按子串匹配）。
// win32：盘根级系统日志/缓存不在通用规则（\Windows\、\AppData\ 等）覆盖范围内——
// 实测 NVIDIA 驱动、腾讯系、Dell 等会在盘根持续写日志，堆积会淹没真实用户事件队列
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
  if (process.platform === 'win32') {
    return [
      // 系统目录：这些位置的写入几乎都是系统/后台行为（用户手动操作极少），无论是否有输入活动都挡。
      // 用户目录（Users/工作区）不受影响——那才是"人为修改"发生的区域
      '\\ProgramData\\',        // Dell 遥测库（DTPDB）、QQ 管家、各类服务配置
      '\\Program Files\\',      // 软件更新器/安装写入
      '\\Program Files (x86)\\',
      '\\WindowsApps\\',        // Windows 商店应用安装/更新目录（开机检查更新时大量事件）
      'nvAppTimestamps',        // NVIDIA 驱动盘根日志（持续写入，事件风暴主要来源）
      'SupportAssist',          // Dell SupportAssist 日志
      '\\UpdateService\\Log',   // Dell 更新服务日志
      '\\Goodix',               // 指纹驱动数据目录（开机初始化触摸）
      '\\UploadCache\\',        // QQ 电脑管家上传缓存
      '~TS',                    // QQ 电脑管家临时文件（~TS*.tmp 反复创建/删除）
      'TAVWfsDB',               // QQ 电脑管家病毒库
      'wxid_',                  // 微信数据目录（wxid_xxx，聊天记录/图片持续写入）
      'GoogleUpdater',          // Google 更新器日志（开机自启写日志）
      'log_center.db',          // 腾讯系日志库
      'QMConfig',               // QQ 电脑管家配置
      'aconfig.dat',            // 腾讯系配置缓存
    ];
  }
  return [];
}

function makeNoiseFilter(extraRules = []) {
  // 规则与路径统一转反斜杠匹配：用户按直觉填正斜杠路径（/Users/...）也能命中
  const rules = DEFAULT_NOISE_SUBSTRINGS.concat(platformNoiseRules(), extraRules)
    .map((r) => r.replace(/\//g, '\\'));
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
    case 'app_switch':
      return `用户打开了「${name}」`;
    case 'app_enter':
      return `「${name}」进入直播间`;
    case 'app_stay':
      return `用户已在「${name}」停留 ${entry.minutes || '多'} 分钟`;
    case 'idle':
      return '屏幕已多分钟没有变化';
    default:
      return `用户对「${name}」做了什么${loc}`;
  }
}

module.exports = { DEFAULT_NOISE_SUBSTRINGS, platformNoiseRules, makeNoiseFilter, formatEventDescription };
