# Carlos Flow 工具契约文档

> 适用版本：v2.11.3
> 生成时间：2026-11-14
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
│ 第三层：追溯与查询（只读，低频，独立价值）                 │  7 个
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
         └─ 9 组判断 / 15 个 return 点（顺序固定，不可调换）：
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
```

> **门禁顺序是有意的**：先证实验证有效（4/5）→ 再证改动合规（6/7）→ 再证测试有判别力（8）→ 再证审查到位（9）。
> 若调换顺序，「未验证」这类更基础的问题会被「双轴未齐」的错误信息掩盖，调用方拿到不可操作的下一步。
>
> **代码注释编号有瑕疵（如实记录）**：`src/index.js` 里这些判断的注释编号是
> 「之二 / 之三 / 之五 / 之四 / 之四 / 之五 / 之六」——其中**「之四」「之五」各出现两次**，
> 且缺「之一」。这是注释本身的历史遗留错乱，**不影响执行顺序**（执行顺序由代码行序决定）。
> 维护时以本表的 9 组分组为准，不要沿用注释编号。

---

## 2. 状态字段字典

`state.json` 共 26 个字段，`schemaVersion` 当前为 **4**。

| 字段 | 类型 | 写入者 | 读取者 | 作用 |
|---|---|---|---|---|
| `schemaVersion` | number | migrate() | loadState | 迁移版本号，旧状态按版本逐步升级 |
| `card` | object\|null | submit_requirement, trigger_check | 几乎所有工具 | 任务卡（goal/quote/scope/acceptance/verify…） |
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
| `last_falsify` | object\|null | falsify | verdict | 负对照结果{verdict, before, after} |
| `audit_axes` | object | audit_submit | verdict, status, audit_guard | 两轴结论{standards, spec} |
| `audit_axes_ts` | number | audit_submit | status | 两轴最后提交时间（审计留痕） |
| `verdict_role` | string\|null | verdict | status | 实际落裁定者角色 |
| `last_verify` | object\|null | run_verify, falsify | verdict, status | 验证结果{ok, cmd, exitCode, output_hash, fingerprint} |
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
  （MCP server 是常驻进程，它的 cwd 是启动时的目录，可能是几个月前的旧仓库）
- `verify.cmd` 为空时直接拒绝（没有可核验依据）

---

#### `flow_falsify`

| 维度 | 内容 |
|---|---|
| **状态门** | 负对照门。PASS 前必须做，且必须 `meaningful` |
| **问题层** | **证明 verify.cmd 真的在测本次改动**。`verify.cmd` 可以是 `echo ok` / `cmd \|\| true` 这类空测试 —— 改动前后都退 0，门禁却以为验证通过。负对照要求：改动前跑必须**失败**，改动后跑必须**通过** |
| **读写字段** | 读：`card`、`card.env.project`。写：`last_falsify{ts, cmd, cwd, verdict, reason, before{exitCode,ok,hash}, after{...}}` + `last_verify`（= 改动后那次运行，让裁定证据绑定到这次运行） |
| **测试覆盖** | 4 个文件：`e2e-carlos.mjs`、`package-e2e.mjs`、`scope-enforcement.mjs`、`verify-stale.test.mjs`（7 处调用） |

**审计事件**：`run/falsify_denied`、`run/falsify`

**判定口径**

| verdict | 含义 | 能否 PASS |
|---|---|---|
| `meaningful` | 改动前失败 + 改动后通过 | ✅ 可以 |
| `vacuous` | 改动前就通过（空测试） | ❌ 拒绝 |
| `not_passing` | 改动后仍失败（改动本身有问题） | ❌ 拒绝 |
| `inconclusive` | 其他 | ❌ 拒绝 |

**关键约束**
- 需要派发快照（`manifest.jsonl`），没派发过直接拒绝
- 先把"改动后"状态备份到临时目录，`finally` 里一定还原 —— 即使 verify 命令本身改文件，也不会把工作区留在改动前状态
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

**9 组判断 / 15 个 return 点（顺序固定，不可调换）**

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
| 5 | 仅 PASS | 验证结果未过期 | fingerprint 变化（A1 门） |
| 6 | 仅 PASS | 无越界改动 | `当前 diff - dispatch_baseline ⊄ scope` |
| 7 | 仅 PASS | role 是 auditor | `claimed_role !== "auditor"` |
| 8a | 仅 PASS | 负对照已做 | 无 `last_falsify` |
| 8b | 仅 PASS | 负对照通过 | `verdict !== "meaningful"` |
| 8c | 仅 PASS | 负对照证据一致 | `last_verify.output_hash !== last_falsify.after.hash` |
| 9a | 仅 PASS | 双轴已齐 | 两轴 `card_ts` 与当前卡不一致 |
| 9b | 仅 PASS | 双轴无 FAIL | `standards` 或 `spec` 判 FAIL |

> **编号说明**：`4a~4d`、`8a~8c`、`9a~9b` 在代码里是独立的 `return fail` 点（共 15 个），
> 本表按语义归为 9 组。统计数据时请以 15 个判断点为准。

**WARN 汇总**：两轴判 WARN 的结论会随裁定一起返回（`warn_count` / `warn_findings`），上限 20 条，防止 WARN 通胀成噪音。

**关键约束**
- 第 1~2 组**无条件**；第 3 组起**仅 PASS**。`DIRECTION` / `LOCAL` 是"有问题"的裁定，不构成"完成"，允许在未派发时先记录返工意见
- 越界判定用**增量**：`当前 diff - 派发基线`，避免误伤用户自己原有的未提交改动

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
| `verify_state` | 四态：`not_run` / `fail` / `stale` / `pass` |
| `axes_ready` | 两轴都有结论 + `card_ts` 一致 + 无 FAIL |
| `warn_count` / `warn_findings` | 与 `flow_verdict` 同一份派生口径 |
| `unreviewed` | 有卡但无裁定 |

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
- 不传 `paths` → 自动跑 `git diff --name-only` 取当前实际改动
- 空 `scope` → **fail-closed**（所有改动都算越界），不是 fail-open

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

### 3.3 第三层：追溯与查询（7 个）

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

> **冗余说明**：其 `axisOk` 逻辑与 `flow_verdict` 内部"防假闭环之六"完全一致（仅 28 行）。
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
npm run test:all            # 全量测试
```

---

## 6. 已知局限（如实记录）

| 局限 | 影响 | 缓解 |
|---|---|---|
| `flow_falsify` 快照只覆盖 `card.scope` 内文件 | scope 外依赖被改时，"改动前"状态只是近似 | 文档如实标注，结论仅供参考 |
| 审计流水 99.8% 是测试生成 | 无法用使用频率证明工具价值 | 靠代码路径 + 设计意图 + 测试覆盖三重证据判断 |
| 非 git 目录时 fingerprint 不可用 | A1 门 fail-open（算 pass） | `flow_status` 如实标注 `fingerprint: "unavailable"` |
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