# Carlos Flow v3.3.1 发布说明

## 核心新特性

### 1. 情绪与怀疑感知引擎补齐英文质问词表 (中英双语对齐)
- **多语言情绪对齐**：`src/trigger.js` 扩展支持对等英文表达：
  - **强烈不满与否定**（`totally wrong`, `completely broken`, `very disappointed`, `stop lying`, `dont mess`, `not working at all`, `what are you doing` 等）；
  - **质问与怀疑句式**（`are you sure`, `did you even test`, `why is it still failing`, `have you checked`, `did you actually fix` 等）；
  - **英文追问上下文感知**：多轮英文质问自动追加疲劳怀疑权重，实现降阈值敏锐激活与纯技术/闲聊防误触。

---

# Carlos Flow v3.3.0 发布说明

## 核心新特性

### 1. 情绪与怀疑度感知引擎 (Sentiment & Doubt Perception)
- **多维态度识别**：`src/trigger.js` 扩展 `calculateSentimentScore` 情绪与怀疑度感知算法，深度捕捉：
  - **强烈不满与否定**（“根本不对/完全错了/差评/很失望/不要瞎改/全搞崩了”）；
  - **质问与怀疑句式**（“你确定/真的跑通/到底改了没有/为什么还在报错”）；
  - **连续标点情绪强化**（连续“？？？”、“！！！”或标点刷屏）；
  - **多轮追问疲劳权重**（检测到上一轮仍在质问时自动追加怀疑加分）。
- **动态阈值自适应**：当检测到用户处于高怀疑状态（`high_doubt`）时，自动下调触发阈值 20%，使 Carlos 更加敏锐地介入安全守护；常规讨论与只读探讨保持 100% 静默无感。
- **专项测试护航**：新增 `test/trigger-sentiment.test.mjs`，7 项断言覆盖负面情绪识别、质问句式匹配、标点强化、多轮追问上下文、动态阈值自适应与防误触测试（100% 绿灯）。

### 2. 发布流程与 GitHub Release 自动同步根治
- **CI 流程前置加固**：`.github/workflows/release.yml` 调整构建流程，确保 Release 创建前置且在测试通过后必定执行。
- **CDN 传播退避重试**：`scripts/verify-release-install.mjs` 引入 6 次指数退避重试机制，彻底消除 npm 全球节点同步延迟导致的误杀。
- **本地发布双保险自动同步**：`scripts/release.mjs` 实现调用 Git 原生凭据管理器本地自动同步 GitHub Releases。

---

# Carlos Flow v3.2.2 发布说明

## 核心修复与加固

- **首页 README 徽章版本号对齐**：更新 `README.md` 与 `README.zh.md` 顶部的 Version 徽章至 `3.2.2`，保证主页展示与 npm 发布版本 100% 对应。
- **发布闸一致性防护**：确保 `ghost.json` releaseNotes 与全套文档版本号零偏差。

---

# Carlos Flow v3.2.1 发布说明

## 核心修复与加固

### 1. 范围检查安全漏洞修复与 Fail-Closed 加固
- **暂存区越界扫描 (`--cached`)**：`src/dispatch.js` 中的 `enforceScope` 扩展支持 `git diff --name-only --cached`，彻底堵住 AI 执行 `git add` 后门禁因未扫描暂存区而误判“无改动放行”的漏洞。
- **Git 执行异常严格 Fail-Closed**：当底层 Git 检查命令异常退出（非 Git 仓库或命令超时）时，显式拦截报错，杜绝将环境异常误判为“无改动通过”。
- **测试用例先行固化**：在 `test/scope-enforcement.mjs` 中新增用例 14 与 15，覆盖暂存区改动与 Git 异常退化，37 项断言全部通过。

### 2. 会话身份自动继承 (session_context)
- **无缝会话追踪**：`src/index.js` 在调用方未显式传入 `sessionId` 时，自动采用宿主注入的 `carlosContext.session_id`，消除卡片与审计记录因落入 `unknown` 账户而互不可见的问题。
- **显式优先与空串保护**：显式传入参数仍然保持最高优先级，空字符串不伪造。

### 3. 快照任务生命周期隔离与文案诚实化修偏
- **快照任务绑定**：快照 manifest 自动绑定 `card_ts` 任务卡标识，`flow_revert_plan` 支持按当前任务卡过滤，防止历史任务文件混入恢复计划。
- **提示文案修偏**：修正 `ui/narrator.js` 中关于“自动领券”、“一键退出”等误导性说明，确保人话解释 100% 真实。
- **发布文档自动同步**：`scripts/release.mjs` 落地 `autoSyncDocs` 自动同步多语言文档。

---

# Carlos Flow v3.2.0 发布说明

## 核心新特性

