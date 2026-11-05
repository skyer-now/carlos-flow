# 变更日志 | Changelog

> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)  
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows [SemVer](https://semver.org/)

---

## [2.5.5] - 2026-11-05 — 智能触发引擎正式发布 + 5 项缺陷修复

### ✨ 新增 | Added

**智能触发引擎**：三层智能触发系统（零外部依赖，纯 JavaScript）

| 层级 | 组件 | 说明 |
|------|------|------|
| L1 | `DynamicTriggerManager` | 动态触发上限：会话时长、任务复杂度、近期触发频率 |
| L2 | `TriggerScorer` | 触发评分：关键词 (0-50) + 上下文 (0-30) + 意图 (0-20) = 0-100 |
| L3 | `TriggerDecisionEngine` | 决策引擎：`trigger` / `review` / `ignore` / `throttled` |

- **配置系统**：`trigger-config.json` 可覆盖全部阈值与权重
- **状态持久化**：触发历史落在 `CARLOS_FLOW_HOME`，不污染仓库目录
- **用户反馈学习**：接受/拒绝行为驱动权重调整
- **详细文档**：[TRIGGER_GUIDE.md](TRIGGER_GUIDE.md)

**测试套件**

- `test/trigger-e2e.mjs`：15 项触发引擎用例（含 4 项回归用例）
- `npm run test:all`：串联 smoke + e2e-carlos + p0-gates + trigger-e2e

### 🐛 修复 | Fixed

> 以下 5 项均为**真实可复现的缺陷**，在本次发布前由独立验证发现并修复。

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-1 | `client/carlos.js` 是 ESM 模块却使用 `require()` 加载触发引擎 | 异常被 catch 吞掉，**触发引擎集成完全失效（死代码）** | 改用 `await import(pathToFileURL(...))` |
| T-2 | `canTrigger()` 用 `calculateHistoryFactor()`（返回 0~1 加权均值）与上限 5~15 比较 | **上限检查永远不触发**，限流形同虚设 | 新增 `countTriggersInWindow()` 返回窗口内实际次数 |
| T-3 | 动态上限公式中历史因子为**加项** | 触发越多上限越高，**封顶逻辑自我抵消** | 改为惩罚项：近期触发越频繁，上限越低 |
| T-4 | `processUserMessage()` 硬编码 `sessionId='default'`，忽略 `context.sessionId` | 多会话场景状态串扰 | 按 `context.sessionId` 创建引擎并透传 |
| T-5 | `src/trigger.js` 的 CLI 入口用 `import.meta.url.endsWith(process.argv[1])` | `file:///` 前缀导致永不匹配，**独立测试模式从未运行过** | 改用 `fileURLToPath` + `resolve` 路径比较 |

### 🔒 安全 | Security

| # | 问题 | 修复 |
|---|------|------|
| S-1 | `.gitignore` 末行为 `*.tar.gz.npmrc.local`（粘连），导致 `.npmrc.local`（含 npm token）**未被忽略** | 拆分为独立规则，并补充 `.npmrc.*.local` |
| S-2 | 一次性修复脚本（`fix_*.mjs`、`debug_*.mjs` 等 42 个）与 `.b64`、`secret.json` 等临时文件混入仓库 | 加入 `.gitignore` 忽略规则 |
| S-3 | 触发器状态文件默认写入当前工作目录 | 改为与 `state.js` 一致的 `CARLOS_FLOW_HOME` 约定 |

### 🔧 变更 | Changed

- 触发引擎 E2E 测试迁入 `test/trigger-e2e.mjs`，纳入 npm scripts
- README / CHANGELOG / package.json 版本号统一为 **2.5.5**
- `carlos-flow-cindy` 与 `carlos-flow-opencode` 的 `src/` 保持逐文件一致

### ✅ 验证 | Verification

| 套件 | 结果 |
|------|------|
| `npm test`（smoke） | SMOKE_OK |
| `npm run test:e2e`（e2e-carlos） | **16/16 通过** |
| `npm run test:p0`（p0-gates） | **10/10 通过** |
| `npm run test:trigger`（trigger-e2e） | **15/15 通过** |

---

## [2.5.4] - 2026-11-04 — 智能绑定图标修复与文档标准化

### 🎨 界面修复 | UI Fixes

- **README 徽章**：移除 Shield.IO 图像，改用纯文本标签，解决乱码/方框显示问题
- **多语言导航**：添加 [中文](README.zh.md) / [English](README.en.md) 语言栏

> 🚨 **注意**：v2.5.2 及更早版本存在 5 处致命语法错误（MCP Server 无法启动），**强烈建议升级到 2.5.3+**。

---

## [2.5.3] - 2026-11-04 — 致命语法错误修复 + 门禁真验证

### 🚨 致命修复 | Critical Fixes

> 2.5.2 存在 **5 处致命语法错误**，导致 MCP Server 完全无法启动。所有宣称"已修复"的功能实际均未运行。

| # | 问题 | 修复 |
|---|------|------|
| C-1 | `flow_claim` 内 `const a` / `const role` 重复声明 → SyntaxError | 删除重复声明 |
| C-2 | `flow_revert_plan` 的 `inputSchema` 未闭合，handler 丢失 | 补全完整实现 |
| C-3 | `flow_check_scope` 后残留旧 `flow_revert_plan` 代码块 | 移除残留 |
| C-4 | `Unknown tool` 返回缺右括号 `}` | 补齐 |
| C-5 | `CallTool` handler 未闭合，`await` 处于非法位置 | 重建为单一正确 handler |
| C-6 | `CallTool` handler 被注册两次（原始 + Phase1 补丁） | 合并为单一 handler，内含参数校验 |

### 🔧 功能修复 | Functional Fixes

| # | 问题 | 修复 |
|---|------|------|
| F-1 | role 白名单失效（`a.role === "auditor" ? ... : "executor"` 先降级，校验永不触发） | 非法值直接报错，不得静默降级 |
| F-2 | dispatch 要求 `dispatch_count > 0` 但计数只在 dispatch 时 +1 → 首次 dispatch 死锁 | 新增 `state.claimed` 标记：claim 置位、dispatch 清零 |
| F-3 | `flow_bypass` 无任何确认校验，可随意开启 | 开启必须 `confirmed=true`；派发后自动清零 |
| F-4 | `isBypassed()` 只看 `bypass` 标志，旧卡片免检会作用于新卡片 | 增加时序校验（`bypass_ts >= card_ts`） |
| F-5 | Bridge spawn 时未注入 `CARLOS_FLOW_MCP_ROOT` → bridge 拼出 `undefined/src/index.js` | 注入绝对路径 `ROOT_ABS` |
| F-6 | `client/carlos.js` 从 `ROOT/mcp-bridge.js` 找 Bridge，但文件在 `bridge/` 下 | 双路径探测（优先 `bridge/`） |
| F-7 | CLI 客户端丢弃 `isError` 标志，调用方无法区分成败 | 错误走 stderr 且退出码非 0 |
| F-8 | E2E 脚本硬编码 `ROOT/carlos.js`（发布版无此文件）→ Promise 挂起 | 双路径探测 + `spawn error` 监听 |
| F-9 | `validateToolArgs` 脱离作用域，参数校验实际未执行 | 重建为顶层函数，独立 handler 内调用 |

### ✅ 验证 | Verification

| 套件 | 结果 |
|------|------|
| `npm test`（smoke） | SMOKE_OK |
| `test/e2e-carlos.mjs` | **16/16 通过** |
| `test/p0-gates.mjs`（新增·门禁专项） | **10/10 通过** |

`test/p0-gates.mjs` 逐条验证审核报告指出的门禁：非法 role 拦截 / 未 claim 拦截 / verify.cmd 真实执行 / verify 失败如实报 / scope 内外判定 / 非法 verdict 拦截 / 免检需确认 / 审计可读。

---

## [2.5.2] - 2026-11-04 — Phase 1 P0 全修复版

### ✨ 新增 | Added

| 编号 | 功能 | 说明 |
|------|------|------|
| 1 | `flow_run_verify` 工具 | 真实执行卡片 `verify.cmd`，返回 `{exitCode, stdout, stderr, ok, durationMs}` |
| 2 | `flow_check_scope` 工具 | 机器级 scope 越界校验，传入变更文件列表，返回 `{ok, violations[]}` |
| 3 | `runVerifyCommand(cmd, cwd)` | `dispatch.js` 导出，真实 spawn 子进程执行验证命令，捕获完整输出 |
| 4 | `enforceScope(scope, diffFiles)` | `dispatch.js` 导出，git diff 对比 scope 白名单，越界即返回违规列表 |
| 5 | `verifyAuditChain(opts)` | `state.js` 导出，SHA-256 链式哈希校验，支持 `sinceIndex` 增量校验 |
| 6 | `isBypassed(state)` | `state.js` 导出，免检模式真实判定（需 `bypass=true` 且 `bypass_ts < card_ts`） |

### 🐛 修复 | Fixed

| 编号 | 问题 | 修复方案 |
|------|------|----------|
| P0-1 | role 拼写错误静默降级为 executor | 白名单校验：仅允许 `executor`/`auditor`，其他直接报错 |
| P0-2 | `dispatch_count` 在 claim 时重置导致无限刷额度 | 仅在 `flow_dispatch` 时 +1，claim/verdict 不计数 |
| P0-3 | `verify.cmd` 未真实执行，仅记录意图 | 新增 `runVerifyCommand()`，真实 spawn 执行并捕获结果 |
| P0-4 | scope 校验仅在卡片提交时做路径存在性检查 | 新增 `enforceScope()` 运行时 git diff 级越界拦截 |
| P0-5 | 免检模式隐式触发，派发不清零 | `isBypassed()` 需显式 `bypass=true` 且时间戳在卡片之后，新派发自动清零 |
| P0-6 | 过期卡拦截 claim 但不拦截 dispatch | `isStale()` 统一拦截 claim 和 dispatch |
| P0-7 | 配额耗尽仍允许 dispatch | `dispatch_count >= MAX_DISPATCH` 同时拦截 claim 和 dispatch |
| P0-8 | verdict 枚举校验缺失，接受任意字符串 | 严格 enum: `PASS`/`DIRECTION`/`LOCAL`，其他报错 |
| P0-9 | 审计链仅写入不校验，字段缺失 | 新增 `verifyAuditChain()`，补全 `prevHash`/`hash` 字段 |
| P0-10 | `CallTool` 无参数校验，直接进入 handler | 统一 `validateToolArgs()` 前置校验 required schema |
| P0-11 | `validateToolArgs` 因缺少 required 字段永不执行 | 补全所有工具 `inputSchema.required` |
| P0-12 | `readManifestAll` 缺失，无法读取完整快照清单 | 新增 `readManifestAll(sid)` 返回全部条目 |
| P0-13 | `write_files` 计数器未在 dispatch 时初始化 | `flow_dispatch` 时重置 `write_files=0` |
| P0-14 | dispatcher 死锁：claim 重置计数导致无限循环 | 移除 claim 时的 `dispatch_count=0` 重置 |
| P0-15 | `card.confirmed` 优先级错误，敏感路径无法通过 | 结构化参数与 cardText 统一取 `||` 逻辑 |
| P0-16 | `flow_bypass` 无需确认即可开启 | 需 `confirmed=true` 且显式 `bypass=true` |
| P0-17 | 审计事件类型不全，缺少 `snapshot`/`dispatch` 等 | 补全 `audit()` 调用点，事件类型标准化 |
| P0-18 | `protocol.js` 协议文档与实现不一致 | 同步更新路由表、合同模板、错误分层、状态 schema |

### 🔧 变更 | Changed

- `MAX_DISPATCH` 从 3 调整为 5（配合修复后的计数语义）
- 审计链存储格式：每条记录强制包含 `prevHash`、`hash`、`seq`
- `flow_dispatch` 返回新增 `snapshot` 字段（快照条目数组）

### 📦 依赖 | Dependencies

- 无新增外部依赖，仍为零依赖核心（仅 `@modelcontextprotocol/sdk`）

---

## [2.5.1] - 2026-11-03 — 初始发布

### ✨ 新增 | Added

- 基础 12 个工具：`flow_protocol`、`flow_add_user_msg`、`flow_submit_requirement`、`flow_claim`、`flow_dispatch`、`flow_verdict`、`flow_status`、`flow_audit`、`flow_diff_hunks`、`flow_bypass`、`flow_save_result`、`flow_revert_plan`
- TCP Bridge 自动管理（首次调用拉起、健康检查、Token 认证、限流、超时控制）
- Cindy 插件集成（`ghost.json`、`settings.html/js`、加密保险库存储）
- 完整测试套件：smoke + e2e-carlos (16) + e2e-rea (8)

### 🔒 安全 | Security

- Bridge 仅监听 127.0.0.1
- 请求体限制 1 MB
- 单连接限流 10 req/s

---

## 升级指南 | Upgrade Guide

### 从 2.5.4 → 2.5.5

1. **更新包**：`npm install -g carlos-flow-cindy@2.5.5`
2. **新特性**：智能触发引擎自动加载，配置 `trigger-config.json` 可调阈值
3. **零破坏性**：完全向后兼容；配置文件不存在时使用默认参数
4. **行为变更**：触发上限现在会随近期触发频率收紧（之前形同虚设）

### 从 2.5.1 → 2.5.2

1. **更新包**：`npm install -g carlos-flow-cindy@2.5.2`
2. **环境变量**：无破坏性变更，现有 `.env` 继续可用
3. **状态目录**：`CARLOS_FLOW_HOME` 兼容，审计链自动补全字段
4. **新工具可用**：`flow_run_verify`、`flow_check_scope` 即刻生效
5. **行为变更**：
   - `dispatch_count` 计数语义修正（仅 dispatch 计数）
   - 免检模式需显式开启且派发自动清零
   - role 拼错直接报错而非降级

---

## 版本对照表 | Version Cross-reference

| 版本 | npm (Cindy) | npm (OpenCode) | GitHub Release | 核心状态 |
|------|-------------|----------------|----------------|----------|
| 2.5.5 | carlos-flow-cindy@2.5.5 | carlos-flow-opencode@2.5.5 | v2.5.5 | **智能触发引擎 + 5 项缺陷修复** |
| 2.5.4 | - | carlos-flow-opencode@2.5.4 | v2.5.4 | 文档标准化 + UI 修复 |
| 2.5.3 | carlos-flow-cindy@2.5.3 | carlos-flow-opencode@2.5.3 | v2.5.3 | **致命语法修复 + 门禁真验证** |
| 2.5.2 | carlos-flow-cindy@2.5.2 | carlos-flow-opencode@2.5.2 | v2.5.2 | Phase 1 P0 全修复 |
| 2.5.1 | 双包 | 双包 | v2.5.1 | 基础版（含已知 P0 缺陷） |

> **注意**：2.5.1 版本存在 18 项 P0 缺陷，2.5.2 存在 5 处致命语法错误，**强烈建议升级到 2.5.5**。