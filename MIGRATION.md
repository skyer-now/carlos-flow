# 迁移指南 · Migration Guide

**从 `carlos-flow-cindy` / `carlos-flow-opencode` 迁移到 `carlos-flow`**

> **版本**：v2.7.0
> **适用**：① 从 ≤ 2.5.9 的双包架构升级到单包架构（包迁移）② 从 v2.6.x 升级到 v2.7.x（状态迁移，见下文）
> **预计耗时**：5 分钟（包迁移）/ 0 分钟（状态迁移自动完成）

---

## 📋 TL;DR

| | 之前 | 现在 |
|---|------|------|
| **安装** | `npm i -g carlos-flow-cindy`<br/>`npm i -g carlos-flow-opencode` | `npm i -g carlos-flow` |
| **命令** | `carlos-flow` / `carlos-flow-cindy` / `carlos-flow-opencode` | `carlos-flow` / `carlos-flow-cindy`（别名）/ `carlos-flow-opencode`（别名） |
| **配置** | 手动改 `ghost.json` / `opencode.json` | `carlos-flow init --target <平台>` 一键生成 |
| **状态目录** | `~/.carlos-flow` | `~/.carlos-flow`（**不变**） |
| **审计链** | 旧的 `gate-audit/*.jsonl` | 原地保留，**不迁移、不破坏** |

**核心变化只有一个**：npm 包从两个变成一个，平台从两个变成六个。
**你的状态、审计链、快照、触发历史全部原地保留。**

---

## ⚠️ 为什么要迁移

### 1. 双包维护成本是真实的

两个包共享 **100% 的核心逻辑**：

```
src/index.js      src/trigger.js     src/state.js
src/card.js       src/dispatch.js    src/protocol.js
```

却要各自发版、各自打 tag、各自跑 CI、各自写 CHANGELOG。版本漂移不是意外，是必然：

> 合并前就出现过 `carlos-flow-cindy@2.5.9` 与 `carlos-flow-opencode@2.5.8` 并存的状态 ——
> 用户 `npm install carlos-flow-opencode` 装到的是旧版，而 `carlos-flow-cindy` 已经是新版。

### 2. bin 名冲突让两个包无法共存

npm 规定同名 bin 不能共存。两个包都声明 `carlos-flow` 时：

```bash
npm install -g carlos-flow-cindy carlos-flow-opencode
# npm error EEXIST: file already exists
```

### 3. 旧包已弃用

```bash
npm install carlos-flow-cindy
# npm WARN deprecated carlos-flow-cindy@2.5.9: Deprecated: use carlos-flow instead
```

---

## 🚀 迁移步骤

### Step 1 — 安装新包

```bash
npm install -g carlos-flow@latest
```

> 新旧包**可以共存**（`carlos-flow` 三个 bin 名互不冲突），
> 建议先装新包、验证无误后再卸载旧包。

### Step 2 — 重新初始化配置

#### Cindy 用户

```bash
carlos-flow init --target cindy
```

生成 `~/.cindy/ghosts/carlos-flow.json`（含正确路径的 `__ROOT__` 已渲染）。
**重启 Cindy** 后侧栏出现「Carlos 工作流」。

#### OpenCode 用户

```bash
carlos-flow init --target opencode
```

生成两处：
- `~/.config/opencode/plugin/opencode.json`（全局 MCP 注册）
- 当前目录 `.mcprc`（项目级 MCP 配置）

**重启 OpenCode**。

#### Cursor / Cline / VS Code / Claude Desktop 用户

```bash
carlos-flow init --target cursor    # → .cursor/mcp.json
carlos-flow init --target cline     # → .cline/mcp.json
carlos-flow init --target vscode    # → .vscode/mcp.json
carlos-flow init --target claude    # → Claude Desktop 全局配置
```

### Step 3 — 验证

```bash
node client/carlos.js flow_status '{"sessionId":"probe"}'
```

期望 `"has_card": false`。

> ⚠️ 注意路径：`node client/carlos.js` 需要在**仓库根目录**执行（源码安装场景）。
> 全局安装后可直接用 `carlos-flow flow_status '{"sessionId":"probe"}'`。

