const { app, ipcMain, Notification, BrowserWindow } = require('electron');
const path = require('node:path');
const { createTray } = require('./tray');
const { loadConfig, saveConfig } = require('./config');
const { FileWatcher, listFixedDrives } = require('./fileWatcher');
const { Brain } = require('../shared/brain');
const { makeNoiseFilter } = require('../shared/noiseFilter');
const templates = require('../shared/templates');
const { testTextConnection, testVisionConnection } = require('./generator');
const { Stage } = require('./stage');
const { ErrorReporter, sourceLabel } = require('./errorReporter');
const { createSettingsWindow, registerSettingsIpc } = require('./settingsWindow');
const { ScreenWatcher } = require('./screenWatcher');
const { ImageProcessor } = require('./imageProcessor');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

let brain = null;
let watcher = null;
let stage = null;
let reporter = null;
let config = null;
let paused = false;

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch { /* 忽略 */ }
}

function applyConfig(saved, { silent = false } = {}) {
  config = saved;
  if (brain) brain.refreshConfig(config);
  // 开机自启
  app.setLoginItemSettings({ openAtLogin: !!config.system.autostart });
  // 重启文件监控（盘符可能变化）
  if (watcher) watcher.stop();
  watcher = new FileWatcher({
    drives: config.monitor.drives.length ? config.monitor.drives : listFixedDrives(),
    filter: makeNoiseFilter(config.monitor.noiseRules),
    onEvent: (entry) => brain?.pushEntry(entry),
    onError: (err) => reporter?.reportError('watch', err),
  });
  watcher.start();
  // 同步演出层配置
  if (stage) stage.updateConfig(config.danmaku);
  // 配置保存后立即重试
  if (brain && brain.getStatus().error) brain.retryNow();
  if (!silent) notify('BulletChat', '配置已应用');
  // 屏幕事件源（启动与保存都走 applyConfig）
  applyScreenWatcher();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二实例：直接退出（app.exit 在 ready 事件前也生效，quit() 在 Windows 上可能无效）
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 已有实例在运行，保持其存活，不执行任何操作
  });

  app.whenReady().then(() => {
    config = loadConfig();
    // 状态广播统一走 reporter 状态形状 {state,text}（设置窗口状态条消费该结构）
    const broadcastStatus = (s) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('status-changed', s);
    };
    reporter = new ErrorReporter({
      notify,
      logDir: path.join(app.getPath('userData'), 'logs'),
      onStatus: broadcastStatus,
    });

    brain = new Brain({
      config,
      generator: require('./generator'),
      templates,
      reporter,
      onDanmaku: (text, meta) => stage?.send(text, meta),
    });

    // 图像处理器（隐藏窗口 + canvas，渲染层无 require，走 preload 暴露的 window.processor）
    const processor = new ImageProcessor({ preloadPath: PRELOAD });
    processor.init().catch((err) => reporter.reportError('screen', err));
    ipcMain.on('process:resolve', (_e, { id, dataUrl }) => processor.resolve(id, dataUrl));
    ipcMain.on('process:error', (_e, { id, message }) => processor.reject(id, new Error(message)));

    let screenWatcher = null;
    function applyScreenWatcher() {
      if (screenWatcher) screenWatcher.stop();
      if (!config.visionModel.enabled) return;
      if (!config.visionModel.baseUrl || !config.visionModel.apiKey || !config.visionModel.model) {
        // 未配置完整：普通提示，不进入错误状态（文件弹幕照常）
        notify('BulletChat', '视觉模型未配置完整，屏幕弹幕未启用（文件弹幕不受影响）');
        return;
      }
      screenWatcher = new ScreenWatcher({
        config,
        getMasks: () => config.monitor.masks,
        onEntry: (entry) => brain?.pushEntry(entry),
        onError: (err) => reporter?.reportError('screen', err),
        processor,
      });
      screenWatcher.start();
    }
    applyScreenWatcher();

    stage = new Stage({ preloadPath: PRELOAD });
    stage.start();
    stage.updateConfig(config.danmaku);

    registerSettingsIpc({
      getConfig: () => config,
      saveConfig: (cfg) => { saveConfig(cfg); config = cfg; return config; },
      onConfigSaved: applyConfig,
    });
    ipcMain.handle('settings:testText', (_e, cfg) => testTextConnection(cfg || config.textModel));
    ipcMain.handle('settings:testVision', (_e, cfg) => testVisionConnection(cfg || config.visionModel));
    ipcMain.handle('settings:getStatus', () => reporter.getStatus());
    ipcMain.handle('stage:getConfig', () => config.danmaku);

    applyConfig(config, { silent: true }); // 初次装配（含自启与监控启动），不弹通知
    brain.start();

    createTray({
      getState: () => ({ paused, localMode: brain.getStatus().localMode }),
      onQuit: () => app.quit(),
      onOpenSettings: () => {
        const settingsWin = createSettingsWindow({ preloadPath: PRELOAD });
        // 新打开/复用的设置窗口都立即收到当前状态：did-finish-load 时 renderer 监听器已就绪；
        // 已加载完成的复用窗口则直接推送
        const pushStatus = () => broadcastStatus(reporter.getStatus());
        settingsWin?.webContents.once('did-finish-load', pushStatus);
        if (!settingsWin?.webContents.isLoading()) pushStatus();
      },
      onTogglePause: () => {
        paused = !paused;
        if (paused) brain.pause();
        else brain.resume();
        notify('BulletChat', paused ? '弹幕已暂停' : '弹幕已恢复');
      },
      onToggleLocalMode: () => {
        brain.setLocalMode(!brain.getStatus().localMode);
        notify('BulletChat', brain.getStatus().localMode ? '已切换到本地模式（弹幕将带【本地】标记）' : '已退出本地模式');
      },
    });
  });

  app.on('window-all-closed', () => { /* 常驻托盘 */ });
}
