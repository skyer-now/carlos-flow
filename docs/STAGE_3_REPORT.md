# 阶段三报告：四门面收敛、AST 负对照与任务工作区隔离（3.0.0 候选）

## 状态摘要（2026-11-22 / 23:xx 北京时间）

阶段三的三块实现已落地并接入自动化测试，`test:all`、`check:full` 真实退出 0。**这不是 Carlos 正式 PASS**：原生 `flow_run_verify` 仍被“Host固定哈希能力不可用”前置阻断，没有门禁收据、双轴裁定与 auditor 最终裁定。阶段一、二同样停留在该阻断上。

另有一项**未完成的发布决策**必须说明：外部工具面默认仍是 26 个底层操作（保持已发布客户端契约），只有设置 `CARLOS_FLOW_TOOL_SURFACE=external` 时才只暴露四个门面。v3.0.0 要把默认值翻过来，需要同步改客户端、模板与一批以 `flow_*` 名字直连的测试，这一步没有在本轮完成。

## 1. 四门面收敛

- `src/handlers/facade.js`：四个门面的动作表补全到覆盖全部 22 个底层能力：

| 门面 | 动作 → 底层操作 |
|---|---|
| `carlos_task` | submit/start→`flow_submit_requirement`、claim、dispatch、protocol、add_user_msg、save_result |
| `carlos_verify` | run→`flow_run_verify`、falsify、check_scope、trigger_check、diff_hunks |
| `carlos_review` | axes、submit、guard、verdict、audit |
| `carlos_manage` | status、cancel、revert、stats、bypass、mode |

- 新增 `FACADE_ACTIONS` 冻结路由表（导出即只读）。
- `src/handlers/catalog.js` 新增 `createExternalCatalog`：只返回四个门面，并在装配期做**双向覆盖校验**——底层能力没有门面动作、或门面动作指向未登记操作，都直接拒绝启动；同时要求外部面恰好四个。
- `src/index.js` 增加 `CARLOS_FLOW_TOOL_SURFACE` 开关（默认 `legacy` 26 操作，`external` 为四门面）。
- 新增 `test/facade-surface.test.mjs`（5 项）：外部面恰好 4 个且名称固定；22 个能力全部可达且无多余目标；**每个动作真实路由**（stub 记录目标并逐一断言）；schema 枚举与路由表一致；内部 26 个操作仍在。

## 2. AST 自动负对照

- 新增 `scripts/ast-negative-control.mjs`：
  - 用 **acorn 8.15.0**（MIT，tarball 约 130KB，纯 JS）解析，不用正则冒充 AST；
  - 支持 `assert.*`、`t.assert.*`、`expect(...).toBe/toEqual` 等链式断言；
  - 比较基线/候选的断言签名多重集，识别**删除**、**弱化**（`strictEqual` → `ok`）、**新增 skip/todo**；
  - 预算：单文件 2MB、AST 节点 20 万；超预算/解析失败/基线无可比较断言一律退出 2（“无法判断”），绝不当作通过；
  - 退出码：0 无退化 / 1 发现退化 / 2 无法判断。
- 新增 `test/ast-negative-control.test.mjs`（7 项），包含计划要求的真实负例：**候选实现是坏的（排序没生效）但唯一能发现它的断言被删掉，直接跑候选测试仍然退出 0**，AST 比较必须检出（退出 1）。另有 skip 检出、弱化检出、语法错误退出 2、无断言退出 2、缺参退出 2。
- 依赖取舍：`package.json` 增加唯一运行时依赖 `acorn@8.15.0`；`package-lock.json` 同步（同时清理了历史遗留、与 package.json 不一致的 `@modelcontextprotocol/sdk` 条目——源码早已改为自带 MCP stdio 实现）。

## 3. 单人任务 Git Worktree 隔离

