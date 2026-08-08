# 检查更新 + 下载安装包 功能设计

日期：2026-08-08
状态：已获用户确认（2026-08-08）

## 1. 目标

打包产物（Windows NSIS exe / macOS dmg）内置「检查更新」能力：

1. 启动时静默检查一次，发现新版提示用户
2. 托盘菜单、设置页可手动检查
3. 用户确认后下载最新完整安装包到下载目录，自动打开安装包，手动安装

**明确不做**：electron-updater 全自动安装（未签名无法稳定自动替换，与"自用分发"定位不符）；不引入 semver 库（版本按 x.y.z 数字逐段比较）。

## 2. 架构

新增主进程模块 `src/main/updater.js`，自包含三个职责：

- `checkUpdate()`：拉取 version.json → 解析 → 取本平台 `files` 条目（`no-installer` 若缺失）→ 用条目内 `version` 与当前版本比较 → 返回结果；**单飞**（检查进行中重复触发直接返回进行中状态，避免启动自检与手动检查重叠双提示）
- `downloadUpdate()`：流式下载到 `.part` 临时文件 → SHA256 校验 → 重命名 → 打开安装包；**单飞**（下载中重复调用被忽略）；进度经 IPC 推送
- 事件/状态管理：向渲染进程推送进度，管理忽略版本

依赖注入便于测试：`fetch`、版本号（`app.getVersion()`）、下载目录均可注入。

```
托盘「检查更新」 ─┐
设置页 [检查更新] ─┤→ updater.js ─→ fetch version.json → 比对 → 通知/设置页展示
启动时静默检查 ───┘                    ↓ 用户点「去下载」
                                流式下载 → sha256 校验 → shell.openPath 打开安装包
```

IPC 通道（preload.js 暴露，沿用现有 ipcRenderer 模式）：

- `updater:check`（invoke）→ `{ status, current, latest, notes }`
  - `status`: `up-to-date` | `update-available` | `no-installer` | `error` | `ignored`
- `updater:download`（invoke，开始下载）
- `updater:cancel`（invoke，中止下载、删除半成品）
- `updater:ignoreVersion`（invoke，写入 config）
- `updater:getState`（invoke，设置页打开时恢复状态）
- `updater:progress`（主进程 → 渲染进程推送：`{ percent, bytesDownloaded, bytesTotal }`）

## 3. version.json 协议

地址：`https://updates.zhipengcoding.com/version.json`（应用内常量 `UPDATE_URL`）

```json
{
  "version": "0.3.0",
  "notes": "修复 xxx\n新增 yyy",
  "files": {
    "win-x64":  { "version": "0.2.0", "url": "https://updates.zhipengcoding.com/BulletChat-0.2.0-win-x64.exe", "sha256": "…" },
    "mac-arm64": { "version": "0.3.0", "notes": "修复 xxx\n新增 yyy", "url": "https://updates.zhipengcoding.com/BulletChat-0.3.0-mac-arm64.dmg", "sha256": "…" },
    "mac-x64":   { "version": "0.3.0", "url": "https://updates.zhipengcoding.com/BulletChat-0.3.0-mac-x64.dmg", "sha256": "…" }
  }
}
```

规则：

- `files` 只放已发布的平台，可缺省；应用按 `process.platform` + `process.arch` 选（darwin+arm64 → mac-arm64，darwin+x64 → mac-x64，win32+x64 → win-x64），缺当前平台返回 `no-installer`
- **`files.<平台>.version` 是该安装包自身的版本号**（双平台分开发布、版本可能不同步，客户端比较用它，避免"提示 0.3.0 却下载到 0.2.0 安装包"的循环提示）；顶层 `version` = 当前所有平台已发布版本的最大值（供合并与展示）
- **`files.<平台>.notes` 可选**：该平台安装包对应的更新说明，客户端优先用它，缺省回退顶层 `notes`（最近一次发布的说明）——平台版本不同步时，win 用户看到的是自己平台版本的说明
- `sha256` 必填，下载后校验。注意：哈希与 manifest 同源，防的是下载损坏/截断，**防篡改靠 HTTPS（TLS）**——两者都做，期望别定错
- 版本解析：允许 `v` 前缀（自动去除），按 `.` 分段取前 3 段，任一段非数字 → 视为非法（检查失败）
- 版本比较：数字逐段比较（`0.9.0 < 0.10.0`）
- 拉取超时 10s，失败静默（启动自检不打扰）

## 4. 交互

### 4.1 托盘（tray.js）

菜单新增「检查更新」，点击触发 `checkUpdate()` 并弹通知展示结果（已是最新 → 通知「已是最新版本」；发现新版 → 通知 + 设置页可下载）。

### 4.2 设置页「更新」区块

