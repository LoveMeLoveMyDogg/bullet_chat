# 子项目：调用统计 设计

日期：2026-08-07
状态：已批准（用户确认：命名"调用统计"而非"额度"；纯统计不设上限；按推荐方案 A 独立计数器）

## 目标

让用户看清每次调用的"性价比"，暴露"白浪费 token"（一次调用 0 条产出、重复输入、失败请求），**不设上限、不做拦截**。统计展示调用次数与估算 token 双口径。

用户原话：不要叫额度，就是统计调用量；不缺 token，只是不想白浪费 token。

## 变更

### U1-1 UsageCounter 模块（新文件 src/shared/usageCounter.js，纯逻辑可测）

每次 API 调用后记一条记录（成功/失败都记），字段：

| 字段 | 说明 |
|---|---|
| `ts` | ISO 时间 |
| `channel` | `text` / `vision` |
| `inputChars` | 事件描述字符数（含 system prompt） |
| `imageKb` | 视觉截图 KB（仅 vision，取整） |
| `outputChars` | 模型回复字符数 |
| `parsedCount` | 实际解析弹幕条数 |
| `error` | 失败原因（成功为 null） |

**估算 token 规则**（UI 标注"估算值"）：
- input = ⌈(inputChars + systemChars) / 1.5⌉，视觉额外 + ⌈imageKb × 12⌉
- output = ⌈outputChars / 1.5⌉
- systemChars：buildSystemPrompt 实际长度在生成时一并传入（system prompt 是每次调用的固定成本，统计要暴露它）

**存储**：内存 ring（当日）+ 每日落盘 `usage-YYYY-MM-DD.jsonl`（追加，与 requests.jsonl 同目录）。跨天惰性切换（记录时检查日期变化即换文件，无定时器）。保留最近 7 天文件，超出自动清理（与日志轮转同思路，清理失败不阻塞）。

### U1-2 brain 接线

- `generateText` / `generateVision` 调用结束后（finally 分支）`usageCounter.record({...})`，参数从调用现场取值（user/system 字符串、截图 dataUrl 大小、回复原文、parsedCount、err）
- 失败也记录（error 字段），失败请求是"白浪费"的重要来源，必须可统计
- retryNow 的探测请求**不计数**（测试连接语义，避免污染统计）

### U1-3 聚合与指标（usageStats 纯函数，可测）

- `getToday()`：`{ text: {calls, inputTokens, outputTokens, danmaku, failed}, vision: {...}, total: {...} }`
- `getHistory(7)`：每日 `{ date, calls, tokens, danmaku, failed }`（按落盘文件聚合）
- 派生指标：失败率 = failed/calls；性价比 = danmaku/calls（每次调用平均换几条弹幕）
- IPC：`settings:getUsageStats`（main 装配，从计数器读取）

### U1-4 设置页「调用统计」分区（vanilla section 拆分）

- **今日汇总卡片**：总调用次数、估算 token（输入/输出分开）、产出弹幕条数、失败次数
- **分通道小表**：文字/视觉 各自 次数/token/条数/失败
- **近 7 天趋势**：纯 CSS div 迷你柱状图（每日调用次数 + token 双色），零依赖零构建
- **估算说明**：估算 token 的 label 带 `？` tooltip（「估算值：按字符数/1.5 粗估（中英混合），视觉按截图大小另加。实际计费以你的 API 服务商为准」）
- 明细复用现有请求日志列表（不动）

### U1-5 测试

- 估算函数边界：空输入、长文本、大截图、0 值
- 记录/落盘/跨天切换/7 天清理
- 聚合正确性：多通道、失败计入、性价比与失败率
- brain 接线：成功/失败都记录、探测请求不计数

## 设置页技术路线（本子项目确认项）

继续 vanilla JS 零构建，按 section 拆分模块（`settings/sections/stats.js` 等，每 section 100~200 行，主文件只做装配与 IPC 透传）。触发信号（settings 拆分后仍超 ~1200 行 / 跨 section 状态联动 / 表单校验重复到痛）出现再评估 petite-vue（无构建）→ Vue3+Vite。

## 不做

- 预算上限 / 超限拦截 / 自动降级（用户明确：不缺 token）
- 按金额统计（需单价表，端点价格差异大）
- 托盘菜单入口（保持托盘简单，打开设置才看）
- 历史保留超 7 天（如需长期趋势后续加）

## 验证

- `npm test` 全绿（新增 ~8 个）
- 冒烟：真实请求后设置页统计数字正确；重启后今日统计保留（落盘）；跨天自动切换
