# BulletChat 弹幕外观配置 设计

日期：2026-08-05
状态：已获用户确认（含两项默认值调整）

## 1. 目标

设置页「弹幕」区新增外观配置：字号范围、颜色列表、速度倍速、动画勾选。配置存 `config.danmaku`，热更新即时生效。

## 2. 配置结构（configCore KNOWN_KEYS.danmaku 变更）

| 键 | 默认 | 说明 |
|---|---|---|
| `fontSizeMin` | 30 | 字号下限 |
| `fontSizeMax` | 39 | 字号上限（min == max 即固定大小） |
| `colors` | `[]` | 颜色列表：**空 = 白色**；1 个 = 全同色；多个 = 随机轮换 |
| `speed` | 1 | 动画倍速 0.5~2，横飘 9s / 掉落 6s / 弹出 3s / 抖动周期按倍速缩放，弹幕移除时长同步缩放 |
| `animations` | `[]` | 允许的动画池（fly/drop/pop/shake），**默认全关**（弹幕静止显示）；勾选才飘 |
| ~~animationsEnabled~~ | — | 移除，被 animations 列表取代；旧配置加载时被 mergeConfig 安全忽略（自动迁移） |

字号与颜色作用于所有弹幕（本地模式也跟随范围，不再有 26px 特例）。

## 3. 实现

- 新增 `src/shared/danmakuStyle.js`（纯 Node，单测覆盖）：
  - `pickFontSize(min, max, rng)` → min..max 随机整数（min>=max 时返回 min）
  - `pickColor(colors, rng)` → 空列表返回 `'#ffffff'`；否则随机取一项（过滤空串）
  - `pickAnimation(animations, rng)` → 空列表返回 null（不飘）；否则随机取一项
  - `durationFor(anim, speed)` → 基础时长 {fly:9000, drop:6000, pop:3000, shake:1200} / speed 取整
- `danmaku.js` 渲染层：字号/颜色/动画/时长改用 danmakuStyle；动画 class 的 `animationDuration` 用内联样式按倍速缩放；移除时长按所选动画的 durationFor 计算；`animations` 空列表 → 静态显示（不设动画 class）；`onStageConfig` 仅当 `maxConcurrent` 变化时才重建轨道（修掉配置热更新清空在途弹幕）
- 设置页「弹幕」区新增「外观」子区：最小/最大字号（number 0~100，保存时校正 min<=max）、颜色列表（逗号分隔，占位提示"留空=白色"）、速度滑块（0.5~2.0 step 0.1，实时显示）、动画四勾选（横飘/掉落/弹出/抖动，默认全不选，提示"勾选后弹幕才会飘动"）；移除原「动画」checkbox
- stage.updateConfig 不变（danmaku 整段透传）

## 4. 测试

- configCore：新默认值断言；旧配置（含 animationsEnabled）加载后字段被丢弃、新默认值生效（迁移）
- danmakuStyle：4 组单测（字号范围/边界、颜色空列表→白、动画空列表→null、时长缩放）
- 手动验证：设置改动 → 弹幕即时生效（白色静态 → 勾动画+调速度 → 彩色飘动）

## 5. 非目标

- 不做字体选择、描边/阴影样式、每条弹幕独立配置
