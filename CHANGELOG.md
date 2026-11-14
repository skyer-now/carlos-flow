## 2.12.1
- 落地向导模式动态组队功能
- 架构补齐：协议注入 ux_meta 与增强拦截机制

## [2.12.0] - 2026-11-14 — 发布暂停开关 + 19 个工具的契约文档

### ✨ 新增 | Added

- **发布暂停开关**（`scripts/publish-gate.mjs` + `release.yml`）：
  `RELEASE_PAUSED=1` 时发布闸直接返回 `publish=false`，不再走版本比较逻辑；
  设为 `0` 恢复正常发布。工作区默认暂停（`RELEASE_PAUSED: '1'`），
  需要发版时再开启。背景：推 `v*` tag 等于触发 npm 自动发布，
  此前出现过修复尚未完成就把版本推上去的情况。
- **工具契约文档**（`docs/TOOL_CONTRACTS.md`）：把 19 个工具的状态门、问题层、
  读写字段、测试覆盖固化成一份可核对的文档，供后续维护与新人上手。
  含 26 个状态字段的读写者清单、v0→v4 迁移链、`flow_verdict` 的
  9 组判断（15 个 return 点，2 个无条件 + 13 个仅 PASS）。
- **测试覆盖统计脚本**（`test/count-tool-refs.mjs`、`test/count-tool-calls.mjs`）：
  统计每个工具在测试里的真实调用文件数与调用次数，文档里的数字可一键复现。
  调用口径含四种形式：进程内 `call()`、JSON-RPC `name:`、CLI `spawnSync`、
  激活计划 `s.tool ===` 断言。

### 🐛 修复 | Fixed

- **并发套件误判普通卡后写为泄漏**：`test/concurrency-e2e.mjs` 的零泄漏判定
  只看 `pending.length === 0 && 卡片字段空`，但用例故意让两个进程提交
  **不同类型**的卡（占位卡 vs 普通卡）。当两个进程都读到空 prev 时，
  普通卡后写落盘的 `activation_activated=false + pending=[]` 是**正确行为**
  （普通卡不上闸门），被误判为泄漏（实测 457 轮里偶发 1 次）。
  现在 `stillLeak` 增加 `activation_activated === true` 条件：
  只有「最终状态是占位卡却 `pending=[]`」才算真泄漏。
  真缺陷（占位卡被错误清空）仍是 `activation_activated=true + pending=[]`，照样能拓住。

### 📚 文档 | Docs

- 新增 `docs/TOOL_CONTRACTS.md`（640 行），含：
  - 三层分类（状态门 9 个 / 工作流辅助 3 个 / 追溯查询 7 个）
  - 19 张契约卡，每张固定四维
  - 26 个状态字段的写入者 / 读取者 / 作用
  - `flow_verdict` 的 9 组判断与顺序为何不可调换
  - 读写矩阵总表、维护检查清单、已知局限
- 如实记录代码注释瑕疵：`src/index.js` 里门禁注释编号「之四」「之五」
  各出现两次且缺「之一」，不影响执行顺序但会误导维护者

## [2.11.3] - 2026-11-13 — 多副本治理收敛 + 推 tag 前置门禁 + A1 验证绑代码状态

### 🐛 修复 | Fixed

- **A1：验证结果绑定代码状态（指纹 + 四态）** —— 研究产物《A1-A2-A3 实施前核验清单》确认的绕过路径：
  `flow_run_verify` 跑通 → executor 继续改代码（甚至改坏）→ `flow_verdict(PASS)` 三道判断全过 → **直接放行**。
  现在 `last_verify` 记录工作区指纹（HEAD + `git diff HEAD` + 全部未跟踪文件），
  PASS 闸门新增第四道判断：指纹不一致即拒绝，错误含「验证结果已过期（STALE）」。
  `flow_status` 新增 `verify_state` 四态（not_run / fail / stale / pass），
  `verify_passed` **仍保持 boolean** 不破坏下游。
- **负对照路径同样绑定指纹**：`flow_falsify` 写 `last_verify` 时此前**不记指纹**，
  于是「先负对照、再改代码、再记 PASS」这条路径会绕过 STALE 闸门 —— 一并修复。
- **`init` 在 Windows 上产出非法 JSON**（影响所有 Windows 用户的安装）：
  旧写法把 Windows 路径的**原始反斜杠**塞进 JSON 模板，
  产出含 `d` `
` `` 等非法转义序列的配置文件，解析即报
  「Bad escaped character」，表现为「安装成功但插件不出现」。
  现在 JSON 目标用 JSON 转义、YAML 目标（.mcprc）用正斜杠路径。

### 🔒 变更 | Changed

- **多副本治理收敛**（本机 5 套副本 → 2 套）：
  - 归档 `carlos-flow-cindy` / `carlos-flow-opencode` / `_carlos-flow-remote` 等 7 个目录
    （三个 git 副本的**独有提交实测均为 0**，无内容丢失）；保留发布线与线上运行副本两份。
  - 线上运行副本（`D:cindycarlos-flow-mcp`）从 2.8.0 **同步到最新发布版**，
    此前它的 bridge 无 `windowsHide`、无路径自探测 —— 也就是说仓库里修好的黑窗问题**在用户机器上根本没生效**。
  - Cindy **已安装插件**（旧 v1.0.5 架构）两处 spawn 补上 `windowsHide: true` ——
    这才是用户实际看到的黑色控制台窗口的来源。
  - npm 全局安装同步到最新发布版。

### 🔒 发布控制 | Release Control

- **发布暂停开关**（`scripts/publish-gate.mjs` + `release.yml`）：
  `RELEASE_PAUSED=1` 时停止 npm publish，只建 GitHub Release；
  设为 `0` 恢复。工作区本地操作默认暂停（`RELEASE_PAUSED: '1'`），
  需要发布时再开启。防止修复未完成时自动把半成品推上 npm。

### 🧪 新增门禁 | Gates

- **推 tag 前置钩子**（`scripts/install-hooks.mjs`）：只拦截 **tag 推送**，依次校验
  版本号一致性（`sync-version --check`）/ `check-all.sh` 真 RPC 往返 / tag 重名。
  背景：推 `v*` tag **等于**触发 npm 自动发布，此前 v2.11.1 那样没跑过验证的提交被打 tag 推上远端。
- **`check:templates` 模板渲染门禁**：用真实 Windows 路径渲染全部模板，
  断言产物可解析且路径无损，并校验 `client/carlos.js` 的转义写法与门禁**同源**。
- **`test:stale` A1 验证测试**：把研究文档里 4 段需要人手敲的命令（V1.1~V1.4）变成 14 条自动化断言。

### ✨ 新增 | Added

- **`sync-version.mjs --check` 只读模式**：有偏差退出码 1 且不写文件，供推 tag 钩子做精确判定。
- **`sync-version.mjs` 批量对齐版本号**：以 package.json 为唯一真源，同步 package-lock.json / ghost.json / TRIGGER_GUIDE.md / CHANGELOG.md。

## [2.11.2] - 2026-11-13 — 修复 Bridge 转发通路与 Windows 黑窗，新增路径自探测

### ✨ 新增 | Added