### Step 4 — 卸载旧包（确认无误后）

```bash
npm uninstall -g carlos-flow-cindy carlos-flow-opencode
```

---

## 🔄 命令对照表

| 旧命令 | 新命令 | 备注 |
|--------|--------|------|
| `carlos-flow`（cindy 包） | `carlos-flow` | 主命令，语义不变 |
| `carlos-flow-cindy` | `carlos-flow-cindy` | 保留为别名，向后兼容 |
| `carlos-flow-opencode` | `carlos-flow-opencode` | 保留为别名，向后兼容 |
| `node client/carlos.js <tool>` | `carlos-flow <tool>` | **新增**：全局安装后可直接用主命令 |
| — | `carlos-flow init --target <平台>` | **新增**：一键配置 |

所有工具调用参数**完全不变**：

```bash
# 旧
node client/carlos.js flow_status '{"sessionId":"x"}'
# 新（全局安装）
carlos-flow flow_status '{"sessionId":"x"}'
```

---

## 📁 配置文件位置对照

| 平台 | 旧（手动配置） | 新（init 生成） |
|------|---------------|-----------------|
| **Cindy** | 手动编辑 `~/.cindy/ghosts/carlos-flow.json` | `carlos-flow init --target cindy` 自动生成 |
| **OpenCode** | 手动编辑 `~/.config/opencode/plugin/opencode.json` + `.mcprc` | `carlos-flow init --target opencode` 自动生成 |
| **Cursor** | 手动创建 `.cursor/mcp.json` | `carlos-flow init --target cursor` 自动生成 |
| **Cline** | 手动创建 `.cline/mcp.json` | `carlos-flow init --target cline` 自动生成 |
| **VS Code** | 手动创建 `.vscode/mcp.json` | `carlos-flow init --target vscode` 自动生成 |
| **Claude Desktop** | 手动编辑 `claude_desktop_config.json` | `carlos-flow init --target claude` 自动合并 |

---

## 💾 数据与状态：全部原地保留

| 数据 | 位置 | 迁移影响 |
|------|------|---------|
| 任务卡状态 | `$CARLOS_FLOW_HOME/gate-state/runs/<sid>/state.json` | ✅ 无影响 |
| 审计链 | `$CARLOS_FLOW_HOME/gate-audit/*.jsonl` | ✅ 无影响（哈希链不中断） |
| 文件快照 | `$CARLOS_FLOW_HOME/…/snapshots/` | ✅ 无影响 |
| 触发历史 | `$CARLOS_FLOW_HOME/trigger-state/` | ✅ 无影响 |
| 触发器配置 | `$CARLOS_FLOW_HOME/trigger-config.json` | ✅ 无影响（合并语义不变） |

> **默认 `CARLOS_FLOW_HOME` 是 `~/.carlos-flow`** —— 与旧版一致，无需任何配置变更。
>
> **⚠️ 审计链上早版本的历史断点**：上表「审计链 ✓ 无影响」指的是**文件不会丢**；但 v2.7.0 修复了跨天链接，升级前写入的文件每天第一条的 `prevHash` 是零值，该历史断点**永久保留**。详见「状态迁移」章节。

### ⚠️ 一个可选的变量命名变化

如果你之前用的是 `CARLOS_FLOW_ROOT`（trigger.js 的兼容读取），仍然有效；
新文档统一用 `CARLOS_FLOW_HOME`。两者语义相同。

---

## 🔍 行为差异（需要注意的 3 点）

### 1. `init` 会写入触发器配置

首次 `init` 时，如果 `$CARLOS_FLOW_HOME/trigger-config.json` 不存在，会自动写入默认配置。
**已存在的文件不会被覆盖。**

### 2. Claude Desktop 的配置是「合并」而非「覆盖」

`init --target claude` 会读取现有的 `claude_desktop_config.json`，
只替换 `mcpServers["carlos-flow"]` 这一项，**保留你其他 MCP server 的配置**。

### 3. Cindy 用户的 Bridge 路径由 `__ROOT__` 决定

