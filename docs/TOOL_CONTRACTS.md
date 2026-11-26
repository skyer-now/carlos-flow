# Carlos Flow 工具契约文档

### 调研/方案互审

`flow_advisory_*` 与门面 `carlos_review` 的 advisory 动作详见 `docs/ADVISORY_REVIEW.md`：不改变 T0/T1/T2 路由，不参与 PASS 双轴门禁，只对结构化调研/方案做交付前检查。

### 验证输出解码（Windows 中文）

`flow_run_verify` / `flow_falsify` 的输出按字节收集后再解码：严格 UTF-8 优先，失败才回退 GB18030（GBK 超集），可用 `CARLOS_VERIFY_ENCODING=utf8|gb18030` 强制指定。命令、shell、退出码与超时行为不变。

## v3.0.0 对外工具面（四门面）

对外 MCP 目录默认只暴露四个门面，底层 22 个操作仍是内部实现，通过门面动作路由并经过同一套参数校验：

| 门面 | 主要动作 |
|---|---|
| `carlos_task` | submit / claim / dispatch / protocol / add_user_msg / save_result |
| `carlos_verify` | run / falsify / check_scope / trigger_check / diff_hunks |
| `carlos_review` | axes / submit / guard / verdict / audit |
| `carlos_manage` | status / cancel / revert / stats / bypass / mode |

兼容开关：`CARLOS_FLOW_TOOL_SURFACE=legacy` 恢复 26 个底层工具目录（旧客户端、脚本与本文档下方以 `flow_*` 描述的内部契约仍然有效）。
门面 schema 覆盖底层必填参数与关键参数，转发时剔除门面专属 `action` 字段；装配期会双向校验“每个底层能力都有门面动作”与“门面动作不指向未登记操作”。

## 阶段一领域化定位（2.28.1，本地准备）

原 26 项（22 原子 + 4 门面）工具的顺序、描述与 inputSchema 保持冻结；v3.1 追加 3 个调研/方案互审内部操作（flow_advisory_*），底层 22 项摘要不变，摘要由 `test/handler-parity.mjs` 对照 42b19d6 固定。真实实现移至 `src/handlers/`：gate 留痕/领取/派发/裁定，verify 验证/负对照，audit 双轴/审计查询，infra 状态/触发/辅助操作，facade 只做明确路由；catalog 拒绝重复、遗漏与未登记工具；shared 不依赖任何领域模块或入口。

门面统一经过 `callTool` 的原子工具 Schema 校验、Host 能力故障检查与同一 AsyncLocalStorage 审计补偿口径，不直接调用底层 handler。参数拒绝新增 `structuredContent={ok:false,code:INVALID_TOOL_ARGUMENTS,tool,error,missing,schema,originalArguments,instructions}`；占位卡 guide 拒绝新增 `ACTIVATION_INCOMPLETE` 与 missing/preservedCard/澄清说明，不生成授权、范围或验收事实。pro 的占位卡文本路径保持原状。

短锁重验卡身份、pending、额度与 claim，原子消费后仅按同卡同派发计数合并基线。范围检查以卡片项目根为准，显式异仓 cwd 拒绝。负对照失败先按完整旧证据 CAS 作废，再追加审计；新卡提交成功后审计请求绑定新版本。非 verdict 审计待确认不能消费旧证据 PASS；最终 verdict 追加失败可重试全部门禁并重新持久化 resolution，遵守原审计恢复测试，不把待确认状态当已完成。宿主权限、UI、锁实现和长命令锁外原则不变。

### 阶段一增量：审计待确认恢复

- `audit_pending.entries` 按随机事件 ID 保存多个活跃未确认追加：原请求的工具及规范化参数摘要、原卡 `card_ts`/脱敏持久化卡摘要、已脱敏的原审计事件（不含链 hash）、失败时间与错误。入口补偿在短锁内合并最新列表，不覆盖并发失败。同卡失败置 `completed_ok=false`；扩 scope、LOCAL/DIRECTION 和无关成功事件不得清除活跃条目。
- `audit_history_pending` 是独立的历史未确认事件数组（缺省不存在，读取视为空）。失败补偿抵达时，原卡完整身份既不匹配当前卡、也不在当前任务的 scope 沿革中，将该迟到事件追加历史，不改新卡完成/验证/领取。明确完整换新卡或取消任务，则在清除/替换原身份前的同一短锁内，将具备 ID、请求摘要、事件载荷且身份匹配旧卡或其 scope 祖先的活动条目合并历史，去重保留全部 ID/载荷并移除对应活动项；新卡自身审计失败仍进入活动队列。取消自身事件绑定锁内实际取消的卡，追加失败保留为对应旧卡历史；若原本无卡则绑定空卡身份，后续新卡提交仍可归档完整事件。取消重试优先匹配补记，不能重新取消 B。两种先后顺序都不丢旧事件，也不让旧失败阻塞新任务独立完成。历史不参与当前卡门禁，也不会被 scope 或裁定静默清除。无完整载荷或归属不明的旧活动标记保守保留，不猜测迁移或自动补记。
- `audit_scope_ancestors` 是同一任务经 `appendScope` 更新前的卡身份列表（`card_ts` 和完整卡摘要，缺省空）。真实 scope 变更时在同一短锁内追加旧身份，因此旧请求在 scope 变更后才补偿，仍按活跃失败关闭门禁。完整新卡提交/触发建卡及取消清除该沿革，并按上述归属规则迁移可确认的旧活动项；`appendScope` 绝不迁移活动项。未采用此协议的外部 writer/人工回滚无法提供同任务沿革保证。`flow_status` 分别返回 `audit_pending` 和 `audit_history_pending`，不将历史混作当前门禁故障。
- 原工具以相同参数重试时，优先进行**仅审计补记**：短锁内逐条追加 `resolution/audit_recovery`，记录 `pending_id`、原卡身份、`original_event`、`business_replayed:false`；确认追加持久化后只移除对应 ID。补记失败仍报错并保留 pending；清状态失败也报错，之后允许同 ID 重复补记。请求不保存原始参数，只有摘要；参数对象键顺序不影响匹配，数组顺序及实际参数值必须一致。门面与原子工具经过相同入口。
- 这不是业务重跑或原操作完整成功的证明。尤其 dispatch 已消费 claim/额度、expected 验证已永久领取时，恢复不能再执行该业务：响应明确带 `audit_recovered`、`business_replayed:false`，`completed_ok` 如实反映当前存储值。恢复仅清对应队列条目，不修改完成、验证或领取状态；活跃失败此前的 false 不会被恢复自动翻绿，历史补记成功或失败也不能取消新卡已有完成状态。旧卡请求只能补记旧事件，不能将旧业务重放到当前卡；同一请求存在多个卡代失败时，每条补记分别保留原卡身份。需核对状态与产物再决定后续动作。
- 最终 `resolution/verdict` 失败是例外：同请求且完整当前卡身份匹配时，仍走原来的**全部门禁重审**，重新确认 resolution 持久化才清匹配 verdict 条目；不能以补记旧 PASS 自动完成。其他活跃 pending（含不同裁定、归属不明的旧卡失败、不同参数事件）仍阻断 PASS。LOCAL/DIRECTION 只保留返工意见，不洗掉别的失败。
- 老版本仅有 kind/card_ts/error、没有完整事件或请求摘要的非 verdict pending 不可自动推测恢复，保持 fail-closed，需人工核验。旧 verdict 中断标记可按原全门禁重审规则恢复；不同裁定或卡代不会将其删除。此为可选状态字段演进，不改变默认 state/schema 或原26项工具描述/Schema 摘要。
- 卡身份摘要对卡先采用与 `saveState` 相同的 `sanitizeFields` 再规范化哈希，避免落盘脱敏导致新卡当前失败被误分历史。`bindAuditVersion` 在 handler 实际读取/接纳卡、短锁实际提交 mode/claim/dispatch/axes/bypass、新卡保存以及取消前绑定对应快照；入口 recovery 的 await 后重取接纳快照，不能沿用入口 A 为后续实际接纳的 B 记账。验证/负对照在锁外命令前绑定，之后审计沿用该快照，不在失败时猜测 latest 身份。expected 领取返回的 caseKey 若不再对应命令前快照则不执行，永久领取仍不回滚。原请求参数摘要仍对原参数计算，不以脱敏摘要合并不同请求；测试仅使用合成秘密。
- 生产身份入口盘点：gate 完整提交在短锁内归档已知旧活动项并建立新卡；appendScope 保存祖先、保留活动项；infra cancel 在清身份前归档并绑定取消事件；trigger 及 CLI 最终 activation 提交都在短锁内再次检查 `prev.card`，已有卡即返回未激活、不保存状态、不归档 B 或追加 activation，不能用锁外空卡观察覆盖新 B。src 其余状态写入（claim/dispatch/verdict、verify/falsify、axes、mode/bypass、审计补偿/恢复）不替换 card/card_ts；axes/bypass 在短锁内重验已接纳卡身份，冲突拒绝写新卡。client/bridge 未发现直接状态写入。verdict 仅按匹配 ID 清当前裁定条目，不丢其他 pending。
- 边界：依赖可信本地状态存储与遵守协议的 writer，不是防本机任意改文件的认证机制。不是事务 outbox：进程在审计失败与请求退出补偿之间崩溃，或状态与审计介质同时不可写时，无法保证跨进程留下完整事件；失败会报告未确认，不保证硬件掉电 exactly-once。审计回执 unknown 与补记状态保存 unknown 都可能重复，不删除/重写历史链。没有自动重放长命令或放宽永久领取协议。

以下历史 `src/index.js` 实现定位现在按工具域查阅；历史版本说明不重写。阶段验证与已知未完成项见 `docs/STAGE_1_REPORT.md`，不声明已公开发布或完成桌面验收。


## PhaseB候选：固定哈希子入口与Host请求能力

此为未安装候选适配，不声明当前安装版0.1.139具备新接口；不虚设尚未发布的最低Host版本。`node.entries=['src/state.js']`及`node.childSpawn=true`是实际权限扩展，待后续安装批准与真实Desktop验收。两public元工具、21后端操作、guide/pro及expected永久领取语义不变。

MCP在同步收行内调用真实Host `bindLaunch()` 捕获请求专用闭包，作为独立内部参数传递，JSON arguments/carlosContext/rpcId/signal不能供给此能力。无binding、收行scope丢失或getter异常的Host采样不可用，不回退Electron execPath或spawnEntry。普通Node CLI保持旧同步API及原环境兼容，不冒称其为Host白名单。

同步与异步指纹共享全部Git采样及哈希结果校验，Host仅改执行边界为 `launch('src/state.js',['--hash-child'],{deadlineMs:5000})`。收到句柄即取completion并监听输出，再分64KiB块write/end，不等待不存在的drain。输出总预算64KiB，合法JSON不是完成证明；须候选05的direct completion真实exited/code0且stdout end，才消费结果。cleanup_unknown不可用，不等待未来exit翻回成功；期限及清理未知由Host新completion收敛，不本地race丢弃生命周期。候选05源码绑定SHA `729ef31531b3b37c9c226fcf7a862252457e9953f416f42b672741514597ac54`；类型/单元/真实Host链通过是父提供的独立证据，不替代安装版Desktop验收。

