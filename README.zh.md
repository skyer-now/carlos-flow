# Carlos Flow — 统一分发版（Cindy / OpenCode / Cursor / Cline / VS Code / Claude Desktop）

> **面向 AI 编码 Agent 的机械门禁框架**：留痕 → 派发 → 验证 → 裁定 → 审计 → 还原  
> **把"相信 Agent"变成"验证 Agent"**——机器级 scope 限制、真实命令执行、防篡改审计链、可控免检、诚实派发配额、独立复核、快照还原。

**语言 / Languages:** [English](README.en.md) | [中文](README.zh.md)  
**版本 / Version:** 2.5.9 | **License:** MIT | **CI:** passing | **Node.js:** 22+ | **MCP:** 1.29+  
**包名:** `carlos-flow`（单一包，取代 `carlos-flow-cindy` 与 `carlos-flow-opencode`）

---

## 🎯 为什么需要 Carlos Flow？

| 痛点 | 传统 AI 编码现状 | Carlos Flow 的机械性答案 |
|------|-----------------|--------------------------|
| **越界改动** | "只改 `src/auth.py`" 是建议，Agent 照样改半个仓库 | `enforceScope()` 运行时 `git diff` 对比卡片白名单，**越界直接阻断派发** |
| **验证表演** | Agent 汇报"测试通过"，无人能证明 | `runVerifyCommand()` 真实 `spawn` 执行 `verify.cmd`，捕获 stdout/stderr/exitCode；**记 PASS 前必须有验证通过证据** |
| **可洗白的审计** | 普通文件日志——可删可改 | SHA-256 **链式审计日志**（`prevHash`→`hash`），改一条全链断裂 |
| **失控的免检** | 一句话关闭所有防护 | 免检需卡片显式 `confirmed=true`，**每次派发自动清零** |
| **无限重试** | 领卡即重置计数，可无限派发 | `dispatch_count` 只在派发时 +1，耗尽同时拦截 claim 和 dispatch |
| **自证式复核** | 同一个 Agent 既实现又审批 | 内置 `auditor` 角色，独立合同，裁定严格三档 `PASS/DIRECTION/LOCAL` |
| **改坏无法回退** | 只能手动 `git revert` | 派发前自动快照 → `flow_revert_plan` 生成原子还原计划 |
| **每次手动喊话启动** | 不喊就不启动，忘了就裸奔 | **智能触发引擎**自动识别意图，评分达标才触发，且告诉你命中了什么 |

---

## ⚡ 核心能力对比

| 能力 | Carlos Flow | 原生 MCP Server | 提示词 / 手写脚本 |
|------|-------------|-----------------|------------------|
| **越界拦截** | ✅ 运行时 `git diff` 级 | ❌ 无 | ❌ 靠自觉 |
| **真实验证** | ✅ spawn 执行并捕获输出，记 PASS 需验证通过 | ❌ 无 | ❌ Agent 自述 |
| **防篡改审计** | ✅ SHA-256 链式哈希 | ❌ 无 | ❌ 无 |
| **可控免检** | ✅ 显式开启 + 自动清零 | ❌ 无 | ❌ 一句话全关 |
| **诚实派发配额** | ✅ 只计派发 | ❌ 无 | ❌ 无 |
| **独立复核** | ✅ 内置 `auditor` 角色 | ❌ 无 | ❌ 可选 |
| **快照 + 还原** | ✅ 自动、原子计划 | ❌ 无 | ❌ 手动 `git revert` |
| **守护进程生命周期** | ✅ 全自动（Cindy 版） | ❌ 手动 | ❌ 手动 |
| **智能触发** | ✅ 三层评分 + 可解释决策 | ❌ 无 | ❌ 无 |