旧版 `ghost.json` 里的路径是相对路径，装到全局目录后会失效。
新版由 `init` 渲染成绝对路径。若你手动编辑过 `ghost.json`，请重新跑一次 `init --target cindy`。

---

## ❓ FAQ

<details>
<summary><b>Q: 升级会不会丢审计链？</b></summary>

不会丢。审计链是文件追加式的（`gate-audit/YYYY-MM-DD.jsonl`），升级后继续追加。
但注意：v2.7.0 修复了「跨天断链」——升级前写入的文件每天第一条的 `prevHash` 是零值，
这个历史断点永久保留（详见「状态迁移」章节）。升级后新记录自动正确串联。
</details>

<details>
<summary><b>Q: 可以两个包同时装吗？</b></summary>

可以。`carlos-flow` 的三个 bin 名（`carlos-flow` / `carlos-flow-cindy` / `carlos-flow-opencode`）
与旧包**不冲突**（旧包用的是 `carlos-flow-cindy` / `carlos-flow-opencode`，
新包保留了同名别名 —— 此时后装的会覆盖前一个的同名 bin，但**代码是同一份**，无实际差异）。
建议直接卸载旧包，避免混淆。
</details>

<details>
<summary><b>Q: 触发阈值会变吗？</b></summary>

不会。`src/trigger.js` 的默认配置（阈值、词表、动态上限公式）在 2.6.0 中**逐字未变**。
只有配置**合并语义**在 2.5.6 就已修正为「追加不是替换」，本版本延续。
</details>

<details>
<summary><b>Q: 旧版本还能用吗？</b></summary>

能，但会显示弃用警告。npm 不会自动卸载旧版本。
</details>

<details>
<summary><b>Q: 如何完全卸载？</b></summary>

```bash
npm uninstall -g carlos-flow carlos-flow-cindy carlos-flow-opencode
# 如需清理状态（会丢失审计链，谨慎）
rm -rf ~/.carlos-flow
```
</details>

---

## 🔄 状态迁移：v2.6.x → v2.7.x（自动，无需手工操作）

v2.7.0 对**状态文件**和**审计链**做了若干行为变更。除特别说明外，**全部自动完成**，
升级后无需手工干预。以下逐项说明「变了什么 / 历史数据会怎样 / 需要你做什么」。

### 1. 审计链：跨天链接修复，历史断点永久保留

**变了什么**：v2.7.0 之前，`audit()` 只在**当天**文件内成链——每天第一条记录的
`prevHash` 是零值（`0000…`），昨天最后一条的 `hash` 没有传给今天。
这意味着跨天的链完整性无法验证（篡改昨天的记录，今天默认校验查不出）。

v2.7.0 起，`audit()` 用 `nextPrevHash(localDate())` 取「当天 tail，没有则往前找最近
一天的 tail」，`verifyAuditChain({fullChain:true})` 逐天串联验证。

**历史数据会怎样**：**升级前写入的审计文件不会被改写，其跨天断点永久保留**。
升级后跑 `verifyAuditChain({fullChain:true})`，你会看到升级前的日期
`dayBroken: 1`（每天第一条的 prevHash 对不上前一天 tail）——
**这是历史事实，不是新故障**。修复只对升级后的新记录生效。

**需要你做什么**：

- 不需要任何操作。新记录自动正确串联。
- 如果你需要一条「全链无断点」的干净记录，可归档旧文件：

  ```bash
  mkdir -p ~/.carlos-flow/gate-audit/archive
  mv ~/.carlos-flow/gate-audit/2026-11-0*.jsonl ~/.carlos-flow/gate-audit/archive/
  ```

  归档后 `fullChain` 只验证保留的文件；被归档文件不再参与校验。
- **不要**手工改写历史文件去「补链」——那等于伪造证据，与审计链的目的相悖。

### 2. state.json：schemaVersion 与自动迁移（v0 → v1）

**变了什么**：v2.7.0 的 `state.json` 新增 `schemaVersion` 字段（当前 = 1），
`loadState()` 会先跑 `migrate()` 再合并默认值。旧版没有版本号，
靠 `{...defaultState(), ...parsed}` 防御性合并——改字段名时旧字段会被静默丢弃。

