# 打包支持（exe / dmg）设计

日期：2026-08-06
状态：已批准（用户确认）

## 目标

为 BulletChat 增加正式打包能力：Windows 产出 NSIS 安装包（.exe），macOS 产出 dmg 镜像。自用分发，不做代码签名与公证。

## 决策

- 工具：**electron-builder**（^26）—— 内置 NSIS 与 dmg 目标，PNG 图标自动转换 .ico/.icns，配置集中在 package.json。
- exe 形态：NSIS 安装包（非一键、允许改安装目录、中文界面）。
- 图标：`tools/generate-icon.js` 用纯 Node 手写 PNG 编码生成 512×512 占位图标（零新依赖），后续有设计图直接替换 `assets/icon.png`。
- 签名：跳过（mac 配置 `identity: null`）；未签名 app 首次运行需右键打开（macOS）/ 点击「仍要运行」（Windows SmartScreen）。
- 平台限制：dmg 只能在 macOS 构建，exe 只能在 Windows 构建，故分两个脚本，各在对应机器跑。

## 变更

### package.json

- devDependencies 新增 `electron-builder`。
- scripts 新增：
  - `build:win`: `electron-builder --win`
  - `build:mac`: `electron-builder --mac`
- 新增 `build` 字段：
  - `appId: com.bulletchat.app`
  - `productName: BulletChat`
  - `files`: `src/**`, `assets/**`（package.json / node_modules 自动包含；无原生依赖）
  - `win.target`: `nsis`
  - `nsis`: `oneClick: false`、`allowToChangeInstallationDirectory: true`、中文界面
  - `mac.target`: `dmg`
  - `mac.identity`: `null`
  - `icon`: `assets/icon.png`

### tools/generate-icon.js（新增）

纯 Node（zlib + 手写 PNG chunk）生成 512×512 PNG：深色圆角底 + 白色气泡 + 彩色弹幕条。输出 `assets/icon.png`。运行一次后提交产物，后续不必每次构建都跑。

### src/main/main.js

在 `app` ready 前固定 userData 路径，保证开发版与打包版配置目录一致（否则打包后默认变 `%APPDATA%/BulletChat`，老配置「消失」）：

```js
app.setPath('userData', path.join(app.getPath('appData'), 'bullet-chat'));
```

### README.md

新增「打包」章节：两个命令、产物在 `dist/`、未签名首次运行提示、macOS 打包版需在系统设置重新授权屏幕录制（权限按 bundle 独立）。

## 验证

- 本机（Windows）执行 `npm run build:win`，确认 `dist/` 产出 NSIS 安装包（exe）。
- `npm test` 保持全绿。
- macOS 侧：脚本与文档就绪，由用户在 Mac 上跑 `npm run build:mac` 验证。

## 不做

- 代码签名 / 公证 / 自动更新
- dmg 自定义背景图
- 安装包签名（SmartScreen 会提示未知发布者，属预期）
