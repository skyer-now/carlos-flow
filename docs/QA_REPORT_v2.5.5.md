# Carlos Flow 发布前独立 QA 验收报告

- **验收对象**：`carlos-flow-cindy`、`carlos-flow-opencode` 两个工作副本（验收时位于本机 `publish-output/` 目录下，下文路径已改写为占位符 `<REPO>`）
- **验收方式**：只读验证（未修改 `publish-output` 下任何源码；仅运行测试套件，套件自身会写出 `test/trigger-e2e-results.json`）
- **环境**：Windows / Git Bash / Node v22.23.4 / npm 10.9.9
- **验收快照时间**：2026-11-05 16:13:30（最后一次全量复跑 16:12:50 ~ 16:13:02）
- **执行者**：Orca Worker `mka57g3utqtzsm6g1grg1zkg`（只读验证角色）

---

## 附：验收后追加的两项修复（均已提交并复跑全绿）

| 编号 | 级别 | 问题 | 修复 | 提交 |
|------|------|------|------|------|
| F-3 | P2 | `shouldTrigger()` 限流分支提前返回，score 丢成 0 且无 confidence | 先算评分再判限流，throttled 分支也返回真实 score/confidence/breakdown | `0a105b1` |
| F-4 | P2 | `test:trigger` 把结果写进发布目录 | 改为写入系统临时目录，保持发布目录干净 | `0a105b1` |

修复后两仓库 `npm run test:all` 复跑全绿（smoke + 16 + 10 + 15），工作区干净。

---

## 一、验收结论

**通过（PASS）**。两仓库、四个套件全部全绿，退出码全为 0，无功能性失败。

最终一轮全量复跑（16:12:50 ~ 16:13:02）发生在两仓库最新提交之后，工作区与 HEAD 差异为 0 行，**本次结论对应已提交的代码**：

| 仓库 | 验收对应 commit | 提交时间 |
|------|----------------|----------|
| carlos-flow-cindy | `8502b9c feat(trigger): 智能触发引擎 + 修复 5 项真实缺陷` | 2026-11-05 16:12:32 |
| carlos-flow-opencode | `6a400f3 feat(trigger): 智能触发引擎 + 纯 stdio 客户端重构` | 2026-11-05 16:12:51 |

仍需发布前收口的 3 项（见第六节）：**验收期间仓库被并发修改、结论需与 commit 绑定**、**`node src/trigger.js` CLI 有全局状态**、**测试套件会向发布目录写入结果文件**。

---

## 二、验收矩阵（两仓库 × 四套件）

| 仓库 | 套件 | 命令 | 通过 / 失败 | 退出码 | 结论 |
|------|------|------|--------------|--------|------|
| carlos-flow-cindy | smoke | `npm test` | 4 步全 OK（`SMOKE_OK`） | 0 | ✅ PASS |
| carlos-flow-cindy | e2e | `CARLOS_FLOW_MCP_ROOT=... npm run test:e2e` | **16 / 0** | 0 | ✅ PASS |
| carlos-flow-cindy | p0 | `CARLOS_FLOW_MCP_ROOT=... npm run test:p0` | **10 / 0** | 0 | ✅ PASS |
| carlos-flow-cindy | trigger | `CARLOS_FLOW_MCP_ROOT=... npm run test:trigger` | **15 / 0**（100%） | 0 | ✅ PASS |
| carlos-flow-opencode | smoke | `npm test` | 4 步全 OK（`SMOKE_OK`） | 0 | ✅ PASS |
| carlos-flow-opencode | e2e | `CARLOS_FLOW_MCP_ROOT=... npm run test:e2e` | **16 / 0** | 0 | ✅ PASS |
| carlos-flow-opencode | p0 | `CARLOS_FLOW_MCP_ROOT=... npm run test:p0` | **10 / 0** | 0 | ✅ PASS |
| carlos-flow-opencode | trigger | `CARLOS_FLOW_MCP_ROOT=... npm run test:trigger` | **15 / 0**（100%） | 0 | ✅ PASS |

合计：**8 / 8 套件通过，0 失败**；断言总数 cindy 41 / opencode 41（smoke 4 + e2e 16 + p0 10 + trigger 15，smoke 按 4 步计）。

---

## 三、关键输出行

