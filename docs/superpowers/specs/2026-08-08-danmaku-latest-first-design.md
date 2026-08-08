# 弹幕最新优先（Latest-First）设计

日期：2026-08-08
状态：已批准（用户确认方案 B：插队 + 年龄丢弃 + 优先发批）

## 目标

解决弹幕时效性问题（用户反馈四连击：最新回复被积压拖后 / 单次回复也显得慢 / 飘出来的内容过时 / 批量回复顺序乱）。根因是 AI 回复全部 append 到 FIFO 缓冲尾部，积压（尤其视觉通道高频时，每 10s +10 条 vs 每 10s 消耗 2~8 条，缓冲可涨到 40 条）导致最新回复要等 40~50 秒才轮到。

原则：最新弹幕才有价值（现有 `bufferLimit` 注释已声明此直播语义，本次落地为主动行为）；不引入新配置项、不碰 UI、不加依赖。

## 变更

### S2-1 缓冲数据模型 + 最新优先插队（brain.js）

- 现状：`buffer` 为 `string[]`，`pushBuffer` 追加到尾部，上限超限从队首丢最旧；emit 从队首 `shift()`（FIFO，旧弹幕先飘）。
- 方案：
  - `buffer` 元素改为 `{ text, ts }`（ts = 入队时间戳），仅 `brain.js` 内部使用（已 grep 确认 11 处引用全部在本文件，无外部依赖）。
  - `pushBuffer(lines)`：新回复整批 `unshift` 到队首（保持批内顺序，`unshift(...lines.map(...))` 一次性展开不反转）；随后年龄清理——从队尾逐条 pop 入队超过 `STALE_BUFFER_MS`（常量 30s）的旧弹幕；仍超限则从队尾 `splice(limit)` 截断（丢最旧）。队首 = 最新，队尾 = 最旧，三条路径统一。
  - emit 取 `this.buffer.shift().text`，其余节奏逻辑（burstMin/burstMax/minIntervalSec）不变。
  - `setLocalMode` 清缓冲逻辑兼容对象结构（`length = 0` 无需改）。
- 测试：插队顺序（有旧货时新回复先吐）；批内顺序不反转；年龄清理（>30s 丢、≤30s 留，注入 fake clock）；上限截断从队尾丢最旧（现有"缓冲上限"测试断言改为队尾语义：`弹幕13/14` 被丢、`新1/新2` 保留）。

### S2-2 新回复到达即发一批（即时感）

- 现状：`scheduleEmit()` 单定时器，到点按 minIntervalSec（默认 10s）节奏吐一批；AI 回复到达时若定时器在跑，新回复要等当前周期剩余（最长 10s）。
- 方案：`scheduleEmit(priority = false)`：
  - `generateText`/`generateVision` 成功 pushBuffer 后改调 `scheduleEmit(true)`。
  - priority 且距上次飘出 `lastEmitAt` ≥ `PRIORITY_GAP_MS`（常量 3s）时：清掉现有定时器，delay=0 重新调度 → 下一批立即飘出（队首就是新回复）。
  - 距上次飘出 < 3s（刚飘完一批）不打断，等现有定时器到点（队首已是新回复，到点先吐它）。
  - 无定时器在跑（屏幕安静）：保持现状，安静时 sinceLast 久远 → 立即发第一批。
  - 防刷屏：`lastEmitAt` 照常更新，打断后后续批次仍按 minIntervalSec 节奏；pause 守卫不变（paused 时不调度）。
- 效果：节奏进行中操作，第一条相关弹幕从"最长 10s+"缩短到"立即或 ≤3s"；积压场景（40 条）从"40~50s 后轮到"变为"插队首即时飘出，旧弹幕 30s 后自动清掉"。
- 测试：priority 且 ≥3s 时 pushBuffer 打断现有定时器立即发；<3s 时不打断（现有 timer 保留）；无 timer 时立即发（现有行为回归）。

### S2-3 测试适配（brain.test.js）

- 现有直接操作 buffer 的用例（约 8 处：`buffer.push('占位1')`、`buffer.includes('弹幕0')`、`buffer.length` 断言等）适配 `{text, ts}` 结构：push 改 `{text, ts}`（或走 `pushBuffer`），includes 改 `.some(b => b.text === ...)`。
- "批量吐出""缓冲上限""补充闸门"三个主题语义逐条核对（上限丢最旧断言从队首改队尾）。

## 不做

- 不改 `minIntervalSec` / `burstMin` / `burstMax` / `maxEventAgeSec` 等配置默认值（全局改节奏会波及本地模式与视觉通道，方案 C 已否决）。
- 不缩短 `batchIntervalMs`（攒批节流省额度，用户关注调用浪费）。
- 不做新配置项 / 设置页改动 / 依赖变更。
- 不碰 stage 渲染层（`onDanmaku` 接口不变）。

## 验证

- `npm test` 全绿（176 现有 + 新增 4 组）。
- 冒烟：`npm start` 实际体验——积压时操作文件/切应用，确认最新回复即时飘出、旧弹幕不挡路。