所有长采样在锁外：status采样后重读卡与完整验证身份，变化时使用最新卡但采样不可用；run_verify普通/expected均在短锁核完整卡及旧last_verify；falsify完成finally还原后才采样，短锁核卡/验证/负对照身份，冲突拒绝旧证据覆盖；verdict短锁比对完整判定状态快照，不因同卡axes/role/bypass等变化拼接PASS，也不自动重试。状态仅局部合并，旧恢复算法不改。输出错误仍单次受控退出1，无原始路径/环境错误回传。


## 增量：验证失效向导与永久领取

只有 `flow_verdict(verdict=PASS)` 的真实 fingerprint STALE 分支返回 `isError:true` 与 `structuredContent.code=VERIFY_STALE`；关键词不是触发依据。满足当前本地、非只读会话位置条件时，后端在既有短锁内首次发行 offer。未确认发行时仍拒绝 PASS，只保留普通手动验证指引。

`caseKey=SHA256(物理session身份,card_ts,完整规范化card,完整规范化last_verify)`，包括旧验证 ts/cmd/cwd/output/fingerprint；当前工作区 fingerprint 不参与代号。物理session身份由RUNS和session的dev/ino以BigInt读取、精确转十进制字符串后哈希；分区、caseKey、offer.sid绑定和完成CAS统一用此身份，不按process.platform lower路径或sid。ino为0、类型未知或无法读取即fail-closed。receipt入口在任何转换前拒绝预存在的session符号链接/junction，普通CLI与r2状态锁的别名行为不变；不是把链接绕过口头排除出威胁模型。每代一个不可变 `<caseKey>.offer.json`，同代反复 STALE 不换 ID、不延长首次10分钟有效期。使用 canonical RUNS 的同级 `verify-receipts/<物理session身份摘要>/`，继承 r2 物理布局约束，并仅对receipt进一步拒绝session路径链接。offer/claim 不属于 state reset 字段，新卡不能删除旧历史；不新增 ledger、epoch、verifyRunId、boot资格或后台服务。

`flow_run_verify.expected` 为可选对象 `{caseKey}`。不带 expected 的旧 CLI/cwd 行为不变；提供后空值、未知字段、过期、跨会话、卡或原验证变化、cmd/canonical cwd 变化均拒绝，绝不 fallback。main 剥 Agent 自报内部字段，只由 Host 顶层重铸 session_context 取四字段关联。stdio metadata 不是 Host 授权，原 Agent 新工具调用仍受原权限；Node 原生权限不是沙箱。

领取在短锁内重新读 state/offer，核绑定并冻结 cmd/cwd，然后真实 `wx` 创建 `<caseKey>.claim`，write → file fsync → close → 支持的目录 fsync。claim 存在即永久消耗，空/partial/坏文件也阻断；永不删除、移动或修复 claim。缺失/损坏 offer 的 expected 请求只拒绝，不借领取路径重建。领取不需写 state 投影，权威来自永久文件存在；锁释放也必须确认后才在锁外 spawn。任一领取/同步/关闭/锁退出异常均不 spawn，不自动重试；open失败若未留下文件不能假称已有持久 tombstone。

完成仅在卡与完整旧 last_verify 身份仍一致时合并新验证；换卡不停止已经启动的旧命令，但旧结果不能覆盖新卡或后来验证。超时、取消、断线、重启及完成写入 unknown 不删除 claim、不重新执行、不自动 PASS/falsify。broker取消不增加业务取消协议。

每会话最多128代；offer发行预留相应claim槽，共最多256文件，不做bounded淘汰/自动GC。满额/未知目录只关闭向导，不禁止普通验证。人工删除/目录回滚、混跑不遵守协议的writer、任意外部文件替换及硬件掉电丢记录不在保证内。Windows只做file fsync、不冒充目录项耐久；POSIX目录同步返回成功也不是硬件掉电exactly-once。

main 原callId交卷前仅在本地可写且 expiresAt 为有限未来时供三按钮卡：「查看变化」「重新检查」「暂不继续」。本实例内存绑定 callId/SID/caseKey/期限，KV仅24条白名单展示记录、整体LWW，不含cmd、路径、diff、点击token，不能恢复重启或未知后的执行资格。回调每次await后重核当前对象；view/retry各一次，在读取后同一同步段领取再保存，互不阻止；失败不回滚。跨SID无效点击不更新真实卡。GET必须ok，GET/PUT/Agent异常中文未知，不泄露、不自动重试。暂缓终止后续交互但不撤已提交请求。

查看与重验仅消费真实callback userActionToken，通过 `agent.run(mode=continue)` 续接原会话，不复用旧callId调Node。查看引导新活跃工具调用先flow_status核当前卡，再flow_diff_hunks读真实当前Git未暂存差异，明确非验证时快照；错误不能说无变化，空结果不推断未跟踪/暂存无变化；摘要仅数量/行区间，不输出原命令、路径或原始diff，不执行验证。重验始终携expected、不fallback。纯规则不变，Agent只是原会话工具续接而非新增AI决策层；capability/receipt身份不等于Host auth，同实例去重不是跨实例CAS。

UI验证为VM运行真实main、仅模拟Host边界；后端用真实文件/子进程/marker。没有安装或手机桌面真人点击验收，不宣称实际UI E2E。Host依据0.1.139/9ffef649…匹配证据，不以latest代替；最低宿主版本以 ghost.json 为准；v2.18.x 的保守支持基线为 0.1.139，不宣称是相关能力的首次引入版本。原型阶段曾保留含义未明的 1.0.2，该记录不再代表当前清单；不新增 background 能力。

> 适用版本：v2.18.1
> 生成时间：2026-11-20
> 数据来源：直接读 `src/index.js`、`src/state.js`、`src/dispatch.js`、`test/*.mjs`，不采信二手描述

---

## 0. 怎么用这份文档

每个工具一张契约卡，固定四维：

| 维度 | 回答的问题 |
|---|---|
| **状态门** | 它在门禁链路上是哪一环？删掉/跳过会怎样？ |
| **问题层** | 它解决的是哪一类真实故障？没有它会漏掉什么？ |
| **读写字段** | 读 `state.json` 哪些字段、写哪些字段、写哪些外部文件？ |
| **测试覆盖** | 哪些测试文件在测它、回归保护强度如何？ |

新增或修改工具时，按第 5 节的检查清单逐项过一遍。

### 测试覆盖数字怎么来的

文档里的「N 个文件 / M 处调用」统计口径：

- **文件数**：该工具在 `test/` 下被**真实调用**过的测试文件个数
- **调用次数**：真实调用出现的总次数，包含四种调用形式：
  1. `call("flow_x", ...)` / `tool("flow_x", ...)` —— 进程内直接调用
  2. `req("tools/call", { name: "flow_x", ... })` —— JSON-RPC 请求形式
  3. `spawnSync(node, [carlos.js, "flow_x", ...])` —— CLI 子进程调用
  4. `result.activationPlan.steps.find(s => s.tool === "flow_x")` —— 激活计划断言
- **不计入**：注释里提到工具名、错误文案里提到工具名（这些只是提及，不是调用）

复核方法（在仓库根目录跑，两个脚本已入库）：

```bash
node test/count-tool-refs.mjs    # 每个工具：真调用文件数 + 仅提及文件数 + 文件明细
node test/count-tool-calls.mjs   # 每个工具：真调用总次数
```

> 新增测试后数字会变，属于正常；如果发现某工具从「N 个文件」变成「0 个」，说明它的测试被删了，要补上。

---

## 1. 全景：三层 + 一条门禁链

### 1.1 分层

```
┌─────────────────────────────────────────────────────────┐
│ 第一层：状态门（写 state 的关键字段）                     │  9 个
│   flow_trigger_check → flow_submit_requirement           │
│                      → flow_claim → flow_dispatch      │
│                      → flow_run_verify → flow_falsify  │
│                      → flow_audit_axes → flow_audit_submit │
│                      → flow_verdict                    │
├─────────────────────────────────────────────────────────┤
│ 第二层：工作流辅助（主 Agent 实际调用，不写门禁字段）      │  3 个
│   flow_status · flow_check_scope · flow_bypass           │
├─────────────────────────────────────────────────────────┤
│ 第三层：追溯与查询（只读，低频，独立价值）                 │  8 个
│   flow_audit · flow_protocol · flow_add_user_msg         │
│   flow_save_result · flow_revert_plan                    │
│   flow_diff_hunks · flow_audit_guard                     │
└─────────────────────────────────────────────────────────┘
```

### 1.2 门禁链（T2 改动的完整流转）

```
用户消息
   │
   ├─ flow_trigger_check          评分：T0 / T1 / T2
   │     └─ 达标时自动：flow_add_user_msg + flow_submit_requirement(占位卡)
   │
   ├─ flow_submit_requirement     留痕：写 card / card_ts / tier / activation_pending
   │     └─ 校验：quote 锚点 / scope 存在性 / 必填字段 / 敏感路径确认
   │
   ├─ flow_claim                  领名额：写 claimed / claimed_role
   │
   ├─ flow_dispatch               派发：写 dispatch_count / dispatch_baseline
   │     └─ 副作用：快照 scope 文件 → manifest.jsonl
   │
   ├─ flow_run_verify             验证：写 last_verify{ok, cmd, fingerprint}
   │
   ├─ flow_falsify                负对照：写 last_falsify + last_verify(=改动后那次)
   │
   ├─ flow_audit_axes             生成两轴审计合同（Standards / Spec）
   │
   ├─ flow_audit_submit           提交单轴：写 audit_axes[axis] + audit_axes_ts
   │
   └─ flow_verdict                ★ 核心闸门
         └─ 9 组判断 / 17 个 return 点（顺序固定，不可调换）：
              【无条件 · 2 组】不管什么裁定都要过
              1. 有卡
              2. 占位卡已补齐（activation_pending 为空）
              【仅 PASS · 7 组】DIRECTION / LOCAL 不要求
              3. 派发过（dispatch_count > 0）
              4. 验证有效（卡片有 verify.cmd / 跑过 / ok===true / 命令对得上）
              5. 验证结果未过期（fingerprint 一致）
              6. 无越界改动（当前 diff - dispatch_baseline ⊆ scope）
              7. role 必须是 auditor（claimed_role === "auditor"）
              8. 负对照通过（verdict === "meaningful" + 证据哈希一致）
              9. 双轴齐且无 FAIL（两轴 card_ts 与当前卡一致）
              【前置否决闸 · 仅 PASS】8e 既有负对照结论可作废
              （作废失败时状态写不进「已作废」，由状态目录里的持久标记作证；
                标记也写不进去时由进程内硬拒名单兜底）
```

> **门禁顺序是有意的**：先证实验证有效（4/5）→ 再证改动合规（6/7）→ 再证测试有判别力（8）→ 再证审查到位（9）。
> 若调换顺序，「未验证」这类更基础的问题会被「双轴未齐」的错误信息掩盖，调用方拿到不可操作的下一步。
>
> **注释编号口径**：`src/index.js` 里的注释统一写成
> `门禁 N/9（无条件|仅 PASS）：...`，与本表的 9 组一一对应。
> 编号必须连续、且与本节表格一一对应（否则「读注释理解出的顺序 ≠ 代码真实顺序」，
> 使用者会按错的那道闸排查问题）。
> 改动这 9 组时，**注释编号与本节表格必须同时改**。

---

### 1.3 Cindy 侧的两段式目录（chip，v2.14.1 起）

Cindy 对插件 `tools` 声明有**硬上限 16 项**，本插件有 21 个操作 —— 直接声明必然被拒装
（v2.14.0 的 `kind:"mcp"` 声明更是已被宿主移除）。因此插件清单改成宿主手册 §3.5 的
「两段式目录」：

