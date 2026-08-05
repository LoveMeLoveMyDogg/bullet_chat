// 弹幕外观纯逻辑（无 DOM 依赖，node:test 可测）
// 渲染层通过 preload 暴露的 window.danmakuStyle 使用

const BASE_DURATIONS = { fly: 9000, drop: 6000, pop: 3000, shake: 1200 };
const DEFAULT_COLOR = '#ffffff';

// 字号范围随机整数；min>=max 时固定；min>max 时校正为 min
function pickFontSize(min, max, rng = Math.random) {
  const lo = Math.max(1, Math.round(min || 30));
  const hi = Math.max(lo, Math.round(max || lo));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// 颜色：空列表=白色；1 个=固定；多个=随机轮换（过滤空串）
function pickColor(colors, rng = Math.random) {
  const list = (colors || []).map((c) => String(c).trim()).filter(Boolean);
  if (list.length === 0) return DEFAULT_COLOR;
  return list[Math.floor(rng() * list.length)];
}

// 动画：空列表=null（不飘只显示）；过滤未知动画名
function pickAnimation(animations, rng = Math.random) {
  const list = (animations || []).filter((a) => BASE_DURATIONS[a]);
  if (list.length === 0) return null;
  return list[Math.floor(rng() * list.length)];
}

// 动画时长（毫秒）= 基础时长 / 倍速；未知动画兜底 3000；下限 300ms 防除零
function durationFor(anim, speed = 1) {
  const base = BASE_DURATIONS[anim];
  if (!base) return 3000;
  const s = Math.max(0.1, Number(speed) || 1);
  return Math.max(300, Math.round(base / s));
}

module.exports = { BASE_DURATIONS, DEFAULT_COLOR, pickFontSize, pickColor, pickAnimation, durationFor };
