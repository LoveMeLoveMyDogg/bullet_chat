# BulletChat 下载首页 设计

日期：2026-08-08
状态：已获用户确认

## 1. 目标

`https://updates.zhipengcoding.com/` 从空白 404 变为 BulletChat 软件下载首页：展示产品、动态渲染各平台下载按钮与版本号。基础设施零改动（Nginx 静态根目录 + `index index.html` 已就绪，放 `index.html` 即生效）。

## 2. 页面（单文件 `tools/landing/index.html`，内联 CSS/JS，零依赖零构建）

结构自上而下：

1. **弹幕飘屏背景**：预置 20+ 条产品相关中文弹幕池，JS 随机生成弹幕（随机位置/速度/字号/颜色/透明度），CSS animation 从右向左飘过并循环；同屏 ~15 条控量；`prefers-reduced-motion` 时降级为静态装饰
2. **Hero 玻璃拟态卡片**：标题「BulletChat 桌面弹幕直播」+ 副标题 + 动态版本徽标 + 下载按钮组 + 未签名安装小字提示
3. **特性卡片 ×4**（玻璃拟态网格）：📁 文件弹幕 / 🖥️ 屏幕弹幕 / 🎭 AI 观众群 / 🔒 隐私保护
4. **更新说明**：动态读 `version.json` 的 `notes`
5. **安装指引**：折叠区（Windows：未知发布者→更多信息→仍要运行；macOS：右键打开 + 屏幕录制授权）
6. **页脚**：© 2026 zhipengcoding.com

风格：深蓝紫渐变背景 + 径向光晕 + `backdrop-filter: blur` 玻璃拟态 + 下载按钮流光 hover 动画；移动端响应式。

## 3. 动态逻辑

- `fetch('/version.json')`（同源无 CORS 限制）→ 渲染：
  - 版本徽标 = 顶层 `version`
  - 下载按钮按 `files` 键渲染：`win-x64` → Windows x64；`mac-arm64` → macOS（Apple 芯片）；`mac-x64` → macOS（Intel）；**缺失的平台不显示按钮**；条目版本落后于顶层时按钮下方小字标注该平台版本
  - 下载链接 = 条目 `url`；更新说明 = 顶层 `notes`（含换行）
- fetch 失败/无 `version.json` → 显示「暂无发布版本，敬请期待」，特性区等静态内容照常
- **发版后首页零维护**（按钮/版本号/说明全部跟随 version.json 自动更新）

## 4. 交付与部署

1. 仓库新增 `tools/landing/index.html`，提交
2. scp 上传到 `/www/wwwroot/updates.zhipengcoding.com/index.html` → `chown www:www`
3. curl 验证 HTTP 200 与内容
4. 本地验证：临时静态服务器 + 假 version.json，浏览器截图核对渲染与视觉效果
