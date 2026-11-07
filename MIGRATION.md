# 迁移指南 · Migration Guide

**从 `carlos-flow-cindy` / `carlos-flow-opencode` 迁移到 `carlos-flow`**

> **版本**：v2.6.0
> **适用**：从 ≤ 2.5.9 的双包架构升级到 2.6.0 单包架构
> **预计耗时**：5 分钟

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

不会。审计链是文件追加式的（`gate-audit/YYYY-MM-DD.jsonl`），`prevHash` 从磁盘尾部读取，
与进程数、版本无关。升级后继续追加，链不会断。
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

## 🔗 相关链接

| | |
|---|---|
| **仓库** | https://github.com/skyer-now/carlos-flow |
| **npm** | https://www.npmjs.com/package/carlos-flow |
| **更新日志** | [CHANGELOG.md](./CHANGELOG.md) |
| **触发引擎指南** | [TRIGGER_GUIDE.md](./TRIGGER_GUIDE.md) |
| **问题反馈** | https://github.com/skyer-now/carlos-flow/issues |
