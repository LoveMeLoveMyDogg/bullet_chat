# BulletChat 桌面弹幕直播

像直播观众一样盯着你的电脑：文件操作、屏幕变化都会飘出 AI 生成的弹幕吐槽。

支持 Windows 与 macOS。macOS 首次使用屏幕识别，需在 系统设置 → 隐私与安全性 → 屏幕录制 中授权（文件弹幕不受影响）。

接口兼容：标准 OpenAI `chat/completions` 端点直接填地址即可；仅支持 Responses API 的端点（如火山方舟 coding plan，填 `https://ark.cn-beijing.volces.com/api/coding/v3`）会自动探测并回退兼容。

## 运行

```bash
npm install
npm start
```

## 打包

打 Windows x64 安装包（NSIS）：
```bash
npm run build:win
```
macOS 上打 dmg：
```bash
npm run build:mac
```
产物在 `dist/` 目录。平台说明：**exe 可以在 macOS 或 Windows 上构建**（electron-builder NSIS 跨平台，无需 wine；macOS 上默认打 arm64，`build:win` 已固定 `--x64`）；dmg 只能在 macOS 构建。

构建工具链下载说明：electron-builder 需要从 GitHub 下载 NSIS 等工具，若网络不通（如国内直连超时）设置镜像：
```bash
# Linux/macOS
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run build:win
# Windows PowerShell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"; npm run build:win
```

自用分发（未签名）说明：
- Windows：首次运行安装包会提示「未知发布者」，点「更多信息 → 仍要运行」
- macOS：首次打开需右键应用 →「打开」；屏幕识别需重新授权（系统设置 → 隐私与安全性 → 屏幕录制，权限按应用独立）

应用图标：默认是 `tools/generate-icon.js` 生成的占位图（`assets/icon.png`），想换图标直接替换该文件后重新构建即可。

## 发布新版（检查更新）

应用内「检查更新」读取 `https://updates.zhipengcoding.com/version.json`（阿里云服务器 Nginx 静态站点，复用泛域名证书）。

发布步骤（各平台在自己电脑上操作）：

1. 升级版本号：`npm version patch`（或手改 package.json）
2. 构建：Windows 包 `npm run build:win`；macOS 包 `npm run build:mac`（Intel 包加 `--x64`）
3. 首次使用先复制 `deploy.env.example` 为 `deploy.env` 并填写 SSH 参数
4. 发布：`node tools/publish-update.js --platform win-x64 --notes "更新说明"`（mac 用 `mac-arm64`/`mac-x64`）

脚本只更新当前平台条目、保留另一平台条目；自动计算 SHA256、上传安装包 + version.json 并修正属主。用户在应用内「检查更新」→ 下载完整安装包 → 手动安装覆盖旧版。

## 使用

1. 托盘图标 → 打开设置
2. 填文字模型（默认 DeepSeek 官方地址），点「测试连接」
3. （可选）填视觉模型（OpenAI 兼容 + 视觉能力，如 opencode-go 中转），勾选启用，可绘制隐私遮罩
4. 保存 → 正常操作电脑，弹幕开飘

没有 API Key 也能玩：设置里勾选「本地模式」，用内置模板弹。

## 隐私

- API Key 仅存本机（系统加密），只发送给你填写的接口地址
- 屏幕识别会把截图发送给你配置的视觉模型 API；可用「隐私遮罩」涂黑敏感区域
- 可随时在托盘暂停屏幕识别或整个弹幕

## 错误处理

出错即提示：系统通知 + 设置页状态条 + 日志（`userData/logs/app.log`），弹幕暂停，60 秒自动重试。

## 已知问题

- 在 ToDesk 等虚拟显示器环境下，弹幕窗口可能不显示（Chromium 环境怪癖，物理显示器正常）

## 未实现（下轮迭代）

- 盘符勾选 UI（当前自动监控所有固定盘）
- 噪音过滤规则编辑 UI（设置页有占位区）