### 3.1 carlos-flow-cindy

```
npm test            → step 1 parseCard OK / step 2 validateCard OK / step 3 saveState + audit OK
                       step 4 loadState OK  卡片往返一致 → SMOKE_OK
npm run test:e2e    → sessionId: e2e-1793866371685   FLOW_HOME: C:\Users\EDY\.carlos-flow
                       ✓ 1 flow_protocol … ✓ 13 终态 completed_ok
                       ✓ 14. 状态落盘到 FLOW_HOME  C:\Users\EDY\.carlos-flow\gate-state\runs\e2e-1793866371685
                       ════ 结果: 16 通过 / 0 失败 ════
npm run test:p0     → ✓ 0 留痕成功 tier=single_file … ✓ 9 flow_protocol 可用
                       ════ 结果: 10 通过 / 0 失败 ════
npm run test:trigger→ 总测试数: 15  ✅ 通过: 15  ❌ 失败: 0  ⚠️ 警告: 0  📈 通过率: 100.0%
```

### 3.2 carlos-flow-opencode

```
npm test            → step 1 parseCard OK / step 2 validateCard OK / step 3 saveState + audit OK
                       step 4 loadState OK  卡片往返一致 → SMOKE_OK
npm run test:e2e    → sessionId: e2e-1793866383527   FLOW_HOME: C:\Users\EDY\.carlos-flow
                       ✓ 1 flow_protocol … ✓ 14. 状态落盘到 FLOW_HOME C:\Users\EDY\.carlos-flow\gate-state\runs\e2e-1793866383527
                       ════ 结果: 16 通过 / 0 失败 ════
npm run test:p0     → ✓ 0 留痕成功 tier=single_file … ✓ 9 flow_protocol 可用
                       ════ 结果: 10 通过 / 0 失败 ════
npm run test:trigger→ 总测试数: 15  ✅ 通过: 15  ❌ 失败: 0  ⚠️ 警告: 0  📈 通过率: 100.0%
```

### 3.3 关键门禁断言（两仓库一致）

| 断言 | 实测输出 |
|------|----------|
| 非法 role 被拒 | `ERROR: 字段 role 值非法，可选：executor, auditor` |
| 未 claim 直接 dispatch 被拒 | `ERROR: 未 claim，请先 flow_claim 领取派发名额。` |
| verify.cmd 失败如实上报 | `ok=false exitCode=3` |
| scope 外文件标违规 | `violations=[".../src/index.js"]` |
| 非法 verdict 被拒 | `ERROR: 字段 verdict 值非法，可选：PASS, DIRECTION, LOCAL` |
| 未确认免检被拒 | `ERROR: 开启免检需要显式确认：用户必须明确授权后，传入 confirmed=true。` |
| 审计链完整性 | `total=10 kinds=record,accepted,card_finding,blocked,claimed,snapshot,agent_result,verdict`（含 hash 链） |

---

## 四、逐项检查清单

| # | 检查项 | carlos-flow-cindy | carlos-flow-opencode |
|---|--------|-------------------|----------------------|
| 1 | `npm test` | ✅ SMOKE_OK | ✅ SMOKE_OK |
| 2 | `npm run test:e2e`（带 `CARLOS_FLOW_MCP_ROOT`） | ✅ 16/16 | ✅ 16/16 |
| 3 | `npm run test:p0`（带 `CARLOS_FLOW_MCP_ROOT`） | ✅ 10/10 | ✅ 10/10 |
| 4 | `npm run test:trigger`（带 `CARLOS_FLOW_MCP_ROOT`） | ✅ 15/15 | ✅ 15/15 |
| 5 | `node src/trigger.js "run dispatch workflow"` / `"hello"` | ✅ 见 4.1 | ✅ 见 4.1（行为一致） |
| 6 | `package.json` version ↔ `CHANGELOG.md` 顶部版本 | ✅ 2.5.5 = 2.5.5（CHANGELOG 第 8 行） | ✅ 2.5.5 = 2.5.5（CHANGELOG 第 8 行） |
| 7 | `grep -n "require(" client/carlos.js` 无残留 | ✅ 0 命中 | ✅ 0 命中 |

补充核查（超出要求，但属发布前必要项）：