| 层 | 位置 | 职责 |
|---|---|---|
| 清单 | `ghost.json` | `kind: chip`，声明 `list_tools` / `call_tool` 两个元工具；`node.protocol = mcp-stdio`，`node.entry = src/index.js` |
| 分发 | `main.js` | 类目表（5 类）+ 每类 RULES；向随包 MCP 服务端取 `tools/list`（说明与参数 schema 的**唯一真源**），再按 name 转发 `tools/call` |
| 能力 | `src/index.js` | 21 个 `flow_*` 操作的实现 |

**为什么要这么接**：`tools/list` 由服务端提供，所以操作说明与参数 schema 不会在
main.js 里再抄一份（抄一份必漂移）；main.js 只维护「操作 → 类目」映射与规则文本。

**约定（宿主手册的硬要求，本仓库按它守）**

- 元工具名固定 `list_tools` / `call_tool`，不自创同义词；
- `list_tools` 支持类目下钻：不传 category 给概览，传了给明细；
- 下钻结果**同一份里**下发该类目 RULES（不能留到调用失败才说）；
- `call_tool` 对未知 name 附全部可用操作名 + 回查提示；对缺参/非法参数附参数 schema 与 RULES；
- 长任务（`flow_run_verify` / `flow_falsify` / `flow_dispatch`）按 45s 发 `tool-progress` 续命，
  避免 330s 工具窗口把慢验证判超时。

**类目划分（类目成员同时列出底层操作与门面；运行时按工具面过滤：默认四门面、`legacy` 26 个底层操作。`scripts/full-audit.mjs` 校验类目表覆盖全部声明，不多不少）**

| 类目 | 操作 |
|---|---|
| `gate` | submit_requirement / claim / dispatch / verdict |
| `verify` | run_verify / falsify |
| `audit` | audit_axes / audit_submit / audit_guard / audit / advisory_axes / advisory_submit / advisory_guard |
| `infra` | status / stats / protocol / mode / bypass / add_user_msg / save_result / revert_plan / check_scope / diff_hunks |
| `trigger` | trigger_check（默认面不暴露，legacy 面可用） |

**测试**：`test/cindy-dispatch.mjs`（23 条，真实起服务端 + vm 里跑 main.js）、
`test/mcp-stdio.mjs`（20 条，协议握手 / stdout 纯净 / 通知不回包 / 未知方法 -32601 / require 可加载）。

---

## 2. 状态字段字典

`state.json` 共 26 个字段，`schemaVersion` 当前为 **4**。

| 字段 | 类型 | 写入者 | 读取者 | 作用 |
|---|---|---|---|---|
| `schemaVersion` | number | migrate() | loadState | 迁移版本号，旧状态按版本逐步升级 |
| `card` | object\|null | submit_requirement, trigger_check | 几乎所有工具 | 任务卡（goal/quote/scope/new_files/acceptance/verify…） |
| `card_ts` | number | submit_requirement, trigger_check | verdict, status, audit_submit | 卡片时间戳，**审计轴绑定它防跨卡拼接** |
| `tier` | string | submit_requirement, trigger_check | claim, verdict, status | 风险档：read_only / single_file / cross_module / sensitive |
| `dispatch_count` | number | dispatch, submit_requirement(重置) | claim, dispatch, verdict | 已派发次数，上限 5 |
| `claimed` | boolean | claim, dispatch | dispatch | 是否已领名额（dispatch 时清零，需重新 claim） |
| `claimed_role` | string\|null | claim | verdict | 最近 claim 的角色，**PASS 必须是 auditor** |
| `write_files` | number | submit_requirement, dispatch | — | 本轮写入文件数（预留，当前不参与判定） |
| `last_user_ts` | number | submit_requirement, claim | — | 最近用户活动时间（判 stale 用） |
| `bypass` | boolean | bypass, dispatch | claim, status | 免检开关（dispatch 后自动清零） |
| `bypass_ts` | number | bypass, dispatch | — | 免检时间戳 |
| `verdict` | string\|null | verdict | status | PASS / DIRECTION / LOCAL |
| `completed_ok` | boolean | verdict | status | **只有 PASS 才置 true** |
| `stale` | boolean | submit_requirement | claim, dispatch, status | 卡片是否过期 |
| `activation_pending` | array | submit_requirement, trigger_check | claim, dispatch, verdict | 占位卡待补字段，非空则拒绝派发 |
| `activation_activated` | boolean | submit_requirement, trigger_check | submit_requirement | 是否曾被激活过（单调，只增不减） |
| `dispatch_baseline` | array | dispatch | verdict | 派发时的工作区改动基线，**越界判定的参照点** |
| `last_falsify` | object\|null | falsify | verdict, status | 负对照结果{verdict, before, after, restore{ok, checked, mismatched}} |
| `audit_axes` | object | audit_submit | verdict, status, audit_guard | 两轴结论{standards, spec} |
| `audit_axes_ts` | number | audit_submit | status | 两轴最后提交时间（审计留痕） |
| `verdict_role` | string\|null | verdict | status | 实际落裁定者角色 |
| `last_verify` | object\|null | run_verify, falsify | verdict, status | 验证结果{ok, cmd, exitCode, output_hash, fingerprint, **card_ts**} |
| `verdict_ts` | number | verdict | — | 裁定时间戳 |
| `task_id` | string\|null | — | — | 预留 |

### 2.1 迁移链

| 版本 | 新增 | 迁移动作 |
|---|---|---|
| v0 → v1 | `schemaVersion`、`dispatch_baseline`、`activation_pending`、`activation_activated` | 补默认值 |
| v1 → v2 | `last_falsify` | 补 `null`（表示未做负对照 → 拒绝 PASS） |
| v2 → v3 | `audit_axes`、`audit_axes_ts` | 补两轴 null（未审查 → 拒绝 PASS） |
| v3 → v4 | `verdict_role` | 补 `null` |

> 迁移的意义：旧用户的 `state.json` 会被**显式升级**而不是静默丢弃字段。
> 历史上没有版本号时，改字段名会让老用户状态被当成"未知字段"丢掉，表现为「免检没清零」「待补项丢失」。

### 2.3 并发与存储（v2.15.0 → v2.16.0）

**写状态的三条铁律**

1. **命令在锁外跑**：`flow_run_verify` / `flow_falsify` 的读-改-写窗口若横跨命令执行期
   （最长 120s / 240s），持锁超过 `staleMs`（30s）会被判陈旧并回收 → 另一进程拿到同一把锁
   → 同时写入。现在：命令跑完再进短锁。
2. **短锁内重新读最新状态**（`commitState`），只合并自己那份字段，绝不把执行前的快照整体写回。
3. **裁定要 CAS**：`flow_verdict` 判定在锁外，写入时核对 `card_ts`；不一致就拒写。

**证据绑定**：`last_verify.card_ts` 记录这次验证针对哪张卡；PASS 门禁要求它与当前卡一致，
旧卡的绿灯不能被新卡复用（缺该字段的历史状态退化为「验证时间必须晚于卡提交时间」）。

**存储清理（`carlos prune` / `scripts/prune.mjs`，v2.16.0）**

| 维度 | 行为 |
|---|---|
| 度量 | 与 `flow_stats` 共用 `src/storage.js`，避免「统计说 4MB、清理删 6MB」 |
| 默认 | **dry-run**：只打印计划（可归档会话、可迁移备份、节省字节），不动任何文件 |
| 会话 | 只归档可确认的已知终态、无活动/历史审计欠账且超过阈值天数的会话；状态未知或计划后身份变化保留；移动至 `<FLOW_HOME>-archive/<stamp>/runs/`，不删除数据 |
| 保护 | 没有结论的会话永不动；**审计目录一字节不碰**（脚本执行前后自校验文件数与字节，变了就退出码 1） |
| 备份 | 历史时间戳命名 → 内容寻址（blob 名只带扩展名，跨文件名也去重），manifest 指针同步改写，迁移后仍可还原 |
| 开关 | `--apply`、`--older-than N`、`--backups-only`、`--sessions-only`、`--archive-root` |
| 测试 | `test:prune`（当前 61 条：既有回归及两类欠账、身份 CAS、真实排队 writer、owner/EXDEV/未知结果故障矩阵） |

**跨平台门禁（`check:portability`，v2.16.0）**

v2.15.0 在 ubuntu CI 上挂的两处（`URL.pathname` 取路径、超时只杀外壳）本地全绿、CI 才红。
门禁把这两类写法变成「写下去就红」：禁止 `import.meta.url).pathname`、要求 spawn 设
`detached: !isWindows` 且终止只能经 `killProcessTree`、校验路径归一。

**存储形态**

| 项目 | 策略 | 为什么 |
|---|---|---|
| 派发快照 | 内容寻址 `sha-<hash>_<name>`，同内容只存一份；每个文件留最近 3 版 | 多轮返工常改同一批文件；实测单会话 94% 占用在 backup/ |
| 审计日志 | 单文件超 `CARLOS_FLOW_AUDIT_MAX_BYTES`（默认 8MB）滚动为 `<date>.N.jsonl` | 单日实测 2MB、全年 ~180MB；整文件读入会随使用线性变慢 |
| 审计校验 | 256KB 缓冲 + StringDecoder 逐行流式累加哈希 | 不整文件读入；跨分片严格串联，篡改中间分片仍被抓 |
| 命令输出 | 头尾各 256KB + 中间折叠，记录原始字节数 | 一次 50MB 输出足以撑爆内存/磁盘 |
| 度量 | `flow_stats`（只读） | 先能回答「占了多少、谁占的」，再谈清理阈值 |

### 2.2 协议漂移防护

`src/protocol.js` 的 `STATE_FIELDS` 由 `JSON.stringify(defaultState())` 生成，**不是手写常量**。

`test/protocol-consistency.mjs` 三道断言钉住：
1. `STATE_FIELDS` 是合法 JSON
2. 字段名集合与 `defaultState()` **双向一致**（漏一个、多一个都红）
3. 每个字段默认值也要一致
4. 源码文本层面禁止回退为手写常量

> 背景：手写副本曾漏掉 9 个字段（claimed / claimed_role / activation_pending / dispatch_baseline…），
> Agent 通过 `flow_protocol` 读到过期字段表，按错误字段名做决策 —— 这类漂移不会让任何现有用例变红。

---

## 3. 工具契约卡

### 3.1 第一层：状态门（9 个）

---

#### `flow_trigger_check`

| 维度 | 内容 |
|---|---|
| **状态门** | 入口。未达阈值时只评分不动作；达标时**自动执行** `flow_add_user_msg` + `flow_submit_requirement(activation:true)`，会话进入门禁态 |
| **问题层** | 避免每条普通需求都弹完整门禁（T0 讨论/解释直接答）。三层评分：关键词权重 + 上下文 + 意图识别，含动态上限与限流 |
| **读写字段** | 读：无 state。写：通过内联 submit 逻辑写 `card, card_ts, tier, dispatch_count, claimed, claimed_role, write_files, last_user_ts, bypass, verdict, completed_ok, stale, activation_pending=[scope,acceptance,verify.cmd], activation_activated=true`。外部：用户原话文件 |
| **测试覆盖** | `e2e-acceptance.mjs`、`e2e-carlos.mjs`、`package-e2e.mjs`（3 个文件，8 处调用） |

