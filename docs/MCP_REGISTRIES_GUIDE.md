# Carlos Flow · 第三方 MCP 平台进驻物料与提交指南 (2026 最新)

本文件汇总了 **Smithery**、**Glama** 和 **MCP.so** 三大主流平台的最新提交入口、审核要求以及准备好的申报物料。

---

## 1. Smithery (`smithery.ai`)

### 平台入口与机制
* **官网提交入口**：[https://smithery.ai/new](https://smithery.ai/new)
* **CLI 提交方式**：`npx -y @smithery/cli publish`
* **审核机制**：自动连接测试 MCP Stdio 握手（`initialize` 与 `tools/list`），通过后即刻收录并生成安装页面。
* **核心配置文件**：仓库根目录中的 `smithery.yaml`（已帮您在项目根目录创建完成）。

### 预置配置文件内容 (`smithery.yaml`)
```yaml
name: carlos-flow
displayName: Carlos Flow (AI Coding Guardian)
description: |
  Carlos Flow is a workflow gate and guardian for AI coding assistants on Windows.
  It provides mechanical guardrails (fail-closed scope checks, spawn-driven real testing),
  communication optimizations (4KB output folding, MCP progress heartbeats), and plain-language guidance.
homepage: https://github.com/skyer-now/carlos-flow#readme
repository: https://github.com/skyer-now/carlos-flow
license: MIT

runtime: node
startCommand:
  type: stdio
  command: npx
  args:
    - "-y"
    - "-p"
    - "carlos-flow"
    - "carlos-flow-server"
```

---

## 2. Glama (`glama.ai`)

### 平台入口与机制
* **官网提交入口**：[https://glama.ai/mcp/servers](https://glama.ai/mcp/servers)
* **提交方式**：
  1. 登录 Glama，输入 GitHub 仓库 URL (`https://github.com/skyer-now/carlos-flow`) 进行抓取；
  2. 根目录放置 `glama.json`，平台爬虫会自动索引维护者并绑定账号权限（已帮您在项目根目录创建完成）。
* **审核机制**：自动扫描 Schema 与工具注解（`readOnlyHint`、`destructiveHint` 等），通过后展示完整工具列表。

### 预置配置文件内容 (`glama.json`)
```json
{
  "$schema": "https://glama.ai/mcp/glama.schema.json",
  "name": "carlos-flow",
  "displayName": "Carlos Flow (AI Coding Guardian)",
  "description": "Carlos Flow is an AI coding guardian and mechanical workflow gate for Windows developer agents (Cursor, VS Code, OpenCode, Claude Desktop, Cindy). Provides fail-closed scope enforcement, real test verification, sentiment-aware triggering, and MCP progress heartbeats.",
  "repository": "https://github.com/skyer-now/carlos-flow",
  "maintainers": [
    "skyer-now"
  ],
  "license": "MIT",
  "runtime": "node",
  "transport": "stdio",
  "tags": [
    "developer-tools",
    "ai-safety",
    "testing",
    "guardrails",
    "workflow",
    "mcp-server"
  ]
}
```

---

## 3. MCP.so (`mcp.so`)

### 平台入口与机制
* **官网提交入口**：[https://mcp.so/submit](https://mcp.so/submit)（或通过 GitHub Issue 提交至官方索引库）
* **提交方式**：网页表单填写。
* **审核机制**：人工审核（免费收录通常在 24~48 小时内处理），重点审查 GitHub 活跃度与功能实用性。

### 表单申报材料清单（已为您组织好，直接复制粘贴即可）

* **Server Name（服务名称）**：`Carlos Flow`
* **Repository URL（开源仓库）**：`https://github.com/skyer-now/carlos-flow`
* **Package Name（npm 包）**：`carlos-flow`
* **Category / Tags（分类标签）**：`Developer Tools`, `AI Safety & Guardrails`, `Testing & Verification`, `Workflow`
* **One-line Slogan（一句话简介）**：
  - **中文**：面向 Windows 的 AI 编程卫士：机械防撞护栏、大日志保护与情绪感知引擎。
  - **英文**：The AI Coding Guardian on Windows: Fail-closed mechanical guardrails, output protection, and sentiment-aware trigger.
* **Detailed Description（详细功能介绍）**：
  > Carlos Flow provides deterministic, fail-closed guardrails for AI coding assistants (Cursor, VS Code, OpenCode, Claude Desktop, and Cindy). It prevents out-of-scope code modifications via `git diff --cached` scanning, requires real test execution proof before completion, protects token windows via 4KB output folding, and includes a multi-dimensional sentiment/doubt perception engine to intervene when developers express frustration or skepticism.