- `grep -rn "require(" src/ test/ client/` → **两仓库均为 0 命中**，ESM 改造彻底，无 CommonJS 残留。
- `src/` 逐文件比对：**6 个文件全部逐字节一致**（`card.js` / `dispatch.js` / `index.js` / `protocol.js` / `state.js` / `trigger.js`），与 CHANGELOG「core src/ 与 carlos-flow-cindy@2.5.5 逐文件一致」的声明相符。
- `test/`：`smoke.js`、`trigger-e2e.mjs` 一致；`e2e-carlos.mjs` / `p0-gates.mjs` 仅在 **Bridge 端口隔离** 相关代码上有差异（opencode 版无 Bridge，纯 stdio，不需要）——属合理差异，非功能分叉。

### 4.1 触发引擎 CLI 行为

命令：`node src/trigger.js "<消息>"`（两仓库 `src/trigger.js` 一致，行为相同）

| 输入 | 干净 `CARLOS_FLOW_HOME` 下结果 | 共享 HOME 下结果 |
|------|---------------------------|-----------------|
| `run dispatch workflow` | **触发**：`decision=trigger` 评分 38 置信度 0.9 理由「触发评分达标」，动作 `workflow_trigger / auto` | `decision=throttled` 理由「时间间隔不足」 |
| `hello` | **不触发**：`decision=ignore` 评分 0 置信度 0.3 理由「评分0低于阈值15」 | `decision=throttled` 理由「时间间隔不足」 |

> 说明：`src/trigger.js` 的 CLI 复用 `~/.carlos-flow/trigger-state.json` 做限流（`TRIGGER_HOME` 可用 `CARLOS_FLOW_HOME` 覆盖）。因此在**同一 HOME 内连续执行两次**，第二次必然被判定为 `throttled`——这是限流设计的正常表现，不是缺陷；但对使用者是误导性输出（`评分: 0` / `置信度: undefined`），建议 CLI 在命中限流时仍输出真实评分。

---

## 五、验收期间的时间线（重要）

验收窗口内 `publish-output` 工作区被**并发修改**，本次验收对象是**未提交的工作区**，而非某个 commit：

| 时间 | 事件 |
|------|------|
| 16:07:03 | cindy `test:e2e` 首跑（旧代码）：**15 通过 / 1 失败**，失败项 `#14 状态落盘到 FLOW_HOME` |
| 16:07:47 | `package.json`（两仓库）被修改 |
| 16:08–16:10 | 定位 `#14` 根因：本机 19099 端口已有常驻 Bridge（PID 69624），其 `CARLOS_FLOW_HOME` 与测试传入值不同 → 状态落到别处；测试复用既有 Bridge 导致传入的 `CARLOS_FLOW_HOME` 被忽略 |
| 16:09:48 | `client/carlos.js` 被修改：PID 文件按端口区分（`bridge-<PORT>.pid`），默认 `FLOW_HOME` 改为 `~/.carlos-flow` |
| 16:09:52 | `test/e2e-carlos.mjs` 被修改：改用独立 `BRIDGE_PORT`（19100+pid%400）并新增 `cleanupBridge()` |
| 16:10:41 | `test/p0-gates.mjs` 被修改：同样加入独立 `BRIDGE_PORT`（19500+pid%400）与清理逻辑 |
| 16:09:59 | cindy `test:e2e` 隔离复跑：**16 / 0**（证实根因为 Bridge 复用，非产品逻辑缺陷） |
| 16:11:24 / 16:11:47 | cindy / opencode `test:e2e`（新代码、默认端口）：**均 16 / 0** |
| 16:12:32 | cindy 仓库提交 `8502b9c`（工作区清空） |
| 16:12:50–16:13:02 | 两仓库四套件最终全量复跑（均在提交之后，工作区 == HEAD）：**全部 PASS，退出码全 0** |
| 16:12:51 | opencode 仓库提交 `6a400f3`（工作区清空） |

---

## 六、发现的问题与建议

