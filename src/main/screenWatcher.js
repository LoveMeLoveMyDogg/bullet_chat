const { desktopCapturer } = require('electron');

const DIFF_THRESHOLD = 0.002;   // 画面变化率阈值
const SAMPLE_STEP = 64;         // 每 64 像素采样一次
const PREVIEW_W = 480;
const PREVIEW_H = 270;
const FULL_W = 1280;

function pixelDiffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let diff = 0;
  let n = 0;
  for (let i = 0; i + 2 < a.length; i += 4 * SAMPLE_STEP) {
    n++;
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 60) diff++;
  }
  return n === 0 ? 1 : diff / n;
}

class ScreenWatcher {
  constructor({ config, getMasks, onEntry, onError, onRecovered, processor }) {
    this.config = config;
    this.getMasks = getMasks;
    this.onEntry = onEntry;
    this.onError = onError;
    this.onRecovered = onRecovered;
    this.processor = processor;
    this.timer = null;
    this.ticking = false;
    this.hadError = false; // 上一轮 tick 是否出错（成功一轮后上报恢复）
    this.last = new Map(); // display_id -> { bits }
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.visionModel.captureIntervalSec * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.last.clear();
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    let ok = false;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: PREVIEW_W, height: PREVIEW_H },
      });
      for (const src of sources) {
        const bits = src.thumbnail.toBitmap();
        const prev = this.last.get(src.display_id);
        if (!prev) {
          this.last.set(src.display_id, { bits });
          continue;
        }
        const diff = pixelDiffRatio(prev.bits, bits);
        this.last.set(src.display_id, { bits });
        if (diff < DIFF_THRESHOLD) continue;

        // 有变化：抓大图 → 应用遮罩 → 交给 Brain
        const full = await this.captureFull(src.display_id);
        const masks = (this.getMasks() || []).filter((m) => String(m.displayId) === String(src.display_id));
        const dataUrl = await this.processor.process(full, masks);
        this.onEntry({
          source: 'screen',
          type: 'screen',
          name: '屏幕变化',
          path: '',
          drive: '',
          imageDataUrl: dataUrl,
        });
      }
      ok = true;
    } catch (err) {
      this.onError?.(new Error(`屏幕识别失败：${err.message}`));
      this.hadError = true;
    } finally {
      this.ticking = false;
    }
    // 本轮成功完成且上一轮出错：上报恢复
    if (ok && this.hadError) {
      this.hadError = false;
      this.onRecovered?.();
    }
  }

  async captureFull(displayId) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: FULL_W, height: Math.round(FULL_W * 9 / 16) },
    });
    const src = sources.find((s) => s.display_id === displayId) || sources[0];
    return src.thumbnail.toDataURL();
  }
}

module.exports = { ScreenWatcher, pixelDiffRatio, DIFF_THRESHOLD };
