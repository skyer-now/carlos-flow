# AGENTS.md — 修改前必读

## 阶段一模块定位（2.28.1）

工具真实实现位于 `src/handlers/{gate,verify,audit,infra,facade}.js`；`catalog.js` 保持原目录顺序并拒绝遗漏/额外操作；`shared.js` 提供共用请求上下文与补偿助手，禁止依赖入口或目录造成循环。`src/index.js` 仅负责服务装配、参数校验、请求级失败补偿与路由。以下旧入口定位均应结合领域模块阅读，不得将全部实现挪到 shared。专项 `npm run test:handlers` 固定原 26 工具契约摘要，架构缺文件失败不等于充分业务证伪；真实安全判别仍由独立 mutation 验证。


> 本文件是**变更前置索引**：改某一类东西之前，先读对应的那份权威契约。
> 目的是让「改了实现、忘了改契约」这类静默退化在 review 前就被发现。

---

## 🔍 改之前先读这里

| 你要改 | 先读（权威契约） | 同步检查 |
|--------|-----------------|---------|
| `src/index.js` 的工具 handler | `src/protocol.js`（该工具的权威定义） | `README.md` 的工具参考表 |
| `src/index.js` 的参数校验 | `scripts/check-params.mjs` 的判定口径 | 工具的 `inputSchema` |
| `src/state.js` 的状态字段 | `src/state.js` 的 `defaultState()` + `schemaVersion` | 迁移函数 `migrate()` |
| `src/state.js` 的审计链 | `docs/AUDIT_REVIEW.md` 的威胁模型 | `test/audit-chain.mjs` |
| `src/state.js` 的 `withStateLock` | `docs/TOOL_CONTRACTS.md` §4.5（排他/回收/退避口径） | `test/state-lock.mjs`、`test/concurrency-e2e.mjs` |
| `src/protocol.js` 的敏感名单 | `docs/TOOL_CONTRACTS.md` §4.4（只能追加，不许放宽） | `test/sensitive-config.mjs` |
| `src/dispatch.js` 的负对照还原 | `docs/TOOL_CONTRACTS.md` 的 `flow_falsify` 关键约束 | `test/falsify-restore.mjs` |
| `src/dispatch.js` 的 scope 判定 | `test/scope-enforcement.mjs` 的用例 | `README.md` 的能力矩阵 |
| 门禁逻辑（claim / dispatch / verdict） | `test/e2e-carlos.mjs` 的第 15~26 组用例 | 变异体 M1~M6 |
| `src/trigger.js` 触发引擎 | `TRIGGER_GUIDE.md` + `test/trigger-e2e.mjs` | 触发器配置模板 |
| 对外工具描述 / README | `scripts/check-claims.mjs`（承诺兑现度门禁） | `npm run check:claims` |
| `bridge/` 或 `client/` | `test/bridge-identity.mjs`（身份隔离） | `npm run test:bridge` |
| `ghost.json` 的工具清单 / `main.js` | `docs/TOOL_CONTRACTS.md` §1.3（两段式目录） | `test/cindy-dispatch.mjs`、`npm run check:full` |
| `src/mcp-stdio.mjs`（协议层） | `docs/TOOL_CONTRACTS.md` §1.3 + MCP stdio 规范 | `npm run test:mcp` |
| 写状态的锁窗口 / 合并策略 | `docs/TOOL_CONTRACTS.md` §2.3 | `test/verify-cas.mjs`、`test/concurrency-e2e.mjs` |
| 快照 / 审计存储形态 | `docs/TOOL_CONTRACTS.md` §2.3 | `test/hardening.mjs`、`test/audit-roll.mjs` |
| 存储清理 / 归档 | `docs/TOOL_CONTRACTS.md` §2.3 + `src/storage.js` 顶部红线 | `test/prune.mjs` |
| CI / 发布流程 | `.github/workflows/` | `npm run check:full` |

