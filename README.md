# 💬 BulletChat 桌面弹幕直播

> 像直播观众一样盯着你的电脑：文件操作、屏幕变化、切换应用……都会飘出 AI 生成的弹幕吐槽。

✅ **Windows** · ✅ **macOS** · 下载：[updates.zhipengcoding.com](https://updates.zhipengcoding.com/) · GitHub：[LoveMeLoveMyDogg/bullet_chat](https://github.com/LoveMeLoveMyDogg/bullet_chat)

<!-- 建议在这里放一张演示截图或录屏 GIF（弹幕飘屏实拍），对推广效果很有帮助 -->

## 它是什么？

一个人写代码、做方案、改 PPT，最大的遗憾是——**没人看**。

BulletChat 把你的电脑变成一个 24 小时直播间：

- 📁 你**新建 / 修改 / 删除文件**，AI 观众立刻吐槽
- 🖥️ **屏幕画面变化**，视觉模型实时点评你在干什么
- 🎭 你**切到不同应用**，对应的观众群当场"换场"接播

你干活，弹幕开飘，枯燥的工作瞬间有了"直播感"——像 B 站、斗鱼那样，只是观众全是一群 AI 活宝。

## 亮点功能

### 🎭 AI 观众群：每个应用都有自己的观众席

内置五组性格鲜明的观众，按你当前打开的应用自动登场：

| 观众群 | 常驻场景 | 成员 |
|---|---|---|
| 🧑‍💻 程序员天团 | VSCode / IDEA / Code 等编辑器 | 秃头架构师、萌新实习生、测试老哥、产品经理 |
| 🍉 吃瓜群众 | 浏览器 | —— |
| 🎮 摸鱼大队 | 游戏、视频 | —— |
| 📖 学习委员 | Word / Notion / Obsidian | —— |
| 💼 社畜同僚 | 微信 / 钉钉 / 邮件 | —— |

写代码时是程序员天团围观，切到浏览器立刻换成吃瓜群众——切换应用的瞬间，AI 还会播报"🍉 吃瓜群众已进入直播间"。观众群、成员、应用归属全部支持自定义，也可以给指定应用绑定专属观众席。

### 📁 文件弹幕

文件的新建、修改、删除都会触发弹幕；小文件自动附带内容片段，观众真的"看得懂"你在写什么。

### 🖥️ 屏幕弹幕

屏幕画面每 8 秒做一次**本地像素检测**（零流量），只在真正变化时才截图发给视觉模型——你写代码、刷网页、拖窗口，观众全程在线点评。

### ⚡ 弹幕雨，不冷场

一次文字回复生成 8 到 10 条弹幕，按 2 到 8 条随机分批飘出，弹幕雨一样接连不断；最新生成的弹幕**优先上屏**，不排队、不积压，像真实直播间一样热闹。

### 🔔 场景播报

打开应用、在同一应用停留过久、屏幕长时间不动（摸鱼被抓）……观众都会"说两句"，全程不冷场。

### 🔒 隐私优先

- API Key 仅存本机（系统级加密），只发送给你填写的接口地址
- 屏幕截图只发给**你配置**的视觉模型接口；「隐私遮罩」可涂黑敏感区域再识别
- 无任何遥测、无数据上报
- 托盘一键暂停屏幕识别或整个弹幕

### 🆓 免费可玩

- **本地模式**：不填任何 API Key，内置模板弹幕开飘
- **OpenCode Zen**：注册即白嫖官方免费模型，一张密钥同时覆盖文字弹幕 + 屏幕识别（见下文教程）

### ⚙️ 全都可调

弹幕频率、批量大小、同屏上限、飘动位置（顶部 / 居中 / 全屏）、截图间隔、观众群、说话风格、噪音过滤规则……设置页可视化调整，改完立即生效。内置**调用统计**，每天调用次数、估算 token、每条弹幕的真实成本一目了然。

## 适合谁

- **程序员**：写代码时有人捧场，写 bug 时有人嘲讽
- **创作者 / 自媒体**：剪视频、写文案、做 PPT 不再孤单
- **学生党**：学习委员观众团在线监督（摸鱼会被抓包）
- **所有觉得"一个人用电脑太安静"的人**

## 快速开始

1. 从[下载页](https://updates.zhipengcoding.com/)下载安装包（Windows exe / macOS dmg）
2. 托盘图标 →「打开设置」
3. 填文字模型接口（默认 DeepSeek 官方地址），点「测试连接」
4. （可选）填视觉模型并勾选启用，可绘制隐私遮罩
5. 保存 → 正常操作电脑，弹幕开飘

macOS 首次使用屏幕识别，需在 **系统设置 → 隐私与安全性 → 屏幕录制** 中授权（文件弹幕不受影响）。应用内自带「检查更新」，新版本一键下载安装。

## 免费方案：OpenCode Zen

不想花钱？注册 [OpenCode Zen](https://opencode.ai) 即可白嫖官方免费模型（DeepSeek V4 Flash / MiMo-V2.5 等），一张密钥同时覆盖文字弹幕和屏幕识别：

1. 打开 <https://opencode.ai>，用 GitHub 账号注册登录
2. 进入 `Zen → API 密钥`，点「创建 API 密钥」，复制 `sk-` 开头的密钥（只完整显示一次）
3. 设置里两个模型共用一套配置：接口地址 `https://opencode.ai/zen/v1`，文字模型名 `deepseek-v4-flash-free`，视觉模型名 `mimo-v2.5-free`，API Key 填刚复制的密钥
4. 分别点「测试连接」，通过后保存即可

⚠️ 免费模型有速率限制（`Rate limit exceeded`），稍等片刻重试即可；免费额度官方随时可能调整。

## 接口兼容

标准 OpenAI `chat/completions` 端点直接填地址即可；仅支持 Responses API 的端点（如火山方舟 coding plan，填 `https://ark.cn-beijing.volces.com/api/coding/v3`）会自动探测并回退兼容。主流服务商（DeepSeek、OpenCode Zen、火山方舟、OpenAI 中转等）开箱即用。

## 错误处理与已知问题

出错即提示：系统通知 + 设置页状态条 + 日志（`userData/logs/app.log`），弹幕暂停，60 秒自动重试。

已知问题：在 ToDesk 等虚拟显示器环境下，弹幕窗口可能不显示（Chromium 环境怪癖，物理显示器正常）。

## 免责声明

本项目**完全免费、开源，仅供个人学习与交流使用，禁止任何形式的商业用途**（包括但不限于售卖、商业内部分发、二次打包收费等）。

- 本项目不提供任何商业授权、付费服务或担保
- 使用本项目产生的 API 调用费用由使用者自行承担（所有请求默认只发往你自己填写的接口地址）
- 请勿将本项目用于任何违反法律法规的场景
- 因使用本项目造成的任何直接或间接损失，作者不承担责任

## 开发者

### 运行

```bash
npm install
npm start
```

### 打包

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
