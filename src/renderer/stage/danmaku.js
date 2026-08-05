const COLORS = ['#fff', '#ffd700', '#7cfc00', '#00e5ff', '#ff69b4', '#ffa500', '#b388ff', '#ff5252'];
const ANIMS = ['anim-fly', 'anim-drop', 'anim-pop', 'anim-shake'];
let config = { maxConcurrent: 6, animationsEnabled: true };

function buildLanes() {
  const lanesEl = document.getElementById('lanes');
  lanesEl.innerHTML = '';
  config.lanes = [];
  for (let i = 0; i < config.maxConcurrent; i++) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.top = (6 + i * 78) + 'px';
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
  if (config.animationsEnabled) el.classList.add(ANIMS[Math.floor(Math.random() * ANIMS.length)]);
  el.textContent = text;
  el.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];
  el.style.fontSize = (meta.source === 'local' ? 26 : 30 + Math.floor(Math.random() * 10)) + 'px';
  if (!config.animationsEnabled) el.style.left = '20px';
  lane.el.appendChild(el);
  const duration = 9000;
  setTimeout(() => { el.remove(); lane.busy = false; }, duration);
}

window.api.onStageConfig((cfg) => {
  config = { ...config, ...cfg };
  buildLanes();
});
window.api.getStageConfig().then((cfg) => { config = { ...config, ...cfg }; buildLanes(); }).catch(() => {});
window.api.onDanmaku(({ text, meta }) => show(text, meta));

// 开发辅助：看不到弹幕时在控制台手动试 window.show('测试弹幕')
window.show = show;
