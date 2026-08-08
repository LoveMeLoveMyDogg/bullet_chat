// 渲染层无 nodeIntegration：样式纯逻辑经 preload 暴露的 window.danmakuStyle 使用
const ds = window.danmakuStyle;
let config = { maxConcurrent: 6, fontSizeMin: 30, fontSizeMax: 39, colors: [], speed: 1, animations: [], position: 'top' };

function buildLanes() {
  const lanesEl = document.getElementById('lanes');
  lanesEl.innerHTML = '';
  config.lanes = [];
  const viewportH = window.innerHeight;
  // 轨道数按位置区域收敛（top/middle 只占视口上部 40%）：maxConcurrent 大时不会铺满全屏，
  // 超出容量的弹幕由 freeLane 随机复用轨道
  const laneCount = ds.laneCountFor(config.position, config.maxConcurrent, viewportH);
  for (let i = 0; i < laneCount; i++) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.top = ds.laneTopFor(config.position, i, laneCount, viewportH) + 'px';
    lanesEl.appendChild(lane);
    config.lanes.push({ el: lane, busy: false });
  }
}

function freeLane() {
  for (const lane of config.lanes) if (!lane.busy) return lane;
  return null; // 全忙：不随机复用（同轨道复用会重叠——fly 同速同轨完全重叠），由调用方排队
}

// 同屏上限：轨道全忙时新弹幕排队，轨道释放后补发（防重叠）。
// 批间最新优先：新到达的批插队首（与主进程缓冲同构，最新弹幕先飘），批内顺序保持；
// 队列上限：超限从队尾丢最旧批（防视觉高频时无限积压）
const pending = []; // 批次队列：队首=最新批，每批 { burst, lines: [{text, meta}, ...] }
const PENDING_LIMIT = 15;
function pushPending(text, meta) {
  const burst = meta && meta.burst;
  const front = pending[0];
  if (burst !== undefined && front && front.burst === burst) {
    front.lines.push({ text, meta }); // 同一批：追加保持批内顺序
  } else {
    pending.unshift({ burst, lines: [{ text, meta }] }); // 新批：插队首
  }
  // 上限：无论新批还是同批追加，超限都从队尾丢最旧批（队列保持 ≤ PENDING_LIMIT）
  let total = 0;
  for (const b of pending) total += b.lines.length;
  while (total > PENDING_LIMIT && pending.length > 1) {
    const dropped = pending.pop(); // 队尾最旧批
    total -= dropped.lines.length;
  }
}
function dequeue() {
  if (!pending.length) return;
  const batch = pending[0];
  const next = batch.lines.shift();
  if (batch.lines.length === 0) pending.shift(); // 批空了移除
  show(next.text, next.meta);
}

function show(text, meta = {}) {
  if (!config.lanes) buildLanes();
  const lane = freeLane();
  if (!lane) {
    pushPending(text, meta);
    return;
  }
  lane.busy = true;
  const el = document.createElement('div');
  el.className = 'danmaku';
  el.textContent = text;
  // 外观：字号范围 / 颜色列表 / 动画池 / 倍速（来自设置页）
  el.style.fontSize = ds.pickFontSize(config.fontSizeMin, config.fontSizeMax) + 'px';
  el.style.color = ds.pickColor(config.colors);
  const anim = ds.pickAnimation(config.animations);
  if (anim) {
    el.classList.add('anim-' + anim);
    el.style.animationDuration = ds.durationFor(anim, config.speed) / 1000 + 's';
  } else {
    el.style.left = '20px'; // 动画全关：静止显示
  }
  lane.el.appendChild(el);
  // 移除时长与动画时长对齐（防中途截断），静态弹幕 8 秒；释放轨道后补发排队弹幕
  const duration = anim ? ds.durationFor(anim, config.speed) : 8000;
  setTimeout(() => { el.remove(); lane.busy = false; dequeue(); }, duration);
}

window.api.onStageConfig((cfg) => {
  // 仅轨道数或位置变化时重建（否则清空在途弹幕）
  const maxChanged = cfg.maxConcurrent !== undefined && cfg.maxConcurrent !== config.maxConcurrent;
  const posChanged = cfg.position !== undefined && cfg.position !== config.position;
  config = { ...config, ...cfg };
  if (maxChanged || posChanged) buildLanes();
});
window.api.getStageConfig().then((cfg) => { config = { ...config, ...cfg }; buildLanes(); }).catch(() => {});
window.api.onDanmaku(({ text, meta }) => show(text, meta));

// 开发辅助：看不到弹幕时在控制台手动试 window.show('测试弹幕')
window.show = show;
