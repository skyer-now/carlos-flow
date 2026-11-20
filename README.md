# Carlos 工作流 (Carlos-Flow)

## 任务内向导（电脑端）

在当前对话让助手调用 `start_wizard`，即可请求打开“任务向导”页并采样真实状态。无卡时先说明目标，不创建或覆盖已有任务卡。助手按目标→范围验收→执行→真实检查与负对照→独立审查→完成或处理问题逐步协调；用户不必填写会话编号、命令或技术参数。

页面只展示白名单摘要，七步不靠按钮次数推进。“查看最近采样”只请求展示缓存，注明采样时间与非实时；获取新状态需要原助手当前工具调用。页面不能批准或执行命令。继续时回原对话点原生“确认并继续”卡；真实点击票请求原助手续接，不改变原权限，不扩大范围、免检或自动 PASS。受理不等于执行完成。

页面可填写目标、范围、验收的内存草稿，草稿不是业务卡或授权。“交给确认卡讨论”只发未可信展示提案；请回原对话单击现有原生意图卡。助手在新活跃调用 resume 消费一个意图，协调后本回合 prepare 下一阶段卡，不需用户催技术调用。普通 call_tool 完全保留原SID/cwd/聚合合同，不读写向导KV；旧 requested 不锁未来工具。原生确认按 callId/SID/目录/当前卡代/nonce/到期核对，未知不重放；KV LWW不是CAS/exactly-once。页面关闭草稿丢失，真实 Host 连续交接尚待验收，不把VM通过称完整闭环。

任务页与设置页共用包内壳，Host 的 session 查询只作展示分支；任务页不读取或保存配置。原 pro/guide 模式和局部验证失效三按钮保留。仅做 Node/VM 行为验证；真实 Host 启动、批准、点击、重开与成功/拒绝全链尚待验收，已知 Host 子进程超时不因这些测试通过而消失。

## 验证失效向导（受限）

Cindy 中只有 PASS 裁定实际发现验证后代码指纹变化时，才显示「查看变化 / 重新检查 / 暂不继续」。查看是检测时摘要而非实时差异；查看与收起仅用展示 KV，不调用 Node 或 Agent。收起不取消验证，也不撤回已经提交的重新检查。

重新检查消费真实点击票，请原会话 Agent 沿既有权限发起新工具调用，不复用旧调用授权。可选 `expected.caseKey` 绑定不可变 offer；同一旧验证代永久 claim 最多启动一次，超时、重启或未知结果不自动重放，不自动 PASS 或 falsify。不带 expected 的普通 CLI 验证照旧可用。

每会话最多128个 case（offer+预留 claim 共256文件），永久保留且不自动清理；满额只关闭向导领取。Windows 不承诺目录项掉电持久，POSIX fsync 成功不是硬件掉电 exactly-once；人工删除/回滚 receipt 目录不在防重放保证内。未宣称手机/桌面已安装点击端到端通过。

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/skyer-now/carlos-flow)
[![Version](https://img.shields.io/badge/version-2.14.0-blue)](https://www.npmjs.com/package/carlos-flow)
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

## 🧩 在 Cindy 里怎么调用

插件的工具面是**两段式目录**（Cindy 对单个插件的工具声明有 16 项上限，本插件有 21 个操作）：

- `list_tools` —— 先看目录：不传 `category` 给 5 个类目概览（gate / verify / audit / infra / trigger），
  传了给该类目的操作明细 + **调用前必读的 RULES**。
- `call_tool` —— 再执行：`name` 用 `list_tools` 返回的操作名，`args` 照它的参数说明填。
  传错名字会附全部可用操作名；少填参数会附参数 schema 与规则，照着改就能过。

其它平台（OpenCode / Cursor / Cline / VS Code / Claude Desktop）仍然直接暴露 21 个工具，不需要这一步。

---

## ⚙️ 工作原理

Carlos 工作流的核心逻辑是“闭环质检”：
1. **任务录入**：你设定目标，系统将其记录为任务卡。
2. **角色调度**：自动派发执行与审计角色，规范操作流程。
3. **自动化质检**：AI 的产出必须通过系统预设的自动化回归测试。
4. **结论裁定**：只有通过测试与双轴门禁，任务才被判定为“已完成”。

---

## 🔧 项目级配置（可选）

在仓库根放一个 `.carlos.json`，就能让门禁认识**你项目自己**的敏感文件（内置名单之外的）：

```json
{
  "sensitive": {
    "names": ["pay_api_key.txt"],
    "segments": ["ledger"],
    "extensions": [".vault"],
    "prefixes": ["billing/ledger/"]
  }
}
```

- **只能追加，不能放宽**：以 `!` 或 `-` 开头的条目一律被忽略；内置名单（`.env`、私钥、锁文件、`migrations` 目录等）永远生效。
- **写坏了也不会放宽**：配置解析失败时自动退回内置名单，不会静默放行。
- 引擎从调用的工作目录向上找最近的 `.carlos.json`（最多 12 层），所以在大仓的子目录里调用也能命中。
- 命中的路径在提交任务卡时会被判为敏感路径，需要 `confirmed: true` 才能继续。

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
