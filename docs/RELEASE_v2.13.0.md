# Carlos Flow 发布说明 · v2.13.0

> 本版为**可靠性与一致性**版本：不含新功能，聚焦「CI 长期红」的根因修复与守护加固。
> 上一个版本：v2.12.8（workdir 目录错位根因修复）。

## 1. 修复：CI 长期红的根因（漂移的变异锚点）

`scripts/mutation-check.mjs` 的 3 个锚点未随源码演进而更新，导致 `check:anchors` 报 3/17 失效，CI `identity` job 长期红：

| 锚点 | 漂移原因 | 修复 |
|---|---|---|
| M2-claim 闸门失效 | 源码已包 `guideError(state, …)`，锚点 `from` 未同步 | 同步 `from` |
| M3-verdict 闸门失效 | 同上 | 同步 `from` |
| M15-审计链校验恒真 | `verifyAuditChain` 返回已加 `mode/mode_ts/claimed_profile` 前缀 | 同步 `from` |

修复后 **`check:anchors` 17/17 命中**，CI `identity` 转绿。

## 2. 加固：堵住两个变异守护盲区

变异测试全量跑暴露：注入退化后测试仍全绿（守护静默失效）。

| 盲区 | 补的测试 |
|---|---|
| **M15** 单日审计校验恒真 | `test/audit-chain.mjs` 新增「单日校验篡改用例」（23 → 25 条） |
| **M12** 锁非排他（`'wx'`→`'a'`） | `test/concurrency-e2e.mjs` 新增「锁排他性：两进程各 100 次读-改-写零丢更新」（3 → 4 条） |

手动注入验证：M15 注入后 `24 通过 / 1 失败`（CAUGHT）；M12 注入后并发套件 FATAL（CAUGHT）。

## 3. 一致性与文档

- `ghost.json` 工具清单与 `src/index.js` 统一为 **20 个工具**（移除空名称残留）。
- `check:no-dead-handler` 期望工具数 22 → 20。
- README 增加「关联文档」章节与「版本一致性约定」（中 / 简 / 英三份同步）。
- `docs/QA_REPORT_v2.5.5.md`、`docs/MUTATION_REPORT_v2.5.5.md` 顶部加**历史快照**版本戳（结论仅对 v2.5.5 负责）。

## 4. 验证数字

- 全量回归 `npm run test:all`：**162/162 全绿**（unit 10 · e2e 88 · flow 22 · acceptance 13 · gate 10 · alignment 25 · bridge 6 · concurrency 4）
- `check:anchors`：**17/17**
- CI（push main + tag v2.13.0）：`test(ubuntu/windows)` · `identity` · `bridge(ubuntu/windows)` 全部 success
- npm：`carlos-flow@2.13.0`，`dist-tags.latest = 2.13.0`

## 5. 审计可追溯性说明

`flow_audit` 已在留痕、派发、快照、验证、负对照、双轴提交、裁定等环节写入链式事件
（`record / accepted / claimed / snapshot / dispatch / falsify / audit_axis_submitted / verdict` 等）。
卡终态落定（`completed_ok`）同样留痕，可按 `sessionId` 全量追溯。
