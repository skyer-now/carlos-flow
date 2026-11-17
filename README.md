# Carlos 工作流 (Carlos-Flow)

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/skyer-now/carlos-flow)
[![Version](https://img.shields.io/badge/version-2.12.2-blue)](https://www.npmjs.com/package/carlos-flow)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文](README.zh.md) | [English Version](README.en.md)

你是否在使用 OpenCode、Claude Code 或其他 AI 编程工具时遇到过困扰？
* **AI 总是“瞎执行”**：指令明明说得很清楚，AI 却完全没按要求办，还得你花时间纠错。
* **流程门槛高**：想用 AI 处理复杂任务，却被各种报错和繁琐的工具链挡在门外。

**Carlos 工作流是一个“通用的 AI 辅助外挂”。无论你用什么开发平台，装上它，立刻为你现有的 AI 工具加装一层“智能监督”和“流程导航”。**

---

## 🌟 为什么它是每个人的“外挂”？

### 1. 兼容你所有的开发工具
* **不换环境，随插随用**：无论你是在用 OpenCode、Claude Code 还是其他 AI 编程工具，Carlos 工作流都能直接兼容。它就像是给你的 AI 装了一个“增强补丁”。
* **无需改变习惯**：你不需要卸载或更换当前的任何软件。它作为后台辅助，静静地运行在你的开发环境中，只在需要纠偏或引导时出现。
* **简单来说**：它就是一个“即插即用”的标准接口，让你在任何工具里都能调用这套辅助系统。

### 2. AI 的“贴身监督员” (确保不跑偏)
* **自动拦截错误**：如果你对 AI 的要求是 A，但它产出的代码变成了 B，Carlos 工作流会自动拦截，并对比你的原始目标，防止 AI 越界或瞎改。

### 3. AI 的“智能导航员” (降低使用门槛)
* **手把手引导**：当你不知道怎么下一步处理时，开启“向导模式”。它会自动根据任务拆解步骤，把复杂的技术活变成简单的确认步骤，带你绕开各种报错坑。

---

## ⚙️ 工作原理

Carlos 工作流的核心逻辑是“闭环质检”：
1. **任务录入**：你设定目标，系统将其记录为任务卡。
2. **角色调度**：自动派发执行与审计角色，规范操作流程。
3. **自动化质检**：AI 的产出必须通过系统预设的自动化回归测试。
4. **结论裁定**：只有通过测试与双轴门禁，任务才被判定为“已完成”。

---

## ❓ 常见问题 (FAQ)

**Q：我用的是 OpenCode / Claude Code，能装吗？**
A：完全支持！Carlos 工作流不挑工具，装上就能用。

**Q：装上它，我还需要像以前一样写代码吗？**
A：你需要继续写你的核心逻辑，但 Carlos 会帮你把那些“繁琐的检查”、“步骤引导”和“合规审计”全部自动处理掉。这相当于雇了个专门帮你查错和导航的助理。

**Q：这听起来很专业，我能学会吗？**
A：完全没问题。它的设计目标就是让不懂复杂技术的人，也能顺畅地操作 AI。当你遇到看不懂的问题时，直接问它，它会用最通俗的话告诉你怎么做。

---

## 📦 版本一致性约定（开发环境篇）

给你的 AI 配置 Carlos 工作流时，有三条约定需要知道：

**1. 你调用的版本 = 当前磁盘版本**

桥接器（`bridge/mcp-bridge.js`）每次调用都会重新启动一个 node 进程，加载 `D:\cindy\publish-output\carlos-flow\src\index.js`。不存在“旧代码驻留”的问题，你通过手机或电脑发出的每一条 `flow_*` 指令，执行的永远是磁盘上的最新版本。

**2. 关键 Commit 后的版本确认**

一旦有新的功能性 commit 推送到 `main`，我会主动执行一次确认循环（在下次会话中）：
```bash
# 对比工作区与 main 分支的代码差异
git status --short

# 确认指定文件已全部一致
git diff HEAD -- src/index.js src/dispatch.js

# 确认远端推送完成
git log --oneline origin/main -1
```
确认结果显示「工作区与 HEAD 无差异」且「origin/main 与 HEAD 一致」，你调用的版本才算点绿。

**3. 保持版本一致**

如果你在进一步开发中修改了 `src/index.js` / `src/dispatch.js` 但尚未 push，那么下一轮调用可能仍执行旧版本。**解决方案**：每次关键修改后先 `git push origin main`，你的下一次调用就会自动拉取最新代码。桥接器不参与“已推送”的选择，它只看磁盘。

---

## 📚 关联文档

| 文档 | 说明 |
|------|------|
| [TRIGGER_GUIDE.md](./TRIGGER_GUIDE.md) | 智能触发引擎深度指南（配置、评分、激活、反馈学习） |
| [CHANGELOG.md](./CHANGELOG.md) | 版本历史（遵循 Keep a Changelog + SemVer） |
| [MIGRATION.md](./MIGRATION.md) | 从 `carlos-flow-cindy` / `carlos-flow-opencode` 迁移 |
| [发布说明 v2.13.0](./docs/RELEASE_v2.13.0.md) | 最新发布状态、CI 结论与回归数字 |
| [QA 报告（历史快照）](./docs/QA_REPORT_v2.5.5.md) | 第三方只读审计，仅对 v2.5.5 负责 |
| [变异报告（历史快照）](./docs/MUTATION_REPORT_v2.5.5.md) | 变异注入详情，仅对 v2.5.5 负责 |

## 🚀 准备好开始了吗？
只需几行命令，为你的 AI 加上这层保护罩。
```bash
npm install -g carlos-flow
carlos init
```
