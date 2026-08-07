// 观众群：群名 + 观众角色 + 场景人设 + 风格标签。命中应用时注入 buildSystemPrompt，
// 让弹幕"像特定观众席"（打开 VSCode 是程序员观众团，切到浏览器变吃瓜群众）
const BUILTIN_GROUPS = {
  '程序员天团': {
    roles: ['秃头架构师', '萌新实习生', '测试老哥', '产品经理'],
    scene: '你是一群程序员观众，正在围观一个程序员干活，会针对他的代码操作吐槽',
    styles: ['专业吐槽', '抽象玩梗', '阴阳怪气损友'],
  },
  '吃瓜群众': {
    roles: ['前排瓜友', '路人大妈', '弹幕侦探'],
    scene: '你是一群吃瓜群众，正在围观主播的屏幕，什么都想看看',
    styles: ['抽象玩梗', '脑补剧情', '傻乐捧场'],
  },
  '摸鱼大队': {
    roles: ['开黑队友', '老板眼线', '隔壁工位老王'],
    scene: '你是一群摸鱼同事，正在围观主播偷偷摸鱼，随时准备帮他望风',
    styles: ['抽象玩梗', '毒舌弹幕', '傻乐捧场'],
  },
  '学习委员': {
    roles: ['三好学生', '学霸同桌', '班主任'],
    scene: '你是一群学习委员，正在监督主播学习，看到学习行为会欣慰',
    styles: ['正经夸夸', '温柔提醒', '萌系治愈'],
  },
  '社畜同僚': {
    roles: ['摸鱼搭子', '甩锅侠', '热心同事'],
    scene: '你是一群社畜同僚，正在围观主播上班摸鱼，深谙打工人的苦',
    styles: ['抽象玩梗', '专业吐槽', '阴阳怪气损友'],
  },
};

// 应用 → 观众群默认绑定：Windows 进程名（小写）/ macOS bundle id（小写）
const DEFAULT_APP_GROUPS = {
  // 程序员
  code: '程序员天团', 'visual studio code': '程序员天团', idea64: '程序员天团',
  intellij: '程序员天团', pycharm64: '程序员天团', goland64: '程序员天团',
  'com.microsoft.vscode': '程序员天团', 'com.jetbrains.intellij': '程序员天团',
  'com.jetbrains.pycharm': '程序员天团', 'com.apple.dt.xcode': '程序员天团',
  // 浏览器
  chrome: '吃瓜群众', msedge: '吃瓜群众', firefox: '吃瓜群众', brave: '吃瓜群众',
  'com.google.chrome': '吃瓜群众', 'com.apple.safari': '吃瓜群众',
  'org.mozilla.firefox': '吃瓜群众', 'com.brave.browser': '吃瓜群众',
  // 聊天/办公
  wechat: '社畜同僚', weixin: '社畜同僚', dingtalk: '社畜同僚', outlook: '社畜同僚',
  thunderbird: '社畜同僚', 'com.tencent.xinwechat': '社畜同僚', 'com.alibaba.dingtalk': '社畜同僚',
  'com.microsoft.outlook': '社畜同僚', 'com.tencent.qq': '社畜同僚', qq: '社畜同僚',
  // 文档/笔记
  winword: '学习委员', wps: '学习委员', obsidian: '学习委员', notion: '学习委员',
  'com.microsoft.word': '学习委员', 'md.obsidian': '学习委员', 'com.notion.id': '学习委员',
  'com.apple.pages': '学习委员', 'com.apple.notes': '学习委员',
  // 娱乐
  steam: '摸鱼大队', spotify: '摸鱼大队', potplayer: '摸鱼大队', bilibili: '摸鱼大队',
  'com.valvesoftware.steam': '摸鱼大队', 'com.spotify.client': '摸鱼大队',
  'com.apple.music': '摸鱼大队', 'com.apple.quicktimeplayer': '摸鱼大队',
};

function resolveGroup(appKey, appGroups = {}, audienceGroups = {}) {
  const a = String(appKey || '').toLowerCase();
  if (!a) return null;
  const name = appGroups[a] || DEFAULT_APP_GROUPS[a];
  if (!name) return null;
  const custom = audienceGroups[name];
  if (custom) return { name, ...custom };
  const builtin = BUILTIN_GROUPS[name];
  return builtin ? { name, ...builtin } : null;
}

module.exports = { BUILTIN_GROUPS, DEFAULT_APP_GROUPS, resolveGroup };