**历史数据会怎样**：**自动迁移，无感**。旧 state.json（无 schemaVersion，视为 v0）
在下次 `loadState()` 时被补上：

- `schemaVersion: 1`
- `dispatch_baseline: []`（无基线 → 裁定走全量判定，更保守）
- `activation_pending: []` / `activation_activated: false`

**需要你做什么**：不需要。迁移是只增不删的（旧字段原样保留）。
若你想确认迁移生效：

```bash
node client/carlos.js flow_status '{"sessionId":"<你的会话>"}'
```

### 3. 敏感信息脱敏：只影响新写入，历史文件不自动清理

**变了什么**：v2.7.0 起，`audit()` 的字段与 `saveState()` 的状态在**落盘前**
经 `sanitizeFields()` 脱敏：key 命中 `secret/key/password/pwd/token/credential/auth`，
或 value 含 `sk_|secret=|password=|token=|api_key=|sk_live|sk_test` 时，
只留掩码（≤8 字符 → `[脱敏]`；否则头尾各 4 位 + `***`）。

**历史数据会怎样**：**已在磁盘上的旧 state.json / 审计文件不会被自动改写**。
如果 v2.6.x 时期有密钥明文落盘，它们仍在原处。

**需要你做什么**（可选）：

- 想彻底清理历史明文：删除对应会话状态目录（该会话需重新建卡）：

  ```bash
  rm -rf ~/.carlos-flow/gate-state/runs/<sid>
  ```

  或手动编辑 `~/.carlos-flow/gate-state/runs/<sid>/state.json`。
- 审计文件同理，可按日期归档/删除。

### 4. Bridge Token：硬编码默认值已移除

**变了什么**：v2.6.x 的客户端内置硬编码默认 token（`carlos-local-token-2026`）。
v2.7.0 改为：优先读 `CARLOS_BRIDGE_TOKEN`；未设置则**首次运行生成 256 位随机
token** 落盘 `$CARLOS_FLOW_HOME/bridge-token`（权限 0600），跨进程复用。

**历史数据会怎样**：升级后首次运行 bridge/客户端会生成新 token。
**旧的硬编码 token 立即失效**。

**需要你做什么**：

- 重启 bridge（Cindy 侧重启即生效；OpenCode 侧重启 OpenCode）。
- 若你在多进程/多机环境共用 token，显式设置 `CARLOS_BRIDGE_TOKEN` 并重启所有进程。

### 5. 无需迁移的部分

| 数据 | 说明 |
|------|------|
| 任务卡 / 派发计数 / 裁定结果 | 字段结构未变，原地可用 |
| 快照 `snapshots/` | 无影响 |
| 触发历史 `trigger-state/` | 无影响 |
| 触发配置 `trigger-config.json` | 合并语义不变 |
| `CARLOS_FLOW_HOME` 路径 | 仍为 `~/.carlos-flow` |

---

## 📋 全维度诊断 20 项处置台账

> 来源：第三方「全维度补位」诊断（基线 v2.6.2）。本表逐条记录 v2.7.0 的处置结论。
> 计数口径：架构盲区 6 项 + 工程缺口 11 行（其中第 2 行与盲区 1 同源）+ 文档不同步 4 项
> = 21 行，去重后 **20 项**。

### A. 架构级盲区（6 项）

| # | 诊断项 | v2.7.0 处置 | 结论 |
|---|--------|------------|------|
| 1 | 审计链跨天断链、跨天篡改不可见 | `audit()` 改用 `nextPrevHash(localDate())`；`verifyAuditChain` 全链逐天串联 | ✅ 已修（T-88） |
| 2 | 审计链无密钥 = 无防篡改 | 新增 HMAC 模式（`CARLOS_FLOW_AUDIT_KEY`）；未设密钥降级 `plain` 并回传 `mode` 字段 | ✅ 已修（T-80） |
| 3 | 敏感信息明文落盘 | `audit()` / `saveState()` 落盘前 `sanitizeFields()` 脱敏 | ✅ 已修（T-89） |
| 4 | Bridge 仅绑 127.0.0.1，同机任意进程可连 | 硬编码默认 Token 已移除（T-82）；IP 白名单/mTLS/请求签名超出当前威胁模型（本机信任） | ⏸️ 不改 |
| 5 | 无可观测性导出（metrics/tracing/优雅关闭） | `/health` 保留；metrics/tracing 属 P3 运维增强，不在核心门禁边界内 | ⏸️ 不改 |
| 6 | 状态 schema 无版本号、无迁移机制 | 新增 `schemaVersion=1` + `migrate()`（v0→v1 自动补字段） | ✅ 已修 |