- **路径自探测**（`bridge/mcp-bridge.js`）：Bridge 依据自身文件位置自动定位 `../src/index.js`，
  不再强制依赖 `CARLOS_FLOW_MCP_ROOT` 绝对路径；该环境变量保留为可选覆盖，向后兼容。
  接入方只需填 bridge 脚本的路径，Cursor / VS Code / Windsurf 三端通用。
- **`/health` 返回真实项目根目录**（解析后的绝对路径），供客户端做 Bridge 身份比对，
  避免端口上跑着「别的 ROOT 的 bridge」时被静默复用。
- **`INSTALL.md`**：Cursor / VS Code / Windsurf 三平台接入步骤、配置自检与常见问题对照表。
- **`scripts/sync-version.mjs`**：以 `package.json` 为唯一真源，批量对齐
  `package-lock.json` / `ghost.json` / `TRIGGER_GUIDE.md` / `CHANGELOG.md` 的版本号，
  消除「版本散落四处、人工改漏即发布中止」的根因。

### 🐛 修复 | Fixed

- **Bridge 转发通路缺失**：上一版把 Bridge 精简为「只 spawn 子进程、不做转发」，
  导致平台侧发来的 `tools/list` 永远不会到达 MCP server —— 19 个工具一个都发现不了。
  现在恢复完整的 TCP → 子进程 stdin → 按 reqId 回包链路。
- **Windows 黑控制台窗口**：MCP server 子进程改用 `windowsHide: true` 启动，
  Bridge 重启时不再弹出黑色控制台窗口。
- **冒烟测试假阳性**：`smoke-test.js` 此前只检查一行启动日志，进程起得来就算「通过」，
  转发断了也测不出来。现在重写为**真 RPC 往返**：起真实 Bridge → 发 `initialize` →
  发 `tools/list` → 断言拿回全部 19 个工具。
- **子进程启动失败的报错可读性**：改为输出 `[Carlos-Diagnosis]` 现象 +
  `[Carlos-Suggestion]` 修复建议，不再只丢一句 Node 原始异常。

### 🔧 发布基础设施 | Release Infrastructure

- **修发布闸 semver 方向写反的真实 bug**：旧实现里 `process.exit(semver(a,b)<=0?1:0)` 的退出码语义
  与 shell 的 `elif` 判定相反 —— 结果「版本更高」被拦在 npm 之外、「版本更低」（补历史 tag）反而放行，
  正好与发布闸的本意完全相反。判定逻辑抽到 `scripts/publish-gate.mjs`，
  新增 `test/publish-gate.test.mjs` 锁住方向（10 条断言）。
- **修 CI 上 `check-all.sh` Permission denied**：脚本可执行位在 Windows 提交时丢失
  （`core.fileMode` 不跟踪 exec bit），Ubuntu runner 直接 126 退出。
  CI 改用 `bash ./check-all.sh`，并在 git index 层补上 `100755`。

### 🔒 变更 | Changed

- **`check-all.sh` 升级为 Gatekeeper 统一入口**：语法校验 + 真 RPC 冒烟测试一体，
  退出码非 0 即阻断提交；未设置 `CARLOS_BRIDGE_TOKEN` 时自动用临时值，避免误报失败。
- **`package.json` 的 `files` 补齐** `INSTALL.md` / `RELEASE_NOTES.md` /
  `check-all.sh` / `smoke-test.js`，使安装指引与自检脚本随包分发。
- **移除误提交的 `bridge/mcp-bridge.js.bak`**（内容是早期被截断的残缺版本，会误导后来人）。

### 🔬 验证 | Verification

- `./check-all.sh` 通过：三个文件语法校验通过，真 RPC 往返耗时约 330ms，拿回 19 个工具。
- 项目自带冒烟测试 `npm test` 通过（SMOKE_OK）。
- 单包一致性检查 `node scripts/check-repo-parity.mjs` 通过。

# 变更日志 | Changelog

> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)  
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows [SemVer](https://semver.org/)

---

## [2.11.0] - 2026-11-12 — 双轴审查补缺口：坏味道基线内置 + WARN 自动汇总

> 本版把「未做项」里两条低优先级增强做实，方案经三轴内审（Standards / Spec / 风险）评审后调整：
> 清单不硬编码「Fowler 12 种」这类无法核实的数字，改为显式可枚举的自维护基线；
> WARN 汇总采用「即时派生、零 state 变更」的实现，不引入 schema 迁移。

### ✨ 新增 | Added

- **坏味道基线内置进 Standards 轴 prompt**（`src/dispatch.js` 的 `SMELL_BASELINE`，18 条）。
  - 以前 prompt 只写了一句「对照仓库规范文件 + Fowler 坏味道基线」，基线内容没给，
    判定质量全看模型自己的记性 —— 不同上下文下结果会漂移。
  - 现在基线**逐条编号内联进 prompt**（审计 subagent 跑在目标仓库，读不到包内文件，
    写成 `docs/xxx.md` 让它去读等于没写）。
  - 出处如实标注：术语对齐 Fowler《Refactoring》第二版第 3 章 Code Smells，
    **但本表由 Carlos 自维护、非原书全表** —— 流传的「Fowler 12 种坏味道」是二手博客
    的说法，不是书里的口径，写进审计权威会把事实错误固化下来。
- **WARN 自动汇总**（`flow_verdict` / `flow_status` 返回 `warn_count` + `warn_findings`）。
  - 以前 WARN 只躺在 `state.audit_axes` 里，主 Agent 不主动读就看不到，
    「带坏味道通过」在汇报里等于被吞掉。
  - 口径与双轴门禁完全一致：**只收 `card_ts` 与当前卡一致的轴结论**，换卡后旧 WARN 自动失效。
  - 三种裁定（PASS / DIRECTION / LOCAL）都带这份汇总 —— 返工意见恰恰最需要坏味道清单。
  - **零 state 变更**：WARN 数据本就在 `audit_axes` 里，即时派生即可，
    不 bump `schemaVersion`、不写迁移分支。
- **`test/audit-baseline.mjs`** —— 审计基线守护测试（10 条断言）：基线条目齐全、条目名唯一、
  规模下限、每条都有中文说明、判定词表与 `flow_audit_submit` 的 enum 对齐、
  基线不泄漏进 executor 合同、prompt 长度上限、出处标注。

### 🐛 修复 | Fixed

- **两轴判定词表与 `flow_audit_submit` 的 enum 错位**：prompt 要求输出「通过/违规/坏味道」，
  而 enum 只有 `PASS / WARN / FAIL`。词表不一致时 subagent 输出自然语言、由主 Agent 手工映射，
  而 **FAIL（硬拦）与 WARN（不拦）的差别就在这一步** —— 映射错了硬拦就失效。
  两轴的 `format` 统一改成 `PASS / WARN / FAIL`，并写明各自判定口径。

### 🔒 变更 | Changed

- **`flow_audit_submit` 写审计事件**（`kind: "audit_axis_submitted"`）：轴结论此前只落在
  `state` 里 —— 可被覆盖、不可追溯。现在审计流水能回答「谁在什么时候提交了什么结论」。

### 🔬 验证 | Verification

- e2e **85/0**（新增 29a–29f 六条：WARN 汇总随裁定返回 / `flow_status` 镜像 /
  两轴全 PASS 不凭空产生 / 换卡后旧 WARN 失效 / DIRECTION 同样带汇总 / 轴结论进审计流水）；
  baseline 10/0；p0 22/0；protocol-consistency 5/0；trigger 29/0；concurrency 3/0；
  acceptance 13/0；smoke 通过。

---

## [2.10.0] - 2026-11-12 — 合并 _carlos-flow-remote 分支：verdict_role 落盘 + 协议字段漂移修复

> 本版把 `_carlos-flow-remote` 分支上**发布线缺失**的独有内容合并进来（该分支后被
> v2.8.0/v2.9.0 取代，其角色门禁实现已被更强的 claimed_role 口径覆盖，故不整支合入）。

### ✨ 新增 | Added

- **`verdict_role` 字段** —— 持久记录「本条裁定是谁落的」。
  - 与 `claimed_role` 的区别：后者是「会话最近 claim 的角色」（可能已过期），
    前者是「实际写下这条裁定时传进来的 role」，直接回答「这条 PASS 是谁落的」。
  - `flow_verdict` 返回值、`flow_status` 均可读；未显式声明 role 时落 `null`（不谎报）。
- **`test/protocol-consistency.mjs`** —— 协议一致性守护（5 条断言）：
  字段集合、字段默认值、ERROR_LAYERS 含「门禁拒绝」层、实现方式未回退为手写常量。

### 🐛 修复 | Fixed

- **`protocol.js` 的 `STATE_FIELDS` 与状态结构漂移**：原先是**手写常量**，已漏掉
  **9 个字段**（`claimed` / `claimed_role` / `activation_pending` / `activation_activated` /
  `dispatch_baseline` / `last_falsify` / `audit_axes` / `audit_axes_ts` / `schemaVersion`）。
  Agent 通过 `flow_protocol` 读到过期的字段表，会按错误的字段名做决策。
  改为从 `defaultState()` 生成，并加测试钉死。

### 🔒 变更 | Changed

- **`ERROR_LAYERS` 新增「门禁拒绝（非错误）」层**：明确告知 Agent 闸门拦不是工具坏了，
  应按错误信息里的下一步修正后重试，**不要重试同一调用**。
- **状态结构版本 v3 → v4**：`migrate()` 新增 v3→v4 迁移，补全旧状态的 `verdict_role`。

### 🔬 验证 | Verification

- e2e **79/0**（新增 28a–28c 三条 `verdict_role` 用例）；p0 22/0；scope 10/0；
  package-e2e 19/0；audit 23/0；bridge 6/0；trigger 29/0；concurrency 3/0；
  acceptance 13/0；lang 12/0；smoke 通过。
- `check:full` / `check:parity` / `check:lang` / `check:anchors` 17/17 / `check:readme` /
  `check:params` / `check:claims` / `check:no-dead-handler` 全部通过。

---

## [2.9.0] - 2026-11-12 — 双轴审查门禁：PASS 裁定前必须收齐 Standards / Spec 两轴证据

### ✨ 新增 | Added

- **`flow_audit_axes`** —— 派发两个并行审计 subagent（Standards 轴 / Spec 轴），各生成一段中文审计合同 prompt。
- **`flow_audit_submit`** —— 保存某一审计轴的结论与证据，按 `card_ts` 绑定当前卡（同轴可重复提交、后者覆盖）。
- **`flow_audit_guard`** —— 两轴门禁自查，与 `flow_verdict` 内的门禁同口径；给主 Agent 一个「落 PASS 前先自查」的显式工具。
- **`flow_status` 暴露双轴状态** —— 新增 `audit_axes` / `audit_axes_ts` / `axes_ready`，主 Agent 落 PASS 前可读。

### 🔒 变更 | Changed

- **`flow_verdict` 新增双轴门禁**（防假闭环之六）：落 `PASS` 前必须两轴证据齐全且无轴 FAIL。
  - **位置**：在负对照门禁**之后**，是 PASS 落定前的最后一道。六道门各自独立、互不掩盖；
    若前置会让「未验证 / 未派发 / 未做负对照」这些更基础的问题被双轴错误信息掩盖。
  - **判定**：任一轴 FAIL 硬拦；WARN（坏味道等 judgement call）只标注不拦。
  - **防冒充**：两轴证据均绑定 `card_ts`，旧卡的审查结果不能冒充新卡（也堵住「卡A的 standards + 卡B的 spec」跨卡拼接）。
  - `DIRECTION` / `LOCAL` 不受限制（返工意见不构成完成）。
- **状态结构版本 v2 → v3**：`migrate()` 新增 v2→v3 迁移，补全旧状态的 `audit_axes` / `audit_axes_ts`。

### 🔧 实现 | Implementation

- `src/dispatch.js`：新增 `AXIS_PROMPTS` 配置表，`buildContractPrompt` 加第 4 参 `axis`（可缺省，旧调用不变）；加新轴只改配置表，不动函数体。
- `src/state.js`：`defaultState()` 新增两字段；`migrate()` 加 v2→v3。
- `src/index.js`：新增 3 工具；`flow_verdict` 加门禁；`flow_status` 暴露双轴状态。
- `ghost.json`：工具清单 16 → 19，与服务端逐一对齐。

### 🔬 验证 | Verification

- 新增 11 条双轴专项用例（27a–27k）：未齐拦截 / 单轴拦截 / 双轴 FAIL 对称拦截 / WARN 放行 / DIRECTION 兼容 / 旧卡防冒充 / guard 三种状态 / `flow_status` 暴露。
- 既有正向 PASS 用例全部补上双轴前置（e2e-carlos / package-e2e / scope-enforcement），负向用例不受影响。
- 主测试 **76/0** 通过（e2e）；p0 22/0；scope-enforcement 10/0；package-e2e 19/0；trigger 29/0；concurrency 3/0；acceptance 13/0；lang 12/0；smoke 通过。
- `check:full` / `check:lang` / `check:anchors` / `check:parity` / `check:readme` 全部通过。

---

## [2.8.0] - 2026-11-08 — 角色门禁绑定会话 claimed_role + auditor 复核流程 + CI 修复

- flow_verdict PASS 现在必须由已 claim "auditor" 角色的会话落下（claimed_role 绑定会话 ID，而非调用方自述字符串）。
- executor 负责做事，auditor 负责复核裁定，测试脚本已同步更新（e2e-carlos、scope-enforcement、package-e2e）。
- 强版 falsify + output_hash 比对继续保留，整体无回归。
- **CI 修复（v2.7.0 引入的「本地绿、CI 红」）**：`test/bridge-identity.mjs` 造假的仓库根目录在系统临时目录下，
  Node 从那里向上找不到仓库的 `node_modules`，`@modelcontextprotocol/sdk` 解析失败 →
  MCP server 起不来 → bridge 不响应 → 客户端挂死到 60s 超时（表现为 `status=null`、无输出）。
  本地能过是假象：开发机用户目录下恰好有一份 `node_modules` 被向上回溯命中。
  现在假根目录会带上 `node_modules`（Windows 用 junction、POSIX 用目录软链，失败退化为复制）。
- **审计链测试日期一致性**：第 5、6 节原先用 `toISOString()`（UTC 日期），与第 1 节和
  `state.js` 的本地日期不一致 —— 在 UTC+8 的 00:00–08:00 会读写到另一天的文件。统一改用本地日期。

## [2.7.0] - 2026-11-07 — 第三方审查全线修复：核心承诺终于成立 + 安全承诺降级为准确表述

> 本版源于一份第三方审查报告（逐条核实与决策记录见 [`docs/AUDIT_REVIEW.md`](./docs/AUDIT_REVIEW.md)）。
> 核实基线：v2.6.3（commit \`f3e081c\`）。报告的 11 项指控，**10 项属实**、1 项部分属实（机制对但结论不准）。
> 全部已修，并固化为**自动门禁**，不再依赖人工记得检查。

### 🎯 核心承诺修复（P0）—— 「越界直接阻断派发」从今天起成立

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-79 | \`enforceScope(scope, diffFiles)\` 是纯函数、**从不自己跑 git diff**，完全信任调用方传入的 paths；且 \`flow_dispatch\` 里**零 scope 校验**（只有快照） | README 承诺的「越界？→ 运行时 git diff 对比白名单，**直接阻断派发**」**完全不成立** —— 越界改动根本不会被发现 | ① \`enforceScope(scope, cwd, diffFiles?)\` 改为**自己跑 \`git diff --name-only\`**（cwd 传入，不传 paths 即自动采集）；② \`flow_dispatch\` 记录**派发前基线**；③ \`flow_verdict\` 记 PASS 前用「当前改动 − 基线」算出**本次执行引入的**改动，越界则**拒绝记 PASS**并写 \`scope_violation\` 审计 |

> **为什么阻断点选在「裁定前」而不是「派发前」**：派发那一刻子 Agent **还没动手**，
> 它之后会改哪些文件无从得知。此时跑 git diff 得到的是「用户自己已有的未提交改动」，
> 拿它当越界拦下来会**误伤正常用法**。
> 正确语义是「本次执行有没有越界」—— 所以用**基线增量**判定，
> 既拦住越界，又不误伤用户原有改动。两点都有实测（\`test/scope-enforcement.mjs\`）。

### 🔐 安全承诺修复（P0）—— 审计链从「假装防篡改」改为「分模式如实告知」

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-80 | 审计链是**裸 SHA-256**（无密钥），攻击者能读文件就能重算整条链 | README 宣称「改一条全链断裂」「防篡改」—— 实测**能洗白**。这是**威胁模型缺失**，不是实现 bug | 新增两种模式：设 \`CARLOS_FLOW_AUDIT_KEY\` → **HMAC-SHA256**（带密钥，无密钥者重算不出 → 篡改必被发现）；未设 → 降级 \`plain\` 并在 \`verifyAuditChain()\` 结果里**显式标注 \`mode\` 字段**。README/SECURITY 同步改成**准确表述**（不再笼统宣称「防篡改」） |
| T-81 | \`verifyAuditChain\` 的 legacy 分支 \`prev = "0".repeat(64)\` **重置链起点** | 一条旧格式记录就让其后所有记录 \`prevHash\` 对不上 → 全判 broken → **v2.5 升级用户审计链长期报红**，会误以为记录被篡改（**误报比漏报更伤信任**） | legacy 记录只计入计数，**保持 \`prev\` 不变** |
| T-82 | 客户端有**硬编码默认 Token**（\`carlos-local-token-2026\`），与 bridge 侧 fail-closed 行为不一致 | 任何本机进程都知道这个字符串；SECURITY.md 却声称「无硬编码密钥」—— 自相矛盾 | 去掉硬编码默认值：优先读 \`CARLOS_BRIDGE_TOKEN\`；未设则**首次运行生成 256 位随机 token** 落盘 \`$CARLOS_FLOW_HOME/bridge-token\`（0600），跨进程复用 |
| T-83 | \`flow_audit\` 的 \`date\` 参数**完全失效**（\`rawDate\` 算出却不用，文件路径仍是 \`localDate()\`） | 工具描述承诺「可按日期过滤」，实际传 \`date=2020-01-01\` 读到的是**今天**的数据 —— 错而不报 | \`readAudit\` / \`verifyAuditChain\` 均改用 \`rawDate\` 构造文件路径 |

| T-88 | `audit()` 的上链 `prevHash` 只取当天 tail，**跨天链断开** | 午夜后任意历史天的篡改今天查不出，等于完美洗白 | `audit()` 改为 `nextPrevHash(localDate())`（当天无记录则往前找最近一天 tail）；`verifyAuditChain` 全链逐天串联验证 |
| T-89 | `audit()` 与 `saveState()` 把密钥片段（`verify.cmd`/`token`/`password`）**明文落盘** | 门禁本身成了泄露源，与“机械门禁”定位直接矛盾 | 脱敏后入盘：key 命中 `secret/key/password/pwd/token/credential/auth` 或 value 含 `sk_|secret=|password=|token=|api_key=|sk_live|sk_test` 时，只留掩码（≤8 字符→`[脱敏]`，否则头尾各 4 位 + `***`） |

### 🧭 行为兑现类门禁（新增）—— 防止这类问题复发


> 报告里最有价值的一个元发现：**现有门禁擅长查「静态一致性」，不擅长查「行为兑现」**。
> 上面的 P0 与 P1 问题**一个都没被现有门禁抓到**。为此新增三个门禁：

| 脚本 | 查什么 |
|------|--------|
| \`npm run check:claims\` | README/工具描述的每个能力声明都有对应代码路径；10 条核心承诺 + 6 条关键不变量 |
| \`npm run check:params\` | \`inputSchema\` 每个参数都被 handler **真实读取**；无「算出却从未使用」的死变量；\`date\` 贯通检查 |
| \`npm run check:no-dead-handler\` | 同一 request schema 不得重复注册；handler 必须走 \`TOOLS.find\` 分发且调用 \`validateToolArgs\` |

### 🧬 专项真实验证（新增）—— 不靠 mock，用真实 git / 真实篡改

| 脚本 | 验什么 | 用例数 |
|------|--------|--------|
| \`npm run test:scope\` | 真实 git 仓库里改文件 → scope 外改动**真被阻断**；派发前已有改动**不误伤**；\`flow_check_scope\` 自动 diff 模式 | 5/5 |
| \`npm run test:audit\` | **真实篡改**审计记录 → hmac 模式必发现；plain 模式如实标注局限；legacy 不误报；date 真的生效 | 23/23 |
| \`npm run test:bridge\` | 端口上是**别人的 bridge** 时不复用（状态不会写到别人的 HOME）；同身份可复用 | 6/6 |
| \`npm run test:lang\` | 语言体检**真能抓到英文**（防假绿） | 12/12 |

### 🧹 整洁性修复

| # | 问题 | 修复 |
|---|------|------|
| T-84 | \`CallToolRequestSchema\` **注册了两次**（后注册覆盖先注册 → 先注册的是 17 行死代码，靠注册顺序维持参数校验的正确性） | 删除先注册的那个；\`check:no-dead-handler\` 守住不再复发 |
| T-85 | \`wasActivated\` 死变量（算出从未使用） | 删除；\`check:params\` 以后自动发现这类 |
| T-86 | \`flow_claim\` / \`flow_revert_plan\` 的 \`inputSchema\` 声明了 \`cwd\` 但 handler 从不读 | **删掉声明**（这两个操作确实不需要工作目录 —— 声明一个不生效的参数会误导调用方） |
| T-87 | legacy 记录导致审计链误报 | 见 T-81 |

### 🧬 变异测试扩容 —— 用注入退化撞自己最自豪的代码

变异体从 13 类增到 **17 类**，新增的 4 条全部针对本次修复的核心：

| 变异体 | 注入的退化 | 抓住它的测试 |
|--------|-----------|-------------|
| **M14** | 审计链去掉 prevHash 链接 | test:audit |
| **M15** | \`verifyAuditChain\` 永远返回 ok:true | test:audit |
| **M16** | \`enforceScope\` 退回 fail-open | test:scope |
| **M17** | \`date\` 参数失效 | test:audit |

并修掉了**历史守护缺口 M9**（闸门派生回退）：之前一直 NOT CAUGHT，
因为普通流程下它与正确实现等价。新增 e2e 用例 19d-3 构造「pending 非空但 activated=false」
的不一致状态，验证普通卡提交能**自愈**而不是把用户永久锁死。

> **变异测试结果：17/17 全部被抓住**（此前 13/14，M9 逃逸）。

### ✨ 新增 | Added

- **`AGENTS.md`** —— 变更前置索引：改哪类东西先读哪份权威契约；7 条红线（门禁只许收紧、
  PASS 三条件、空 scope fail-closed、占位卡未补齐不得派发/裁定、legacy 不重置链起点、
  不引入硬编码密钥、描述与实现必须一致）；提交前必跑清单；加新工具的 6 步清单
- **状态 schema 版本机制** —— \`schemaVersion\` + \`migrate()\`：将来改字段名时，
  旧状态**显式迁移**而不是静默降级（早先靠 \`{...defaultState(), ...parsed}\` 防御性合并，
  改字段名会让老用户状态静默丢字段 —— 极难定位）
- **README「门禁体系」章节** —— 把 11 个门禁脚本、17 类变异体、5 个真实验证整理成可读结构，
  并给出**给质疑者的可执行入口**（每条命令都能自己跑一遍）

### 🔬 验证 | Verification

| 项 | 结果 |
|----|------|
| 主测试 | **131/0**（smoke 4 / e2e 64 / p0 22 / trigger 29 / concurrency 3 / acceptance 13） |
| 专项真实验证 | scope **5/0** · audit **12/0** · bridge **6/0** |
| 语言体检自检 | **12/0** |
| 变异测试 | **17/17 全部被抓住** |
| 门禁脚本 | check:full / identity / lang / claims / params / no-dead-handler / anchors / readme —— 全通过 |

---

## [2.6.3] - 2026-11-07 — 统一工具返回结构 + 新增包级端到端实测

### 🐛 修复 | Fixed

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-78 | `ok()` 只做序列化、不注入 `ok` 字段；各工具有的显式写 `ok: true`、有的没写（如 `flow_audit`） | 调用方拿到手的返回结构不一致 —— 想判断成败只能逐个工具记「这个有没有 ok」 | `ok()` 统一注入 `ok: true`（payload 里已有 `ok` 则保留原值，不改 `ok:false` 语义）。**增量兼容**：读取 `total` / `events` / `by_type` 等既有字段不受影响 |

### ✨ 新增 | Added

- **`test/package-e2e.mjs`（`npm run test:package`）** —— 「装完就能用」的真实路径实测：
  `npm pack` → 装到**干净临时目录** → 从 `node_modules` 拉起 MCP server → 真实 JSON-RPC
  → 校验包内 23 个关键文件齐备 / bin 有 shebang / ghost.json 工具清单与服务端逐一对齐 /
  插件候选含单包名 → 跑完整门禁流程 + 负例 + 智能触发。

> **为什么必须走真实安装路径**：之前所有测试都跑在源码目录，绕过了
> `npm pack → tarball → npm install → node_modules 布局 → 全局 bin → 真实握手` 这条链路。
> v2.6.2 修掉的两个严重 bug（T-69 插件找不到单包、T-70 ghost.json 缺 3 个工具）
> **都是只有走真实安装路径才会暴露**的 —— 源码目录测试永远发现不了。

### 🔬 验证 | Verification

- `test:package` **19/0** 通过（真实 tarball + 真实安装 + 真实 MCP 握手）
- 主测试 **129/0** 通过
- `check:full` / `check:identity` / `check:lang` / `test:lang`（12/0）全部通过

---

## [2.6.2] - 2026-11-07 — 对外产物全面排查：修掉 2 个严重 bug 与 5 类遗留

### 🐛 修复 | Fixed

> 这一版的每一项**都不会让任何测试变红**，但会直接让用户看到错误信息。
> 单包合并后仓库里散落着大量双仓时代的遗留，为此新增 `scripts/full-audit.mjs`
> 做独立的「对外产物体检」，首轮报出 49 项，本次修完归零。

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-69 | `plugins/carlos-flow-trigger.js` 硬编码找 `node_modules/carlos-flow-opencode` | 单包化后该目录**根本不存在** → 除「插件就在包内」外的所有安装方式都找不到 MCP server → **OpenCode 的自动触发静默失效**（不报错，只是永远不触发） | 改为同时尝试 `carlos-flow` 与两个已弃用旧包名；实测真实 npm 安装下能定位到 `src/index.js` |
| T-70 | `ghost.json` 只声明 12 个工具，缺 `flow_run_verify` / `flow_check_scope` / `flow_trigger_check` | **Cindy 用户根本看不到这三个工具** —— 服务端有、清单没有 | 补齐到 15 个，与服务端 `src/index.js` 逐一对齐；并新增「ghost.json 工具清单 vs 服务端实际工具」的一致性检查 |
| T-71 | `scripts/verify-install-e2e.sh` 默认验证已废弃的旧包名 + 写死的旧版本号 | 该脚本验证的是一个**不存在的包** → 装包验收形同虚设 | 默认包名改为 `carlos-flow`，版本改为取自本仓 `package.json` |
| T-72 | 该脚本的「包内无个人路径」审计，grep 模式里含字面量 | **必然检出自己** → 这项审计从来没通过过 | 模式改为变量拼接；`CHANGELOG.md` 例外（版本历史刻意保留被修复路径的原样描述，便于追溯） |
| T-73 | `TRIGGER_GUIDE.md` 三处死链（`../README.md` 等，文件本身就在根目录） | 文档里的链接点不开 | 改为 `./` 相对路径 |
| T-74 | `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` 指向已删除的旧仓库、保留双仓表述 | 社区文档与 Security Advisories 入口全部失效 | 全部改为单一仓库 `carlos-flow` |
| T-75 | `settings.html` 示例路径用旧包名、`settings.js` 注释含开发者机路径 | Cindy 插件设置页给用户错误的安装路径示例 | 清理 |
| T-76 | `scripts/verify-activation-e2e.sh` 与 `scripts/mutation-check.mjs` 注释含开发者机路径 | 随包分发的文件里出现开发者机路径 | 改为泛化表述 |
| T-77 | `TRIGGER_GUIDE.md` 的版本号有两种写法（半角 `:` 与全角 `：`），升版本时只改了一半 | 文档里留下旧版本号；体检脚本因只认半角而**漏检** | 版本提取兼容两种冒号；并新增「同一文件出现多个版本号」检查 |

### ✨ 新增 | Added

- **`scripts/full-audit.mjs`（`npm run check:full`）** —— 「对外产物体检」：
  旧引用 / 个人路径 / 版本一致性 / 文档死链 / npm 发布集合 / 模板占位符 /
  package.json 关键字段 / 脚本与 CI 的双仓残留 / ghost.json 工具清单，9 类检查。
- **CI 与 Release workflow 接入 `npm run check:full`** —— 上述遗留一旦复发立即红。

### 🔬 验证 | Verification

- `check:full` 通过（首轮 49 项 → 0）
- `check:identity` / `check:lang` / `test:lang`（12/0）全部通过
- 主测试 **129/0** 通过（smoke 4 / e2e 62 / p0 22 / trigger 29 / concurrency 3 / acceptance 13）
- 插件路径修复用**真实 npm 安装**实测：能定位到 `node_modules/carlos-flow/src/index.js`

---

## [2.6.1] - 2026-11-07 — 修复全局命令不可用（bin 缺 shebang）

### 🐛 修复 | Fixed

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-68 | `client/carlos.js` **缺 shebang**（`#!/usr/bin/env node`） | npm 的 `cmd-shim` 读首行决定 shim 类型 —— 没 shebang 就把目标当成 **shell 脚本**直接 exec → 类 Unix 环境（Git Bash / Linux / macOS）下 `carlos-flow init --target cindy` 直接报 `client/carlos.js: line 1: //: Is a directory`，**全局命令完全不可用**（Windows 的 `.cmd` shim 反而正常 → 问题只在类 Unix 暴露，极易漏测） | 补上 shebang；单包一致性守卫新增「bin 入口必须有 node shebang」检查项，回归即红 |

> **为什么这个 bug 能在 2.6.0 发布出去**：2.6.0 的验证是在**源码目录**里跑的
> （`node client/carlos.js ...`），完全绕过了 bin shim 这条路径。
> 真正的暴露场景是**全局安装后直接敲命令** —— 已在 2.6.1 的发布验证里
> 用 `npm install -g carlos-flow@2.6.1 && carlos-flow init --target <平台>` 走通。

---

## [2.6.0] - 2026-11-07 — 单包统一分发（6 大平台）+ 文档全面重写

### 🎯 架构重构 | Breaking Change

> **两个包合并为一个**：`carlos-flow-cindy` + `carlos-flow-opencode` → **`carlos-flow`**
>
> 合并的根因不是“想统一”，而是**维护成本**：两套包共享 100% 的核心逻辑
> （`state.js` / `trigger.js` / `card.js` / `dispatch.js` / `protocol.js` / `index.js`），
> 却要各自发版、各自打 tag、各自跑 CI —— 版本漂移是必然结果
> （合并前就出现过 `cindy@2.5.9` 与 `opencode@2.5.8` 并存）。
> 合并后核心逻辑**零分叉**，版本永远一致。
>
> **迁移指南**：见 [MIGRATION.md](./MIGRATION.md)

| 变更 | 之前 | 现在 |
|------|------|------|
| **npm 包名** | `carlos-flow-cindy` + `carlos-flow-opencode` | **`carlos-flow`**（单一包） |
| **bin 命令** | `carlos-flow` / `carlos-flow-cindy` / `carlos-flow-opencode`（三个包九个入口） | `carlos-flow` + 两个兼容别名（一个包三个入口） |
| **版本管理** | 双版本，易漂移 | 单版本，一致 |
| **平台覆盖** | Cindy / OpenCode | Cindy / OpenCode / Cursor / Cline / VS Code / Claude Desktop |

### ✨ 新增 | Added

- **`carlos-flow init --target <platform>`** —— 一键生成对应平台的 MCP 配置：
  - `cindy` → `~/.cindy/ghosts/carlos-flow.json`
  - `opencode` → `~/.config/opencode/plugin/opencode.json` + 项目 `.mcprc`
  - `cursor` → 项目 `.cursor/mcp.json`
  - `cline` → 项目 `.cline/mcp.json`
  - `vscode` → 项目 `.vscode/mcp.json`
  - `claude` → `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
    / `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **`templates/` 目录** —— 4 套平台配置模板（Cursor / Cline / VS Code / Claude），
  统一使用 `__ROOT__` 占位符，由 `init` 渲染成实际路径
- **`MIGRATION.md`** —— 从旧包迁移的完整指南（命令对照、配置文件位置、行为差异）
- **`package.json` `exports` 字段** —— `carlos-flow/cindy`、`carlos-flow/opencode`、
  `carlos-flow/trigger-config` 子路径导出，宿主可按需引用清单与默认配置

### 🐛 修复 | Fixed

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-59 | `CARLOS_FLOW_HOME` 的 `~` 在 `OPENCODE_DB_PATH` 等环境变量上不展开 | Windows 下 `CARLOS_OPENCODE_DB=~/.opencode` 字面写入，OpenCode 用户拿不到原话 → quote 锚点校验失败 → 卡片无法提交 | `state.js` / `trigger.js` 统一走 `expandHome()`（`~`、`~/x`、`~\x` 三种写法全覆盖） |
| T-60 | `release.mjs` 硬编码双仓身份（`carlos-flow-cindy` / `carlos-flow-opencode`） | 单包化后身份自检直接失败，**发不了版** | 重写为单包发布器：身份自检 → 版本/lock/CHANGELOG/ghost.json 一致性 → 测试 → 打包内容检查 → 推送 main + tag |
| T-61 | `client/carlos.js` 的 `ROOT` 默认取 `process.cwd()` | 源码目录执行时找不到 `ghost.json` / `templates/`，`init` 报 ENOENT | 改为从脚本自身位置推导包根目录（`client/` → 上级），`CARLOS_FLOW_MCP_ROOT` 仍可覆盖 |
| T-62 | `init` 的目标白名单只认 `cindy` / `opencode` | 新增平台的 `init --target cursor` 被拒 | 白名单扩展到 6 个平台，错误提示同步列出全部合法值 |
| T-63 | 包的 `files` 白名单缺 `templates/` | 初始化模板不会进 tarball，`init --target cursor` 装完即失败 | `files` 补入 `templates/`，并用 `npm pack --dry-run` 逐项核对 |
| T-64 | `ghost.json` / `opencode.json` 里的路径写死为仓库内相对路径 | 安装到 npm 全局目录后路径全错 | 统一改为 `__ROOT__` 占位符，由 `init` 渲染成实际绝对路径 |
| T-65 | `flow_run_verify` 的工作目录只用 `process.cwd()` | MCP server 是**常驻进程**，它的 cwd 是**启动时**的目录（可能是几个月前的旧仓库）→ `verify.cmd` 在错误目录执行、路径全错 → 门禁把这种失败当成「验证不通过」→ **真 PASS 被误杀** | 工作目录优先级改为：显式 `cwd` > 卡片提交时的项目目录（`card.env.project`）> server 进程 cwd；新增回归用例 23d 守护 |
| T-66 | Bridge 的 `REQUEST_TIMEOUT` 固定 **5s** | `flow_run_verify` 的服务端内部超时是 120s（真实 spawn `verify.cmd`），但 Bridge 5s 就断 —— **任何耗时 >5s 的验证命令必然超时失败**（如 `npm test`），用户只看到「Timeout」，而服务端那边命令其实跑得好好的 | 默认改为 180s（> 服务端 120s 上限），可用 `CARLOS_BRIDGE_TIMEOUT_MS` 覆盖 |
| T-67 | CLI 客户端的 MCP 调用超时固定 **5s** | 同上，且比服务端短得多 → `flow_run_verify` 从命令行调用**永远失败** | 改为 180s，可用 `CARLOS_MCP_TIMEOUT_MS` 覆盖 |

### 📚 文档 | Documentation

> 全面重写，按顶级开源项目（React / Vue / TypeScript / Kubernetes）的文档标准组织信息架构。

- **README** —— 全新信息架构：
  - 徽章栏 + TL;DR（30 秒看懂这是什么、解决什么问题）
  - **痛点对照表** —— 「你说 X / Agent 实际做 Y」直接展示约束从建议变机械
  - **核心亮点** —— 6 大亮点（零分叉跨平台架构 / 智能触发引擎 / 反自欺激活闸门 /
    Fail-closed 语义 / 变异测试守护 / 跨进程并发安全）
  - **技术框架** —— Mermaid 分层架构图 + 五层职责表（哪层有平台耦合、哪层零耦合）
  - **能力矩阵** —— 对比原生 MCP Server 与提示词方案，逐项标注 ✅/❌
  - **15 个 MCP 工具参考表** —— 每个工具的作用与关键约束
  - **配置说明** —— 触发器配置合并语义（追加≠替换）+ 7 个环境变量
  - **测试覆盖矩阵** —— 6 个套件 128 个用例逐项说明
  - **FAQ 7 问** —— 含信任边界、免检是否后门、中文支持、性能影响
- **CHANGELOG** —— 按 Keep a Changelog 重构，2.5.9 明确标注 Breaking Change 与迁移指引
- **TRIGGER_GUIDE** —— 补充三层架构详解、评分公式、配置合并语义、激活闸门时序
- **MIGRATION** —— 新增：旧包 → 新包命令对照、配置文件位置对照、行为差异说明
- 中英双语**零差异同步**（`npm run check:readme` 守护）

### 🔬 验证 | Verification

- 全套测试 **129/0 通过**（smoke 4 / e2e 62 / p0 22 / trigger 29 / concurrency 3 / acceptance 13）
- 6 平台 `init --target` 命令逐个实测通过
- 旧包 `carlos-flow-cindy@2.5.9` / `carlos-flow-opencode@2.5.9` 已标记 **Deprecated** 并提示迁移

---

## [2.5.9] - 2026-11-06 — 清除全部个人私有路径（安装/分发可用性修复）

### 🐛 修复 | Fixed

> 这一版修的全是**会跟着包分发给所有人**的问题 —— 开发机路径被写进了产物里。
> 用户按文档照抄必然失败，且无法自行察觉。

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-52 | Cindy 插件设置页默认值写死 `D:/cindy/carlos-flow-mcp` | Cindy 用户**开箱即见**一个开发者本机的无效路径（目录名根本不存在） | 默认值改为空（留空即用插件自带 `src/`），placeholder 改为通用说明 |
| T-53 | `scripts/verify-activation-e2e.sh` 写死 `D:/cindy/publish-output/carlos-flow-cindy` | 该脚本**随包分发**：用户跑会 `cd` 到不存在的路径；且在 **opencode 包里还指向 cindy 仓**（跨仓串味） | 根目录改为从**脚本自身位置**推导（`scripts/` → 仓库根），两仓一致 |
| T-54 | README 安装示例写死 `D:/dev-env/node-v22.23.4-win-x64/...`、`C:/Users/EDY/.carlos-flow` | **用户照抄必失败**（路径不存在 / 指向别人的用户名目录） | 改为 `<npm 全局目录>` 占位符 + `npm root -g` 推导说明；`CARLOS_FLOW_HOME` 改用 `~/.carlos-flow` 平台无关写法 |
| T-55 | README 环境变量表 / 路径说明 / QA 报告残留 `D:/dev-env/rea`、`D:/dev-env/ghidra/...`、`D:/dev-env/jdk-...`、`D:/cindy/.qa-logs/...` | 继续散落开发者本机路径 | 全部替换为通用示例（`/opt/rea`、`/opt/ghidra_*`、`/usr/lib/jvm/*`）；QA 报告改为指向 CI 输出 |
| T-56 | README 声称 Windows 配置目录是 `%APPDATA%opencode` | **实证是错的**：OpenCode 走 XDG 风格，Windows 上真正被读的是 `~/.config/opencode/`（`$env:USERPROFILE.configopencode`）。照 README 放到 `%APPDATA%` 的用户 → 配置读不到 → **MCP server 根本不启动** | README 统一改为「所有平台都是 `~/.config/opencode/`」，并给出 Windows 的 `$env:USERPROFILE.configopencode` 写法 + 明确警示「不是 %APPDATA%」（中文/英文 FAQ 同步） |
| T-57 | `CARLOS_FLOW_HOME=~/.carlos-flow` **不会被展开** | `path.normalize` 只换分隔符不展开 `~` → 状态/审计链写到**当前工作目录下字面名为 `~` 的目录**（实测 `FLOW_HOME = ~.carlos-flow`），位置诡异极易丢失 | `state.js` / `trigger.js` 新增 `expandHome()`，统一展开 `~`、`~/...`（Windows 同时支持 `~`）；新增回归用例（trigger 29 项） |
| T-58 | `scripts/verify-install-e2e.sh` 里路径内插进 `node -e` 字符串 | Windows 路径含**反斜杠与空格** → 被拆坏，测试在 Windows 上假失败（实测 tools/list 返回 0 个工具） | 路径一律经**环境变量**传给 node 进程；包目录布局多平台探测（lib/node_modules、node_modules、Lib/…） |

> 补充：另修正 `verify-activation-e2e.sh` 的跨仓串味（opencode 包里原本指向 cindy 仓），
> 以及 README 里 `D:/dev-env/rea`、`ghidra`、`jdk` 等开发机路径（全部换成通用示例）。



### 🧪 新增 | Added

- **`scripts/verify-install-e2e.sh`** —— 「从没见过本项目的用户」视角的安装验收：
  从真实 npm registry 装包（独立 prefix，模拟干净环境）→ 检查包内容完整性 →
  验证触发器模板是合法 JSON 且可被引擎读取 → 拉起 MCP server 走真实 JSON-RPC
  （`tools/list` / `flow_status` / `flow_trigger_check`）→ 审计包内无个人私有路径。
  跨平台（Windows / Linux 均实测通过）；路径一律经环境变量传给 node，**不内插进 `node -e` 字符串**
  （Windows 路径含反斜杠与空格，内插会被拆坏）。


## [2.5.8] - 2026-11-06 — 修包内容与文档不一致 + 变异体锚点加固

### 🐛 修复 | Fixed

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-47 | `trigger-config.usable.json` 整份含 `//` 注释 ⇒ **不是合法 JSON** | 复制成 trigger-config.json 后 `JSON.parse` 抛错 → 配置被整体丢弃、静默回退默认词表 ⇒ 用户以为「复制即可生效」，实际自定义词**一条都不生效** | 改为纯 JSON；`trigger-config.example.json` 补上真实可配置键（原先真键都带 `_` 前缀，直接复制同样无效） |
| T-48 | README 安装命令钉死 `@2.5.5` | 用户照文档装不到含 bin 修复的版本，老 EEXIST 照原样复现 | 改为不钉版本（`npm install -g carlos-flow-opencode`），避免文档随发版过时；版本行同步；`docs/` 报告链接改 GitHub 绝对链接（`docs/` 不在 npm files 白名单，相对链接在 npm 页面 404） |
| T-49 | `.mutation-report.md` 未被 `.gitignore` 覆盖 | 跑一次变异测试就脏工作区 ⇒ `release.mjs` 的「工作区干净」硬拦、**发不了** | 加 `.gitignore` + 把历史上误提交的该文件取消跟踪并删除；同时清理根目录 13 个死进程残留的 `bridge-*.pid` |
| T-50 | M6/M9 **共用同一段 from 锚点**、M10 的 from 仅 2 行 | 该段一改缩进/注释 → 多个变异体同时 SKIP：**静默失去守护作用**，而历史报告仍显示「13/13 全部被抓住」 | 三个锚点各自唯一且更长；新增 `scripts/check-mutant-anchors.mjs`（`npm run check:anchors`）+ 接入 CI，锚点失效立刻报错 |
| T-51 | `release.mjs` 的跳过逻辑按**标签**、目标路径按**身份**解析 —— 两者不同源 | 在 opencode 仓**不带** `--include-peer` 时：「opencode」分支被跳过（跳掉**自己**），「cindy」分支照跑却推了**对方** ⇒ **opencode 包永不发布，反而去发 cindy**，而日志还写「跳过 opencode」 | 推送循环重构为「跳过与路径同源于身份」：本仓**始终**发布，对方仓受 `--include-peer` 约束；两个标签分支合并为一段，日志带仓名与身份标记。四种组合的决策推演已全部验证正确 |

> 实测：两个触发器模板复制后，自定义词「评审」生效、默认中文词「门禁」保留、只读词「讲一下」已追加。


## [2.5.7] - 2026-11-06 — 修 bin 名冲突：两个包可同时全局安装

### 🐛 修复 | Fixed

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-46 | `carlos-flow-cindy` 与 `carlos-flow-opencode` 声明了**同名 bin** `carlos-flow` | `npm install -g` 两个包时后者与前者互斥 → **EEXIST 报错，两个包无法共存** | npm 的规则是同名 bin 不能共存，必须有一个让位：`carlos-flow-cindy` 保留 `carlos-flow`（通用名）并新增别名 `carlos-flow-cindy`；`carlos-flow-opencode` 只用 `carlos-flow-opencode`。opencode 用户升级后请改用新命令名（README 用法本就是 `node client/carlos.js ...`，不依赖 bin 名） |

> 实测：修复前 `npm install -g carlos-flow-cindy@2.5.6 carlos-flow-opencode@2.5.6` 报 EEXIST，修复后两包可同时安装。


## [2.5.6] - 2026-11-06 — 门禁伪填充绕过修复 + 触发器接入 MCP 路径

### 🐛 修复 | Fixed

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| T-34 | `acceptance` 必填校验只看数组长度 | `[""]` / `[null]` / `[0]` / `[{}]` 等伪填充被当作「已填」——空验收标准的卡片能过校验，激活闸门也会误判为「已补齐」而解开 | 必填校验与闸门推导统一改为**内容判定**（严格口径：每个元素都必须是有效非空字符串） |
| T-35 | 卡片文本字段用 `String(x)` 归一化 | `[null]`→`["null"]`、`[{}]`→`["[object Object]"]`，垃圾串被当成合法验收标准 | 取消过滤式归一化，两条入口（结构化 / cardText）均保留原始类型，由校验器统一判定 |
| T-36 | `trigger-config.json` 浅合并 | 用户写一个自定义词就把默认词表（含内置中文流程词）整个丢掉，中文场景重新变回 0 分 | 改**深合并**：keywordWeights 合并、词表数组追加去重 |
| T-37 | README FAQ / TRIGGER_GUIDE 仍写「默认词表为英文」 | 文档与实现不符，用户据此以为中文不触发 | 全部更正，并说明自定义是**追加**不是替换 |
| T-38 | 验收标准判定用 some（至少一个有效） | `[null,"x"]` 混入的 null 会原样落盘并进入 executor 合同文本 | 收紧为 every（每个元素都必须有效） |
| T-39 | scope 非字符串元素被静默丢弃 | `scope=[123]` → 静默降档成 read_only 空卡且无提示 | 入口即明确拒绝 |
| T-40 | 参数校验不查数组元素类型 | `paths:["README.md",123]` 抛不可读的 Node 底层错误 | 补元素级校验，入口即给明确提示 |

### ✨ 新增 | Added

- **`flow_trigger_check` MCP 工具** —— 触发引擎不再只接在命令行客户端上，宿主可在消息事件里调用它，
  获得与 CLI 完全一致的自动触发行为（MCP 协议是被动的，服务端不能主动推送）
- **OpenCode 插件 `plugins/carlos-flow-trigger.js`** —— 监听 `chat.message` 钩子，实现消息级自动触发；
  异常只记日志、绝不阻断用户消息
- **内置中文流程词** —— 工作流 / 门禁 / 任务卡 / 派发 / 子代理 / 流程 / 触发 / 执行 / 调度 / 审计 / 复核 / 留痕 / 裁定；
  只收流程性词汇，不收「实现 / 新增 / 接口」这类普通开发动词
- **`trigger-config.usable.json` / `trigger-config.example.json`** —— 可直接用的中文触发配置模板
- **`test/e2e-acceptance.mjs`（`npm run test:acceptance`）** —— 端到端验收：MCP 触发 / 中文词表 /
  伪填充拒绝 / 配置合并 / 插件真实开卡

### 🌐 跨平台 | Cross-platform

- `runVerifyCommand` 不再硬编码 `cmd.exe`（Linux/macOS 上命令根本没跑，exitCode=127，门禁失守）
- OpenCode DB 路径多路探测（XDG / macOS 原生 / Windows APPDATA），修复 macOS/Windows 读不到用户原话
- npm 包补入 `scripts/` 目录 —— 装包后 `npm run test:e2e` 不再因缺文件失败

