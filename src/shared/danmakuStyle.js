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

// 弹幕轨道垂直位置：top=顶部 / middle=垂直居中 / full=全屏均匀分布（未知值回退顶部）
const LANE_TOP = 6;  // 顶部起始偏移
const LANE_H = 78;   // 轨道间距
const TOP_REGION_RATIO = 0.4; // 顶部/中间位置占视口高的比例（B 站风格：弹幕集中在屏幕上方区域）

// 位置区域的轨道数上限：轨道间距固定，区域高度决定能放几条不重叠的轨道。
// maxConcurrent 超过区域容量时按区域收敛（多余弹幕由 freeLane 随机复用轨道），
// 否则"顶部"配置在 maxConcurrent 大时会把轨道铺满整个屏幕
function laneCountFor(position, maxConcurrent, viewportH) {
  const n = Math.max(1, maxConcurrent || 6);
  const h = viewportH || 600;
  const regionH = h * (position === 'full' ? 1 : TOP_REGION_RATIO);
  const maxFit = Math.max(1, Math.floor((regionH - LANE_TOP) / LANE_H));
  return Math.min(n, maxFit);
}

function laneTopFor(position, index, maxConcurrent, viewportH) {
  const n = Math.max(1, maxConcurrent || 6);
  const h = viewportH || 600;
  if (position === 'middle') {
    const area = Math.max(0, h - n * LANE_H);
    return Math.max(LANE_TOP, Math.round(area / 2) + index * LANE_H);
  }
  if (position === 'full') {
    return Math.round((h / n) * index) + LANE_TOP;
  }
  return LANE_TOP + index * LANE_H; // top（默认）
}

module.exports = { BASE_DURATIONS, DEFAULT_COLOR, pickFontSize, pickColor, pickAnimation, durationFor, laneTopFor, laneCountFor, LANE_TOP, LANE_H };
