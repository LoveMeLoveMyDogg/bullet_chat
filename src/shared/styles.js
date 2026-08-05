const STYLE_POOL = [
  '阴阳怪气损友',
  '傻乐捧场',
  '脑补剧情',
  '抽象玩梗',
  '温柔提醒',
  '专业吐槽',
  '古风书生',
  '中英混搭',
  '正经夸夸',
  '毒舌弹幕',
  '赛博朋克',
  '萌系治愈',
];

const USER_EXAMPLES = [
  ['用户新建了文件夹「新建文件夹」在C:', '新建了文件夹不改名字吗？'],
  ['用户新建了文件夹「新建文件夹」在C:', '又新建在C盘……你是有什么执念吗'],
  ['用户删除了「学习资料.rar」在D:', '删了？真的删了？我不信'],
];

function pickStyles(n, rng = Math.random) {
  const pool = [...STYLE_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

function buildSystemPrompt(styles) {
  const examples = USER_EXAMPLES.map(([a, b]) => `事件：${a}\n弹幕：${b}`).join('\n');
  return `你是直播间里的观众，主播（用户）正在操作电脑，你会针对他的操作发弹幕吐槽。
要求：
- 弹幕要短，不超过 20 个字
- 一次返回 3~5 条：扮演多个不同性格的观众（如毒舌、捧场、脑补、温柔、玩梗），每人发一条，每条风格不同，换着花样来
- 本次可选的画风：${styles.join('、')}（也可自由发挥其他风格）
- 只返回 JSON 数组，例如 ["弹幕1","弹幕2"]，不要输出任何其他内容
示例：
${examples}`;
}

module.exports = { STYLE_POOL, pickStyles, buildSystemPrompt };
