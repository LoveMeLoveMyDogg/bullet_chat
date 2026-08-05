const $ = (id) => document.getElementById(id);

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

// 请求日志：发送给文字/视觉模型的内容、回复与截图
async function renderRequestLogs() {
  const logs = await window.settings.getRequestLogs();
  const box = $('req-log');
  box.innerHTML = '';
  if (!logs.length) {
    box.textContent = '（暂无请求记录，有 AI 请求后显示）';
    return;
  }
  for (const l of [...logs].reverse()) {
    const row = document.createElement('div');
    row.className = 'req-item ' + (l.error ? 'req-err' : '');
    const head = document.createElement('div');
    const time = new Date(l.ts).toLocaleTimeString();
    const channel = l.channel === 'vision' ? '视觉' : '文字';
    head.textContent = `[${time}] [${channel}] ${l.error ? '失败：' + l.error : ''}`;
    row.appendChild(head);
    const body = document.createElement('div');
    body.className = 'req-body';
    body.textContent = `发送：${l.input}`;
    row.appendChild(body);
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
}

$('btn-refresh-log').onclick = renderRequestLogs;
$('btn-open-log').onclick = () => window.settings.openLogDir();
load().then(renderRequestLogs);