### 1. 通信优化与传输防护 (全量实测与落地)
- **P1 输出保护与工件落盘 (Output Protection)**：
  - **4KB 单流 UTF-8 摘要折叠**：自动拦截超大 stdout/stderr 文本，按 Unicode 字符边界安全计算并累加 UTF-8 字节（`VERIFY_SUMMARY_BYTES = 4096`），注入 `\n…[输出已折叠；完整内容请查阅落盘工件]…\n` 折叠标记，彻底杜绝大文本打爆通道与大模型上下文；
  - **私有权限与自动清理**：完整输出安全写入本地私有目录（POSIX 设置 `0700/0600`，Windows 显式剥离继承并配置专属 ACL），新增 `pruneArtifacts` 实现 **30 份 / 7 天** 生命周期轮换清理，杜绝磁盘无界膨胀；
  - **证据与指纹零污染**：`output_hash` 计算与 `last_verify` 状态提交严格在展示层之前完成，摘要折叠 100% 保持原始指纹不变；
  - **存储故障优雅降级**：当磁盘或目录出现异常时自动 catch 并回退返回原始完整文本与全中文 `output_warning`，不向上层抛出硬崩。
- **P2 MCP Progress 协议心跳通知 (Heartbeat Notifications)**：
  - **标准 Progress 通道接通**：自 `params._meta.progressToken` 提取令牌，在耗时命令运行期间周期推送 `notifications/progress`，告知客户端执行进度与已运行秒数；
  - **无 Token 静默与 Token 0 边界安全**：未携带 Token 时保持 100% 完全静默；采用 `Number.isFinite` 确保数字 `0` 作为 Token 时不被当成 falsy 丢弃；
  - **确定性生命周期销毁**：命令退出（涵盖 close、error、timeout、abort 全部分支）在 `finish()` 中确定性调用 `clearInterval(heartbeatProgress)`，严防定时器泄漏。
- **P3 复合事务与快捷编排 (`pipeline_start`)**：
  - **一站式开卡与派发**：`carlos_task(action: "pipeline_start")` 依次原子串联 `submit → claim → dispatch`，单次调用即可完成留痕、认领与派发；
  - **严格阶段短路拦截**：前序步骤校验不通过立即中断，不产生后续未授权状态（如 submit 失败不 claim，claim 失败不 dispatch）；
  - **分步回执快照与恢复指引**：派发阶段受阻时结构化保留前序成功快照，并提示 *“任务卡与认领已生效，请修复派发条件后重试 dispatch，无需重新提交任务卡”*；
  - **门禁逻辑零削弱**：底层 9 重机械门禁、CAS 锁与敏感路径审查 100% 保持原生严格执行。

---

# Carlos Flow v3.1.0 发布说明

## 核心新特性

### 1. 调研与方案轻量互审体系 (Advisory Review)
- **双轴复核机制**：`flow_advisory_axes` / `submit` / `guard`（支持高阶门面 `carlos_review`）。
  - **Evidence 调研轴**：复核是否真的执行了查询、引用来源是否真实支撑结论、声明与证据是否一一对应。
  - **Feasibility 方案轴**：复核方案合理性、技术可行性、影响面评估以及可执行的回滚方案。
- **纯规则轻量触发决策引擎**：支持中英双语语义识别，常规查询（`none`）静默不打扰，时效/排障问题单轴（`single`），高风险架构/发布方案决策双轴（`dual`）。提供 30 分钟同主题冷却与 24 小时预算上限保护。
- **真实证据绑定与离线核验**：声明项 `evidence_ref` 支持 `path:line` 离线校验与 URL 外部溯源；两轴证据高度雷同自动拦截防敷衍；支持 canary 已知缺陷注入核验。
- **持久复核收据与状态清理**：复核通过后落盘摘要哈希收据；互审 prompt 自动生命周期轮换清理，不影响 T2 审计记录。

### 2. 平台支持收口与 Windows 运行时加固
- **Windows-Only 官方支持**：CI 与发布工作流矩阵全量收敛至 `windows-latest`，移除实验性平台的非阻塞容错。
- **Windows 进程树与长路径保护**：实测超时整树 `taskkill /T /F` 回收衍生子进程；深度路径与快照持久化容错。
- **互审核心逻辑变异测试**：新增针对证据解绑、过期拦截、轴缺失与预算超限的 4 类专项变异测试（100% 捕获）。

### 3. 关键修复：Windows 8.3 短名路径归一（发布前真实阻断）
Windows 上 `RUNNER~1`（短名）与 `runneradmin`（长名）指向同一目录，但字符串比较会失效。本次修掉三处：
- **项目身份**改用规范长名，同一仓库不再分裂成两个记忆分区；
- **状态目录排除**（指纹计算）改按规范长名比较，修掉「写一次状态就 STALE」；
- **越界前缀排除**改按规范长名比较，修掉「正常改动被误判越界、合法 PASS 全被拦」。

### 4. 发布链路自检
- `npm publish` 结果改为以 registry 可查为准（`scripts/verify-npm-publish.mjs`）：命令变绿不再等于包已上线。
- 发布流水线把 20 组测试拆成具名步骤，失败可直接定位；失败输出转成公开运行注解，无 admin 权限也能看到具体断言。