### B. 工程成熟度缺口（11 行，去重后 10 项）

| # | 诊断项 | v2.7.0 处置 | 结论 |
|---|--------|------------|------|
| 1 | 跨平台路径规范化 | `expandHome()` 已解决 `~` 展开；scope 跨平台误判未复现 | ⏸️ 不改 |
| 2 | 审计链跨文件不链接 | 同盲区 1 | ✅ 已修（同源） |
| 3 | legacy 记录误报 | legacy 记录只计数、不重置 `prev` | ✅ 已修（T-81） |
| 4 | 时间戳可伪造 | 本地时钟是信任边界；hash 链仍约束代际关系 | ⏸️ 不改 |
| 5 | 无磁盘配额/轮转 | P2 运维项，不在代码门禁范围 | ⏸️ 不改 |
| 6 | 命令注入面（`verify.cmd`） | 用户自建卡片属信任边界；文档已声明 | ⏸️ 不改 |
| 7 | 无 i18n | P3，中/英 README 已覆盖主要用户 | ⏸️ 不改 |
| 8 | 无数据备份/恢复 | P2 运维项（`flow_revert_plan` 仅流程级） | ⏸️ 不改 |
| 9 | 无幂等键设计 | 不在核心风险面 | ⏸️ 不改 |
| 10 | 并发保护不全（无原子 CAS） | 跨进程排他锁已有；CAS 属增强 | ⏸️ 不改 |
| 11 | CHANGELOG 缺破坏性变更记录 | v2.7.0 CHANGELOG 含 T-80~T-89 破坏性变更 | ✅ 已修 |

### C. 文档与实现不同步（4 项）

| # | 诊断项 | v2.7.0 处置 | 结论 |
|---|--------|------------|------|
| 1 | SECURITY「无硬编码密钥」vs 客户端硬编码 token | 硬编码默认值已删除，改随机生成落盘 | ✅ 已修（T-82） |
| 2 | SECURITY 版本表缺当前版本 | 补 `2.7.x ✅ 活跃维护` | ✅ 已修 |
| 3 | README「跨平台单包」vs `path.normalize` | 文档保留；风险未复现 | ⏸️ 不改 |
| 4 | MIGRATION.md 无状态迁移章节 | 本章节即修复 | ✅ 已修 |

### 处置统计

| 结论 | 项数 | 说明 |
|------|------|------|
| ✅ 已修 | 9 项 | 架构 4（盲区 1/2/3/6）+ 工程 2（缺口 3/11）+ 文档 3（不同步 1/2/4）；另盲区 1 与缺口 2 同源合并 |
| ⏸️ 不改 | 11 项 | 均在当前攻击面 / 承诺边界之外，成本收益不匹配；如未来威胁模型扩展（多用户/多机）再评估 |

> **一句话**：20 项中**能修的都修了**（且都有对应测试或门禁守护）；
> 剩下 11 项不是「忘了」，而是**评估后判定不属于本项目的核心承诺边界**——
> 与其堆功能，不如把边界写清楚。

---

## 🔗 相关链接

| | |
|---|---|
| **仓库** | https://github.com/skyer-now/carlos-flow |
| **npm** | https://www.npmjs.com/package/carlos-flow |
| **更新日志** | [CHANGELOG.md](./CHANGELOG.md) |
| **触发引擎指南** | [TRIGGER_GUIDE.md](./TRIGGER_GUIDE.md) |
| **问题反馈** | https://github.com/skyer-now/carlos-flow/issues |
