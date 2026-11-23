# Carlos 工作流 (Carlos-Flow)

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/skyer-now/carlos-flow)
[![Version](https://img.shields.io/badge/version-3.0.0-blue)](https://www.npmjs.com/package/carlos-flow)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文说明](README.zh.md) | [English Documentation](README.en.md)

---

## 阶段一（2.28.1，本地准备）

`src/index.js` 负责服务与统一路由；`src/handlers/` 按 gate、verify、audit、infra、facade 实现真实领域，shared 共用请求补偿，catalog 保持原 26 工具顺序及契约。门面同样经过参数校验；结构化恢复说明保留已填参数/卡片，缺授权、范围、验收事实时须澄清，不自动确认。宿主权限和 UI 不变。验证状态及未完成项见 [阶段报告](docs/STAGE_1_REPORT.md)，不代表已公开发布或安装。

## 操作系统支持

当前仅支持 **Windows**。CI 与发布工作流仅使用 `windows-latest`；macOS / Linux 验证暂停，不声明支持。保留通用路径与进程安全代码不等于其它系统已验证，详见 [平台支持说明](docs/PORTABILITY.md)。开发工具适配不代表所有宿主组合均已实机验收。

## 💡 为什么需要 Carlos 工作流？

你在使用 AI 辅助编程（如 OpenCode、Claude Code、Cursor、VS Code 或 Cindy）时，是否经常遇到这些痛点？
* **AI 总是“瞎执行/越界乱改”**：指令明明说“只改登录接口”，AI 却随手重构了半个仓库。
* **自证式假绿**：AI 汇报“测试全通过”，实际上根本没执行测试命令。
* **流程门槛高、报错看不懂**：复杂的报错一堆技术黑话，想撤销或恢复现场极其繁琐。

**Carlos 工作流是面向 Windows 的 AI 编程工作流门禁与向导**，为现有 AI 编程工具提供**“机械防撞护栏”**与**“通俗智能向导”**。

---

## 🌟 核心特性与亮点

### 1. Windows 上的开发工具适配
* **提供开发工具配置适配**：Cindy、OpenCode、Cursor、Cline、VS Code、Claude Desktop；具体宿主仍需验证。
* **无需改变日常习惯**：作为后台静默辅助运行，不弹黑窗、不占常驻进程，只在需要纠偏与引导时出现。

### 2. 机械级防撞护栏 (确保 AI 绝不跑偏)
* **越界硬拦截 (Fail-Closed)**：AI 尝试修改未授权的文件时，当场踩刹车拦截。
* **真实验证命令驱动**：真实调用 `spawn` 执行项目测试，没有真实的通过证据绝不允许宣布完工。
* **防篡改审计流水**：SHA-256 链式审计日志，改动一条全链失效，操作全留痕。
* **写改分离与独立复核**：写代码的角色不能自己审批自己的作业，必须由独立复核角色验收。

### 3. 通俗智能向导 (100% 大白话自解释)
* **大白话人话翻译**：拦截时彻底屏蔽技术黑话，清晰告知**“🛑 为什么停下 + 💡 为什么踩刹车 + 👉 怎么办”**。
* **语义副作用智能分级**：自动识别只读闲聊、临时排查与真实代码修改，闲聊完全静默，真改动自动守护。
* **会话内上下文自动提取**：在移动端或简短发言时说“动手吧/按方案改”，自动回溯当前会话中讨论的文件路径，免去手动输入繁琐路径。
* **可核对的撤销与回滚**：随时支持“取消门禁”解套；“恢复重来”会先给出还原计划，确认后才按开工前快照还原代码。

---

## 🚀 快速上手

### 1. 全局安装
```bash
npm install -g carlos-flow
```

### 2. 针对你的开发平台初始化
```bash
# Cindy 环境
carlos-flow init --target cindy

# OpenCode 环境
carlos-flow init --target opencode

# Cursor / Windsurf 环境
carlos-flow init --target cursor

# VS Code 环境
carlos-flow init --target vscode

# Cline / Claude Desktop 环境
carlos-flow init --target cline

# Tencent WorkBuddy 环境
carlos-flow init --target workbuddy

# OpenAI Codex CLI 环境
carlos-flow init --target codex

# ByteDance Trae 环境
carlos-flow init --target trae

# Alibaba Qoder (通义灵码) 环境
carlos-flow init --target qoder
```

### 3. 验证服务状态
在任意终端或工作区执行：
```bash
carlos-flow flow_status '{"sessionId":"test"}'
```
输出包含 `"ok": true` 即表示门禁服务已就绪。

---

## 🧩 平台使用方式

### 在 Cindy 桌面端中调用
Cindy 插件采用高效的两段式目录（支持专用任务向导页 `start_wizard`）：
- `list_tools` —— 查看 5 大类目（门禁主链、真实验证、审计取证、系统运维、智能触发；默认四门面下智能触发类目不暴露，`legacy` 面可用）；
- `call_tool` —— 执行具体门禁操作，参数填错或缺失时自动下发大白话自纠指引。

### 在 OpenCode / Cursor / VS Code 等平台中调用
直接使用标准 MCP 协议，通过对话让 AI 助手调用门禁工具链。

---

## ⚙️ 核心工作流 6 步闭环

```
  1. 留痕开卡        2. 领取入场券        3. 派发与自动拍照
(记录目标与范围)  →  (领 executor 名额) → (自动生成代码快照)
                                                 │
                                                 ▼
  6. 完工交付        5. 双轴独立审查       4. 真实命令验证
(PASS 或一键还原) ← (规范轴与验收轴复核) ← (真跑测试拿有效证据)
```

---

## ❓ 常见问题 (FAQ)

**Q：装上 Carlos 工作流会拖慢我的电脑或 AI 吗？**  
A：不会。核心引擎完全基于本地轻量 JavaScript 计算，单次决策耗时小于 **2 毫秒**，无外部网络依赖，零大模型 Token 消耗。

**Q：误触发了门禁或者想中途换方案怎么办？**  
A：随时对 AI 发送**“取消门禁”**即可恢复自由对话；发送**“恢复重来”**会按开工前快照生成还原计划，确认后才实际还原。未派发的纯占位卡在 5 分钟后也会自动无感老化撤销。

**Q：这套工具需要我懂高深的技术指令吗？**  
A：完全不需要。向导层已经全部做成通俗人话，AI 遇到阻断时会用大白话向你解释原因并给出明确的下一步选项。

---

## 📚 详细文档

* [v2.22.0 版本更新全景与历史演进文档](./docs/RELEASE_v2.22.0.md) —— 本次里程碑完整功能、架构转变与工具映射
* [智能触发引擎使用指南](./TRIGGER_GUIDE.md) —— 触发评分、副作用分级与双阈值决策详解
* [版本迁移指南](./MIGRATION.md) —— 从旧版本或多包架构平滑升级
* [更新日志](./CHANGELOG.md) —— 详细版本变更历史与发布说明

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