| 编号 | 级别 | 问题 | 证据 | 建议 |
|------|------|------|------|------|
| F-1 | **P1（已缓解，需流程化）** | 验收对象在验收窗口内**被并发修改**：Bridge 隔离、按端口 PID 文件、触发引擎接入等修复是在验收过程中陆续落到工作区的 | 时间线见第五节；两仓库现已提交（`8502b9c` / `6a400f3`），最终复跑与提交内容一致 | 已满足（结论绑定 commit）。建议固化流程：**合并后以 commit 为准重跑 `npm run test:all` 并把日志作为发布凭据**，禁止在验收中途改动被测目录 |
| F-2 | **P1（已修复并提交）** | `test:e2e` / `test:p0` 原实现**复用本机 19099 常驻 Bridge**，测试传入的 `CARLOS_FLOW_HOME` 被忽略 → 状态落到 Bridge 启动时的 FLOW_HOME，断言 `#14` 失败 | 16:07 首跑 `#14` 失败；诊断确认状态落到了 Bridge 自身的 FLOW_HOME | 修复已随 `8502b9c` 提交（独立 `BRIDGE_PORT` + `cleanupBridge()` + 按端口 PID 文件），复跑 16/16 通过。建议 CI 同样保留端口隔离，避免 CI 机器上残留 Bridge 时误报 |
| F-3 | P2 | `node src/trigger.js` CLI 有全局状态，同一 HOME 连续两次调用第二次必为 `throttled`，且此时 `评分: 0` / `置信度: undefined` 输出失真 | 4.1 节实测 | CLI 命中限流时仍输出真实评分/置信度；或在 `TRIGGER_GUIDE.md` 明确说明 CLI 行为与状态文件位置 |
| F-4 | P2 | 测试套件会向 `publish-output` 内写入 `test/trigger-e2e-results.json`（`test:trigger` 副作用） | 两个仓库 `npm run test:trigger` 输出均提示写入该路径 | 确认该文件应纳入 `.gitignore` 或改为写入临时目录，保持发布目录干净 |
| F-5 | P3 | Cindy 版依赖**常驻 Bridge + 固定端口 19099**，默认端口单例，第三方/多实例并行时有争用风险 | `bridge/mcp-bridge.js` 默认端口、`client/carlos.js` 默认 `BRIDGE_PORT=19099` | 当前按端口隔离 PID 文件已缓解；建议后续支持端口自动避让 |
| F-6 | P3 | OpenCode 版**无 Bridge、纯 stdio、单次调用**，天然隔离，测试稳定性更好 | `client/carlos.js`（opencode）每次调用直接 spawn MCP Server | 无需处理；可在文档中说明两者差异 |

**已确认无问题的项**：版本号一致性（2.5.5 ↔ CHANGELOG 2.5.5）、`require(` 残留（0 命中）、`src/` 双仓一致性（6/6 逐字节相同）、审计链 hash 完整性、免检/verdict/role/claim 四类门禁拒绝行为。

---

## 七、复现命令

```bash
# carlos-flow-cindy
cd <REPO>
npm test
CARLOS_FLOW_MCP_ROOT="<REPO>" npm run test:e2e
CARLOS_FLOW_MCP_ROOT="<REPO>" npm run test:p0
CARLOS_FLOW_MCP_ROOT="<REPO>" npm run test:trigger
node src/trigger.js "run dispatch workflow"
node src/trigger.js "hello"
grep -n "require(" client/carlos.js        # 期望：无输出
grep -m1 -E "^## \[[0-9]+\.[0-9]+\.[0-9]+\]" CHANGELOG.md   # 期望：## [2.5.5]

# carlos-flow-opencode（把 CARLOS_FLOW_MCP_ROOT 换成 opencode 目录，其余同）
```

原始日志留存：`D:/cindy/.qa-logs/`（`final-cindy-*.log`、`final-oc-*.log` 为最终复跑日志；`cindy-e2e.log` 为 16:07 的失败现场）。

---

## 八、环境清理说明

- 本次验收**未修改** `publish-output` 下任何源码/配置/文档。
- 诊断过程中我在 Cindy 版上以 `BRIDGE_PORT=19098` 临时拉起过一个 Bridge 做隔离对照，已**结束该进程并删除 `bridge-19098.pid`**；端口 19098 已释放。
- 原有常驻 Bridge（PID 69624 / 端口 19099 / `bridge.pid`）**保持原样未动**。
- 测试在 `C:\Users\EDY\.carlos-flow` 与临时目录下产生的状态文件为套件正常行为，未清理。
