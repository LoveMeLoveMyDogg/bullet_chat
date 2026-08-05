// 渲染层无 nodeIntegration：样式纯逻辑经 preload 暴露的 window.danmakuStyle 使用
const ds = window.danmakuStyle;
let config = { maxConcurrent: 6, fontSizeMin: 30, fontSizeMax: 39, colors: [], speed: 1, animations: [], position: 'top' };

function buildLanes() {
  const lanesEl = document.getElementById('lanes');
  lanesEl.innerHTML = '';
  config.lanes = [];
  const viewportH = window.innerHeight;
  for (let i = 0; i < config.maxConcurrent; i++) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.top = ds.laneTopFor(config.position, i, config.maxConcurrent, viewportH) + 'px';
    lanesEl.appendChild(lane);
    config.lanes.push({ el: lane, busy: false });
  }
}

function freeLane() {
  for (const lane of config.lanes) if (!lane.busy) return lane;
  return config.lanes[Math.floor(Math.random() * config.lanes.length)]; // 全忙则随机复用
}

function show(text, meta = {}) {
  if (!config.lanes) buildLanes();
  const lane = freeLane();
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
  // 移除时长与动画时长对齐（防中途截断），静态弹幕 8 秒
  const duration = anim ? ds.durationFor(anim, config.speed) : 8000;
  setTimeout(() => { el.remove(); lane.busy = false; }, duration);
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
