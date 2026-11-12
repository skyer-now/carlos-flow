# Carlos Flow 2.6.0 — 单包统一分发（6 大平台）

> **本文档对应 2.6.0 的单包统一分发发布**（当时的 Breaking Change 与迁移说明）。
> 2.6.0 之后的版本变更请看 [`CHANGELOG.md`](CHANGELOG.md)（当前最新：v2.11.0）。

> **Breaking Change**：两个包合并为一个。
> `carlos-flow-cindy` + `carlos-flow-opencode` → **`carlos-flow`**
>
> 迁移指南见仓库的 [`MIGRATION.md`](https://github.com/skyer-now/carlos-flow/blob/main/MIGRATION.md)。

---

## 🎯 为什么要合并

两个包共享 **100% 的核心逻辑**（`src/index.js` / `trigger.js` / `state.js` / `card.js` /
`dispatch.js` / `protocol.js`），却要各自发版、各自打 tag、各自跑 CI、各自写 CHANGELOG。

**版本漂移不是意外，是必然** —— 合并前就出现过 `carlos-flow-cindy@2.5.9` 与
`carlos-flow-opencode@2.5.8` 并存的状态；用户 `npm install carlos-flow-opencode`
装到的是旧版，而 cindy 那边已经是新版。

合并后：核心逻辑**零分叉**，版本永远一致，维护成本减半。

---

## ✨ 新增

| 内容 | 说明 |
|------|------|
| **6 大平台支持** | Cindy / OpenCode / Cursor / Cline / VS Code (Copilot) / Claude Desktop |
| **`carlos-flow init --target <平台>`** | 一键生成对应平台的 MCP 配置（6 个目标全部实测通过） |
| **`templates/` 目录** | 4 套平台配置模板 + `opencode.json.template` + `.mcprc.template`，统一 `__ROOT__` 占位符 |
| **`MIGRATION.md`** | 从旧包迁移的完整指南（命令对照、配置位置对照、行为差异、FAQ） |
| **`package.json` `exports`** | `carlos-flow/cindy`、`carlos-flow/opencode`、`carlos-flow/trigger-config` 子路径导出 |

---

## 🐛 修复

| # | 问题 | 影响 |
|---|------|------|
| T-59 | `CARLOS_FLOW_HOME` 的 `~` 在 `OPENCODE_DB_PATH` 等环境变量上不展开 | Windows 下字面写入，OpenCode 用户拿不到原话 → quote 锚点校验失败 → 卡片无法提交 |
| T-60 | `release.mjs` 硬编码双仓身份 | 单包化后身份自检直接失败，**发不了版** |
| T-61 | `client/carlos.js` 的 `ROOT` 默认取 `process.cwd()` | 源码目录执行时 `init` 报 ENOENT |
| T-62 | `init` 的目标白名单只认 2 个平台 | 新增平台的 `init` 被拒 |
| T-63 | 包的 `files` 白名单缺 `templates/` | 初始化模板不进 tarball，装完即失败 |
| T-64 | `ghost.json` / `opencode.json` 路径写死为相对路径 | 装到全局目录后路径全错 |
| T-65 | `flow_run_verify` 的工作目录只用 `process.cwd()` | server 是常驻进程，cwd 是**启动时**的目录 → `verify.cmd` 在错误目录跑 → **真 PASS 被误杀** |
| T-66 | Bridge 的 `REQUEST_TIMEOUT` 固定 **5s** | 服务端内部超时是 120s，但 Bridge 5s 就断 → **任何耗时 >5s 的验证命令必然超时失败** |
| T-67 | CLI 客户端的 MCP 调用超时固定 **5s** | 同上，命令行调 `flow_run_verify` **永远失败** |

---

## 📚 文档全面重写

按顶级开源项目（React / Vue / TypeScript / Kubernetes）的文档标准重构信息架构：

- **README** — 徽章栏 + TL;DR + 痛点对照表 + 6 大核心亮点 + Mermaid 技术框架图
  + 五层职责表 + 能力矩阵 + 15 工具参考表 + 配置说明 + 测试覆盖矩阵 + FAQ 7 问
- **CHANGELOG** — 按 Keep a Changelog 重构，2.6.0 明确标注 Breaking Change
- **TRIGGER_GUIDE** — 新增评分公式完整推导、配置合并语义三类表、激活闸门时序图
- **MIGRATION** — 新增
- 中英双语**零差异同步**

---

## 🔬 验证

- 全套测试 **129/0 通过**（smoke 4 / e2e 62 / p0 22 / trigger 29 / concurrency 3 / acceptance 13）
- 变异测试锚点 **13/13 全部命中**
- 6 平台 `init --target` 命令逐个实测通过
- 新增单包一致性守卫（身份 / 版本 / 文档 / 产物 / 安全五类检查）

---

## 🔗 安装

```bash
npm install -g carlos-flow
carlos-flow init --target <cindy|opencode|cursor|cline|vscode|claude>
```

> 旧包 `carlos-flow-cindy` / `carlos-flow-opencode` 已标记 **Deprecated**。