---

## 🚫 红线（改坏了就是事故）

1. **门禁只许收紧，不许放宽**
   - 任何让「本该被拦住的」变得能通过的改动，都是回归。
   - 典型危险：把 `ok: false` 改成 `ok: true`、把 `fail()` 改成 `ok()`、
     删掉某个拒绝分支、把 `every` 改成 `some`。

2. **PASS 裁定必须同时满足三个条件**
   - `dispatch_count > 0`（确实派发过）
   - `last_verify.ok === true`（验证真的通过）
   - `last_verify.cmd` 与**当前卡片**的 `verify.cmd` 一致（不能用旧卡结果冒充）

3. **空 scope = fail-closed**
   - 卡片 `scope` 为空时，**任何**文件改动都算越界。
   - 不许改成「白名单为空 → 随便改」。

4. **激活占位卡未补齐时不得派发 / 不得裁定**
   - `activation_pending` 非空 → `flow_claim` / `flow_dispatch` / `flow_verdict` 全部拒绝。

4.1 **敏感规则只许追加（v2.14.0）**
   - `.carlos.json` 的 `sensitive` 只能**加**规则；`!x` / `-x` 否定式必须被忽略。
   - 配置损坏时退回内置基线，不许因为「配置读不到」而放宽。

4.3 **长命令必须跑在锁外（v2.15.0）**
   - `flow_run_verify` / `flow_falsify` / 任何 spawn 外部命令的 handler：**命令在锁外跑，
     跑完用 `commitState` 在短锁内合并写**。
   - 禁止把整段读-改-写包进 `withStateLock`：持锁超过 `staleMs`(30s) 会被判陈旧并回收，
     另一个进程随即拿到同一把锁 → 同时写入，比不加锁更难复现。
   - 锁等待必须是**异步**的（`sleepAsync`）；同步自旋会冻住整个事件循环。

4.4 **裁定的证据必须属于当前卡（v2.15.0）**
   - `last_verify.card_ts` 与当前卡不一致 → 拒绝 PASS；`flow_verdict` 写入前核对 `card_ts`（CAS）。
   - 老状态缺 `card_ts` 时退化为「验证时间不得早于卡提交时间」，不得直接放行。

4.2 **负对照不得让工作区停在改动前（v2.14.0）**
   - 进入临界区前必须写 `journal.json`；`finally` 里还原后必须逐文件核对摘要。
   - 还原失败时**保留备份目录**（下一次调用靠它恢复），不许删了当没事。

5. **审计链的 legacy 记录不得重置链起点**
   - 旧格式记录（无 hash）只计入 `legacy` 计数，**保持 `prev` 不变**。
   - 重置会让 v2.5 升级上来的用户审计链长期报红 —— 误报比漏报更伤信任。

6.1 **插件清单只能是 chip，且工具面 ≤16 项（v2.14.1）**
   - Cindy 已移除 `kind:"mcp"`；`tools` 超过 16 项直接拒装。
   - 21 个操作走两段式：`ghost.json` 只声明 `list_tools` / `call_tool`，
     `main.js` 的类目表必须**恰好覆盖**服务端全部操作（`check:full` 守着）。
   - 随包 Node 程序不能依赖 node_modules（Forge 打包会跳过），
     所以协议层是自研的 `src/mcp-stdio.mjs`，不是 SDK。

6.2 **只用跨平台写法（v2.16.0 起有门禁）**
   - 取模块所在目录必须 `fileURLToPath(import.meta.url)`，**禁止** `URL.pathname`
     （POSIX 上会变成相对路径，spawn 成功却永远连不上）。
   - 结束外部命令必须整棵树：Windows `taskkill /T /F`、POSIX `detached:true` + `kill(-pid)`；
     裸 `child.kill()` 只杀外壳，命令派生的进程会变孤儿。
   - 由 `npm run check:portability` 强制。

