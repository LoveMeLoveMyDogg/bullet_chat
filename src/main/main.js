const { app, ipcMain, Notification, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createTray } = require('./tray');
const { loadConfig, saveConfig } = require('./config');
const { FileWatcher, listWatchRoots } = require('./fileWatcher');
const { Brain } = require('../shared/brain');
const { makeNoiseFilter } = require('../shared/noiseFilter');
const templates = require('../shared/templates');
const { testTextConnection, testVisionConnection } = require('./generator');
const { Stage } = require('./stage');
const { ErrorReporter } = require('./errorReporter');
const { createSettingsWindow, registerSettingsIpc } = require('./settingsWindow');
const { ScreenWatcher } = require('./screenWatcher');
const { AppWatcher } = require('./appWatcher');
const { ImageProcessor } = require('./imageProcessor');
const { startDemo, stopDemo } = require('./demoMode');
const { RequestLogger } = require('./requestLogger');
const { UsageCounter } = require('../shared/usageCounter');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

// 固定配置目录：打包后默认 userData 会变成 %APPDATA%/BulletChat（productName），
// 与开发版 %APPDATA%/bullet-chat 不一致会"丢配置"。必须在 app ready 之前设置
app.setPath('userData', path.join(app.getPath('appData'), 'bullet-chat'));

let brain = null;
let watcher = null;
let stage = null;
let reporter = null;
let config = null;
let paused = false;
let demoHandle = null;
let screenWatcher = null;
let appWatcher = null;
let processor = null;
let screenPaused = false; // 托盘"暂停屏幕识别"开关

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch { /* 忽略 */ }
}

// 屏幕事件源：启动与保存都走 applyConfig，故必须声明在模块作用域（applyConfig 也是模块级），
// 若声明在 whenReady 回调内，模块级 applyConfig 按词法作用域找不到它 → ReferenceError
function applyScreenWatcher() {
  if (screenWatcher) screenWatcher.stop();
  if (screenPaused) return; // 托盘暂停中：不启动也不弹首启提示
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
    onRecovered: () => reporter?.reportRecovered?.('screen'),
    idleMinutes: config.monitor.idleMinutes,
    onIdle: (e) => brain?.pushEntry(e),
    processor,
  });
  screenWatcher.start();
  // 首次开启屏幕识别的隐私提示（只提示一次，确认后写入配置）
  if (!config.monitor.privacyAcknowledged) {
    notify('BulletChat', '屏幕识别已开启：截图仅发送给你配置的视觉 API 地址，可在设置中绘制隐私遮罩');
    config.monitor.privacyAcknowledged = true;
    saveConfig(config);
  }
}

function applyConfig(saved, { silent = false } = {}) {
  config = saved;
  if (brain) brain.refreshConfig(config);
  // 开机自启
  app.setLoginItemSettings({ openAtLogin: !!config.system.autostart });
  // 重启文件监控（盘符可能变化）
  if (watcher) watcher.stop();
  watcher = new FileWatcher({
    drives: config.monitor.drives.length ? config.monitor.drives : listWatchRoots(),
    filter: makeNoiseFilter(config.monitor.noiseRules),
    onEvent: (entry) => brain?.pushEntry(entry),
    onError: (err) => reporter?.reportError('watch', err),
    onRecovered: () => reporter?.reportRecovered?.('watch'),
  });
  watcher.start();
  // 前台应用监控：切换/停留事件进 brain（观众群体系的事件源）。
  // 创建/重启都走 applyConfig（首次启动与每次保存配置），与文件/屏幕事件源一致
  if (appWatcher) appWatcher.stop();
  appWatcher = new AppWatcher({
    stayMinutes: config.monitor.stayMinutes,
    aliases: config.monitor.appAliases,
    onEvent: (e) => brain?.pushEntry(e),
    onStay: (e) => brain?.pushEntry(e),
    onError: (err) => reporter?.reportError('watch', err),
  });
  if (config.monitor.appWatch) appWatcher.start();
  // 同步演出层配置
  if (stage) stage.updateConfig(config.danmaku);
  // 配置保存后立即重试
  if (brain && brain.getStatus().error) brain.retryNow();
  if (!silent) notify('BulletChat', '配置已应用');
  // 屏幕事件源（启动与保存都走 applyConfig）
  applyScreenWatcher();
}