**关键约束**
- `message` 必填（quote 锚点与评分都依赖它）
- `execute=false` 只评分不动作（供测试与预演）
- 会话已有 `card` 时**不覆盖**（保护用户已有任务）

---

#### `flow_submit_requirement`

| 维度 | 内容 |
|---|---|
| **状态门** | 留痕门。**任何 T2 改动前必须调用**，否则后续全链报错 |
| **问题层** | ① 防止"替用户编需求"（quote 必须在用户原话中可定位）② 防止改不存在的文件（scope 路径存在性校验）③ 防止误改敏感路径（.env / migrations / .github / *.pem 等需 `confirmed:true`）④ 占位卡未补齐时阻断派发 |
| **读写字段** | 读：`card`、`activation_activated`、`activation_pending`（判断闸门保持/解除）。写：`card, card_ts, tier, dispatch_count=0, claimed=false, claimed_role=null, write_files=0, last_user_ts, bypass=false, verdict=null, completed_ok=false, stale=false, activation_pending, activation_activated` |
| **测试覆盖** | 8 个文件：`concurrency-e2e.mjs`、`e2e-acceptance.mjs`、`e2e-carlos.mjs`、`p0-gates.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`trigger-e2e.mjs`、`verify-stale.test.mjs`（50 处调用，**最深**） |

**审计事件**：`finding/card_finding`、`decision/blocked`、`decision/activation_gate_activated`、`decision/activation_gate_unlocked`、`decision/activation_gate_held`、`run/record`、`decision/accepted`、`run/activation`、`decision/activation_released`

**关键约束**
- 读-改-写包在 `withStateLock` 里（跨进程排他锁），否则多进程并发会丢更新导致闸门被绕过
- `activation_pending` 由**当前卡片内容幂等派生**，不依赖上一轮传递
- 两条入口（结构化参数 / `cardText`）口径必须一致，否则 `cardText` 路径可绕开闸门

#### 新增：新文件授权（`new_files`）

「派发时尚不存在的新文件」**不走 `scope`**，走独立字段 `card.new_files`（仓库根相对路径数组）。

**为什么分开**：`scope` 的语义是「只准改这些**已存在**的文件」，存在性校验一字未改；
新文件在派发时**本来就不存在**，硬塞进 `scope` 只会把存在性校验变成谎言，
或者被迫放宽成「scope 可以不存在」——那会让「scope 越宽 = 授权越宽」的老路重开。
所以新文件走单独的字段、单独的授权说明、单独的拒绝条件。

| 入参 | 卡片字段 | 含义 |
|---|---|---|
| `newFiles` | `card.new_files` | 获授权可新建的文件路径（相对仓库根，派发时尚不存在） |
| `newFilesReason` | `card.new_files_reason`（cardText 入口） | 新文件授权的**用户授权说明**（必填且非空） |
| — | `card.new_files_reasons` | **逐文件**的授权说明（`{路径: 说明}`）；追加授权时旧文件的说明不被覆盖 |

**拒绝条件（任一不满足即返回 `ok:false`，且不落卡）**

| 条件 | 拒绝原因 |
|---|---|
| `confirmed !== true` | 新文件授权需要用户明确确认 |
| `newFilesReason` 缺失 / 为空 | 新文件授权必须提供非空授权说明 |
| **授权说明无法在用户原话中定位** | 与 `quote` 同级锚定：自述 `confirmed` 不算数，说明必须真的出现在用户说过的话里 |
| `newFiles` 不是非空数组 | 新文件授权必须是非空路径数组 |
| 数组元素不是非空字符串 | 新文件授权包含无效路径 |
| 绝对路径，或解析后越出仓库根（`..` 逃逸 / 指向仓库外） | 必须是仓库内相对路径 |
| **父目录是符号链接 / junction 且指向仓库外** | 真实路径落在仓库之外（否则文件会写到仓库外） |
| **真实路径解析失败**（权限不足 / 特殊文件系统） | 按保守口径拒绝 |
| 路径已存在且是**目录** | 目录请放入 `scope` |
| 路径已存在且是**普通文件** | 已存在文件请放入 `scope` |
| 路径已存在且是**符号链接** | 拒绝经链接写到别处 |
| **父目录不存在** | 本轮只授权文件，不授权新建目录 |
| 与 `scope` 里的路径重复 | 同一路径只留一处授权 |
| **授权列表内部出现重复路径**（`'a.txt'` 与 `'./a.txt'`、`'a/b.txt'` 与 `'a\b.txt'`） | 同一路径只留一条授权：重复授权会让「授权了几条」与「快照覆盖了哪些文件」对不上 |
| `scope` 为空 | 空 `scope` 按 fail-closed 处理，不允许授权新文件 |
| `cardText` 的 `new_files` 与参数 `newFiles` 同时给且内容不同 | 冲突：不得静默丢弃其中一份授权依据 |
| `cardText` 的 `new_files_reason` 与参数 `newFilesReason` 同时给且内容不同 | 冲突：不得静默丢弃其中一份授权说明 |

**唯一实现**

规则本体**只有一份**：`src/card.js` 的 `validateNewFiles(raw, scope, root, options)`。
提交入口（`flow_submit_requirement` 的结构化参数 / `cardText` 两条入口）与
`appendScope` 分支都调用它；卡片层复核（`validateCard`）也调用同一份。
规则一旦有多份副本就会漂移，而漂移的后果是**门禁口径自相矛盾**
（落卡时判在仓库内、执行时判在仓库外），所以规则只允许存在一份。

- 路径比较口径统一：全仓**只有一把**平台感知的路径键（`src/card.js` 的 `pathKey`）——
  `win32` 下大小写不敏感（文件系统本身就是大小写不敏感的），
  其它平台（POSIX）**敏感**（大小写不同的就是两个不同文件，折叠大小写会把真越界当成授权内）。
  授权校验、越界检测（`src/dispatch.js` 的 `enforceScope`）、`scope` 追加层共用它，
  三处不得各写一份。
  同一把 `pathKey` 也被 `src/dispatch.js` 的 `enforceScope` 复用 ——
  授权写法与落盘写法大小写不同时（授权 `Docs/Guide.md`、落盘 `docs/guide.md`），
  在 `win32` 上已授权的新文件不会被误判成越界；在 POSIX 上它们本就是两个文件，
  落盘的那个必须判越界。
- **仓库内判定按真实路径**：父目录是符号链接 / junction 且指向仓库外时拒绝授权
  （词法比较看不出这一点：`<root>/link/new.txt` 看着在仓库内，真实落点却在仓库外）。
  真实路径解析失败（权限不足 / 特殊文件系统）按保守口径拒绝。
- **真实路径解析只有一份**：卡片层（授权边界）与还原层（`flow_falsify` 写回/删除前的
  边界闸）调用同一个 `src/card.js` 的 `realTargetPath` —— 两份实现一旦漂移，
  就会出现「落卡时判定在仓库内、执行/还原时判定在仓库外」的自相矛盾。
- **派发时再核一次**：`flow_dispatch` 对已登记的 `new_files` 重做一次真实路径边界复核
  （与落卡同口径，解析失败按保守口径拒绝）并拒绝派发。
  理由：授权与执行之间可能隔很久，期间授权路径的父目录可能被换成指向仓库外的
  符号链接 / junction —— 落卡时安全，执行时文件已经写到仓库外了。
- 卡片层校验**不依赖可选参数**：卡片含 `new_files` 但校验上下文里没有仓库根时，
  按保守口径**拒绝**（无法判定「是否落在仓库内」= 不能默默放宽范围）。
- 触发器落卡路径（`flow_trigger_check` 自动激活）与提交路径**口径一致**：
  同样补上仓库根，同样用 `validateNewFiles` 校新文件授权。

**通过后的语义**
- 派发快照把 `new_files` 一并纳入：派发时不存在 → 快照记 `created:true`
- 派发后的范围校验**允许集 = `scope` + `new_files`**：已登记的新文件被创建后不得判越界
- 还原时 `created:true` 的条目按「删除该文件」处理（只删普通文件，见 `flow_falsify`）
- 派发合同的「任务边界」必须**列出获授权的新文件**：执行者只看得到 prompt，
  看不到卡片字段 —— 不列出来就等于没授权
- `appendScope` 分支同样可追加新文件授权（仍需 `confirmed=true` + `newFilesReason`，
  且说明同样要在用户原话中可定位），追加后既有派发次数、快照、角色与证据保持不变
- **逐文件保留授权依据**：每个获授权新文件各自记一条说明（`card.new_files_reasons`）。
  追加授权时旧文件的说明**不得被新说明覆盖** —— 覆盖等于抹掉历史授权依据。
  `card.new_files_reason` 保留首次授权的说明作为汇总字段。
- `appendScope` 追加新文件后**必须补记快照**（`created:true`）：否则负对照的
  「改动前态」删不掉它 → 负对照退化成 `vacuous`（空测试）

---

#### `flow_claim`

| 维度 | 内容 |
|---|---|
| **状态门** | 派发名额门。领取 executor/auditor 身份，返回四段合同 prompt |
| **问题层** | ① 防止无卡开工 ② 防止卡片过期后继续派发 ③ 防止超过 5 次派发上限 ④ 防止占位卡未补齐就派发 ⑤ 让 `claimed_role` 有可信来源（verdict 的 role 门禁依赖它） |
| **读写字段** | 读：`card, stale, dispatch_count, activation_pending`。写：`claimed=true, claimed_role, last_user_ts` |
| **测试覆盖** | 7 个文件：`concurrency-e2e.mjs`、`e2e-acceptance.mjs`、`e2e-carlos.mjs`、`p0-gates.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`（27 处调用） |

**审计事件**：`decision/claimed`

**关键约束**
- **claim 不消耗额度**（`dispatch_count` 不变），只标记 `claimed=true`；额度在 dispatch 时才 +1
- `role` 只接受 `executor` / `auditor`，非法值直接报错（不静默降级）

---

#### `flow_dispatch`

| 维度 | 内容 |
|---|---|
| **状态门** | 派发门。生成合同、快照 scope 文件、记录改动基线 |
| **问题层** | ① 防止未 claim 就派发 ② **记录派发前基线** —— 这是越界判定的参照点（派发时子 Agent 还没动手，此时判定只会误伤用户已有改动）③ 快照用于事后还原与负对照 ④ 派发后自动清零免检（防"忘记关免检"长期生效） |
| **读写字段** | 读：`card, stale, dispatch_count, activation_pending, claimed`。写：`dispatch_count+1, claimed=false, write_files=0, bypass=false, bypass_ts=0, dispatch_baseline`。外部：`runs/<sid>/backup/manifest.jsonl`（快照）、`runs/<sid>/dispatch/*.prompt.txt`（合同） |
| **测试覆盖** | 5 个文件：`e2e-carlos.mjs`、`p0-gates.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`（11 处调用） |

**审计事件**：`decision/bypass_auto_reset`、`run/snapshot`、`run/dispatch_baseline`、`run/dispatch`

**关键约束**
- `run=false`（默认）只返回 prompt，由主 Agent 自行派子 Agent；`run=true` 也只写 prompt 文件 + 返回路径，**不直接起子进程**
- 快照只覆盖 `card.scope` 内文件 —— 这是负对照的已知局限（scope 外依赖只是近似还原）
- 快照同时覆盖 `card.new_files`（获授权可新建的文件）：派发时它们不存在 → 记 `created:true`，
  还原时按「删除该文件」处理
- 派发前对已登记的 `card.new_files` **重做一次真实路径边界复核**（与落卡同口径）：
  授权与执行之间可能隔很久，期间授权路径的父目录可能被换成指向仓库外的
  符号链接 / junction —— 落卡时安全，执行时文件已经写到仓库外了。
  复核不通过（真实路径落在仓库外 / 解析失败）→ **拒绝派发**并给出原因
- **复核的根 = 卡片登记的项目根**（`card.env.project`），不是派发时 cwd 的仓库根：
  拿新根复核等于「换个基准重新判一次」，原本越出卡片项目根的授权路径会被放行
- **派发目录必须落在卡片项目根之内**：不一致（派发到别的仓库/目录）→
  **拒绝派发**并说明两个根分别是什么；卡片未登记项目根且有待复核的新文件 → 同样拒绝派发
  （无从判定边界 = 不能默认放行）。未传 `cwd` 时派发基准回落到卡片项目根
  （卡片已经定义了「这次工作在哪个项目」，没传 cwd 不等于「换个项目」）
- 派发合同 prompt 的「任务边界」必须列出**获授权的新文件**（`scope` + `new_files`）：
  执行者只看得到 prompt，看不到卡片字段
- 派发时记录的改动基线（`dispatch_baseline`）必须包含**未跟踪文件**：
  `git diff --name-only` 只含已跟踪文件，旧实现因此看不见「新建文件」

---

#### `flow_run_verify`

| 维度 | 内容 |
|---|---|
| **状态门** | 验证门。执行 `card.verify.cmd` 并写入验证证据 |
| **问题层** | ① 防止"我说测试过了" —— 必须真实执行并记 exitCode ② **绑定代码状态**（fingerprint）—— 防止验证通过后继续改坏代码再记 PASS ③ 记录输出哈希，防止证据被换掉 |
| **读写字段** | 读：`card`、`card.env.project`（工作目录）。写：`last_verify{ts, cmd, cwd, exitCode, ok, output_hash, fingerprint}` |
| **测试覆盖** | 3 个文件：`e2e-carlos.mjs`、`p0-gates.mjs`、`verify-stale.test.mjs`（6 处调用） |

**关键约束**
- 工作目录优先级：**显式 cwd > 卡片提交时的 `card.env.project` > `process.cwd()`**
- Git 指纹的 HEAD / diff / 未跟踪列表命令均限时 5 秒、缓冲上限 8 MiB；必须无 error、status 为 0 且无 signal 才能消费全文。超时、超限、非零或 null status 返回 `git_command_failed`（含 phase），不生成 hash，不把错误当空输出或非 Git。
- 只有 Git 明确确认 `not_a_git_repo`，且 cwd 祖先发现路径没有 `.git` 元数据或未知 IO/链接时，才保留非 Git 项目兼容。损坏 `.git`、明确 Git 环境路径、未知故障（包括缺失 Git、损坏仓库、无有效 HEAD）一律 fail-closed。`flow_run_verify` / `flow_falsify` 的命令即使成功，指纹失败也不形成有效验证证据：保存 `last_verify.ok=false` 及失败指纹并返回错误，命令原始 exitCode 与还原回执仍保留。
- `flow_status` 不将旧或当前失败指纹标成 pass；`flow_verdict(PASS)` 拒绝未知失败。Git 指纹必须有合法 HEAD 与 64 位 SHA256；双方完整指纹的 HEAD 或 diff hash 真的变化才产生 `VERIFY_STALE` 与向导入口。旧字段缺失/畸形不产生向导，缺失旧指纹仅在当前明确非 Git 时保留旧项目兼容。
- 未跟踪列表用 NUL 分隔、保留原始字节并严格 UTF8 roundtrip；不支持的非法字节路径显式失败，不映射成 U+FFFD 后读取另一文件。HEAD/diff/未跟踪采集统一真实 Git root，仅剥离 Git 记录末尾 LF，不 trim 或删除路径自身的 CR；异常协议明确失败，不误选相邻库。验证命令的 cwd 仍保持原选择；子目录调用也绑定父/兄弟未跟踪依赖。
- 未跟踪 metadata/content/close/hash 全部在短命受信 Node 子进程中运行，固定 `node -e` 入口，仅通过 stdin JSON 传路径，不用 shell 拼接。父从启动开始设 5 秒 timeout，超时 SIGKILL 并同步等待该无后继进程退出；不是 Promise.race 遗留任务。最终出口也检查读取 deadline。不可中断的 OS 内核 IO/进程回收仍可能延长实际返回，不宣称硬件绝对 5 秒。
- 读取以 64 KiB 块流式 hash 全文，未跟踪内容累计上限 8 MiB；输入 JSON 另限 8 MiB，输出/诊断总缓冲限 64 KiB，不把 Node 运行时 RSS 声称为 64 KiB。读取/关闭/类型/读取期间变化等失败显式返回不可用，不将错误文本或空输出当 hash，也不把诊断中的路径/环境秘密回传。超过 1 MiB 的文件不能仅 hash 大小；同尺寸内容变化须可检出。小文件保留原路径分隔符＋原内容 SHA256 算法，大文件旧大小摘要与新全文摘要不兼容，需重新验证。
  （MCP server 是常驻进程，它的 cwd 是启动时的目录，可能是几个月前的旧仓库）
- `verify.cmd` 为空时直接拒绝（没有可核验依据）

---

#### `flow_falsify`

| 维度 | 内容 |
|---|---|
| **状态门** | 负对照门。PASS 前必须做，且必须 `meaningful` |
| **问题层** | **证明 verify.cmd 真的在测本次改动**。`verify.cmd` 可以是 `echo ok` / `cmd \|\| true` 这类空测试 —— 改动前后都退 0，门禁却以为验证通过。负对照要求：改动前跑必须**失败**，改动后跑必须**通过** |
| **读写字段** | 读：`card`、`card.env.project`。写：`last_falsify{ts, cmd, cwd, verdict, reason, before{exitCode,ok,hash}, after{...}, restore{ok,checked,mismatched}}` + `last_verify`（= 改动后那次运行，让裁定证据绑定到这次运行） |
| **测试覆盖** | 5 个文件：`e2e-carlos.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`、`falsify-restore.mjs`（8 处调用） |

**审计事件**：`run/falsify_denied`、`run/falsify`

**判定口径**

| verdict | 含义 | 能否 PASS |
|---|---|---|
| `meaningful` | 改动前失败 + 改动后通过 | ✅ 可以 |
| `vacuous` | 改动前就通过（空测试） | ❌ 拒绝 |
| `not_passing` | 改动后仍失败（改动本身有问题） | ❌ 拒绝 |
| `restore_failed` | 最终还原不完整（工作区没回到进入负对照时的状态） | ❌ 拒绝 |
| `inconclusive` | 其他 | ❌ 拒绝 |

**关键约束**
- 需要派发快照（`manifest.jsonl`），没派发过直接拒绝
- 先把"改动后"状态备份到临时目录，`finally` 里一定还原 —— 即使 verify 命令本身改文件，也不会把工作区留在改动前状态
- **还原是可核验的**（v2.14.0）：进入临界区前写 `negative_control/<ts>/journal.json`；`finally` 里还原后逐文件比对内容摘要，结果写回 `restore{ok, checked, mismatched}`，失败时**保留备份目录**并写 stderr 告警
- **还原失败关闭**：删除/还原失败一律**记账并如实报告**，不得吞错后继续、
  更不得对外宣称「已还原」。具体：
  - 删除/还原失败一律**记账并如实报告**，负对照返回 `ok:false`（`verdict=restore_failed`），
    **不拿半还原状态当「改动前态」去跑对照**；
  - **范围边界**：只允许对任务卡登记项目（仓库根）内的路径执行还原，越界路径拒绝并记账；
  - **只删普通文件**：目标是目录（含非空目录）或符号链接时失败关闭，不递归删除、不跟随符号链接；
  - **事务记录**：每次还原动作与结果追加到 `journal.json` 的 `restore_log`，
    失败时目录保留（证据不删），下次调用可据此恢复；
  - 负对照语义不变：还原到改动前态 → 验证必须失败；还原到改动后态 → 验证必须通过
- **还原只有一份实现**：边界判定、只删普通文件、失败记账、
  结果结构全部收敛到 `dispatch.js` 的 `restoreEntries()`；四个调用点
  （manifest 还原 / 崩溃恢复 / 还原当前态 / 还原记录态）都调用它。
  多份实现必然漂移 —— 写回分支一旦漏了 `lstat` 防护，就会顺着符号链接把
  **仓库外**的文件改掉，而删除分支有，口径不一致 = 门禁有洞
- **写回分支与删除分支口径一致**：还原前统一过三道闸：
  ① 范围边界按 **realpath 解析后的真实路径**判定（路径里只要有符号链接/junction，
  真实路径就落到别处 → 越界）；
  ② 目标本身不能是符号链接（`lstat` 不跟随链接）；
  ③ 目标沿途的**父目录**不能是符号链接/junction；
  任一不满足 → 拒绝执行、记账、失败关闭，**仓库外的真实文件一个字节都不会被改动**
- **最终 journal 写盘失败必须如实报告**：`journal.json` 是崩溃恢复的
  唯一依据，写不下去就如实标记 `restore.journal_write_failed=true` 并**失败关闭**
  （不静默忽略），备份目录保留
- **负对照失败即作废既有结论**：本次负对照失败（还原失败关闭等）时，
  立即清空 `last_falsify` —— 否则上一轮的 `meaningful` 旧结论会被沿用，
  坏掉的负对照照样能放行 PASS；`last_falsify` 同时记录 `card_ts`，
  裁定时校验证据属于**当前卡**（旧卡结论不得冒充新卡）
- **负对照抛异常同样作废既有结论**：负对照**抛异常**
  （参数非法、工作区不可读等）与「返回失败」是同一类后果 ——
  本次没拿到有效结论就不能留旧结论。异常路径同样清空 `last_falsify`，
  否则旧 `meaningful` 结论会继续支撑 PASS
- **作废失败必须失败关闭**：作废（写状态清空 `last_falsify`）本身失败
  （状态锁损坏 / 超时）时，旧结论会继续支撑 PASS —— 而作废失败的原因往往
  正是状态存储坏了，**没有地方能写下「旧结论已作废」**。
  因此作废失败会另外落一个**不依赖状态锁**的持久标记
  （`<CARLOS_FLOW_HOME>/gate-state/runs/<session>/falsify_invalidation_failed.json`），
  裁定闸（门禁 8e）看到标记一律拒 PASS；作废成功或负对照成功写入新结论时标记被撤销。
  防线分三层（由弱到强）：① 状态写入成功 → 旧结论真被清空；
  ② 状态写入失败但标记写得进去 → 标记作证，跨进程拒 PASS；
  ③ 状态与标记**都写不进去** → 落进程内硬拒名单（本进程内一律拒 PASS），
  此时存储不可写，跨进程持久化在物理上不可能 —— 宁可拒，也不能让旧结论冒充新证据。
  标记写入失败必须**如实报告**（不得当作已作废、也不得声称已标记）
- **标记清除失败必须如实报告**：旧的「不可 PASS」标记撤不掉时（权限/占用等），
  不能静默吞掉 —— 它会一直挡着 PASS，而用户重跑负对照也清不掉。
  负对照成功但清除失败时，返回值与 `note` 里必须写明「标记清除失败」
- **还原不完整不得支撑 PASS**：最终还原失败项
  ① 置 `restore.ok=false`；② 负对照结论降级为 `restore_failed`（不得仍是 `meaningful`）。
  裁定闸门另外独立核一次 `restore.ok` —— 还原没核对通过就不给 PASS
- **还原范围根不得缺省放行**：`restoreEntries()` 的
  `options.root` 是**必填**边界根；缺了时每一项都按「拒绝」记账并返回 `ok:false`
  （缺省即跳过边界判定 = fail-open，能把仓库外的文件改掉/删掉）
- **崩溃可恢复**（v2.14.0）：上一次被强杀（日志停在 `pending`）时，本次调用先按日志把工作区救回来，并在返回值 `recovered{dirs, files, unresolved}` 里如实报告
- **局限**：快照只覆盖 scope 内文件，scope 外依赖被改时结论仅供参考

---

#### `flow_audit_axes`

| 维度 | 内容 |
|---|---|
| **状态门** | 双轴审查的入口。生成两段审计合同 prompt |
| **问题层** | 把"审查"拆成两个独立视角：**Standards 轴**（仓库规范 + 18 项坏味道基线）与 **Spec 轴**（验收标准忠实度 + 越界）。分开审比一份报告更可靠 |
| **读写字段** | 读：`card`。写：无 state。外部：`runs/<sid>/dispatch/*.prompt.txt`（两份合同） |
| **测试覆盖** | 4 个文件：`e2e-carlos.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`（5 处调用） |

**审计事件**：无

**关键约束**
- 坏味道基线（`SMELL_BASELINE`，18 项）由项目自维护，**术语对齐 Fowler《Refactoring》第二版第 3 章**，但不是原书全表 —— 文档里如实标注边界
- 判定词表必须与 `flow_audit_submit` 的 enum（PASS/WARN/FAIL）对齐，否则 FAIL（硬拦）与 WARN（不拦）的差别会在映射时失效

---

#### `flow_audit_submit`

| 维度 | 内容 |
|---|---|
| **状态门** | 双轴审查的提交口。PASS 前必须两轴都提交 |
| **问题层** | ① 让审计结论落盘可查（此前只躺在对话里）② **按 card_ts 绑定** —— 防止旧卡结论冒充新卡、防止两轴跨卡拼接（卡A的 standards + 卡B的 spec 不算数） |
| **读写字段** | 读：`card`、`card_ts`。写：`audit_axes[axis]{verdict, findings, evidence, card_ts, ts}`、`audit_axes_ts` |
| **测试覆盖** | 4 个文件：`e2e-carlos.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`（9 处调用） |

**审计事件**：`decision/audit_axis_submitted`

**判定口径**

| verdict | 含义 | 是否硬拦 |
|---|---|---|
| `PASS` | 通过 | 否 |
| `WARN` | 坏味道等 judgement call | **否**（由主 Agent 读 `audit_axes` 后标注） |
| `FAIL` | 规范硬违规 / 未实现验收 | **是** |

---

#### `flow_verdict`

| 维度 | 内容 |
|---|---|
| **状态门** | **核心闸门**。唯一能把 `completed_ok` 置 true 的工具 |
| **问题层** | 六类「假闭环」的拦截点（详见下方判断表）。没有它，一张刚提交、什么都没跑的卡也能标完成 |
| **读写字段** | 读：`card, card_ts, activation_pending, dispatch_count, dispatch_baseline, last_verify, last_falsify, audit_axes, claimed_role, verdict, tier`。写：`verdict, completed_ok, verdict_ts, verdict_role` |
| **测试覆盖** | 6 个文件：`concurrency-e2e.mjs`、`e2e-carlos.mjs`、`p0-gates.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`（31 处调用） |

**审计事件**：`decision/verdict_denied`、`decision/scope_violation`、`finding/verdict_overwrite`、`resolution/verdict`

**9 组判断 / 17 个 return 点（顺序固定，不可调换）**

前 2 组**无条件适用**（任何裁定都要过）；第 3 组起**仅 PASS 适用**（DIRECTION / LOCAL 是返工意见，不构成「完成」）。

| # | 适用 | 判断 | 拒绝原因（`return fail` 的实际文案要点） |
|---|---|---|---|
| 1 | 无条件 | 有卡 | 没有留痕，无法记录裁定 |
| 2 | 无条件 | 占位卡已补齐 | `activation_pending` 非空 |
| 3 | 仅 PASS | 派发过 | `dispatch_count = 0` |
| 4a | 仅 PASS | 卡片有 `verify.cmd` | 无可核验依据 |
| 4b | 仅 PASS | 验证跑过 | 无 `last_verify` |
| 4c | 仅 PASS | 验证通过 | `last_verify.ok !== true` |
| 4d | 仅 PASS | 命令对得上 | `last_verify.cmd` ≠ 当前卡 `verify.cmd` |
| 5 | 仅 PASS | 验证结果未过期 | fingerprint 变化（A1 门）；旧或当前 Git 指纹读取失败也拒绝，但不是 STALE 向导 |
| 6 | 仅 PASS | 无越界改动 | `当前 diff - dispatch_baseline ⊄ scope` |
| 7 | 仅 PASS | role 是 auditor | `claimed_role !== "auditor"` |
| 8a | 仅 PASS | 负对照已做 | 无 `last_falsify` |
| 8b | 仅 PASS | 负对照通过 | `verdict !== "meaningful"` |
| 8c | 仅 PASS | 负对照还原核对通过 | `last_falsify.restore.ok === false` |
| 8d | 仅 PASS | 负对照证据一致 | `last_verify.output_hash !== last_falsify.after.hash` |
| 8e | 仅 PASS | 既有负对照结论**可作废** | 作废失败标记存在（`falsify_invalidation_failed.json`） |
| 9a | 仅 PASS | 双轴已齐 | 两轴 `card_ts` 与当前卡不一致 |
| 9b | 仅 PASS | 双轴无 FAIL | `standards` 或 `spec` 判 FAIL |

> **编号说明**：`4a~4d`、`8a~8e`、`9a~9b` 在代码里是独立的 `return fail` 点（共 17 个），
> 本表按语义归为 9 组。统计数据时请以 17 个判断点为准。
>
> **8e 是前置否决闸**：它在其它组之前求值（标记存在 = 旧负对照结论不可信，
> 任何 PASS 都不该落），但语义上属于第 8 组（负对照）。
> 放在前面是因为它给出的下一步最具体（先修状态存储，再重做负对照）。

**WARN 汇总**：两轴判 WARN 的结论会随裁定一起返回（`warn_count` / `warn_findings`），上限 20 条，防止 WARN 通胀成噪音。

**关键约束**
- 第 1~2 组**无条件**；第 3 组起**仅 PASS**。`DIRECTION` / `LOCAL` 是"有问题"的裁定，不构成"完成"，允许在未派发时先记录返工意见
- 越界判定用**增量**：`当前 diff - 派发基线`，避免误伤用户自己原有的未提交改动
- **还原不完整不得支撑 PASS**：负对照的最终还原没核对通过
  （`last_falsify.restore.ok === false`）时，即使 `verdict` 写着 `meaningful` 也拒 PASS ——
  工作区没回到进入负对照时的状态，「改动后」那一态就不是我们以为的那一态
- **作废失败不得支撑 PASS**：负对照失败/异常时要作废上一轮的 `last_falsify`；
  作废这一步失败（状态锁损坏 / 超时）时，旧结论会继续支撑 PASS ——
  而作废失败的原因往往正是状态存储坏了，状态里写不进「已作废」。
  因此作废失败会落一个不依赖状态锁的持久标记，门禁 8e 看到标记一律拒 PASS

---

### 3.2 第二层：工作流辅助（3 个）

---

#### `flow_status`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定 |
| **问题层** | 回答"现在到哪一步了"。主 Agent 每轮汇报、CLI 查询、测试断言都靠它 |
| **读写字段** | 读：`card, card_ts, tier, dispatch_count, verdict, verdict_role, completed_ok, stale, bypass, activation_pending, audit_axes, audit_axes_ts, last_verify`。**不写任何字段**（无 `saveState` 调用） |
| **测试覆盖** | 4 个文件：`bridge-identity.mjs`、`e2e-acceptance.mjs`、`e2e-carlos.mjs`、`verify-stale.test.mjs`（30 处调用） |

**返回的关键派生字段**

| 字段 | 含义 |
|---|---|
| `verify_passed` | 真实验证是否通过（boolean，不破坏下游） |
| `verify_state` | 四态：`not_run` / `fail` / `stale` / `pass`；Git 指纹读取失败为 `fail`，不得报 `pass` |
| `axes_ready` | 两轴都有结论 + `card_ts` 一致 + 无 FAIL |
| `warn_count` / `warn_findings` | 与 `flow_verdict` 同一份派生口径 |
| `unreviewed` | 有卡但无裁定 |
| `wizard` | 本次只读安全向导摘要；不等于原 `completed_ok` 或 `verified` |

**Phase1 安全向导投影**

`ui/narrator.js` 的 `deriveWizardStatus(state, observation)` 是纯函数，保留原 `narrate` 导出，顶层无 DOM、Host 或文件依赖。`flow_status` 只调用一次已有权威 `verifyState`，将同次 `verify_state`、`verify_passed`、指纹可用性和采样时间传给投影，不在 UI 模块重算工作区指纹。原返回字段、schema 与非 Git 兼容口径不变；向导在无可用指纹时保守停在检查，不能借兼容绿灯宣称完整完成。

摘要白名单仅为 `stage/stage_label/status/completed_ok/goal/scope_count/reason/next_responsible/sampled_at/warning_count`。目标只显示“已记录目标/尚未记录目标”，不回传任意目标原文；范围只给数量。命令、路径、原始错误、输出、diff、审查原文与秘密不进入摘要。采样时间是本次工具调用观察，不宣称页面实时；缺观察时纯投影返回未知。现有 flow_status 原字段不是这个脱敏白名单，页面不得直接广播整个工具结果。

阶段由真实卡及证据派生：无卡启动，缺目标停目标，范围/验收/命令或占位待补项停范围；没有验证证据时执行状态待确认，派发次数不是执行完成。验证必须绑定当前 `card_ts`、命令与时间，真实 `ok`、退出码、输出哈希及本次权威采样均有效，才检查负对照。负对照须有当前命令/时间、改动前真实非零退出、改动后成功及匹配哈希，并明确还原核对成功。现有负对照无独立卡代，使用其时间、命令与当前验证输出哈希关联；显式旧卡代拒绝，缺失/空证据/超时不算有效。

审查须两轴当前卡代、时间不早于验证、有证据且结论属于 PASS/WARN；FAIL 阻塞，WARN 以计数保留。最终完成还要求真实 `completed_ok`、auditor PASS、派发记录及不早于验证和双轴的最终裁定时间。审计待确认、还原失败、陈旧任务、免检均阻塞。自报步骤、缓存、`verified`、executor 自批与未知结果不参与推进。投影是状态存储内的保守一致性摘要，不证明文件未被外部伪造，也不代替后端裁定、审计链核验或 Host 授权。

验证：`test/verify-ui.mjs` 保留原 narrator 风格断言，新增完整正负矩阵及真实 stdio `flow_status` fixture（无卡、占位卡、非 Git 指纹不可用），逐字节确认工具不写 fixture 状态。真实 Host 页面、启动工具、确认卡及点击续接属于后续 Phase2，Phase1 不声称完整桌面向导验收。

> **注意**：`verify_passed` 与 `verified` 语义不同。`verified` 只表示"是否已有裁定"，不代表验证通过。

---

#### `flow_check_scope`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定（但 `flow_verdict` 内部用**同一份** `enforceScope` 逻辑） |
| **问题层** | 提交裁定前自查越界。auditor 合同明确要求调用 |
| **读写字段** | 读：`card.scope`。**不写 state** |
| **测试覆盖** | 3 个文件：`e2e-carlos.mjs`、`p0-gates.mjs`、`scope-enforcement.mjs`（6 处调用） |

**行为**
- 传 `paths` → 检查调用方给的清单
- 不传 `paths` → 自动跑 `git diff --name-only`（已跟踪文件的改动）
  **+ `git ls-files --others --exclude-standard`（未跟踪的新文件）** 取当前实际改动
- 空 `scope` → **fail-closed**（所有改动都算越界），不是 fail-open
- 允许集 = `card.scope` + `card.new_files`（获授权可新建的文件被创建后不得误报）
- **未跟踪的新文件同样纳入越界判定**：`git diff --name-only`
  只含已跟踪文件，只看它会完全看不见「新建了一个没授权的文件」——
  越界检测漏了最大的一类。尊重 `.gitignore`（被忽略的文件不算改动）；
  `CARLOS_FLOW_HOME` 若落在仓库内，其状态文件不计入改动（避免自我误报）
- **自动模式做基线相减**：不传 `paths` 时，
  「当前改动 − 派发时基线」= 本次执行**引入**的改动，只有它参与越界判定。
  不做相减 → 派发**之前**就存在的未跟踪文件会被报成越界
  （与裁定路径的口径不一致：裁定做了相减，自查没做，自查说没问题、裁定说有问题）。
  传了 `paths` → 按调用方给的清单逐项判（调用方自己指定要查什么，不做相减）
- **路径键与卡片层同一把**：允许集比对用 `card.js` 的 `pathKey`
  （平台感知：`win32` 折叠大小写、其它平台敏感）—— 授权写法与落盘写法大小写不同时，
  在 `win32` 上已授权的新文件不得被误判成越界；在 POSIX 上大小写不同本就是两个文件，
  落盘的那个必须判越界。路径键**不得**无条件小写（那会在 POSIX 上把真越界当成授权内）

---

#### `flow_bypass`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读 `card` 判存在性；写 `bypass` / `bypass_ts`。派发后自动清零 |
| **问题层** | 用户说"直接干 / 跳过门禁 / 免检"时的**逃生阀**。必须显式 `confirmed:true`，不能隐式触发 |
| **读写字段** | 读：`card`。写：`bypass, bypass_ts` |
| **测试覆盖** | 2 个文件：`e2e-carlos.mjs`、`p0-gates.mjs`（4 处调用） |

**审计事件**：`decision/bypass_denied`、`decision/bypass_on`、`decision/bypass_off`

**关键约束**
- 无卡时不允许开启（免检只能在已留痕的前提下使用）
- `on=true` 必须 `confirmed=true`，否则拒绝并记录审计
- 每次 dispatch 后自动清零，防止"忘记关免检"长期生效

---

### 3.3 第三层：追溯与查询（8 个）

#### `flow_stats`

| 维度 | 内容 |
|---|---|
| **状态门** | 无（只读）。清理/归档前的度量入口 |
| **问题层** | 存储问题的真痛点是「说不出占了多少、谁占的、删了会不会影响回溯」，于是清理只能靠猜。它把三件事量出来：各会话占用 Top N、备份去重率、审计按日增长 + 陈旧会话清单（含是否终态） |
| **读写字段** | 只读：扫 `RUNS_DIR/*`（按目录大小）、`backup/manifest.jsonl`（算去重率）、`AUDIT_DIR`（按日分片大小）、`trigger-state`。**不写任何文件** |
| **测试覆盖** | `test/hardening.mjs`（4a–4f 六条断言，含「只读」验证） |

**关键约束**
- 目录扫描有上限（会话 300、文件 20000），不会因为历史堆积而卡死；
- 只报度量与建议，**不执行任何删除**；真正的清理口径要靠人决定（哪些是终态、哪些还在跑）。


---

#### `flow_audit`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定 |
| **问题层** | 事后回答"到底派发了什么、改了什么、谁批的"。同时可验证审计链完整性（HMAC 模式可发现有意篡改） |
| **读写字段** | 读：`gate-audit/*.jsonl`。**不写 state** |
| **测试覆盖** | 2 个文件：`e2e-carlos.mjs`、`package-e2e.mjs`（4 处调用） |

**参数**：`sessionId`（不传则聚合全部）、`type`（run/finding/decision/resolution）、`limit`、`date`、`verifyChain`

**返回**：`total, by_type, by_kind, events, chain, mode`

> `mode` 如实标注审计链模式：设了 `CARLOS_FLOW_AUDIT_KEY`（≥16 字符）走 HMAC-SHA256，否则 plain。
> README/SECURITY 不笼统宣称"防篡改"，而是准确表述两种模式的保障强度。

---

#### `flow_protocol`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定 |
| **问题层** | Agent 查协议定义（档位表、四段合同、报告规格、错误分层、状态字段、审计事件类型、免检触发词、任务卡模板），避免"凭记忆猜" |
| **读写字段** | 无读写。返回 `PROTOCOL` 常量（其中 `STATE_FIELDS` 由 `defaultState()` 生成） |
| **测试覆盖** | 2 个文件：`e2e-carlos.mjs`、`p0-gates.mjs`（2 处调用）+ `protocol-consistency.mjs`（字段一致性） |

**关键约束**
- `STATE_FIELDS` 必须与 `defaultState()` 完全一致（测试逐字段比对）
- `ERROR_LAYERS` 必须包含"门禁拒绝"层，并注明"不要重试同一调用"

---

#### `flow_add_user_msg`

| 维度 | 内容 |
|---|---|
| **状态门** | 不写 state。写用户原话文件（quote 锚点的唯一数据源） |
| **问题层** | 为 `flow_submit_requirement` 的 quote 锚点校验提供数据源。通常由 `flow_trigger_check` 自动调用，不是独立入口 |
| **读写字段** | 无 state 读写。外部：用户原话文件 |
| **测试覆盖** | 9 个文件（**最广**）：`bridge-identity.mjs`、`concurrency-e2e.mjs`、`e2e-acceptance.mjs`、`e2e-carlos.mjs`、`p0-gates.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`trigger-e2e.mjs`、`verify-stale.test.mjs`（41 处调用） |

**数据源合并**：调用方传入的 `userMessages` + 自动从 OpenCode SQLite 读取的用户原话（`getUserMessages`）

**平台兼容**：`OPENCODE_DB_CANDIDATES` 按平台探测 —— Linux XDG 路径 / macOS `~/Library/Application Support/opencode/` / Windows `%APPDATA%\opencode\`。只探 XDG 路径会导致 macOS/Windows 用户永远拿不到用户原话，quote 校验直接失败。

---

#### `flow_save_result`

| 维度 | 内容 |
|---|---|
| **状态门** | 不写 state。写结果文件 + 审计事件 |
| **问题层** | 持久化子 Agent（executor/auditor）的执行结果，便于后续审计与还原 |
| **读写字段** | 无 state 读写。外部：`runs/<sid>/dispatch/*.result.json` |
| **测试覆盖** | 1 个文件：`e2e-carlos.mjs`（1 处调用，**极浅**） |

**审计事件**：`run/agent_result`

---

#### `flow_revert_plan`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定 |
| **问题层** | 改动出问题时的还原计划。**只返回计划，绝不自动执行** |
| **读写字段** | 读：`runs/<sid>/backup/manifest.jsonl`。不写 state |
| **测试覆盖** | 1 个文件：`e2e-carlos.mjs`（1 处调用，**极浅**） |

**返回**：`plan[{action, target, source}]`、`count`、`note`
- 新建文件（`created:true`）→ `delete`
- 原有文件 → `restore`（从 backup 恢复到 orig）

---

#### `flow_diff_hunks`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定 |
| **问题层** | 独立复核 executor 到底改了哪些**行**（不只是哪些文件）。审计争议时提供证据 |
| **读写字段** | 无 state 读写。执行 `git diff -U0` |
| **测试覆盖** | 1 个文件：`e2e-carlos.mjs`（1 处调用，**极浅**） |

**返回**：`files[{path, hunks[{oldStart, oldCount, newStart, newCount}]}]`、`raw_length`
- 非 git 目录 / git 失败时返回 `files:[]` + `error`（不算工具错误）

---

#### `flow_audit_guard`

| 维度 | 内容 |
|---|---|
| **状态门** | 只读。不参与门禁判定（`flow_verdict` 不受此调用影响，仍会再拦一道） |
| **问题层** | 主 Agent 落 PASS 前**提前自查**两轴是否齐。属于"便利入口"，不是必需门 |
| **读写字段** | 读：`audit_axes`、`card_ts`。不写 state |
| **测试覆盖** | 1 个文件：`e2e-carlos.mjs`（3 处调用，**浅**） |

> **冗余说明**：其 `axisOk` 逻辑与 `flow_verdict` 内部的「门禁 9/9（双轴审查）」完全一致（仅 28 行）。
> 保留它作为"提前自查"的便利入口，删除收益约等于零。

---

## 4. 读写矩阵总表

### 4.1 写 state 的工具（9 个）

| 工具 | saveState 次数 | 写入字段 |
|---|---|---|
| `flow_submit_requirement` | 1 | card, card_ts, tier, dispatch_count, claimed, claimed_role, write_files, last_user_ts, bypass, verdict, completed_ok, stale, activation_pending, activation_activated |
| `flow_claim` | 1 | claimed, claimed_role, last_user_ts |
| `flow_dispatch` | 2 | dispatch_count, claimed, write_files, bypass, bypass_ts, dispatch_baseline |
| `flow_audit_submit` | 1 | audit_axes[axis], audit_axes_ts |
| `flow_verdict` | 1 | verdict, completed_ok, verdict_ts, verdict_role |
| `flow_bypass` | 1 | bypass, bypass_ts |
| `flow_run_verify` | 1 | last_verify |
| `flow_falsify` | 1 | last_falsify, last_verify |
| `flow_trigger_check` | 1 | （内联 submit 逻辑）card, card_ts, tier, activation_pending, activation_activated |

### 4.2 只读工具（10 个，saveState 调用 0 次）

`flow_status` · `flow_check_scope` · `flow_audit_guard` · `flow_audit` · `flow_protocol` · `flow_diff_hunks` · `flow_revert_plan` · `flow_add_user_msg` · `flow_save_result` · `flow_audit_axes`

### 4.3 审计事件产出

| 工具 | 事件 |
|---|---|
| `flow_submit_requirement` | finding/card_finding, decision/blocked, decision/activation_gate_activated, decision/activation_gate_unlocked, decision/activation_gate_held, run/record, decision/accepted, run/activation, decision/activation_released |
| `flow_claim` | decision/claimed |
| `flow_dispatch` | decision/bypass_auto_reset, run/snapshot, run/dispatch_baseline, run/dispatch |
| `flow_audit_submit` | decision/audit_axis_submitted |
| `flow_verdict` | decision/verdict_denied, decision/scope_violation, finding/verdict_overwrite, resolution/verdict |
| `flow_bypass` | decision/bypass_denied, decision/bypass_on, decision/bypass_off |
| `flow_save_result` | run/agent_result |
| `flow_falsify` | run/falsify_denied, run/falsify |
| `flow_trigger_check` | run/activation |
| 其余 10 个 | 无 |

---

### 4.4 项目级敏感规则（`.carlos.json`，v2.14.0）

内置敏感名单（`.env` / 私钥 / 锁文件 / `migrations` 目录…）是**不可缩减的安全基线**。
项目可以在仓库根放一个 `.carlos.json` **追加**自己的敏感面：

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

| 维度 | 行为 |
|---|---|
| 生效范围 | 从工具调用的 `cwd`（缺省为 `process.cwd()`）逐级向上最多 12 层查找 |
| 匹配方式 | `names` 命中文件名；`segments` 命中目录段；`extensions` 命中文件名后缀（不带点也认）；`prefixes` 命中路径前缀 |
| 只增不减 | **没有**删减 / 豁免语法；以 `!` 或 `-` 开头的条目一律忽略并写 stderr |
| 配置损坏 | JSON 解析失败 → 退回内置基线并写 stderr（不抛错、不放宽） |
| 缓存 | 按「文件路径 + mtime + size」缓存，避免每次工具调用重读 |
| 换项目 | 找不到配置时清空扩展，避免上一个项目的规则污染 |
| 测试 | `test/sensitive-config.mjs`（25 条断言：基线 / 追加 / 否定式 / 坏配置 / 切项目 / riskTier） |

> 为什么只许追加：AGENTS.md 第 1 条红线是「门禁只许收紧，不许放宽」。
> 一旦允许 `"!package.json"` 这类否定式，任何一次误配置都会静默把基线放出去。

### 4.5 状态锁（`withStateLock`，v2.14.0 加固）

| 维度 | 行为 |
|---|---|
| 排他性 | `openSync(lockFile, "wx")`（O_CREAT\|O_EXCL）—— 原子排他，M12 变异体守着这条 |
| 持有者标识 | 同一 wx fd 写入 PID＋随机 nonce 后关闭；完整内容用于身份核验，兼容旧纯 PID 的死亡判定 |
| 陈旧回收 | 仅严格有效 PID 且 ESRCH 才回收；活 PID、EPERM、空锁、坏锁和未知持有者即使超龄也不抢占。staleMs 不再授予年龄回收权 |
| 转换互斥 | 独立异步 bakery gate 覆盖创建、死 PID 回收、身份核验、rename 核验/重试与释放；不跨业务 fn。死槽仅忽略不删除，未知槽拒绝。RUNS_DIR 与 session 目录先 realpath，实际 IO 保留其大小写；仅 Windows gate key 小写归一。session 必须是物理 RUNS_DIR 的直接子目录，relative 与父目录 dev/ino 双重校验，在转换前拒绝逃逸的 session junction/符号链接及非直接子目录；不支持两个不同 RUNS 根通过外部 session 链接共享锁的布局 |
| 释放 | 完整 owner 身份相符才 rename 到唯一 retired 路径；只清理自身 retired。错误有 phase，业务首因与释放/槽清理错误用 AggregateError 同时保留 |
| 重试 | gate 与业务锁等待均异步且有界；释放使用独立预算。非竞争 IO 错误传播，不无限 continue |
| 超时 | fail-closed：`timeoutMs`（默认 5s）内拿不到锁就报错，**绝不无锁写状态**，错误里点明持有者 pid |
| 测试 | `test/state-lock.mjs`（11 条断言）、`test/concurrency-e2e.mjs`（跨进程回归） |

### 4.6 状态保存确认与部署边界

`saveState` 使用同目录唯一 wx temp，顺序为完整 write → 文件 fsync → close → rename → 支持平台的目录同步。POSIX 同步祖先目录链以覆盖新建目录项；Windows Node 不执行不受支持的目录 fsync，因此只确认文件同步及原子替换，不承诺掉电目录项耐久或硬件 exactly-once。

创建成功但 owner 写入/close 失败时，在原 gate 内用 fstat 与当前文件的 dev/ino/birthtime 身份核对后私有 retire 补偿；不能证明身份则保留 fail-closed 并显式报未确认。取得 owner 后、业务回调前若自身槽清理失败，只有仍能证明持有原 gate 才补偿 owner，保留槽清理错误；永久 IO 可能留下阻断槽，不能声称完全恢复或越过它执行。目录 fsync 与 close 同时失败按发生顺序聚合，不以 close 覆盖同步首因。

错误提供 `phase` 与 `commitStatus`：rename 前失败为 not-committed，rename 本身异常或其后失败为 unknown；这只是本次保存的提交观测，不是业务重放许可。失败不回滚或删除 target；close/temp 清理错误也显式聚合，不能假称已存或没存。本阶段不实现 receipt 或命令执行去重。

新旧 writer 混跑不受新 gate 全面保护：旧实现仍可能按年龄删除活 owner，或无身份 unlink。未来严格执行能力部署前须使共享 CARLOS_FLOW_HOME 的 writer 全部采用新协议；本补丁不扫描、停止或清理用户进程/业务状态，也不声称 Node 是 OS 沙箱。未知旧空锁须人工核验，不再自动抢占；`test/state-lock.mjs` 旧 4a/4b 因此是安全契约修订，其余旧断言保留。

### 4.7 归档与状态 writer 协调（P2 候选）

`applyPrune` 是异步 API，返回 Promise；CLI 实执行及自动调度都必须 `await` 后消费结果，自动调度在自身异步回调内 await/catch，不把“已调度”当“已归档”。默认 dry-run 不移动会话；实执行报告 `archived`、`archiveFailed`、`archiveErrors`，不能仅凭计划宣称已完成。

计划与执行均排除 `audit_pending` 和 `audit_history_pending` 欠账；旧式/未知标记、坏 JSON、非对象状态及未知终态均保守保留。计划保存精确目录身份、state 文件身份/时间和完整原始 state SHA256。执行取得原状态业务锁后重验，并在 owner 正常退出后的同一 `stateTransition` gate 内再次核对完整身份、实际时间阈值、状态与欠账；不允许旧计划搬走同名新 B，即使其仍是终态且 mtime 被恢复。归档定位不为缺失源重建 session。

`archiveStateSession` 复用原 `withStateLock`/转换 gate，不另造一把互不协调的锁：确认 retire 自身 owner 完成后，仍持原 gate 时同步重验并紧接 `rename`，不带 `.state.lock` 搬目录。普通 writer 在等待后取得 wx 前、业务回调前及退出时核 canonical 路径与目录 dev/ino/birthtime；若原目录已归档或被同名替换，排队 writer 以 `session-identity` 失败关闭，不写替换目录。活 owner 未正常退出或释放失败时不得移动。

归档目标必须在物理 FLOW_HOME/RUNS 之外，使用随机独占批次名，目标已存在则拒绝覆盖。明确 `EXDEV` 直接失败保留源，不降级为 cp+rm；不盲重试 rename。rename 报未知 after-effect，或 rename 已发生后 gate 清理失败，会报告归档未确认：源可能已在归档位置，**不保证失败时源仍在原路径**，也不回滚删除数据。必须核查在线与归档两处，未知结果不能盲目重放；这不是硬件掉电 exactly-once 承诺。

保证针对已持久化状态及遵守本协议的 writer；未持久化的迟到审计补偿、任意外部编辑/目录替换、人工回滚及旧 writer 混跑不在保证内。归档不是事务 outbox，也未为备份、长命令和审计介质引入全局事务。两类已保存欠账不能归档，但不能据此声称尚未保存的未来补偿绝不会迟到。

---

## 5. 维护检查清单

### 5.1 新增一个工具

- [ ] 在 `src/index.js` 的 `TOOLS` 数组末尾追加（**不要插中间**，避免影响行号引用）
- [ ] `inputSchema` 里 `required` 字段要写全 —— `validateToolArgs` 会校验 required / 类型 / enum / 数组元素类型
- [ ] 若写 state，必须走 `withStateLock`（读-改-写临界区），否则并发丢更新
- [ ] 若写 state，考虑是否需要 bump `schemaVersion` 并加 `migrate()` 分支
- [ ] 若改 `defaultState()` 字段，`protocol.js` 的 `STATE_FIELDS` 会自动跟随（无需手改），但 `test/protocol-consistency.mjs` 必须过
- [ ] 同步 `ghost.json` 的工具声明
- [ ] 同步 `client/carlos.js` 的 CLI 工具列表
- [ ] 在本文档第 3 节加一张契约卡
- [ ] 加测试：至少 1 个正向 + 1 个反向（拒绝路径）

### 5.2 修改一个工具的 state 字段

- [ ] 检查 `migrate()` 是否需要新分支
- [ ] 检查 `test/protocol-consistency.mjs` 是否红
- [ ] 检查 `flow_status` 是否需要回显新字段
- [ ] 检查 `flow_verdict` 的门禁是否需要读新字段

### 5.3 修改门禁逻辑

- [ ] **不要调换 `flow_verdict` 的判断顺序**（错误信息的可操作性依赖顺序）
- [ ] 新增门禁时，确认它是 fail-closed 还是 fail-open，并在文档里写明
- [ ] 跑 `npm run test:all`（含 concurrency / acceptance / p0 / scope / audit / stale）

### 5.4 提交前必跑

```bash
npm run check:lang          # 产物语言体检（提交信息/注释必须中文）
npm run check:claims        # 行为兑现门禁
npm run check:params        # 参数真实被读 + 无死变量
npm run check:no-dead-handler  # 重复 handler / 分发与校验未丢
npm run check:anchors       # 变异锚点未失效（20/20）
npm run test:all            # 全量测试（含 sensitive / lock / falsify）
```

---

## 6. 已知局限（如实记录）

| 局限 | 影响 | 缓解 |
|---|---|---|
| `flow_falsify` 快照只覆盖 `card.scope` 内文件 | scope 外依赖被改时，"改动前"状态只是近似 | 文档如实标注，结论仅供参考 |
| 越界判定已包含未跟踪文件 | `git diff --name-only` 只含已跟踪文件；越界判定另外跑 `git ls-files --others --exclude-standard`，自动模式能看见新建的未跟踪文件 | 尊重 `.gitignore`；仓库内若放了 `CARLOS_FLOW_HOME`，其状态文件不计入改动 |
| 审计流水 99.8% 是测试生成 | 无法用使用频率证明工具价值 | 靠代码路径 + 设计意图 + 测试覆盖三重证据判断 |
| 非 git 目录时 fingerprint 不可用 | 仅 Git 明确确认 `not_a_git_repo` 时 A1 门 fail-open（算 pass） | `flow_status` 如实标注 `fingerprint: "unavailable"` |
| `flow_audit_guard` 与 `flow_verdict` 逻辑重复 | 28 行冗余 | 保留为便利入口，删除收益≈0 |
| `write_files` / `task_id` 未被判定使用 | 预留字段 | 记录在此，避免误以为它们参与门禁 |

---

## 7. 相关文档

| 文档 | 内容 |
|---|---|
| `README.md` / `README.en.md` / `README.zh.md` | 用户视角的接入说明 |
| `TRIGGER_GUIDE.md` | 智能触发引擎的评分与配置 |
| `INSTALL.md` | 六平台接入步骤（Cindy / OpenCode / Cursor / Cline / VS Code / Claude） |
| `docs/AUDIT_REVIEW.md` | v2.6.3 第三方审查报告的逐条核实 |
| `docs/RETROSPECTIVE-2026-11-13.md` | 多副本治理与发布门禁的复盘 |
| `AGENTS.md` | Agent 侧的工作流约束与红线 |