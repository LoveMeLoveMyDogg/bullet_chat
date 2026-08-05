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
  $('dm-max').value = config.danmaku.maxConcurrent;
  $('dm-local').checked = config.danmaku.localMode;
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
    captureIntervalSec: Math.max(2, Number($('vision-interval').value) || 4),
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
  config.visionModel.captureIntervalSec = Math.max(2, Number($('vision-interval').value) || 4);
  const iv = Number($('dm-interval').value);
  config.danmaku.minIntervalSec = Number.isNaN(iv) ? 10 : Math.max(0, iv); // 0 是合法值（不间隔），仅非数字回退 10
  config.danmaku.maxConcurrent = Math.min(12, Math.max(1, Number($('dm-max').value) || 6));
  config.danmaku.localMode = $('dm-local').checked;
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

load();
