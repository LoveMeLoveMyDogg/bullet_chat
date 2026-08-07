// 前台应用显示名映射：Windows 进程名（小写）/ macOS bundle id（小写）→ 中文显示名。
// 探测层只输出稳定 appKey，显示名在这里统一（弹幕文案可读性）
const BUILTIN_DISPLAY_NAMES = {
  // Windows 进程名（小写）
  code: 'VSCode', chrome: '浏览器', msedge: '浏览器', firefox: '浏览器', wechat: '微信',
  dingtalk: '钉钉', outlook: '邮件', thunderbird: '邮件', explorer: '文件资源管理器',
  notepad: '记事本', winword: 'Word', excel: 'Excel', powerpoint: 'PowerPoint',
  obsidian: 'Obsidian', notion: 'Notion', powershell: '终端', windowsterminal: '终端',
  steam: 'Steam', spotify: '音乐', potplayer: '播放器', bilibili: 'B站',
  // macOS bundle id（小写）
  'com.microsoft.vscode': 'VSCode', 'com.google.chrome': '浏览器', 'com.apple.safari': 'Safari',
  'com.tencent.xinwechat': '微信', 'com.apple.finder': '访达', 'com.apple.textedit': '文本编辑',
  'md.obsidian': 'Obsidian', 'com.notion.id': 'Notion', 'com.microsoft.word': 'Word',
  'com.apple.terminal': '终端', 'com.apple.preview': '预览', 'com.apple.notes': '备忘录',
  'com.apple.music': '音乐', 'com.spotify.client': '音乐', 'com.tencent.qq': 'QQ',
  'com.apple.iphonesimulator': '模拟器', 'org.videolan.vlc': '播放器',
};

function displayNameFor(appKey, aliases = {}) {
  const a = String(appKey || '').toLowerCase();
  if (!a) return a;
  if (aliases[a]) return aliases[a];
  return BUILTIN_DISPLAY_NAMES[a] || appKey;
}

module.exports = { BUILTIN_DISPLAY_NAMES, displayNameFor };
