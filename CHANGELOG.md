# 变更日志 | Changelog

> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)  
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows [SemVer](https://semver.org/)

---

## [2.5.5] - 2026-11-05 — 智能触发引擎正式发布 + 激活机制 + 9 项缺陷修复

### 🔁 激活机制 | Activation（本次最关键的一环）

> 之前的实现只会在命中时**打一行日志**，并没有真的启动工作流。
> 现在「动态决策 → 判断 → 激活」形成闭环，判定会转成**真实执行**的门禁动作。

| 阶段 | 动作 | 实际效果 |
|------|------|---------|
| **判断** | L1 上限 → L2 评分 → L3 四档决策 | 得到 `decision` + `score` + `confidence` + `breakdown` |
| **翻译** | `buildActivationPlan()` | 判定转成**可执行的 MCP 动作序列**（每步带 `auto` 标记） |
| **激活 ①** | `flow_add_user_msg` | 用户原话入库，成为任务卡 `quote` 的锚点数据源 |
| **激活 ②** | `flow_submit_requirement`（`activation: true`） | 提交 `read_only` 占位卡，**会话进入已留痕门禁态** |
| **闸门** | `activation_pending` | 字段补齐前，`flow_claim` / `flow_dispatch` / `flow_verdict` **一律拒绝派发** |
| **放行** | 重新提交完整卡（不带 `activation`） | 待补项由**服务端从当前卡片内容幂等派生**；三项**全部补齐**才清空 `activation_pending`（只补一项不解闸）→ 正常派发 |

**安全约束**：会话已有任务卡时跳过自动开卡（不覆盖已有任务）；自动激活不决定改哪些文件；
推断出的 `goal` 标记为占位需确认；`manual` 档只给建议不执行任何动作。

### ✨ 新增 | Added

**智能触发引擎**：三层智能触发系统（零外部依赖，纯 JavaScript）

| 层级 | 组件 | 说明 |
|------|------|------|
| L1 | `DynamicTriggerManager` | 动态触发上限：会话时长、任务复杂度、近期触发频率（惩罚项） |
| L2 | `TriggerScorer` | 触发评分：关键词 (0-50, 权重 0.5) + 上下文 (0-30, 权重 0.3) + 意图 (0-20, 权重 0.2) = 加权满分 **38** |
| L3 | `TriggerDecisionEngine` | 决策引擎：`trigger` / `review` / `ignore` / `throttled` |

- **激活计划**：`buildActivationPlan()` 把决策翻译成可执行动作序列，含 `steps` / `pendingFields` / `prompt`
- **激活闸门**：`flow_submit_requirement` 新增 `activation` 参数；`flow_claim` / `flow_dispatch` 检查 `activation_pending` 拒绝派发
- **状态可见**：`flow_status` 新增 `activation_pending` 字段
- **配置系统**：`trigger-config.json` 可覆盖全部阈值与权重（`triggerThreshold: 15`、`autoTriggerThreshold: 25`、`lowConfidenceThreshold: 10`）
- **状态持久化**：触发历史落在 `CARLOS_FLOW_HOME`，不污染仓库目录
- **用户反馈学习**：接受/拒绝行为驱动权重调整
- **评分可解释**：每次决策返回完整 `breakdown`（命中的关键词 / 上下文词 / 意图类型）
- **限流也如实**：被限流时仍返回真实评分与置信度，不假装 0 分
- **详细文档**：[TRIGGER_GUIDE.md](TRIGGER_GUIDE.md)

**测试套件**

- `test/trigger-e2e.mjs`：25 项触发引擎用例（含 10 项回归用例）
- `npm run test:all`：串联 smoke + e2e-carlos + p0-gates + trigger-e2e + concurrency
- 测试脚本在缺少 `CARLOS_FLOW_MCP_ROOT` 时自动回退到仓库根目录，**本地无需额外配置环境变量**

### 🐛 修复 | Fixed

> 以下均为**真实可复现的缺陷**，在本次发布前由独立验证发现并修复（每条都有 file:line 证据与可复现的实测步骤）。

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-1 | `client/carlos.js` 是 ESM 模块却使用 `require()` 加载触发引擎 | 异常被 catch 吞掉，**触发引擎集成完全失效（死代码）** | 改用 `await import(pathToFileURL(...))` |
| T-2 | `canTrigger()` 用 `calculateHistoryFactor()`（返回 0~1 加权均值）与上限 5~15 比较 | **上限检查永远不触发**，限流形同虚设 | 新增 `countTriggersInWindow()` 返回窗口内实际次数 |
| T-3 | 动态上限公式中历史因子为**加项** | 触发越多上限越高，**封顶逻辑自我抵消** | 改为惩罚项：近期触发越频繁，上限越低 |
| T-4 | `processUserMessage()` 硬编码 `sessionId='default'`，忽略 `context.sessionId` | 多会话场景状态串扰 | 按 `context.sessionId` 创建引擎并透传 |
| T-5 | `src/trigger.js` 的 CLI 入口用 `import.meta.url.endsWith(process.argv[1])` | `file:///` 前缀导致永不匹配，**独立测试模式从未运行过** | 改用 `fileURLToPath` + `resolve` 路径比较 |
| T-6 | `shouldTrigger()` 在限流分支提前 `return`，未先计算评分 | 评分丢成 `0`、置信度缺失，调用方无法判断真实意图强度 | 改为先算评分再判限流，`throttled` 分支也返回 `score` / `confidence` / `breakdown` |
| T-7 | `test:trigger` 把结果文件写入发布目录 `test/trigger-e2e-results.json` | **污染 npm 发布内容** | 改为写入系统临时目录 |
| T-8 | 命中自动激活后，客户端只打印一行日志，**没有执行任何实际动作** | 「自动触发」名不副实，工作流并不会真的启动 | 新增 `buildActivationPlan()` + 客户端逐步执行激活步骤 + `activation_pending` 派发闸门 |
| T-9 | 触发状态所有会话共用一个 `trigger-state.json` | **一个会话的限流会影响另一个会话**，多场景下莫名“时间间隔不足” | 状态按 session 分文件存放到 `CARLOS_FLOW_HOME/trigger-state/<sessionId>.json` |
| T-10 | 占位卡可以直接 `flow_verdict` 记 PASS | **假闭环**：未派发、未验证、未补齐字段，却把 `completed_ok` 置为 true | `flow_verdict` 增加闸门：`activation_pending` 非空时拒绝记裁定，并写入 `verdict_denied` 审计事件 |
| T-11 | `sanitizeSessionId` 清洗后可能撞名（`a/b` 与 `a_b` 都变成 `a_b`） | 不同会话共用同一份状态文件，限流互相影响 | 文件名追加原始 sessionId 的哈希后缀，保证唯一 |
| T-12 | 占位卡闸门可被「空 scope 的普通卡」清掉 | **绕过路径**：Agent 提交一张 scope 为空的普通卡即可解除闸门，而空 scope 意味着「不许改任何文件」 | 解除闸门要求本次提交的 scope 非空；否则保持闸门并记 `activation_gate_held` 审计事件 |
| T-13 | 客户端触发兜底项是「工具名 + 参数 JSON」 | **自伤**：参数含触发词 → 自己开占位卡 → 同一次调用的 `flow_dispatch` 反被闸门拒绝；**锚点污染**：写入的「用户原话」是命令行文本 → Agent 用真实原话重提卡时 quote 锚点校验失败 → 补齐流程卡死 | 兜底改为空串：**不传 `triggerMessage` 即完全不启用自动触发** |
| T-14 | `create(sessionId)` 与 `shouldTrigger(msg, ctx, sessionId)` 两个入参未强制一致；L2 评分器还自己去磁盘读会话状态 | L1 读 A 会话状态、L2 读 B 会话历史 → 跨会话污染评分 | L3 记住会话 ID（`this.sessionId`），评分器不再读磁盘、由 L3 传入本会话历史条数 |
| T-15 | 激活闸门的释放判据只看 `scope` 非空 | **半补齐绕过**：只补 `scope`、`acceptance`/`verify.cmd` 仍缺就解闸 → 可记 PASS → `completed_ok=true` | 改为**逐字段核验**：`scope` / `acceptance` / `verify.cmd` 三项全补齐才解闸，`activation_pending` 精确列出还缺哪几项 |
| T-16 | `enforceScope()` 在空 scope 时直接 `return { ok: true }` | **fail-open**：白名单为空等于「随便改」，任意路径都判未越界 | 改为 **fail-closed**：空 scope + 有变更 → 全部判越界 |
| T-17 | `flow_verdict` 只要求「有卡片」 | **未复核即完成**：刚提交、什么都没跑的卡也能直接记 PASS → `completed_ok=true` | 增加前置：记 **PASS** 前必须 `dispatch_count > 0`（`DIRECTION`/`LOCAL` 不受影响，不误伤返工意见） |
| T-18 | 反馈学习是**死代码**：`recordFeedback` 只写进程内 Map，`updateFeedbackWeights()` 无任何调用点，调整的权重也没人读 | 文档宣称「反馈学习」但功能不存在 | 反馈改为**持久化**到会话状态；每 10 条自动触发学习；学习结果**真正影响触发阈值**（`effectiveThreshold`） |
| T-19 | `triggerWindowMinutes: 15` 与 `minTriggerIntervalSeconds: 300` 不匹配 | 窗口内最多触发 3 次，而上限至少 6 → 「次数达上限」分支**永远不可达**，实际只有 5 分钟冷却 | 默认窗口改为 **60 分钟**（1 小时内最多 12 次），上限惩罚项才有意义 |
| T-20 | 激活占位卡的建立与解闸在审计链里没有专属事件（只有通用 `record`/`accepted`） | 事后无法从 `gate-audit` 流水回答「这是不是占位卡？解闸过没有？」 | 新增四类专属事件：`activation` / `activation_gate_held` / `activation_released` / `verdict_denied` |
| T-21 | `verdict` 的 `dispatch_count` 前置最初对三档裁定一视同仁 | 未派发时 `DIRECTION`/`LOCAL` 也被拦 —— 「先标返工意见」的合理流程被误伤 | 前置**只施加于 PASS** |
| T-22 | `flow_verdict` 只看 `dispatch_count > 0`，**不看验证结果** | **「未验证即完成」**：`verify.cmd` 故意 `exit 3`、乃至从未跑过验证，都能签发 PASS → `completed_ok=true` | 记 PASS 前必须：`flow_run_verify` 写入的 `last_verify` 存在且 `ok===true` 且其 `cmd` 与**当前卡片**的 `verify.cmd` 一致；否则拒绝并记 `verdict_denied`。`DIRECTION`/`LOCAL` 豁免 |
| T-23 | 门禁**采信执行者自述**：`flow_save_result` 只原样存档 stdout/stderr，不做任何事实交叉验证 | 存入一份完全虚假的 executor 报告（声称改了 5 个文件、88 项全过，实际什么都没做）即可支撑一次 PASS 裁定 | 记 PASS 的机器级约束收紧到 T-22（验证必须真跑通）；「采信自述、无自动事实交叉验证」作为**已知边界**写入 `docs/QA_REPORT_v2.5.5.md` §六 |
| T-24 | `scripts/mutation-check.mjs` 的基线结果只被记录，不参与判定 | **假绿**：基线 44 通过 / 1 失败时，13 个变异体仍全判「被抓住」且 `exit 0` | 基线任一套件非全绿 → 报告标红 + `exit 1`；套件输出无法解析时同样 fail-closed |
| T-25 | `mutation-check.mjs` 的 `rmSync(WORK)` 在 Windows 上遇残留 bridge 占用 → `EBUSY` **直接崩溃**；各变异体复用同一 `BRIDGE_PORT` | 中断过一次后跑变异测试必崩；且可能串到旧副本的 bridge → 结果失真 | 删目录加重试与可读错误；每轮独立 `BRIDGE_PORT`；收尾只终止**本轮新增**的 bridge（不误杀源仓 bridge） |
| T-26 | `scripts/release.mjs` 与 `release.yml` 跑 `test:all` 时**未设** `CARLOS_FLOW_HOME` | 会写用户真实的 `~/.carlos-flow`（CI runner 同样被写） | 两处均隔离到 `os.tmpdir()` / `runner.temp` 下的独立目录并在结束后清理 |
| T-27 | `release.mjs` 的「先推 opencode、再推 cindy」顺序**零测试守护** | 顺序被误改会重新出现「cindy 已打 tag 而 opencode 失败」的半发布 | 推送步骤抽成有序常量 `PUSH_SEQUENCE`，新增 `--print-push-sequence` 只读子命令，并加 e2e 行为级断言（opencode 索引必须小于 cindy） |
| T-28 | `runVerifyCommand` 硬编码 `spawn("cmd", ["/c", cmd])` | **Linux/macOS 上命令根本没跑**（`cmd.exe` 不存在），exitCode=127，导致「验证通过才能记 PASS」的门禁在非 Windows 环境彻底失守 | 按平台选 shell：Windows 用 `cmd.exe /c` + `shell:true`；POSIX 用 `/bin/sh -c` + `shell:false`。实测 `shell:false` 会吃掉引号导致 exitCode 变 0，故 Windows 必须 `shell:true` |
| T-29 | 触发引擎只接在 CLI 客户端（`client/carlos.js`），MCP server 根本没接触发引擎 | **MCP 路径「自动触发」不生效**——README 里「工作流会自己认出该上场的时候」在实际使用路径上不成立 | 新增 `flow_trigger_check` 工具（MCP 侧暴露触发能力），宿主在收到消息时调用即可获得与 CLI 完全一致的自动触发行为 |
| T-30 | 默认词表纯英文（work/flow/carlos/dispatch/trigger/start/run/execute），中文需求全 0 分不触发 | **中文场景触发器等于失效**，用户需自行扩展 `trigger-config.json` | 内置中文流程词（工作流/门禁/派发/审计/复核/任务卡/子代理/流程/触发/执行/调度/审计/复核/留痕/裁定），且只收流程性词汇不收普通开发动词，实测中文需求能触发、普通需求零误触发 |
| T-34 | `acceptance` 必填校验只看数组**长度**（`card.js` + `src/index.js` 闸门推导） | `acceptance=[""]` / `[null]` / `[0]` / `[{}]` 这类「长度>0 但内容无效」的伪填充被当成「已填」——cross_module 档卡片带着空验收标准就能通过校验，闸门也会误判为「已补齐」而解开 | `card.js` 的必填校验改为**内容判定**（文本类数组必须至少有一个非空字符串）；`src/index.js` 闸门推导同步改为内容判定，两端口径一致且都卡严 |
| T-35 | 卡片文本字段用 `asStringArray` 归一化（`String(x)`） | `[null]` → `["null"]`、`[{}]` → `["[object Object]"]` —— 垃圾串被当成合法验收标准，绕过内容判定 | 新增 `asTextArray`：**只保留真正的字符串元素**，数字/null/对象一律丢弃；scope/acceptance/unknowns/assumptions 改用它，paths/userMessages 保持原行为 |
| T-36 | `trigger-config.json` 用浅合并 `{...DEFAULT_CONFIG, ...loaded}` | 用户一旦写 `keywordWeights` 就会把默认词表（含内置中文流程词）**整个丢掉**——「只是加一个自定义词」反而让所有默认词失效，中文场景重新变回 0 分 | 词表类字段改**深合并**：`keywordWeights` 合并（用户词覆盖同名项，默认保留）；`readOnlyIntentWords`/`mutatingActionWords` 追加去重；其余标量仍覆盖。附 `trigger-config.usable.json` / `trigger-config.example.json` 模板 |
| T-37 | README FAQ 与 TRIGGER_GUIDE 仍写「默认词表为英文，中文需自行扩展」 | **文档与实现不符**（v2.5.5 起中文词表已内置），用户据此以为中文不触发 | 全部更正为「中英文流程词已内置」，并说明自定义是**追加**不是替换 |

### 📝 文档事实性修正 | Documentation Corrections

> 第三方只读评审逐条核对文档与实现的差异，以下为已修正的**事实性偏差**（此前文档写错或写了未实现的功能）：

| # | 文档原文 | 实际 | 已修正为 |
|---|---------|------|---------|
| D-1 | 评分示例 `score: 37` | 带 `complexity: 1.2` 时真实值是 **38** | 全部示例改为 38 |
| D-2 | CLI 示例用中文/非词表英文句子，声称「判定触发」 | 默认词表是**英文**，那些句子命中 0 个词 → 实际 `ignore` | 改为能真正触发的 `run dispatch workflow`，并明确「必须显式传入、默认词表为英文」 |
| D-3 | 决策伪码与实现不一致（漏了 `throttled` 分支与反馈偏移） | 实现含限流分支与反馈学习偏移 | 伪码改为**与 `src/trigger.js` 逐行对应**，并补四档决策表 |
| D-4 | 未说明 `confidence` 的计数口径 | 命中项数决定（0→0.3 / 1~2→0.6 / ≥3→0.9），且存在重复计数 | 新增「置信度口径」小节，说明口径与已知偏差 |
| D-5 | 「衰减加权值仅用于上限微调」 | 代码里**没有这个行为** | 改为如实描述（原始次数判定 + 惩罚项公式） |
| D-6 | 「免检」被暗示为能跳过检查 | `isBypassed()` 全仓无调用点，免检只是**标志位 + 派发后自动清零** | 文档措辞按实际语义修正 |
| D-7 | 「反馈学习」被描述为已实现 | 当时是死代码 | 随 T-18 一并实现，文档改为真实行为 |

### 🔬 变异测试扩展 | Mutation Testing（13 类变异体）

| 变异 | 注入内容 | 结果 |
|------|---------|------|
| M1 | 把 `checkTrigger` 里的 `callMCP` 换成假返回（激活只剩日志） | **CAUGHT** — `17b/17c` 失败 |
| M2 | 移除 `flow_claim` 的 `activation_pending` 闸门 | **CAUGHT** — `15c/17c` 失败 |
| M3 | 移除 `flow_verdict` 的 `activation_pending` 闸门 | **CAUGHT** — `15e/15f` 失败 |
| M4 | 去掉 `sanitizeSessionId` 的哈希后缀（会话撞名） | **CAUGHT** — 会话隔离用例失败 |
| M5 | 把 `filled.scope` 硬置 true（scope 未补也算补齐） | **CAUGHT** — 半补齐用例失败 |
| M6 | 移除逐字段核验（只要提交就解闸） | **CAUGHT** — `19a~19d` 失败 |
| M7 | `enforceScope` 空 scope 改回 fail-open | **CAUGHT** — 空 scope 用例失败 |
| M8 | 移除 `verdict` 的 `dispatch_count` 检查 | **CAUGHT** — 未派发用例失败 |

> 两仓库（cindy / opencode）各跑一遍，**13/13 全部被抓住**。报告：[`docs/MUTATION_REPORT_v2.5.5.md`](docs/MUTATION_REPORT_v2.5.5.md)

### 🧪 测试增强 | Test Hardening

- `test/e2e-carlos.mjs`：16 → **42** 项
  - 第 17 组：走**真实客户端进程**验证激活路径（断言服务端状态真的变了，而非 stderr 里那句话）
  - 第 18 组：不传 `triggerMessage` 不触发（防自伤）
  - 第 19 组：半补齐不解闸、三项补齐才解闸
  - 第 20 组：未派发不许记 PASS；`DIRECTION` 不误伤
  - 第 21 组：空 scope fail-closed
  - 第 22 组：审计链四类专属事件可查
- `test/trigger-e2e.mjs`：15 → **23** 项（激活计划完整性、quote 锚点、会话隔离、撞名回归、`create`/`shouldTrigger` 会话一致、反馈学习生效、`reset("*")` 重置全部会话）
- `test/p0-gates.mjs`：10 → **15** 项（新增激活占位卡闸门、未派发记 PASS、空 scope fail-closed）

### 🧬 变异测试 | Mutation Testing（新增）

> 光有测试不够——还要证明**测试真的能抓住退化**。
> `npm run test:mutation` 会在临时副本上注入 4 类退化，确认测试套件会失败。

| 变异 | 注入内容 | 结果 |
|------|---------|------|
| M1 | 把 `checkTrigger` 里的 `callMCP` 换成假返回（激活只剩日志） | **CAUGHT** — `17b/17c` 失败 |
| M2 | 移除 `flow_claim` 的 `activation_pending` 闸门 | **CAUGHT** — `15c/17c` 失败 |
| M3 | 移除 `flow_verdict` 的 `activation_pending` 闸门（假闭环） | **CAUGHT** — `15e/15f` 失败 |
| M4 | 去掉 `sanitizeSessionId` 的哈希后缀（会话撞名） | **CAUGHT** — 会话隔离用例失败 |
| M5 | 移除「空 scope 提交不能解除激活闸门」的防护 | **CAUGHT** — `16d/16e` 失败 |

> 两仓库（cindy / opencode）各跑一遍，**13/13 全部被抓住**。报告由 `npm run test:mutation` 自动生成。

### 🧪 测试增强 | Test Hardening

- `test/e2e-carlos.mjs` 新增第 17 组：**通过真实客户端进程**验证激活路径，
  断言的是**服务端状态真的变了**（`has_card` / `activation_pending`），
  而不是 stderr 里那句「已执行激活步骤」——只要把 `callMCP` 换成空实现，用例立即失败
- `test/e2e-carlos.mjs` 新增 `15e/15f`：防假闭环（占位卡不许记 PASS）
- `test/trigger-e2e.mjs` 新增：清洗后同形的 sessionId 不共用状态文件
- 新增 `scripts/mutation-check.mjs` 与 `npm run test:mutation`
- 变异测试报告归档：[`docs/MUTATION_REPORT_v2.5.5.md`](docs/MUTATION_REPORT_v2.5.5.md)

### 🔒 安全 | Security

| # | 问题 | 修复 |
|---|------|------|
| S-1 | `.gitignore` 末行为 `*.tar.gz.npmrc.local`（粘连），导致 `.npmrc.local`（含 npm token）**未被忽略** | 拆分为独立规则，并补充 `.npmrc.*.local` |
| S-2 | 一次性修复脚本（`fix_*.mjs`、`debug_*.mjs` 等 42 个）与 `.b64`、`secret.json` 等临时文件混入仓库 | 加入 `.gitignore` 忽略规则 |
| S-3 | 触发器状态文件默认写入当前工作目录 | 改为与 `state.js` 一致的 `CARLOS_FLOW_HOME` 约定 |
| S-4 | 硬编码机器路径 `D:\opencode-backups` | 改为跨平台默认 `~/.carlos-flow` |

### 🚀 发布工程 | Release Engineering

| 项目 | 说明 |
|------|------|
| **OIDC 发布** | GitHub Actions 使用 OIDC 身份发布到 npm，**仓库不再需要存放 npm token** |
| **`scripts/release.mjs`** | 一条命令跑完版本校验 / 双语一致性 / 测试 / 构建 / 发布 |
| **`npm run check:readme`** | `prepublishOnly` 钩子自动校验 README.md / README.zh.md / README.en.md 三份文件不漂移 |
| **独立 QA 验收** | [`docs/QA_REPORT_v2.5.5.md`](docs/QA_REPORT_v2.5.5.md)：两仓库 × 五套件 = **全绿** |

### 📚 文档 | Documentation

- **README 可读性**：清除了被重复注入的**语言栏 / 版本行噪音**（每份 24~26 处 → 收敛到顶部 1 处），原先粘在 Markdown 表格行尾导致表格被截断的问题已修复
- **README 新增**：v2.5.5 更新速览区（三层触发架构表、7 项缺陷表、安全与发布工程、文档可读性说明）
- **README 修正**：触发评分的真实满分（38 而非 100）、动态上限的惩罚项语义、决策引擎的四档输出
- **FAQ 补充**：触发不生效 / 触发过频 / 状态文件位置 三条排查项
- **测试命令**：`npm run test:p0`、`npm run test:trigger`、`npm run test:all` 全部写入 README

### 🔧 变更 | Changed

- 触发引擎 E2E 测试迁入 `test/trigger-e2e.mjs`，纳入 npm scripts
- README / CHANGELOG / package.json 版本号统一为 **2.5.5**
- `carlos-flow-cindy` 与 `carlos-flow-opencode` 的 `src/` 保持逐文件一致
- 清理 42 个一次性修复脚本与临时产物（净删 5325 行）

### ✅ 验证 | Verification

| 套件 | 结果 |
|------|------|
| `npm test`（smoke） | SMOKE_OK |
| `npm run test:e2e`（e2e-carlos） | **42/42 通过**（激活闸门 + 客户端真实激活路径 + 四道门禁防线） |
| `npm run test:p0`（p0-gates） | **15/15 通过**（新增激活闸门与 fail-closed 断言） |
| `npm run test:trigger`（trigger-e2e） | **23/23 通过**（激活计划 + 会话一致 + 反馈学习 + 撞名回归） |
| `npm run test:mutation`（变异测试） | **13/13 变异全部被抓住** |

---

## [2.5.4] - 2026-11-04 — 智能绑定图标修复与文档标准化

### 🎨 界面修复 | UI Fixes

- **README 徽章**：移除 Shield.IO 图像，改用纯文本标签，解决乱码/方框显示问题
- **多语言导航**：添加 [中文](README.zh.md) / [English](README.en.md) 语言栏

> 🚨 **注意**：v2.5.2 及更早版本存在 5 处致命语法错误（MCP Server 无法启动），**强烈建议升级到 2.5.3+**。

---

## [2.5.3] - 2026-11-04 — 致命语法错误修复 + 门禁真验证

### 🚨 致命修复 | Critical Fixes

> 2.5.2 存在 **5 处致命语法错误**，导致 MCP Server 完全无法启动。所有宣称"已修复"的功能实际均未运行。

| # | 问题 | 修复 |
|---|------|------|
| C-1 | `flow_claim` 内 `const a` / `const role` 重复声明 → SyntaxError | 删除重复声明 |
| C-2 | `flow_revert_plan` 的 `inputSchema` 未闭合，handler 丢失 | 补全完整实现 |
| C-3 | `flow_check_scope` 后残留旧 `flow_revert_plan` 代码块 | 移除残留 |
| C-4 | `Unknown tool` 返回缺右括号 `}` | 补齐 |
| C-5 | `CallTool` handler 未闭合，`await` 处于非法位置 | 重建为单一正确 handler |
| C-6 | `CallTool` handler 被注册两次（原始 + Phase1 补丁） | 合并为单一 handler，内含参数校验 |

### 🔧 功能修复 | Functional Fixes

| # | 问题 | 修复 |
|---|------|------|
| F-1 | role 白名单失效（`a.role === "auditor" ? ... : "executor"` 先降级，校验永不触发） | 非法值直接报错，不得静默降级 |
| F-2 | dispatch 要求 `dispatch_count > 0` 但计数只在 dispatch 时 +1 → 首次 dispatch 死锁 | 新增 `state.claimed` 标记：claim 置位、dispatch 清零 |
| F-3 | `flow_bypass` 无任何确认校验，可随意开启 | 开启必须 `confirmed=true`；派发后自动清零 |
| F-4 | `isBypassed()` 只看 `bypass` 标志，旧卡片免检会作用于新卡片 | 增加时序校验（`bypass_ts >= card_ts`） |
| F-5 | Bridge spawn 时未注入 `CARLOS_FLOW_MCP_ROOT` → bridge 拼出 `undefined/src/index.js` | 注入绝对路径 `ROOT_ABS` |
| F-6 | `client/carlos.js` 从 `ROOT/mcp-bridge.js` 找 Bridge，但文件在 `bridge/` 下 | 双路径探测（优先 `bridge/`） |
| F-7 | CLI 客户端丢弃 `isError` 标志，调用方无法区分成败 | 错误走 stderr 且退出码非 0 |
| F-8 | E2E 脚本硬编码 `ROOT/carlos.js`（发布版无此文件）→ Promise 挂起 | 双路径探测 + `spawn error` 监听 |
| F-9 | `validateToolArgs` 脱离作用域，参数校验实际未执行 | 重建为顶层函数，独立 handler 内调用 |

### ✅ 验证 | Verification

| 套件 | 结果 |
|------|------|
| `npm test`（smoke） | SMOKE_OK |
| `test/e2e-carlos.mjs` | **16/16 通过** |
| `test/p0-gates.mjs`（新增·门禁专项） | **10/10 通过** |

`test/p0-gates.mjs` 逐条验证审核报告指出的门禁：非法 role 拦截 / 未 claim 拦截 / verify.cmd 真实执行 / verify 失败如实报 / scope 内外判定 / 非法 verdict 拦截 / 免检需确认 / 审计可读。

---

## [2.5.2] - 2026-11-04 — Phase 1 P0 全修复版

### ✨ 新增 | Added

| 编号 | 功能 | 说明 |
|------|------|------|
| 1 | `flow_run_verify` 工具 | 真实执行卡片 `verify.cmd`，返回 `{exitCode, stdout, stderr, ok, durationMs}` |
| 2 | `flow_check_scope` 工具 | 机器级 scope 越界校验，传入变更文件列表，返回 `{ok, violations[]}` |
| 3 | `runVerifyCommand(cmd, cwd)` | `dispatch.js` 导出，真实 spawn 子进程执行验证命令，捕获完整输出 |
| 4 | `enforceScope(scope, diffFiles)` | `dispatch.js` 导出，git diff 对比 scope 白名单，越界即返回违规列表 |
| 5 | `verifyAuditChain(opts)` | `state.js` 导出，SHA-256 链式哈希校验，支持 `sinceIndex` 增量校验 |
| 6 | `isBypassed(state)` | `state.js` 导出，免检模式真实判定（需 `bypass=true` 且 `bypass_ts < card_ts`） |

### 🐛 修复 | Fixed

| 编号 | 问题 | 修复方案 |
|------|------|----------|
| P0-1 | role 拼写错误静默降级为 executor | 白名单校验：仅允许 `executor`/`auditor`，其他直接报错 |
| P0-2 | `dispatch_count` 在 claim 时重置导致无限刷额度 | 仅在 `flow_dispatch` 时 +1，claim/verdict 不计数 |
| P0-3 | `verify.cmd` 未真实执行，仅记录意图 | 新增 `runVerifyCommand()`，真实 spawn 执行并捕获结果 |
| P0-4 | scope 校验仅在卡片提交时做路径存在性检查 | 新增 `enforceScope()` 运行时 git diff 级越界拦截 |
| P0-5 | 免检模式隐式触发，派发不清零 | `isBypassed()` 需显式 `bypass=true` 且时间戳在卡片之后，新派发自动清零 |
| P0-6 | 过期卡拦截 claim 但不拦截 dispatch | `isStale()` 统一拦截 claim 和 dispatch |
| P0-7 | 配额耗尽仍允许 dispatch | `dispatch_count >= MAX_DISPATCH` 同时拦截 claim 和 dispatch |
| P0-8 | verdict 枚举校验缺失，接受任意字符串 | 严格 enum: `PASS`/`DIRECTION`/`LOCAL`，其他报错 |
| P0-9 | 审计链仅写入不校验，字段缺失 | 新增 `verifyAuditChain()`，补全 `prevHash`/`hash` 字段 |
| P0-10 | `CallTool` 无参数校验，直接进入 handler | 统一 `validateToolArgs()` 前置校验 required schema |
| P0-11 | `validateToolArgs` 因缺少 required 字段永不执行 | 补全所有工具 `inputSchema.required` |
| P0-12 | `readManifestAll` 缺失，无法读取完整快照清单 | 新增 `readManifestAll(sid)` 返回全部条目 |
| P0-13 | `write_files` 计数器未在 dispatch 时初始化 | `flow_dispatch` 时重置 `write_files=0` |
| P0-14 | dispatcher 死锁：claim 重置计数导致无限循环 | 移除 claim 时的 `dispatch_count=0` 重置 |
| P0-15 | `card.confirmed` 优先级错误，敏感路径无法通过 | 结构化参数与 cardText 统一取 `||` 逻辑 |
| P0-16 | `flow_bypass` 无需确认即可开启 | 需 `confirmed=true` 且显式 `bypass=true` |
| P0-17 | 审计事件类型不全，缺少 `snapshot`/`dispatch` 等 | 补全 `audit()` 调用点，事件类型标准化 |
| P0-18 | `protocol.js` 协议文档与实现不一致 | 同步更新路由表、合同模板、错误分层、状态 schema |

### 🔧 变更 | Changed

- `MAX_DISPATCH` 从 3 调整为 5（配合修复后的计数语义）
- 审计链存储格式：每条记录强制包含 `prevHash`、`hash`、`seq`
- `flow_dispatch` 返回新增 `snapshot` 字段（快照条目数组）

### 📦 依赖 | Dependencies

- 无新增外部依赖，仍为零依赖核心（仅 `@modelcontextprotocol/sdk`）

---

## [2.5.1] - 2026-11-03 — 初始发布

### ✨ 新增 | Added

- 基础 12 个工具：`flow_protocol`、`flow_add_user_msg`、`flow_submit_requirement`、`flow_claim`、`flow_dispatch`、`flow_verdict`、`flow_status`、`flow_audit`、`flow_diff_hunks`、`flow_bypass`、`flow_save_result`、`flow_revert_plan`
- TCP Bridge 自动管理（首次调用拉起、健康检查、Token 认证、限流、超时控制）
- Cindy 插件集成（`ghost.json`、`settings.html/js`、加密保险库存储）
- 完整测试套件：smoke + e2e-carlos (16) + e2e-rea (8)

### 🔒 安全 | Security

- Bridge 仅监听 127.0.0.1
- 请求体限制 1 MB
- 单连接限流 10 req/s

---

## 升级指南 | Upgrade Guide

### 从 2.5.4 → 2.5.5

1. **更新包**：`npm install -g carlos-flow-cindy@2.5.5`
2. **新特性**：智能触发引擎自动加载，配置 `trigger-config.json` 可调阈值
3. **零破坏性**：完全向后兼容；配置文件不存在时使用默认参数
4. **行为变更**：触发上限现在会随近期触发频率收紧（之前形同虚设）

### 从 2.5.1 → 2.5.2

1. **更新包**：`npm install -g carlos-flow-cindy@2.5.2`
2. **环境变量**：无破坏性变更，现有 `.env` 继续可用
3. **状态目录**：`CARLOS_FLOW_HOME` 兼容，审计链自动补全字段
4. **新工具可用**：`flow_run_verify`、`flow_check_scope` 即刻生效
5. **行为变更**：
   - `dispatch_count` 计数语义修正（仅 dispatch 计数）
   - 免检模式需显式开启且派发自动清零
   - role 拼错直接报错而非降级

---

## 版本对照表 | Version Cross-reference

| 版本 | npm (Cindy) | npm (OpenCode) | GitHub Release | 核心状态 |
|------|-------------|----------------|----------------|----------|
| 2.5.5 | carlos-flow-cindy@2.5.5 | carlos-flow-opencode@2.5.5 | v2.5.5 | **智能触发引擎 + 7 项缺陷修复 + OIDC 发布** |
| 2.5.4 | - | carlos-flow-opencode@2.5.4 | v2.5.4 | 文档标准化 + UI 修复 |
| 2.5.3 | carlos-flow-cindy@2.5.3 | carlos-flow-opencode@2.5.3 | v2.5.3 | **致命语法修复 + 门禁真验证** |
| 2.5.2 | carlos-flow-cindy@2.5.2 | carlos-flow-opencode@2.5.2 | v2.5.2 | Phase 1 P0 全修复 |
| 2.5.1 | 双包 | 双包 | v2.5.1 | 基础版（含已知 P0 缺陷） |

> **注意**：2.5.1 版本存在 18 项 P0 缺陷，2.5.2 存在 5 处致命语法错误，**强烈建议升级到 2.5.5**。