```
当前版本 v0.1.0   [检查更新]
（空闲）已是最新版本 ✓
（发现新版）发现 v0.2.0：修复xxx   [去下载] [忽略此版本]
（已忽略）已忽略 v0.2.0，更高版本将重新提醒
（下载中）正在下载 65%  [取消]
（下载完）已下载，正在打开安装包
（失败）检查失败：网络错误 / 下载失败，请重试 / 校验失败，请重试
```

### 4.3 启动流程

app ready 后延迟 5s 静默检查一次（等窗口/托盘就绪）。发现新版 → 系统 Notification 提示（不弹窗），点击通知打开设置页；用户也可从托盘/设置页操作。若该版本已被忽略则跳过。关掉通知不做任何持久化，下次启动仍提醒。

实现注意：现 `main.js` 的 `notify()` 丢弃 Notification 实例，需保留实例才能挂 `click` 事件打开设置页（Windows AppUserModelId 已设置，无需额外处理）。启动自检不设开关（自用匿名 GET 打自己服务器）；如后续需要，加 `system.autoCheckUpdate` 配置项即可。

### 4.4 忽略版本

「忽略此版本」→ 版本号写入 config（`system.ignoredUpdateVersion`，经 configCore）。之后检查跳过该版本，直到出现更高版本才重新提醒。

写入路径：主进程直接改配置并保存，**不走 applyConfig**（避免重启 watcher）；设置页「保存」时主进程把当前 `ignoredUpdateVersion` 合并回写入的配置再落盘——设置页持有的是加载时的整包快照，直接覆盖会把忽略清掉（竞态）。

### 4.5 下载

- 位置：`app.getPath('downloads')`；不可写时回退 `userData` 临时目录
- 文件名：version.json 中 URL 尾部文件名（如 `BulletChat-0.2.0-win-x64.exe`），已存在同名时追加序号
- **下载到 `.part` 临时文件**，流式下载，进度事件推送；可取消（中止流、删 `.part`）
- **SHA256 校验通过后重命名为最终文件名**，`shell.openPath()` 打开安装包 → 通知「下载完成」；校验失败只删 `.part`，下载目录不留半成品
- **单飞**：检查与下载各设 in-flight 锁；`before-quit` 中止进行中的下载（沿用 main.js 现有 before-quit 钩子）
- 失败/校验失败：删 `.part`，设置页提示重试

## 5. 服务器部署（按 baota-subdomain-deployment-sop.md）

| 变量 | 值 |
|---|---|
| SITE_DOMAIN | `updates.zhipengcoding.com` |
| DEPLOY_PATH | `/www/wwwroot/updates.zhipengcoding.com` |
| SSL_CERT_DIR | `/www/server/panel/vhost/cert/zhipengcoding.com`（复用泛域名证书） |
| 部署方式 | 纯静态文件 + Nginx，**无 Node 后端、无 PM2**（与 SOP 标准项目的差异） |
| 宝塔登记 | 按 SOP 第 9/10 节：备份 site.db → 查重 → 插 sites/domain → 补配套文件 |

- DNS：`updates.zhipengcoding.com` A → `your-server-ip` 已在阿里云控制台添加，Google DoH 验证生效（2026-08-08）
- SSH：`ssh -i /path/to/your-ssh-key.pem root@your-server-ip` 连通正常
- 服务器无 dig 命令，验证用 curl

Nginx 配置要点（静态站点）：根目录指向 DEPLOY_PATH，SSL 用现有证书，开启 `location /` 静态文件服务；`version.json` 加 `Cache-Control: no-cache`（防客户端 HTTP 缓存读到旧版本）；`.conf` 写入 `/www/server/panel/vhost/nginx/updates.zhipengcoding.com.conf`，含 SOP 9.6 的 well-known/extension include 与证书配置。

## 6. 发布流程

新增 `tools/publish-update.js`（本地执行，mac/Windows 均可运行，**按平台单独发布**）：

用法（`--platform` 取 version.json 的 files 键，架构感知）：

```bash
# macOS 电脑上发布 Apple Silicon 包
node tools/publish-update.js --platform mac-arm64 --notes "修复 xxx"
# macOS 电脑上发布 Intel 包（需 electron-builder --mac --x64 构建）
node tools/publish-update.js --platform mac-x64 --notes "修复 xxx"
# Windows 电脑上发布 win 包
node tools/publish-update.js --platform win-x64 --notes "修复 xxx"
```

发版前置：**先 bump 版本**（`npm version patch|minor` 或手改 package.json）再构建——客户端比较的是 `app.getVersion()`，安装包版本必须与 package.json 一致。产物名由 package.json 的 `win.artifactName` / `mac.artifactName` 统一定义（win: `${productName}-${version}-win-${arch}.${ext}`；mac: `${productName}-${version}-mac-${arch}.${ext}`），与 version.json URL 一致。