const gotLock = app.requestSingleInstanceLock();
// Windows toast 通知需要 AppUserModelId，必须在 ready 前设置（Windows-only API）
if (process.platform === 'win32') app.setAppUserModelId('com.bulletchat.app');
if (!gotLock) {
  // 第二实例：直接退出（app.exit 在 ready 事件前也生效，quit() 在 Windows 上可能无效）
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 已有实例在运行，保持其存活，不执行任何操作
  });

  app.whenReady().then(() => {
    // 状态广播统一走 reporter 状态形状 {state,text}（设置窗口状态条消费该结构）
    const broadcastStatus = (s) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('status-changed', s);
    };
    reporter = new ErrorReporter({
      notify,
      logDir: path.join(app.getPath('userData'), 'logs'),
      onStatus: broadcastStatus,
    });

    // 损坏配置：备份原文件 + 显式提示（走 reporter 通道，通知与设置页状态条同时可见）。
    // 文件不存在（首次运行）不算损坏，不会走到这里
    config = loadConfig(({ file }) => {
      let backup = file;
      try {
        backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(file, backup);
      } catch { /* 备份失败不阻塞（原文件可能已不可读） */ }
      reporter.reportError('config', new Error(`配置文件损坏，已备份为 ${path.basename(backup)} 并恢复默认设置`));
    });

    // 请求日志：发送给文字/视觉模型的输入与回复 + 截图存档（设置页可查看）
    const logger = new RequestLogger({ logDir: path.join(app.getPath('userData'), 'logs') });

    // 调用统计：只记录发给 AI 的请求（含失败），探测请求不计
    const usage = new UsageCounter({ dir: path.join(app.getPath('userData'), 'usage') });

    brain = new Brain({
      config,
      generator: require('./generator'),
      templates,
      reporter,
      logger,
      usageCounter: usage,
      getCurrentApp: () => appWatcher?.getCurrent() || null,
      onDanmaku: (text, meta) => stage?.send(text, meta),
    });

    // 图像处理器（隐藏窗口 + canvas，渲染层无 require，走 preload 暴露的 window.processor）
    processor = new ImageProcessor({ preloadPath: PRELOAD });
    processor.init().catch((err) => reporter.reportError('screen', err));
    ipcMain.on('process:resolve', (_e, { id, dataUrl }) => processor.resolve(id, dataUrl));
    ipcMain.on('process:error', (_e, { id, message }) => processor.reject(id, new Error(message)));

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
    ipcMain.handle('settings:getUsageStats', () => ({ today: usage.getToday(), history: usage.getHistory(7) }));
    ipcMain.handle('settings:getRequestLogs', () => logger.getLogs());
    ipcMain.handle('settings:openLogDir', () => {
      const dir = path.join(app.getPath('userData'), 'logs');
      shell.openPath(dir);
      return dir;
    });
    ipcMain.handle('stage:getConfig', () => config.danmaku);

    applyConfig(config, { silent: true }); // 初次装配（含自启与监控启动），不弹通知
    brain.start();

    // 托盘对象必须持有全局引用，否则会被 GC 回收导致图标消失
    global.__tray = createTray({
      getState: () => ({ paused, localMode: brain.getStatus().localMode, demo: !!demoHandle, screenPaused }),
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
      onToggleDemo: () => {
        if (demoHandle) {
          stopDemo(demoHandle);
          demoHandle = null;
          notify('BulletChat', '演示模式已关闭');
        } else {
          demoHandle = startDemo({ onEntry: (e) => brain?.pushEntry(e) });
          notify('BulletChat', '演示模式已开启（模拟事件流）');
        }
      },
      onToggleScreenPause: () => {
        screenPaused = !screenPaused;
        if (screenPaused) screenWatcher?.stop();
        else applyScreenWatcher();
        notify('BulletChat', screenPaused ? '屏幕识别已暂停' : '屏幕识别已恢复');
      },
    });
  });

  app.on('window-all-closed', () => { /* 常驻托盘 */ });
}
