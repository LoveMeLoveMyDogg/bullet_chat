const $ = (id) => document.getElementById(id);

// 每行 "key: value" → { key: value }（去空白）
function parseMap(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// 每行 "群名: 角色1｜角色2｜场景描述" → { 群名: { roles, scene, styles: [] } }
function parseGroups(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const parts = line.slice(i + 1).split('｜').map((s) => s.trim()).filter(Boolean);
    if (!name || parts.length === 0) continue;
    out[name] = { roles: parts.slice(0, -1), scene: parts[parts.length - 1], styles: [] };
  }
  return out;
}

let config = null;
let maskState = { displayId: null, masks: [], dragging: null, preview: null };

async function load() {
  config = await window.settings.getConfig();
  $('text-baseUrl').value = config.textModel.baseUrl;
  $('text-apiKey').value = config.textModel.apiKey;
  $('text-model').value = config.textModel.model;
  $('vision-enabled').checked = config.visionModel.enabled;
  $('vision-baseUrl').value = config.visionModel.baseUrl;
  $('vision-apiKey').value = config.visionModel.apiKey;
  $('vision-model').value = config.visionModel.model;
  $('vision-interval').value = config.visionModel.captureIntervalSec;
  $('dm-interval').value = config.danmaku.minIntervalSec;
  $('dm-vision-interval').value = config.danmaku.minIntervalVisionSec;
  $('dm-event-age').value = config.danmaku.maxEventAgeSec;
  $('dm-max').value = config.danmaku.maxConcurrent;
  $('dm-burst-min').value = config.danmaku.burstMin;
  $('dm-burst-max').value = config.danmaku.burstMax;
  $('dm-reply-count').value = config.danmaku.replyCount;
  $('dm-local').checked = config.danmaku.localMode;
  $('dm-read-content').checked = config.danmaku.readFileContent;
  for (const rb of document.querySelectorAll('input[name=dm-position]')) {
    rb.checked = rb.value === config.danmaku.position;
  }
  $('dm-styles').value = config.danmaku.styles.join(',');
  // 外观
  $('dm-fs-min').value = config.danmaku.fontSizeMin;
  $('dm-fs-max').value = config.danmaku.fontSizeMax;
  $('dm-colors').value = config.danmaku.colors.join(',');
  $('dm-speed').value = config.danmaku.speed;
  $('dm-speed-val').textContent = config.danmaku.speed + 'x';
  for (const cb of $('dm-anims').querySelectorAll('input[type=checkbox]')) {
    cb.checked = config.danmaku.animations.includes(cb.value);
  }
  $('sys-autostart').checked = config.system.autostart;
  maskState.masks = config.monitor.masks || [];
  // 前台应用监控 / 观众群 / 噪音规则
  $('mon-app-watch').checked = config.monitor.appWatch;
  $('mon-stay').value = config.monitor.stayMinutes;
  $('mon-idle').value = config.monitor.idleMinutes;
  $('mon-app-groups').value = Object.entries(config.monitor.appGroups || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('mon-audience-groups').value = Object.entries(config.monitor.audienceGroups || {}).map(([k, v]) => `${k}: ${[v.roles.join('｜'), v.scene].filter(Boolean).join('｜')}`).join('\n');
  $('mon-app-aliases').value = Object.entries(config.monitor.appAliases || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('mon-noise-rules').value = (config.monitor.noiseRules || []).join('\n');
  $('mon-human-file').checked = config.monitor.humanFileOnly !== false; // 旧配置缺字段默认开启

  const displays = await window.settings.getDisplays();
  const sel = $('mask-display');
  sel.innerHTML = '';
  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.label;
    sel.appendChild(opt);
  }
  if (displays.length) {
    sel.onchange = () => loadMaskPreview(sel.value);
    await loadMaskPreview(sel.value);
  }
}

async function loadMaskPreview(displayId) {
  maskState.dragging = null;
  const preview = await window.settings.getDisplayPreview(displayId);
  if (!preview) return;
  maskState.displayId = preview.displayId; // 以 desktopCapturer 的 display_id 为准（与 ScreenWatcher 遮罩过滤一致）
  const img = new Image();
  preview.image = img; // 先挂引用，onload 后再绘制
  maskState.preview = preview;
  img.onload = redrawMasks;
  img.src = preview.dataUrl;
}

function redrawMasks() {
  const canvas = $('mask-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (maskState.preview) {
    ctx.drawImage(maskState.preview.image, 0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  for (const m of maskState.masks.filter((m) => String(m.displayId) === String(maskState.displayId))) {
    ctx.fillRect(m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height);
  }
  if (maskState.dragging) {
    const d = maskState.dragging;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    ctx.fillRect(x * canvas.width, y * canvas.height, Math.abs(d.x1 - d.x0) * canvas.width, Math.abs(d.y1 - d.y0) * canvas.height);
  }
}

function norm(p) {
  const rect = $('mask-canvas').getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (p.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (p.clientY - rect.top) / rect.height)) };
}

$('mask-canvas').addEventListener('mousedown', (e) => {
  const p = norm(e);
  maskState.dragging = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});
$('mask-canvas').addEventListener('mousemove', (e) => {
  if (!maskState.dragging) return;
  const p = norm(e);
  maskState.dragging.x1 = p.x;
  maskState.dragging.y1 = p.y;
  redrawMasks();
});
$('mask-canvas').addEventListener('mouseup', () => {
  if (!maskState.dragging) return;
  const d = maskState.dragging;
  if (Math.abs(d.x1 - d.x0) > 0.01 && Math.abs(d.y1 - d.y0) > 0.01) {
    maskState.masks.push({
      displayId: maskState.displayId,
      x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
      w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
    });
  }
  maskState.dragging = null;
  redrawMasks();
});
$('btn-mask-clear').onclick = () => {
  maskState.masks = maskState.masks.filter((m) => String(m.displayId) !== String(maskState.displayId));
  redrawMasks();
};

function showResult(elId, ok, text) {
  const el = $(elId);
  el.textContent = text;
  el.className = 'result ' + (ok ? 'ok' : 'err');
}

// 从表单收集当前值（测试按钮测的是表单里填的，不是已保存的）
function formTextModel() {
  return {
    baseUrl: $('text-baseUrl').value.trim(),
    apiKey: $('text-apiKey').value.trim(),
    model: $('text-model').value.trim(),
  };
}

function formVisionModel() {
  return {
    enabled: $('vision-enabled').checked,
    baseUrl: $('vision-baseUrl').value.trim(),
    apiKey: $('vision-apiKey').value.trim(),
    model: $('vision-model').value.trim(),
    captureIntervalSec: Math.max(2, Number($('vision-interval').value) || 8),
  };
}

$('btn-test-text').onclick = async () => {
  const btn = $('btn-test-text');
  btn.disabled = true;
  showResult('text-test-result', true, '测试中…');
  const r = await window.settings.testText(formTextModel());
  showResult('text-test-result', r.ok, (r.ok ? '✓ ' : '✗ ') + r.message);
  btn.disabled = false;
};

$('btn-test-vision').onclick = async () => {
  const btn = $('btn-test-vision');
  btn.disabled = true;
  showResult('vision-test-result', true, '测试中…');
  const r = await window.settings.testVision(formVisionModel());
  showResult('vision-test-result', r.ok, (r.ok ? '✓ ' : '✗ ') + r.message);
  btn.disabled = false;
};

// 速度滑块实时显示当前倍速
$('dm-speed').addEventListener('input', () => {
  $('dm-speed-val').textContent = $('dm-speed').value + 'x';
});

$('btn-save').onclick = async () => {
  config.textModel.baseUrl = $('text-baseUrl').value.trim();
  config.textModel.apiKey = $('text-apiKey').value.trim();
  config.textModel.model = $('text-model').value.trim();
  config.visionModel.enabled = $('vision-enabled').checked;
  config.visionModel.baseUrl = $('vision-baseUrl').value.trim();
  config.visionModel.apiKey = $('vision-apiKey').value.trim();
  config.visionModel.model = $('vision-model').value.trim();
  config.visionModel.captureIntervalSec = Math.max(2, Number($('vision-interval').value) || 8);
  const iv = Number($('dm-interval').value);
  config.danmaku.minIntervalSec = Number.isNaN(iv) ? 10 : Math.max(0, iv); // 0 是合法值（不间隔），仅非数字回退 10
  const viv = Number($('dm-vision-interval').value);
  config.danmaku.minIntervalVisionSec = Number.isNaN(viv) ? 10 : Math.max(0, viv); // 视觉独立限速
  const ev = Number($('dm-event-age').value);
  config.danmaku.maxEventAgeSec = Number.isNaN(ev) ? 120 : Math.max(0, ev); // 0 = 不限时
  config.danmaku.maxConcurrent = Math.min(12, Math.max(1, Number($('dm-max').value) || 6));
  const bmin = Math.max(1, Math.min(12, Number($('dm-burst-min').value) || 2));
  const bmax = Math.max(bmin, Math.min(12, Number($('dm-burst-max').value) || 8));
  config.danmaku.burstMin = bmin;
  config.danmaku.burstMax = bmax; // 保存时校正 min<=max
  config.danmaku.replyCount = Math.min(20, Math.max(1, Number($('dm-reply-count').value) || 10));
  config.danmaku.localMode = $('dm-local').checked;
  config.danmaku.readFileContent = $('dm-read-content').checked;
  const checkedPos = document.querySelector('input[name=dm-position]:checked');
  config.danmaku.position = checkedPos ? checkedPos.value : 'top';
  config.danmaku.styles = $('dm-styles').value.split(',').map((s) => s.trim()).filter(Boolean);
  // 外观：字号范围（min<=max 校正）、颜色列表、倍速、动画勾选
  config.danmaku.fontSizeMin = Math.max(0, Math.min(100, Number($('dm-fs-min').value) || 30));
  config.danmaku.fontSizeMax = Math.max(config.danmaku.fontSizeMin, Math.min(100, Number($('dm-fs-max').value) || 39));
  config.danmaku.colors = $('dm-colors').value.split(',').map((s) => s.trim()).filter(Boolean);
  config.danmaku.speed = Number($('dm-speed').value) || 1;
  config.danmaku.animations = Array.from($('dm-anims').querySelectorAll('input[type=checkbox]:checked')).map((cb) => cb.value);
  config.system.autostart = $('sys-autostart').checked;
  // 前台应用监控 / 观众群 / 噪音规则（0 = 关闭对应播报，故仅非数字回退默认值，见各 tooltip）
  config.monitor.appWatch = $('mon-app-watch').checked;
  const stay = Number($('mon-stay').value);
  config.monitor.stayMinutes = Number.isNaN(stay) ? 20 : Math.max(0, stay);
  const idle = Number($('mon-idle').value);
  config.monitor.idleMinutes = Number.isNaN(idle) ? 10 : Math.max(0, idle);
  config.monitor.appGroups = parseMap($('mon-app-groups').value);
  config.monitor.appAliases = parseMap($('mon-app-aliases').value);
  config.monitor.audienceGroups = parseGroups($('mon-audience-groups').value);
  config.monitor.noiseRules = $('mon-noise-rules').value.split('\n').map((s) => s.trim()).filter(Boolean);
  config.monitor.humanFileOnly = $('mon-human-file').checked;
  config.monitor.masks = maskState.masks;
  await window.settings.saveConfig(config);
  $('save-result').textContent = '已保存 ✓';
  setTimeout(() => { $('save-result').textContent = ''; }, 2000);
};

window.settings.onStatus((s) => {
  const bar = $('status-bar');
  bar.className = s.state === 'error' ? 'err' : 'ok';
  bar.textContent = `状态：${s.text}`;
});

// 请求日志：发送给文字/视觉模型的内容、回复与截图（5s 自动刷新，无变化不重建）
let lastLogSignature = '';   // 上次渲染的日志签名（数量+最新条目 ts），未变化跳过重建
let seenLogKeys = new Set(); // 已渲染条目 key（ts|channel|error），只保留当前 ≤100 条
let firstRender = true;      // 首屏不高亮（开页时全部算"新"会全闪）

async function renderRequestLogs() {
  const logs = await window.settings.getRequestLogs();
  const sig = logs.length + '|' + (logs.length ? logs[logs.length - 1].ts : '');
  if (sig === lastLogSignature) return; // 无新请求：跳过（避免每 5s 重建 DOM）
  lastLogSignature = sig;
  const first = firstRender; // 本次渲染是否首屏：循环内求值用快照（若先置 false 则 isNew 恒真，开页全闪）
  firstRender = false; // 首次完整渲染（无论空或非空）后不再抑制高亮
  const box = $('req-log');
  const prevScroll = box.scrollTop; // 重建前保存滚动位置（自动刷新时阅读旧日志不跳）
  box.innerHTML = '';
  if (!logs.length) {
    box.textContent = '（暂无请求记录，有 AI 请求后显示）';
    return;
  }
  const currentKeys = new Set();
  for (const l of [...logs].reverse()) {
    const key = `${l.ts}|${l.channel}|${l.error || ''}`;
    currentKeys.add(key);
    const isNew = !first && !seenLogKeys.has(key);
    const row = document.createElement('div');
    row.className = 'req-item ' + (l.error ? 'req-err ' : '') + (isNew ? 'req-new' : '');
    const head = document.createElement('div');
    const time = new Date(l.ts).toLocaleTimeString();
    const channel = l.channel === 'vision' ? '视觉' : '文字';
    head.textContent = `[${time}] [${channel}] ${l.error ? '失败：' + l.error : ''}`;
    row.appendChild(head);
    const body = document.createElement('div');
    body.className = 'req-body';
    body.textContent = `发送：${l.input}`;
    row.appendChild(body);
    if (l.paths && l.paths.length) {
      // 操作文件路径：对照噪音过滤规则配置（忽略这些路径/文件名的操作事件）
      const paths = document.createElement('div');
      paths.className = 'req-paths';
      paths.textContent = '路径：' + l.paths.join(' ｜ ');
      row.appendChild(paths);
    }
    if (l.reply) {
      const rep = document.createElement('div');
      rep.className = 'req-body';
      rep.textContent = l.parsedCount !== undefined
        ? `回复：${l.reply}（实际解析 ${l.parsedCount} 条）`
        : `回复：${l.reply}`;
      row.appendChild(rep);
    }
    if (l.image) {
      const img = document.createElement('img');
      img.className = 'req-shot';
      // 跨平台 file:// URL：Windows 盘符（C:\ → /C:/）+ 统一正斜杠；macOS 绝对路径原样
      img.src = 'file://' + l.image.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:');
      img.title = l.image;
      row.appendChild(img);
    }
    box.appendChild(row);
  }
  seenLogKeys = currentKeys; // 只保留当前渲染的条目（防 Set 无限增长）
  box.scrollTop = prevScroll; // 恢复滚动位置
}

// 调用统计：今日汇总 + 分通道 + 近 7 天柱状（估算 token 黄色叠加）
async function renderUsageStats() {
  const { today, history } = await window.settings.getUsageStats();
  const sum = $('usage-summary');
  const t = today.total;
  sum.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'usage-card';
  card.innerHTML =
    `今日：调用 <b>${t.calls}</b> 次 · 输入 ≈${t.inputTokens} token · 输出 ≈${t.outputTokens} token` +
    ` · 产出 <b>${t.danmaku}</b> 条弹幕 · 失败 <b>${t.failed}</b> 次` +
    (t.calls ? `（每次调用平均产出 ${(t.danmaku / t.calls).toFixed(1)} 条）` : '');
  sum.appendChild(card);

  const ch = $('usage-channels');
  ch.innerHTML = '';
  const table = document.createElement('table');
  table.innerHTML = `<tr><th>通道</th><th>次数</th><th>输入 token</th><th>输出 token</th><th>产出条数</th><th>失败</th></tr>`;
  for (const [key, label] of [['text', '文字'], ['vision', '视觉']]) {
    const c = today[key];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${c.calls}</td><td>≈${c.inputTokens}</td><td>≈${c.outputTokens}</td><td>${c.danmaku}</td><td>${c.failed}</td>`;
    table.appendChild(tr);
  }
  ch.appendChild(table);

  const chart = $('usage-chart');
  chart.innerHTML = '';
  const max = Math.max(1, ...history.map((d) => d.calls));
  const maxT = Math.max(1, ...history.map((d) => d.tokens));
  for (const d of history) {
    const wrap = document.createElement('div');
    wrap.className = 'usage-bar-wrap';
    const hCalls = Math.max(2, Math.round((d.calls / max) * 80));
    const hTokens = Math.max(2, Math.round((d.tokens / maxT) * 80));
    const col = document.createElement('div');
    col.style.height = hCalls + 'px';
    col.className = 'usage-bar';
    col.title = `${d.date}：${d.calls} 次`;
    const colT = document.createElement('div');
    colT.style.height = hTokens + 'px';
    colT.className = 'usage-bar usage-bar-tokens';
    colT.title = `${d.date}：≈${d.tokens} token`;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:84px;';
    bar.appendChild(colT);
    bar.appendChild(col);
    const label = document.createElement('div');
    label.className = 'usage-bar-label';
    label.textContent = d.date.slice(5);
    wrap.appendChild(bar);
    wrap.appendChild(label);
    chart.appendChild(wrap);
  }
}

$('btn-refresh-usage').onclick = renderUsageStats;
$('btn-refresh-log').onclick = renderRequestLogs;
$('btn-open-log').onclick = () => window.settings.openLogDir();

// 更新区块：状态来自主进程（检查/下载都在主进程执行，渲染进程只展示与发指令）
async function renderUpdate() {
  const s = await window.updater.getState();
  $('update-current').textContent = s.currentVersion;
  const status = $('update-status');
  const actions = $('update-actions');
  const wrap = $('update-progress-wrap');
  $('btn-update-download').hidden = true;
  $('btn-update-ignore').hidden = true;
  $('btn-update-cancel').hidden = true;
  actions.hidden = s.state !== 'available' && s.state !== 'downloading';
  wrap.hidden = true;
  switch (s.state) {
    case 'available':
      status.textContent = `发现新版本 v${s.latestVersion}${s.notes ? '：' + s.notes.split('\n')[0] : ''}`;
      status.className = 'result ok';
      $('btn-update-download').hidden = false;
      $('btn-update-ignore').hidden = false;
      break;
    case 'downloading':
      status.textContent = `正在下载 v${s.latestVersion}… ${s.progress ? s.progress.percent + '%' : ''}`;
      status.className = 'result ok';
      wrap.hidden = false;
      $('update-progress-bar').style.width = (s.progress ? s.progress.percent : 0) + '%';
      $('btn-update-cancel').hidden = false;
      break;
    case 'done':
      status.textContent = `已下载 v${s.latestVersion}，正在打开安装包`;
      status.className = 'result ok';
      break;
    case 'ignored':
      status.textContent = `已忽略 v${s.latestVersion}，更高版本将重新提醒`;
      status.className = 'result ok';
      break;
    case 'error':
      status.textContent = `更新失败：${s.message || '网络错误'}`;
      status.className = 'result err';
      break;
    case 'checking':
      status.textContent = '正在检查…';
      status.className = 'result ok';
      break;
    case 'no-installer':
      status.textContent = '此平台暂无安装包';
      status.className = 'result ok';
      break;
    default: // idle / up-to-date
      status.textContent = '已是最新版本';
      status.className = 'result ok';
  }
}

$('btn-update-check').onclick = async () => {
  $('btn-update-check').disabled = true;
  await window.updater.check();
  $('btn-update-check').disabled = false;
  renderUpdate();
};

$('btn-update-download').onclick = async () => { await window.updater.download(); renderUpdate(); };
$('btn-update-cancel').onclick = async () => { await window.updater.cancel(); renderUpdate(); };
$('btn-update-ignore').onclick = async () => {
  const s = await window.updater.getState();
  if (s.latestVersion) await window.updater.ignoreVersion(s.latestVersion);
  renderUpdate();
};

window.updater.onProgress(() => renderUpdate());
load().then(async () => { await renderRequestLogs(); renderUsageStats(); renderUpdate(); });

// 日志自动刷新：5s 轮询，仅窗口可见时拉取（隐藏/最小化跳过；窗口销毁即渲染进程销毁，无泄漏）
const LOG_REFRESH_MS = 5000;
setInterval(() => {
  if (document.visibilityState === 'visible') renderRequestLogs();
}, LOG_REFRESH_MS);