流程（仅操作当前平台，不影响另一平台）：

1. 校验本地 `dist/` 下有当前平台对应版本的产物（dmg/exe，文件名匹配 artifactName）
2. 计算产物 SHA256（node:crypto，跨平台一致）
3. 拉取远程 version.json 合并：
   - **HTTP 404 → 首次发布，新建**；**网络错误/超时 → 中止，不上传任何文件**（防止误删另一平台条目）
   - 更新本平台 `files` 条目（version/notes/url/sha256），**保留另一平台条目不变**
   - 顶层 `version` = 所有平台条目的最大版本；顶层 `notes` = 本次说明
4. 组装 `dist/updates/` 暂存目录（version.json + 本平台安装包），**整体上传**至服务器静态站点根目录（installer 与 manifest 必须一起到位，URL 才能通）
5. 服务器端 `chown www:www` 保证可读

**上传后端自动选择**：优先 `rsync`（macOS 自带）；Windows 无 rsync，回退 `scp`（Windows 10+ 自带 OpenSSH，按文件逐个传）。SSH 连接参数沿用 SOP 模式，从 `deploy.env` 读取（`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` / `DEPLOY_PATH`）。

**并发约束**：假设同一时刻只有一个平台在发布（单人自用，last-write-wins 可接受）；远程拉取失败即中止已消除危险变体。

日常发版：bump 版本 → 本机 `npm run build:<平台>` → 执行对应 `--platform` 的发布命令。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| version.json 拉取失败/超时 | 启动自检静默；手动检查提示「检查失败：网络错误」 |
| JSON/版本号非法 | 同上，解析防御不崩溃 |
| 下载中断 | 删半成品，提示「下载失败，请重试」 |
| SHA256 不符 | 删文件，提示「校验失败，请重试」 |
| 本平台无安装包 | 提示「此平台暂无安装包」 |
| 下载目录不可写 | 回退 userData 临时目录 |
| 发布脚本：远程拉取失败（非 404） | 中止，不上传任何文件（防误删另一平台条目） |

## 8. 测试

新增 `tests/updater.test.js`（`node --test`，纯逻辑离线可跑）：

- 版本解析/比较：`v0.2.0` 前缀、`0.1.0 < 0.2.0`、`0.9.0 < 0.10.0`、相等、非数字段 → 非法；客户端以本平台条目 `version` 为准（双平台版本不同步时不循环提示）
- 平台选择：darwin+arm64 → mac-arm64；win32+x64 → win-x64；未知 → null
- 忽略版本：忽略后同版本不提醒、更高版本重新提醒；`system.ignoredUpdateVersion` 经 configCore 保存/加载往返
- SHA256 校验：已知内容对已知哈希
- **发布脚本合并逻辑**：远程有 version.json 时只更新本平台条目、保留另一平台；顶层 version = 各平台最大值；**404 → 新建；网络错误 → 中止且不上传**
- 下载流程：本地 `node:http` 临时 server 模拟 version.json + 安装包，注入 fetch 测完整下载（`.part` → 校验 → 重命名）、取消、失败清理、拉取超时
- 单飞：检查进行中重复触发只发一次提示；下载中重复 download 被忽略
- 版本号：`app.getVersion()` 注入（当前 0.1.0），测试用假值

## 9. 文件清单

| 文件 | 动作 |
|---|---|
| `src/main/updater.js` | 新增，核心模块 |
| `src/main/tray.js` | 修改，加「检查更新」菜单项 |
| `src/main/settingsWindow.js` | 修改，注册 updater IPC |
| `src/main/main.js` | 修改，notify() 保留实例支持点击；settings:saveConfig 合并回写 ignoredUpdateVersion；before-quit 中止下载 |
| `src/preload/preload.js` | 修改，暴露 updater API |
| `src/renderer/settings/` | 修改，更新区块 UI + 进度条 |
| `src/shared/configCore.js` | 修改，`system.ignoredUpdateVersion` 配置项（默认 `''`，进 KNOWN_KEYS 带默认值） |
| `package.json` | 修改，win/mac `artifactName` 统一产物名 |
| `.gitignore` | 修改，排除 `deploy.env`（保留 `deploy.env.example` 入库） |
| `tools/publish-update.js` | 新增，发布脚本（`--platform win-x64|mac-arm64|mac-x64` 单平台发布、404 新建/网络错误中止的远程合并、rsync/scp 自动选择、读 deploy.env） |
| `deploy.env` / `deploy.env.example` | 新增，SSH 连接参数（沿用 SOP 模式） |
| `tests/updater.test.js` | 新增 |
| 服务器：Nginx 站点 + 宝塔登记 | 部署（实施阶段） |