> 📋 **完整 QA 验收报告**：[docs/QA_REPORT_v2.5.5.md](https://github.com/skyer-now/carlos-flow/blob/main/docs/QA_REPORT_v2.5.5.md)（第三方只读验收，13/13 变异体全抓住）  
> 🧬 **变异测试报告**：[docs/MUTATION_REPORT_v2.5.5.md](https://github.com/skyer-now/carlos-flow/blob/main/docs/MUTATION_REPORT_v2.5.5.md)

---

## 🚀 30 秒快速开始

### 1. 安装（单一包，零依赖冲突）
```bash
npm install -g carlos-flow
```
> ⚠️ 报 `ETARGET`？清缓存：`npm cache clean --force && npm view carlos-flow versions`

### 2. 一键初始化（按你的平台选一个）
| 平台 | 命令 | 生成产物 |
|------|------|----------|
| **Cindy** | `carlos-flow init --target cindy` | `~/.cindy/ghosts/carlos-flow.json` |
| **OpenCode** | `carlos-flow init --target opencode` | `~/.config/opencode/plugin/opencode.json` + 项目 `.mcprc` |
| **Cursor / Windsurf** | `carlos-flow init --target cursor` | 项目 `.cursor/mcp.json` |
| **Cline** | `carlos-flow init --target cline` | 项目 `.cline/mcp.json` |
| **VS Code (Copilot)** | `carlos-flow init --target vscode` | 项目 `.vscode/mcp.json` |
| **Claude Desktop** | `carlos-flow init --target claude` | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) |

> 💡 **环境变量**（可选，有默认值）：  
> `CARLOS_FLOW_HOME=~/.carlos-flow` 状态/审计目录（跨平台）  
> `CARLOS_FLOW_MCP_ROOT=/path/to/carlos-flow` 源码安装时指向仓库根目录

### 3. 重启并验证
```bash
# CLI 验证
node client/carlos.js flow_status '{"sessionId":"probe"}'
# 期望输出里 has_card: false 即表示服务正常
```

---

## 🧠 智能触发引擎 —「工作流会自己认出该上场的时候」

### 三层架构，决策可解释

```
用户输入
    ↓
L1: DynamicTriggerManager (动态上限)
    - 计算当前触发上限：5 + 会话时长×0.5 + 复杂度×2 − 窗口内已触发×0.3，封顶 15
    - 同会话最短间隔 5 分钟；触发越多上限越低（惩罚项）
    ↓
L2: TriggerScorer (三维评分，满分 38)
    - 关键词 50：只收流程性词（工作流/门禁/派发/审计/任务卡…），不收「实现/新增/接口」
    - 上下文 30：工作流相关语境
    - 意图 20：用户行为模式
    ↓
L3: TriggerDecisionEngine (四档决策)
    - trigger  (≥15 且置信度≥0.8) → 自动激活
    - review (10~15)               → 建议手动启动
    - ignore  (<10)                → 静默忽略
    - throttled                    → 如实返回评分，不动作
    ↓
激活机制（自动档）
    1. flow_add_user_msg     — 用户原话入库，成为 quote 锚点数据源
    2. flow_submit_requirement (activation:true) — 提交 read_only 占位卡，会话进入已留痕门禁态
    3. activation_pending    — 缺 scope/acceptance/verify.cmd 时，claim/dispatch/verdict 全拦
    4. 补齐后重新提交完整卡  — 闸门放行，正常派发
```

### 关键特性
- 🎚️ **动态上限**：会话越长、任务越复杂 → 上限自动放宽；触发越频繁 → 上限收紧
- 🛡️ **不打扰**：最短间隔 5 分钟，限流时照样返回真实评分与置信度
- 📊 **评分透明**：每次返回完整 `breakdown`（命中关键词 / 上下文词 / 意图类型）
- 🧠 **反馈学习**：负反馈占多数时自动抬高触发阈值，更保守
- 🇨🇳 **中文开箱即用**：内置中文流程词；普通开发需求**不会误触发**

> 📖 **完整使用指南**：[TRIGGER_GUIDE.md](TRIGGER_GUIDE.md)

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户 / Agent                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Client (client/carlos.js)                                   │
│  - 智能触发检查 (flow_trigger_check)                              │
│  - Bridge 自动拉起、健康检查、Token 认证                         │
└─────────────────────────────────────────────────────────────────┘
                              │ JSON-RPC (stdio)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Server (src/index.js) — 核心工具集                          │
│  ├── flow_submit_requirement  — 留痕/提交任务卡                   │
│  ├── flow_claim / flow_dispatch — 领取/派发（含快照）            │
│  ├── flow_run_verify          — 真实执行 verify.cmd              │
│  ├── flow_verdict             — 裁定 PASS/DIRECTION/LOCAL        │
│  ├── flow_check_scope         — 越界拦截                         │
│  ├── flow_status / flow_audit — 状态查询 / 审计流水              │
│  ├── flow_bypass              — 可控免检                         │
│  ├── flow_revert_plan         — 原子还原计划                     │
│  └── flow_trigger_check       — 智能触发评分                     │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ 状态持久化  │   │ 审计链     │   │ 文件快照   │
        │ (gate-state)│   │ (gate-audit)│   │ (snapshots)│
        └──────────┘   └──────────┘   └──────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    ┌──────────────────┐
                    │  触发引擎状态     │
                    │ (trigger-state/) │
                    └──────────────────┘
```

---

## 📦 包结构（单一包，零平台耦合）

```
carlos-flow/
├── client/carlos.js                    # CLI 入口（含 init --target）
├── src/index.js                        # 核心 MCP Server（stdio，标准协议）
├── src/trigger.js                      # 智能触发引擎（三层架构）
├── src/state.js                        # 状态/审计/锚点数据源（含 ~ 展开）
├── src/card.js / dispatch.js / protocol.js
├── bridge/mcp-bridge.js                # Cindy 专用：后台常驻 + Token 认证
├── plugins/carlos-flow-trigger.js      # OpenCode 专用：chat.message 钩子
├── ghost.json                          # Cindy 清单（__ROOT__ 占位符）
├── opencode.json / .template           # OpenCode 配置（已渲染 + 模板）
├── .mcprc.template                     # OpenCode MCP 配置模板
├── trigger-config.usable.json          # 触发器默认配置（含中文词表）
├── trigger-config.example.json         # 触发器配置示例
├── templates/                          # 6 平台初始化模板
│   ├── cursor/mcp.json
│   ├── cline/mcp.json
│   ├── vscode/mcp.json
│   └── claude/claude_desktop_config.json
└── test/                               # 128 个测试用例（全部通过）
    ├── smoke.js / e2e-carlos.mjs / p0-gates.mjs
    ├── trigger-e2e.mjs / concurrency-e2e.mjs / e2e-acceptance.mjs
    └── mutation-check.mjs
```

---

## 🛠️ 开发与测试

```bash
# 克隆源码
git clone https://github.com/skyer-now/carlos-flow.git
cd carlos-flow

# 安装依赖
npm install

# 跑全套测试（128 个用例，全通过）
npm run test:all

# 单独跑
npm run test:e2e        # 端到端 61 项
npm run test:p0         # P0 门禁 22 项
npm run test:trigger    # 触发引擎 29 项
npm run test:concurrency # 并发 3 项（零泄漏、零利用）
npm run test:acceptance  # 验收 13 项
npm run test:mutation   # 变异测试（13/13 变异体全抓住）

# 本地打包
npm pack
```

---

## 📚 详细文档

| 文档 | 说明 |
|------|------|
| [TRIGGER_GUIDE.md](TRIGGER_GUIDE.md) | 智能触发引擎完整使用指南（配置、评分、激活、反馈学习） |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史（遵循 Keep a Changelog + SemVer） |
| [QA 验收报告](docs/QA_REPORT_v2.5.5.md) | 第三方只读验收（13/13 变异体全抓住） |
| [变异测试报告](docs/MUTATION_REPORT_v2.5.5.md) | 变异体注入细节 |

---

## 🔄 迁移指南（从旧包升级）

| 旧包 | 新命令 | 说明 |
|------|--------|------|
| `carlos-flow-cindy` | `carlos-flow` / `carlos-flow-cindy` (别名) | 保留 `carlos-flow` 通用名，新增别名兼容 |
| `carlos-flow-opencode` | `carlos-flow-opencode` (仅此命令) | opencode 用户请改用新命令名 |

```bash
# 卸载旧包
npm uninstall -g carlos-flow-cindy carlos-flow-opencode

# 安装统一包
npm install -g carlos-flow

# 重新初始化
carlos-flow init --target cindy      # 或 opencode/cursor/cline/vscode/claude
```

> ⚠️ 旧包 `carlos-flow-cindy` / `carlos-flow-opencode` 已标记 **Deprecated**，安装时会提示迁移至 `carlos-flow`。

---

## 🤝 贡献

欢迎 PR！请先跑 `npm run test:all` 确保 **128/0 全通过**。

---

## 📄 License

MIT © Carlos Flow Contributors

---

## 🔗 相关链接

- **GitHub 仓库**: https://github.com/skyer-now/carlos-flow
- **npm 包**: https://www.npmjs.com/package/carlos-flow
- **问题反馈**: https://github.com/skyer-now/carlos-flow/issues
- **更新日志**: [CHANGELOG.md](CHANGELOG.md)