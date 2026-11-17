# AGENTS.md — 修改前必读

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

4.2 **负对照不得让工作区停在改动前（v2.14.0）**
   - 进入临界区前必须写 `journal.json`；`finally` 里还原后必须逐文件核对摘要。
   - 还原失败时**保留备份目录**（下一次调用靠它恢复），不许删了当没事。

5. **审计链的 legacy 记录不得重置链起点**
   - 旧格式记录（无 hash）只计入 `legacy` 计数，**保持 `prev` 不变**。
   - 重置会让 v2.5 升级上来的用户审计链长期报红 —— 误报比漏报更伤信任。

6. **不得引入硬编码密钥 / Token / 路径**
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
