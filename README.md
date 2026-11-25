# Carlos 工作流 (Carlos-Flow)

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/skyer-now/carlos-flow)
[![Version](https://img.shields.io/badge/version-3.2.2-blue)](https://www.npmjs.com/package/carlos-flow)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文说明](README.zh.md) | [English Documentation](README.en.md)

---

## 操作系统支持

当前仅支持 **Windows**。CI 与发布工作流仅使用 `windows-latest`；macOS / Linux 验证暂停，不声明支持。保留通用路径与进程安全代码不等于其它系统已验证，详见 [平台支持说明](docs/PORTABILITY.md)。开发工具适配不代表所有宿主组合均已实机验收。

## 💡 为什么需要 Carlos 工作流？

你在使用 AI 辅助编程（如 OpenCode、Claude Code、Cursor、VS Code 或 Cindy）时，是否经常遇到这些痛点？
* **AI 总是“瞎执行/越界乱改”**：指令明明说“只改登录接口”，AI 却随手重构了半个仓库。
* **自证式假绿**：AI 汇报“测试全通过”，实际上根本没执行测试命令。
* **超大日志打爆上下文**：测试输出几万行日志直接撑爆大模型 Token，导致通信超时或上下文丢失。
* **长任务通信失联挂死**：长时间运行测试时无状态反馈，客户端误以为进程死锁而强制超时中断。
* **流程门槛高、报错看不懂**：复杂的报错一堆技术黑话，想撤销或恢复现场极其繁琐。

**Carlos 工作流是面向 Windows 的 AI 编程工作流门禁与向导**，为现有 AI 编程工具提供**“机械防撞护栏”**、**“通信优化保护”**与**“通俗智能向导”**。

---

## 🌟 核心特性与亮点

### 1. 机械级防撞护栏与范围安全 (Fail-Closed 加固)
* **全域越界硬拦截**：`enforceScope` 深度扫描工作区已跟踪改动、**暂存区已跟踪改动 (`--cached`)** 与未跟踪新文件；彻底消除 AI 执行 `git add` 后门禁失效的漏洞；
* **Git 异常严格退化**：底层 Git 命令执行失败或超时时，一律执行 Fail-Closed 拒绝放行，绝不将环境异常误判为“零改动通过”；
* **真实验证命令驱动**：真实调用 `spawn` 执行项目测试，没有真实的通过证据绝不允许宣布完工；
* **写改分离与独立复核**：写代码的角色不能自己审批自己的作业，必须由独立复核角色验收；
* **快照任务生命周期隔离**：快照 manifest 自动绑定 `card_ts` 任务卡标识，确保任务取消后重新开始时还原计划绝不混入历史任务文件。

### 2. 通信优化与传输防护 (v3.2.0 重磅演进)
* **P1 输出保护与工件落盘**：
  * **4KB 单流 UTF-8 摘要折叠**：自动拦截超大 stdout/stderr 输出，按 Unicode 字符安全截断，彻底消除大文本打爆通道与上下文的现象；
  * **私有工件落盘与自动清理**：完整日志安全落盘至本地私有目录（POSIX 0700/0600，Windows 剥离继承设置独立 ACL），自动执行 **30 份 / 7 天** 生命周期轮转清理；
  * **证据指纹零污染**：证据哈希计算与状态提交在展示层之前完成，摘要折叠 100% 保持 `output_hash` 与代码状态指纹原始不变；
  * **存储故障优雅降级**：发生磁盘或权限异常时，自动回退原始文本并附带全中文告警，不谎报成功。
* **P2 MCP Progress 协议心跳通知**：
  * **标准 Progress 支持**：从 `_meta.progressToken` 提取令牌，在长耗时验证期间周期推送 `notifications/progress`，告知客户端执行进度与已运行秒数；
  * **零干扰与边界安全**：无 Token 保持完全静默，严格支持数字 `0` 边界 Token；命令退出（成功、失败、超时或取消）在 `finish()` 中确定性销毁定时器。
* **P3 复合事务与快捷编排 (`pipeline_start`)**：
  * **一站式开卡与派发**：`carlos_task(action: "pipeline_start")` 依次原子串联 `submit → claim → dispatch`，单次调用即可完成留痕、认领与派发；
  * **严格阶段短路拦截**：前序步骤校验不通过立即中断，不产生后续未授权状态；
  * **分步回执快照与恢复指引**：派发阶段受阻时结构化保留前序成功快照，并提示无需重提任务卡。

### 3. 会话身份自动继承 (session_context)
* **无缝会话追踪**：支持宿主环境自动注入 `carlosContext.session_id`，调用方未手填时自动补位，彻底消除状态落到 `unknown` 导致任务卡与审计记录互不可见的问题；显式指定优先。

### 4. 调研与方案轻量互审体系 (Advisory Review)
* **Evidence 调研轴**：复核是否真的执行了查询、引用来源是否真实支撑结论、声明与证据是否一一对应。
* **Feasibility 方案轴**：复核方案合理性、技术可行性、影响面评估以及可执行的回滚方案。
* **纯规则轻量触发决策引擎**：支持中英双语语义识别，常规查询（`none`）静默不打扰，时效/排障问题单轴（`single`），高风险架构/发布方案决策双轴（`dual`）。
* **真实证据绑定与离线核验**：声明项 `evidence_ref` 支持 `path:line` 离线校验与 URL 外部溯源；两轴证据高度雷同自动拦截防敷衍；支持 canary 已知缺陷注入核验。

### 5. 四大高阶复合门面工具 (High-Level Facades)
* **`carlos_task`**：聚合管理任务的留痕、开卡、角色认领、复合派发与结果保存 (`submit` / `claim` / `dispatch` / `start` / `pipeline_start` / `protocol` / `add_user_msg` / `save_result`)；
* **`carlos_verify`**：聚合管理真实验证执行、反向负对照证伪、越界自查与触发检查 (`run` / `falsify` / `check_scope` / `trigger_check` / `diff_hunks`)；
* **`carlos_review`**：聚合管理双轴独立审查、审查结论提交、最终裁定与调研互审 (`axes` / `submit` / `guard` / `verdict` / `audit` / `advisory_axes` / `advisory_submit` / `advisory_guard`)；
* **`carlos_manage`**：聚合管理状态查询、一键人话撤销、回滚计划与存储度量 (`status` / `cancel` / `revert` / `stats` / `bypass` / `mode`)。

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
- `list_tools` —— 查看 5 大类目（门禁主链、真实验证、双轴审查与流水、状态·协议·还原、智能触发；默认对外收敛为 4 个门面，`legacy` 面可查看全部 25 个底层操作）；
- `call_tool` —— 执行具体门禁门面或底层操作，参数填错或缺失时自动下发大白话自纠指引。

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
*(💡 使用高阶门面 `carlos_task(action: "pipeline_start")` 可一键完成第 1~3 步)*

---

## ❓ 常见问题 (FAQ)

**Q：为什么大日志输出会被折叠？怎么看完整内容？**  
A：为了防止过大的测试输出撑爆大模型的上下文窗口，当单流输出大于 4KB 时会自动进行安全折叠，并将原始输出落盘保存到本地私有目录（返回中带有完整文件路径）。你可以在终端或文件管理器中直接打开该文件查阅。

**Q：长耗时测试为什么不再出现超时中断？**  
A：v3.2.0 接通了 MCP 标准 Progress 心跳机制。在长命令执行期间会自动向支持的客户端发送心跳与运行耗时通知，避免客户端因通道无响应而误判死锁。

**Q：误触发了门禁或者想中途换方案怎么办？**  
A：随时对 AI 发送**“取消门禁”**即可恢复自由对话；发送**“恢复重来”**会按开工前快照生成还原计划，确认后才实际还原。未派发的纯占位卡在 5 分钟后也会自动无感老化撤销。

---

## 📚 详细文档

* [智能触发引擎使用指南](./TRIGGER_GUIDE.md) —— 触发评分、副作用分级与双阈值决策详解
* [版本迁移指南](./MIGRATION.md) —— 从旧版本或多包架构平滑升级
* [更新日志](./CHANGELOG.md) —— 详细版本变更历史与发布说明
* [发布说明](./RELEASE_NOTES.md) —— 最新里程碑特性与修复细节
