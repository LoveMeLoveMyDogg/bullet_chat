const { desktopCapturer } = require('electron');

const DIFF_THRESHOLD = 0.002;   // 画面变化率阈值
const SAMPLE_STEP = 64;         // 每 64 像素采样一次
const PREVIEW_W = 480;
const PREVIEW_H = 270;
const FULL_W = 1024; // 变化检测后的大图宽度（视觉识别足够，体积小上传快）

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
  constructor({ config, getMasks, onEntry, onError, onRecovered, processor, idleMinutes = 0, onIdle = null, clock = Date.now }) {
    this.config = config;
    this.getMasks = getMasks;
    this.onEntry = onEntry;
    this.onError = onError;
    this.onRecovered = onRecovered;
    this.processor = processor;
    this.idleMinutes = idleMinutes; // 0 = 关闭空闲播报
    this.onIdle = onIdle;
    this.clock = clock;
    this.idleSince = this.clock(); // 最后一次画面变化时刻（启动即开始计时）
    this.idleSent = false; // 本段空闲已播报（只播一次）
    this.timer = null;
    this.ticking = false;
    this.hadError = false; // 上一轮 tick 是否出错（成功一轮后上报恢复）
    this.last = new Map(); // display_id -> { bits }
  }

  // 空闲计时状态机（纯逻辑，可测）：画面有变化重置；无变化累计超 idleMinutes 播报一次
  updateIdle(hasChanged) {
    if (this.idleMinutes <= 0) return null;
    if (hasChanged) {
      this.idleSince = this.clock();
      this.idleSent = false;
      return null;
    }
    if (this.idleSent) return null;
    if (this.clock() - this.idleSince >= this.idleMinutes * 60000) {
      this.idleSent = true;
      const entry = { source: 'file', type: 'idle', name: '', drive: '', isDir: false };
      this.onIdle?.(entry);
      return entry;
    }
    return null;
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

  // 截屏源不可用：macOS 通常是屏幕录制权限未授权，给出可操作的引导
  failPermission() {
    const hint = process.platform === 'darwin'
      ? '屏幕录制权限未授权：请在 系统设置 → 隐私与安全性 → 屏幕录制 中开启后重启应用'
      : '未检测到可用屏幕源';
    this.onError?.(new Error(hint));
    this.hadError = true;
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
      if (sources.length === 0) {
        this.failPermission();
        return;
      }
      for (const src of sources) {
        // macOS 屏幕录制权限未授权时 thumbnail 为空（0×0），给用户可操作的引导
        const size = src.thumbnail.getSize();
        if (!size.width || !size.height) {
          this.failPermission();
          return;
        }
        const bits = src.thumbnail.toBitmap();
        const prev = this.last.get(src.display_id);
        if (!prev) {
          this.last.set(src.display_id, { bits });
          continue;
        }
        const diff = pixelDiffRatio(prev.bits, bits);
        this.last.set(src.display_id, { bits });
        if (diff < DIFF_THRESHOLD) {
          this.updateIdle(false); // updateIdle 内部播报（与 AppWatcher 事件源模式一致）
          continue;
        }
        this.updateIdle(true);

        // 有变化：抓大图 → 应用遮罩 → 交给 Brain
        const full = await this.captureFull(src.display_id);
        if (!full) continue; // 捕获失败（源列表竞态/虚拟显示器热切换）：跳过该源，下轮自动重试
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
      // 错误信息兜底：部分异常不是标准 Error（无 .message），直接显示 String(err)
      const detail = err && err.message ? err.message : String(err);
      // macOS 屏幕录制权限被拒/失效时 desktopCapturer 直接抛 "Failed to get sources"（而非返回空列表）
      if (/Failed to get sources/i.test(detail)) {
        this.failPermission();
        return;
      }
      this.onError?.(new Error(`屏幕识别失败：${detail}`));
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
    if (!src) return null; // 源列表为空（虚拟显示器热切换的竞态窗口）：返回 null，调用方跳过本轮
    return src.thumbnail.toDataURL();
  }
}

module.exports = { ScreenWatcher, pixelDiffRatio, DIFF_THRESHOLD };
