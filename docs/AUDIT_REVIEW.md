# 第三方审查报告的逐条核实结论

> 核实基线：`carlos-flow` v2.6.3（GitHub `skyer-now/carlos-flow`，commit `f3e081c`）
> 核实方式：直接读源码 + 实跑复现，不采信报告转述

| 报告项 | 核实结论 | 实际证据 | 决策 |
|--------|----------|----------|------|
| **P0-1** 测试与生产共用 Bridge 端口 | ⚠️ **部分属实，根因属实** | 主流测试套件**已隔离端口**（`e2e-carlos` 用 `19100+pid%400`、`p0-gates` 用 `19500+`、`verify-activation-e2e.sh` 用 `19655`）。但 `client/carlos.js:175` 的 `isBridgeRunning` **只发 `GET /health`、不校验 bridge 身份** —— 端口上是别的 ROOT 的 bridge 时会被静默复用，导致 `CARLOS_FLOW_HOME` 失效 | **做方案 B**：bridge 的 `/health` 回传自身 ROOT/FLOW_HOME，客户端比对不一致即视为"未运行"、另起一个 | 
| **P0-2** `enforceScope` 不跑 git diff、`flow_dispatch` 无 scope 检查 | ✅ **完全属实** | `dispatch.js:211` `enforceScope(scope, diffFiles)` 纯函数、信任传入值；`flow_dispatch`（index.js:361-447）**只调 `snapshotFiles`，零 scope 校验**（grep `enforceScope` 无命中）。**README「越界直接阻断派发」不成立** | **做方案 A**：派发时记录 git 改动基线，裁定前计算本次引入的改动并真正阻断 |
| **P1-3** `flow_audit` 的 `date` 参数失效 | ✅ **属实**（2 处，报告说 3 处） | `state.js:271`（`verifyAuditChain`）与 `state.js:313`（`readAudit`）：`rawDate` 算出后从未使用，文件路径仍是 `${localDate()}.jsonl` | 修：两处改用 `rawDate` |
| **P1-4** 重复注册 CallTool handler | ✅ **属实** | `index.js:1144` 与 `index.js:1225` 各注册一次 `CallToolRequestSchema`；SDK 用 `Map.set` → 后者覆盖前者，`1144-1200`（含 58 行）**永不执行** | 删第一个 handler，保留带 `validateToolArgs` 的那个 |
| **审计链无密钥 → 可被完整重算** | ✅ **属实** | `state.js` 中 `createHmac` 零命中；`rec.hash = createHash("sha256")...` 裸哈希，攻击者可读文件即可重算整条链 | **A + C 都做**：有 `CARLOS_FLOW_AUDIT_KEY` 时用 HMAC，无密钥时降级并**在 verify 结果里显式标注 mode**；README/SECURITY 改成准确表述 |
| **legacy 分支重置 `prev` 导致误报** | ✅ **属实** | `state.js:294-298`：`legacy++; prev = "0".repeat(64); continue;` —— 一条旧格式记录会让其后所有记录 `prevHash` 对不上 → 全判 broken | 修：legacy 记录**跳过且保持 prev 不变**，不重置链起点 |
| **Bridge 默认 Token 硬编码** | ✅ **属实，且两端不一致** | `client/carlos.js:30`：`process.env.CARLOS_BRIDGE_TOKEN \|\| "carlos-local-token-2026"`（兜底）；`bridge/mcp-bridge.js:11`：`const TOKEN = process.env.CARLOS_BRIDGE_TOKEN` + **fail-closed**。SECURITY.md:39 声称「无硬编码密钥」 | **做方案 B**：首次运行生成随机 token 落盘到 `$CARLOS_FLOW_HOME/bridge-token`（0600），跨进程共享；不再有硬编码默认值 |
| **SECURITY.md 支持版本表过期** | ✅ **属实** | 表里只有 `2.5.x` 与 `< 2.5`，**2.6.x 缺失** | 更新为 2.6.x 活跃 / 2.5.x 仅修安全问题 |
| **`verify.cmd` 命令注入面** | ⚠️ **面存在，但影响被高估** | `dispatch.js:185` 确实用 shell 拼接。但 `verify.cmd` 本质就是"执行用户指定的验证命令"，是设计意图；且**自动激活产生的占位卡没有 `verify.cmd`**（`activation` 时 scope/acceptance 均为空），必须人工补齐才能过闸门 → **自动触发路径已被 activation 闸门挡住** | 不加硬编码黑名单（永远不全、且会误伤合法 npm scripts）。改为**可选开关** `CARLOS_FLOW_BLOCK_DANGEROUS=1` + 文档写明威胁模型 |
| `runVerifyCommand` 已跨平台修好 | ✅ 属实（正面，保留） | `dispatch.js:167` 有明确注释说明原先硬编码 `cmd.exe` 的问题 | 保留 |
| npm 包确实发布可用 | ✅ 属实（正面，保留） | `carlos-flow@2.6.3` 在 registry，`npm i -g` 实测 6 平台 init 全通过 | 保留 |

## 关于报告提出的「门禁体系只擅长静态一致性，不擅长行为兑现」

**完全正确，且这是本次最重要的元问题。**
现有的 `check:full` / `check:identity` 查的是「文档与文件是否一致」，
而 P0-2 / P1-3 / P1-4 全是「**文档承诺 ↔ 代码行为**」的落差 —— 静态检查天然查不到。

因此必须补上三个**行为兑现**类门禁：
- `check:claims` —— README/工具描述的每个能力声明都能对应到代码路径
- `check:params` —— `inputSchema` 声明的每个参数都在 handler 里被真正读取
- `check:no-dead-handler` —— 同一 request schema 不得重复注册

这三个脚本会立刻抓出 P0-2 / P1-3 / P1-4，是**防复发**的关键。

## 关于「变更前置索引 AGENTS.md」与「状态 schema 版本号」

**采纳**，成本低、收益高：
- `AGENTS.md`：告诉改代码的人「改这里先读哪里」，避免改坏契约
- `schemaVersion`：状态文件加版本号 + 迁移函数，避免将来改字段名时老用户状态**静默降级**

## 明确**不做**的（避免为改而改）

- ❌ 不加 `verify.cmd` 高危命令硬编码黑名单（默认拒绝）——会误伤合法脚本，且永远不全；改为可选开关
- ❌ 不做 `flow_dispatch` 时就阻断 scope —— 派发前还没有本次改动，跑了只会把**用户已有改动**误判成越界；正确时机是**裁定前**，且要用「派发前基线」算出**本次引入**的改动
- ❌ 不引入事件总线 / 分布式协议 / 双模式 UI —— 本项目没有 UI、没有分布式，这些是 Cindy 的形态不是本项目的
- ❌ 不删 `ERROR_LAYERS`（悬空）—— 先确认它是否被协议文档引用，若被引用则接线，否则标注为内部常量