- 新增 `src/worktree.js`：
  - 任务标识白名单（字母数字与 `._-`，最长 40，拒绝 `..` 与路径分隔符）；
  - 基线必须是有效提交；主工作区脏且未显式给基线时**拒绝隐式迁移**；
  - 工作区根必须是已存在目录，目标父目录真实路径必须仍等于根本身（拒绝越界与符号链接逃逸）；
  - **先登记再创建**：`FLOW_HOME/tasks/<id>/worktree.json` 记录 repo、真实路径、基线 ref/commit、状态；创建中断或 HEAD 不一致时保留现场，不静默删除；
  - 清理只针对已登记工作区：有 `running` 标记拒绝，有未提交/未跟踪改动拒绝（除非显式 force），用 Git 原生 `worktree remove`，**不做全局 prune**，登记随后删除。
- 新增 `test/worktree-isolation.test.mjs`（10 项）：标识穿越拒绝、从明确提交创建并登记、两个任务互不污染、脏主工作区拒绝隐式迁移（显式基线仍可建）、无效基线拒绝且不留登记、越界路径拒绝、未交付改动拒绝清理（force 后可清）、运行中标记阻止清理、未登记目录不被触碰、清理后主仓库 worktree 列表同步。

## 验证证据

- 证据目录：`D:/cindy/task-evidence/stage3-validation-20261122-235322/`
- 完整日志：`full.log`，SHA256 `e29dcd3b27b3d779aea2bc64e26c5eef5c0b0927cb63fe4501c87d9ed87891b0`
- 开始 `2026-11-22T23:53:22+08:00`，结束 `2026-11-23T00:01:55+08:00`
- `TEST_ALL_EXIT=0`（`full.log:1668`）、`CHECK_FULL_EXIT=0`（`full.log:1686`）
- 专项：stage2 25/25、auto-verify-qasheet 7/7、knowledge-mesh 5/5、proactive-guidelines 5/5、worktree 10/10（`full.log:1546`）、AST 7/7（`full.log:1609`）、facade 5/5（`full.log:1660`）
- 测试隔离 `CARLOS_FLOW_HOME`/`HOME`/`USERPROFILE`/`TMP` 到 D 盘任务目录，日志含 `START`/`TEST_ALL_EXIT`/`CHECK_FULL_EXIT`/`END`。

## 未验证 / 未完成

1. **外部工具面默认值未翻转**：v3.0.0 需要把 `legacy` 改为 `external` 默认，并同步客户端、模板、README 与直连 `flow_*` 的测试；本轮只做到“开关可用且路由完整”。
2. **MCP 端到端未用 external 面跑通**：`test/mcp-stdio`、`e2e-carlos` 等仍走 26 操作默认面；external 面的端到端发现与调用只有目录级测试。
3. **acorn 在 npm 安装产物与 Cindy 随包环境未实测**（计划要求两处分别核实）；本轮只验证了工作区 `node_modules` 下可用。
4. **AST 负对照只支持 JS/ESM 断言调用**，不覆盖其它语言与所有作弊方式；`assert.rejects` 等异步断言的参数结构未做专门比对。
5. **worktree 的崩溃恢复未实测**（创建中断/进程被杀后按登记人工恢复的流程只有设计，没有故障注入测试）。
6. 原生 `flow_run_verify` / `flow_falsify` / 双轴 / 裁定仍因 Host 能力阻断未执行。
7. 版本号仍为 2.28.1，未升到 3.0.0，未打标签、未发布、未安装。

## 边界

- 不自动安装、不重启、不公开发布、不删除用户项目。
- worktree 清理只作用于本工具登记过的目录，不使用 `git worktree prune`。
- AST 负对照不修改被测文件，只读取并比较。
- 未改动既有 26 操作契约的默认行为。

## 回滚

新增文件（`src/worktree.js`、`scripts/ast-negative-control.mjs`、三个专项测试）可直接删除；`src/handlers/facade.js`、`catalog.js`、`src/index.js`、`package.json`/`package-lock.json` 可用 `git checkout --` 还原；`FLOW_HOME/tasks/` 为新增目录。