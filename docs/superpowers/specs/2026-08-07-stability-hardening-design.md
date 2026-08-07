# 子项目 1：稳定性加固 设计

日期：2026-08-07
状态：已批准（用户确认，含损坏配置策略=备份+重置+通知）

## 目标

纯内部改造（不改配置结构、不加依赖、不碰 UI）：修复四个真实缺陷 + 补强错误分支测试。对应 A 类工程质量项中的降采样、定时器卫生、损坏配置提示、测试补强。

## 变更

### S1-1 队列级同路径去重（事件风暴降采样增强）

- 现状：`pushEntry` 已有 2 秒同路径 change 去抖（COALESCE_MS），但内容池 `queue` 同路径可积压多条，一次补充调用把 N 条同路径事件发给 AI。
- 方案：`maybeRefill` 取批后按 `path + type` 去重、同键只留最新一条（stable 顺序；`describeEntry` 读文件当前内容，旧 change 事件冗余；"新建→修改"不同 type 保留叙事）。屏幕事件不进文字队列，不受影响。
- 测试：同路径多条 change 入队 → 一次补充只发一条；不同 type 同路径两条都保留。

### S1-2 changeSeen 剪枝

- 现状：`changeSeen` 只增不减。
- 方案：`pushEntry` 中 size > 5000 时清理超过 60 秒的旧条目；清后仍超限则全清（与 fileWatcher 优雅降级一致）。
- 测试：灌入超限条目后 map 大小回落；清理后同路径 change 重新被当作新事件。

### S1-3 定时器/状态卫生（brain）

- `start()` 守卫：`mode === 'running'` 时直接返回（防双重试定时器链）。
- `stop()` 设 idle 后调 `emitStatus()`（托盘/设置页即时感知）。
- 移除死代码 `batchTimer`（缓冲模式后无人调度，constructor/stop 里的清理一并删除）。
- 测试：双 start 只产生一条重试链（定时器计数）；stop 后 onStatus 收到 idle 广播。

### S1-4 remount 定时器单槽 → 每 root 独立（fileWatcher，真实 bug）

- 现状：`remountTimer` 单槽，两个盘符先后失效互相覆盖，先失效的根永远不会重挂。
- 方案：`this.remountTimers = new Map()`（root → timer）；`remount()` 先清该 root 旧定时器再设新；回调触发后 delete 该键；`stop()` 全部清理。
- 测试：两 root 并发 remount → 5 秒后两个都重挂成功（watchers Map 两个都在）；stop 后不残留定时器。

### S1-5 损坏配置备份 + 显式提示

- 现状：`loadConfigFile` 吞掉所有异常静默回默认（静默降级）。
- 方案：
  - `loadConfigFile(file, fsMod, decrypter, onCorrupt = null)`：JSON.parse 或 parseConfig（含解密失败）抛错时，若提供 `onCorrupt` 则调用 `onCorrupt({ file, error })`；随后返回 `defaultConfig()`。文件不存在（首次运行）不算损坏，不触发。
  - 接线：`configCore.loadConfigFile(file, fsMod, decrypter, onCorrupt)` 保持纯函数可测；`config.js` 的 `loadConfig(onCorrupt)` 透传；`main.js` 装配时传回调：`fs.renameSync` 备份为 `config.json.corrupt-<ISO 时间戳>`（备份失败不阻塞），随后 `reporter.reportError('config', new Error('配置文件损坏，已备份为 <文件名> 并恢复默认设置'))` —— 走既有 reporter 通道，通知 + 设置页状态条同时可见，符合"出错必须提示"原则。
  - 边界：解密失败（如 safeStorage 密钥变化）同样走损坏路径；备份文件名在通知中展示。
- 测试：损坏 JSON 触发 onCorrupt 且返回默认；正常 JSON 不触发；缺失文件不触发；onCorrupt 未传时不抛异常。

### S1-6 测试补强

- generator：`friendlyError` 402/404/429/5xx 分支、超时（AbortError → ApiError timeout）分支、`ApiError.status` 字段值。
- S1-1~S1-5 各自新增测试（列在各节）。

## 不做

- 不引入崩溃上报/自动更新/签名（A5/A6 另议）
- 不改配置结构、不加 UI、不加依赖
- 不重构 noiseFilter/样式等无关模块

## 验证

- `npm test` 全绿（77 + 新增 ≈ 90+）
- 冒烟：`npm start` 正常启动；损坏 config.json 场景手动验证通知与备份文件（或由测试覆盖，视实施条件）
