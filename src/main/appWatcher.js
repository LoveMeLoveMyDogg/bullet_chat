const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const { displayNameFor } = require('../shared/appNames');

const POLL_MS = 2000; // 轮询间隔：变化才发事件，几乎不占 CPU

// lsappinfo front 输出：
//   旧版：frontASN = ASN:0x0-0x1234:com.microsoft.VSCode
//   macOS 26：ASN:0x0-0x11011:（裸 ASN，无 bundle id 后缀）
// 返回 bundle id（旧格式）或裸 ASN（新格式），无匹配返回 null
function parseMacFront(out) {
  const m = /^(?:frontASN\s*=\s*)?(ASN:[A-Za-z0-9-]+)(?::([A-Za-z0-9.-]+))?:?\s*$/.exec(String(out || '').trim());
  return m ? (m[2] || m[1]) : null;
}

// lsappinfo info <ASN> -only bundleid 输出："CFBundleIdentifier"="com.apple.finder"；
// 也容忍裸引号形式："com.apple.finder"；无匹配返回 null
function parseBundleId(out) {
  const m = /(?:"?CFBundleIdentifier"?\s*=\s*)?"([A-Za-z0-9.-]+)"/.exec(String(out || '').trim());
  return m ? m[1] : null;
}

// PowerShell 长驻脚本 stdout 行："进程名小写|窗口标题"；空行 = 无前台窗口
function parseWinLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const i = s.indexOf('|');
  if (i <= 0) return null;
  return { appKey: s.slice(0, i).toLowerCase(), title: s.slice(i + 1) };
}

const WIN_POLL_SCRIPT = `
while ($true) {
  $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object MainWindowHandle | Select-Object -Last 1
  if ($p) { Write-Output ($p.ProcessName.ToLower() + '|' + $p.MainWindowTitle) } else { Write-Output '' }
  Start-Sleep -Milliseconds ${POLL_MS}
}`;

class AppWatcher {
  constructor({ pollMs = POLL_MS, clock = Date.now, platform = process.platform, exec = execFile, onEvent, onStay, onError, stayMinutes = 20, aliases = {} }) {
    this.pollMs = pollMs;
    this.clock = clock;
    this.platform = platform;
    this.exec = exec;
    this.onEvent = onEvent;
    this.onStay = onStay;
    this.onError = onError;
    this.stayMinutes = stayMinutes;
    this.aliases = aliases;
    this.current = null; // { appKey, since }
    this.timer = null;
    this.winProc = null;
  }

  updateConfig({ stayMinutes, aliases } = {}) {
    if (stayMinutes !== undefined) this.stayMinutes = stayMinutes;
    if (aliases !== undefined) this.aliases = aliases;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.winProc?.kill();
    this.winProc = null;
  }

  getCurrent() {
    return this.current ? { appKey: this.current.appKey } : null;
  }

  async poll() {
    try {
      const app = await this.probe();
      if (!app) return; // 无前台窗口（锁屏/刚启动）：跳过
      const now = this.clock();
      const prev = this.current;
      if (!prev || prev.appKey !== app.appKey) {
        this.current = { appKey: app.appKey, since: now };
        this.onEvent?.({
          source: 'app', type: 'app_switch', name: displayNameFor(app.appKey, this.aliases),
          appKey: app.appKey, drive: '', isDir: false,
        });
      } else if (this.stayMinutes > 0 && now - prev.since >= this.stayMinutes * 60000) {
        this.current.since = now; // 播报后重置计时（离开再回来由切换自然重置）
        this.onStay?.({
          source: 'app', type: 'app_stay', name: displayNameFor(app.appKey, this.aliases),
          appKey: app.appKey, minutes: this.stayMinutes, drive: '', isDir: false,
        });
      }
    } catch (err) {
      this.onError?.(new Error(`前台应用探测失败：${err.message}`));
    }
  }

  probe() {
    if (this.platform === 'darwin') {
      return new Promise((resolve) => {
        this.exec('lsappinfo', ['front'], (err, stdout) => {
          if (err) return resolve(null);
          const token = parseMacFront(stdout);
          if (!token) return resolve(null);
          if (token.includes('.')) return resolve({ appKey: token }); // 旧格式：直接是 bundle id
          // macOS 26：裸 ASN，需按 ASN 二次查询 bundle id
          this.exec('lsappinfo', ['info', token, '-only', 'bundleid'], (err2, stdout2) => {
            if (err2) return resolve(null);
            const key = parseBundleId(stdout2);
            resolve(key ? { appKey: key } : null);
          });
        });
      });
    }
    // Windows：长驻 PowerShell 进程，stdout 逐行输出前台窗口（避免每次 spawn 的开销）
    return new Promise((resolve) => {
      if (!this.winProc) {
        this.winProc = spawn('powershell', ['-NoProfile', '-Command', WIN_POLL_SCRIPT], { stdio: ['ignore', 'pipe', 'inherit'] });
        this.winProc.on('error', (err) => this.onError?.(new Error(`PowerShell 启动失败：${err.message}`)));
        this.winProc.on('exit', () => { this.winProc = null; });
        this.winLineBuf = null;
        readline.createInterface({ input: this.winProc.stdout }).on('line', (line) => {
          const app = parseWinLine(line);
          this.winLineBuf = app ? { appKey: app.appKey } : null;
        });
      }
      resolve(this.winLineBuf || null);
    });
  }
}

module.exports = { POLL_MS, parseMacFront, parseBundleId, parseWinLine, AppWatcher };
