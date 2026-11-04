# 变更日志 | Changelog

> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)  
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows [SemVer](https://semver.org/)

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

| 版本 | npm | GitHub Release | 核心状态 |
|------|-----|----------------|----------|
| 2.5.3 | carlos-flow-opencode | v2.5.3 | 同步 2.5.2 全部修复 |
| 2.5.2 | carlos-flow-cindy | v2.5.2 | **Phase 1 P0 完整修复** |
| 2.5.1 | 双包 | v2.5.1 | 基础版（含已知 P0 缺陷） |

> **注意**：2.5.1 版本存在上述 18 项 P0 缺陷，**强烈建议升级到 2.5.2+**