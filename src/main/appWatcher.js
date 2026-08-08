const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const { displayNameFor } = require('../shared/appNames');

const POLL_MS = 1000; // 轮询间隔：1 秒（人为门控依赖输入间隔缓存，轮询越密门控时序误差越小）
const HUMAN_INPUT_MS = 10000; // 距最后键盘/鼠标输入 ≤10 秒视为"有人正在操作"（人为文件操作门控阈值）

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

// PowerShell 长驻脚本 stdout 行："A|进程名小写|窗口标题"（A=应用行，兼容旧格式"进程名|标题"）；空应用行 = 无前台窗口
function parseWinLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const rest = s.startsWith('A|') ? s.slice(2) : s;
  const i = rest.indexOf('|');
  if (i <= 0) return null;
  return { appKey: rest.slice(0, i).toLowerCase(), title: rest.slice(i + 1) };
}

// "I|<距最后输入毫秒>" → 数值；格式不符返回 null
function parseInputLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('I|')) return null;
  const raw = s.slice(2).trim();
  if (raw === '') return null; // Number('') 是 0，需显式判空
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

// PowerShell 长驻脚本 stdout 行：
//   A|进程名小写|窗口标题（A=应用；空标题行 "A|" = 无前台窗口）
//   I|距最后键盘/鼠标输入的毫秒数（GetLastInputInfo，人为活动信号）
// 用 user32.GetForegroundWindow 取真实前台窗口（Get-Process 的 MainWindowHandle
// 排序取"最后一个"不等于前台窗口：最小化的记事本句柄也可能大于 Alt-Tab 切到的 Chrome）
const WIN_POLL_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct LastInputInfo { public uint cbSize; public uint dwTime; }
public class WinFore {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInputInfo plii);
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $li = New-Object LastInputInfo
  $li.cbSize = 8  # LASTINPUTINFO = 2x uint，x86/x64 均为 8 字节；PowerShell 5.1 的 Marshal.SizeOf 嵌套类型解析有坑，硬编码
  [WinFore]::GetLastInputInfo([ref]$li) | Out-Null
  $idleMs = ([uint32][Environment]::TickCount) - $li.dwTime
  if ($idleMs -gt 2147483647) { $idleMs = 0 }
  Write-Output ('I|' + $idleMs)
  $hwnd = [WinFore]::GetForegroundWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    $procId = [uint32]0
    [WinFore]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $sb = New-Object System.Text.StringBuilder 512
    [WinFore]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { Write-Output ('A|' + $p.ProcessName.ToLower() + '|' + $sb.ToString()) } else { Write-Output 'A|' }
  } else { Write-Output 'A|' }
  Start-Sleep -Milliseconds ${POLL_MS}
}`;

// macOS 长驻脚本（osascript JXA）：stdout 逐行输出 "I|距最后键盘/鼠标输入毫秒"。
// CGEventSourceSecondsSinceLastEventType 是 GetLastInputInfo 的 macOS 等价物：
// CoreGraphics 读 HID 空闲状态（不监听事件），无需辅助功能/输入监控权限；
// osascript 系统自带，零依赖。长驻循环与 Windows PowerShell 通道对称（delay() 是 JXA 内置全局函数，秒）。
// 坑：JXA 的 console.log 输出到 stderr，必须用 NSFileHandle 显式写 stdout（readline 只接 stdout）
const MAC_INPUT_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit() {
  const s = $.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateHIDSystemState, $.kCGAnyInputEventType);
  out.writeData($.NSString.alloc.initWithUTF8String('I|' + Math.round(s * 1000) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
while (true) {
  emit();
  delay(${POLL_MS} / 1000);
}`;

class AppWatcher {
  constructor({ pollMs = POLL_MS, clock = Date.now, platform = process.platform, exec = execFile, spawnImpl = spawn, onEvent, onStay, onError, stayMinutes = 20, aliases = {} }) {
    this.pollMs = pollMs;
    this.clock = clock;
    this.platform = platform;
    this.exec = exec;
    this.spawnImpl = spawnImpl;
    this.onEvent = onEvent;
    this.onStay = onStay;
    this.onError = onError;
    this.stayMinutes = stayMinutes;
    this.aliases = aliases;
    this.current = null; // { appKey, since }
    this.timer = null;
    this.winProc = null;
    this.macInputProc = null; // macOS 输入活动长驻进程（osascript JXA）；win32 的输入行与前台行同走 winProc
    this.lastIdleMs = null; // 距最后键盘/鼠标输入的毫秒（长驻进程轮询缓存；null=未就绪）
  }

  start() {
    if (this.timer) return;
    // macOS 输入活动信号源：start 即启动长驻进程（输入通道没有 poll 时机，不能像 winProc 那样 lazy）
    if (this.platform === 'darwin') this.ensureInputProc();
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.winProc?.kill();
    this.winProc = null;
    this.macInputProc?.kill();
    this.macInputProc = null;
  }

  // macOS 人为活动信号源：长驻 osascript（JXA）逐行输出 "I|<距最后输入毫秒>"。
  // spawn 'error' 后 Node 不一定再触发 'exit'，置空防轮询静默死掉（与 winProc 对称）；
  // 首行输出前 lastIdleMs=null → getHumanActivity 返回 null，门控放行（宽松：不误挡启动后的立即操作）
  ensureInputProc() {
    if (this.macInputProc) return;
    this.macInputProc = this.spawnImpl('osascript', ['-l', 'JavaScript', '-e', MAC_INPUT_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.macInputProc.on('error', (err) => {
      this.macInputProc = null;
      this.onError?.(new Error(`osascript 启动失败：${err.message}`));
    });
    this.macInputProc.on('exit', () => { this.macInputProc = null; });
    readline.createInterface({ input: this.macInputProc.stdout }).on('line', (line) => {
      const idle = parseInputLine(line);
      if (idle !== null) this.lastIdleMs = idle;
    });
  }

  getCurrent() {
    return this.current ? { appKey: this.current.appKey } : null;
  }

  // 人为活动信号：距最后键盘/鼠标输入是否在阈值内（人为文件操作门控用）。
  // lastIdleMs 为 null（长驻进程首轮输出前）→ 返回 null，调用方不拦截（宽松：避免误挡用户启动后的立即操作）
  getHumanActivity() {
    if (this.lastIdleMs === null) return null;
    return { active: this.lastIdleMs <= HUMAN_INPUT_MS, idleMs: this.lastIdleMs };
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
        // windowsHide：关键——GUI 应用无控制台，不隐藏会每次启动闪一个 PowerShell 黑窗
        this.winProc = this.spawnImpl('powershell', ['-NoProfile', '-Command', WIN_POLL_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        this.winProc.on('error', (err) => {
          this.winProc = null; // spawn 'error' 后 Node 不一定再触发 'exit'，不置空轮询会静默死掉
          this.onError?.(new Error(`PowerShell 启动失败：${err.message}`));
        });
        this.winProc.on('exit', () => { this.winProc = null; });
        this.winLineBuf = null;
        readline.createInterface({ input: this.winProc.stdout }).on('line', (line) => {
          const idle = parseInputLine(line);
          if (idle !== null) { this.lastIdleMs = idle; return; }
          const app = parseWinLine(line);
          this.winLineBuf = app ? { appKey: app.appKey } : null;
        });
      }
      resolve(this.winLineBuf || null);
    });
  }
}

module.exports = { POLL_MS, HUMAN_INPUT_MS, parseMacFront, parseBundleId, parseWinLine, parseInputLine, AppWatcher, MAC_INPUT_SCRIPT };