7. **不得引入硬编码密钥 / Token / 路径**
   - 密钥走环境变量；状态目录走 `CARLOS_FLOW_HOME`；路径用 `__ROOT__` 占位符 + `init` 渲染。

7. **工具描述与实现必须一致**
   - 描述里承诺的能力，代码里必须有对应实现。
   - `inputSchema` 声明的参数，handler 必须真的读取。
   - 由 `npm run check:claims` 与 `npm run check:params` 强制。

---

## ✅ 提交前必跑

```bash
npm run test:all            # 主测试套件（smoke + e2e + p0 + trigger + concurrency + acceptance）
npm run test:scope          # 越界拦截真实验证（真实 git 仓库 + 真实改动）
npm run test:audit          # 审计链篡改检测验证（HMAC / plain / legacy / date）
npm run test:bridge         # Bridge 身份隔离（端口上是别人的 bridge 不得复用）
npm run test:sensitive      # 项目级敏感规则：只能追加、否定式无效、坏配置退回基线
npm run test:lock           # 状态锁：退避 / 死锁回收 / fail-closed
npm run test:falsify        # 负对照：还原核对 + 崩溃恢复
npm run test:mcp            # 零依赖 MCP stdio 服务端（握手 / stdout 纯净 / 未知方法）
npm run test:dispatch       # chip 两段式目录（真实服务端 + main.js 端到端）
npm run test:hardening      # 超时整树回收 / 输出截断 / 快照去重 / 存储可观测
npm run test:cas            # 长验证并发合并 + 旧卡证据不得复用
npm run test:roll           # 审计按大小滚动 + 流式校验 + 篡改可检出
npm run test:prune          # 存储清理：只归档终态、可搬回、审计零变动
npm run check:portability   # 跨平台：禁止 URL.pathname、进程树回收、路径归一
npm run test:lang           # 产物语言体检的自检
npm run test:package        # 包级端到端（真实 tarball + 干净安装 + 真实 MCP 握手）
npm run check:full          # 对外产物全面体检
npm run check:claims        # 承诺兑现度门禁
npm run check:params        # 参数有效性门禁
npm run check:no-dead-handler  # 重复注册门禁
npm run check:anchors       # 变异锚点未失效
npm run check:readme        # 双语 README 未漂移
```

变异测试（耗时较长，发布前跑）：

```bash
npm run test:mutation       # 20 类变异体必须 20/20 全部被抓住
```

---

## 📐 加新工具的清单

1. `src/index.js` 的 `TOOLS` 里加定义（`name` / `description` / `inputSchema` / `handler`）
2. `ghost.json` 的 `tools` 里加同样的声明（**Cindy 用户靠它看到工具**，缺了就等于没有）
3. 描述里**不要**承诺实现里没有的能力 —— `npm run check:claims` 会查
4. `inputSchema` 的每个参数都要在 handler 里真的被读取 —— `npm run check:params` 会查
5. 加测试（正常路径 + 至少一个负例）
6. 如果改了门禁语义 → 同步 `src/protocol.js` 与 `README.md` 的能力矩阵

---

## 🔗 相关文档

- [`README.md`](./README.md) — 项目总览与能力矩阵
- [`TRIGGER_GUIDE.md`](./TRIGGER_GUIDE.md) — 触发引擎指南
- [`MIGRATION.md`](./MIGRATION.md) — 旧包迁移
- [`CHANGELOG.md`](./CHANGELOG.md) — 版本历史
- [`docs/AUDIT_REVIEW.md`](./docs/AUDIT_REVIEW.md) — 第三方审查报告的逐条核实与决策记录
- [`SECURITY.md`](./SECURITY.md) — 安全策略与威胁模型

## 发布流程基线 (Release Baseline)
- 发布前必须自动校验审计记录并归档。
- 必须自动更新 CHANGELOG 并合并 Release Notes。
- 执行发布命令必须通过全量 CI 门禁。
