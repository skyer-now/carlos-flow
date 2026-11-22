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
- `src/index.js` 增加 `CARLOS_FLOW_TOOL_SURFACE` 开关（默认 `legacy` 26 操作，`external` 为四门面）。分发与参数校验查的是**完整目录**，对外可见面只影响 `tools/list`，因此门面动作在 external 面下仍能路由（首版实现把两者混成一个数组，导致 external 面全部动作返回 Unknown tool，已修并补端到端测试）。
- 新增 `test/facade-surface.test.mjs`（7 项）：外部面恰好 4 个且名称固定；22 个能力全部可达且无多余目标；**每个动作真实路由**；schema 枚举与路由表一致；**external 面经真实 MCP 入口**列工具并调用门面（并断言返回目标工具的真实结构）；门面 schema 覆盖底层必填与关键参数、转发时剔除 `action`；未知动作明确失败；内部 26 个操作仍在。

## 2. AST 自动负对照

- 新增 `scripts/ast-negative-control.mjs`：
  - 用 **acorn 8.15.0**（MIT，tarball 约 130KB，纯 JS）解析，不用正则冒充 AST；
  - 支持 `assert.*`、`t.assert.*`、`expect(...).toBe/toEqual` 等链式断言；
  - 比较基线/候选的断言签名多重集；签名只含“方法名 + 字面量”，因此重命名变量不会误报，而改期望值（`2`→`3`）会作为 `changed` 被检出；同时识别**弱化**（`strictEqual` → `ok`）与**新增 skip/todo**；
  - 预算：单文件 2MB、AST 节点 20 万；超预算/解析失败/基线无可比较断言一律退出 2（“无法判断”），绝不当作通过；
  - 退出码：0 无退化 / 1 发现退化 / 2 无法判断。
- 新增 `test/ast-negative-control.test.mjs`（9 项），包含计划要求的真实负例：**候选实现是坏的（排序没生效）但唯一能发现它的断言被删掉，直接跑候选测试仍然退出 0**，AST 比较必须检出（退出 1）。另有 skip 检出、弱化检出、重命名不误报、改期望值检出、语法错误退出 2、无断言退出 2、缺参退出 2。
- 依赖取舍：`package.json` 增加唯一运行时依赖 `acorn@8.15.0`；`package-lock.json` 同步（同时清理了历史遗留、与 package.json 不一致的 `@modelcontextprotocol/sdk` 条目——源码早已改为自带 MCP stdio 实现）。

## 3. 单人任务 Git Worktree 隔离

- 新增 `src/worktree.js`（当前是独立库，尚未接入 `flow_dispatch`/`flow_run_verify`，所以“任务默认在独立工作区执行”还没有生效）：
  - 任务标识白名单（字母数字与 `._-`，最长 40，拒绝 `..` 与路径分隔符）；
  - 基线必须是有效提交；主工作区脏且未显式给基线时**拒绝隐式迁移**；
  - 工作区根必须是已存在目录；目标用 `lstat` 检查，已存在同名文件/目录/悬空链接一律拒绝；登记记录要求 `path` 位于登记时的受控根下；
  - **先登记再创建**：`FLOW_HOME/tasks/<id>/worktree.json` 记录 repo、真实路径、受控根、基线 ref/commit、状态；`worktree add` 失败或 HEAD 不一致时保留登记（标记 `failed`/`mismatch`），不销毁唯一记录；
  - 清理只针对已登记工作区：登记内容不合法（非对象、`task_id` 不一致、缺路径）直接拒绝；有 `running` 标记拒绝；有未提交/未跟踪改动拒绝（除非显式 force）；用 Git 原生 `worktree remove`，**不做全局 prune**。
  - 任务标识额外拒绝 Windows 尾点与保留设备名（`CON`/`NUL`/`COM1` 等）。
- 新增 `test/worktree-isolation.test.mjs`（10 项）：标识穿越拒绝、从明确提交创建并登记、两个任务互不污染、脏主工作区拒绝隐式迁移（显式基线仍可建）、无效基线拒绝且不留登记、越界路径拒绝、未交付改动拒绝清理（force 后可清）、运行中标记阻止清理、未登记目录不被触碰、清理后主仓库 worktree 列表同步。

## 验证证据

- 证据目录：`D:/cindy/task-evidence/stage3-validation-20261123-003819/`
- 完整日志：`full.log`，SHA256 `9bb253085223264f17443840873176f23ace50827b54b4dc642cd0a469c6f159`
- 开始 `2026-11-23T00:38:19+08:00`，结束 `2026-11-23T00:45:06+08:00`
- `TEST_ALL_EXIT=0`（`full.log:1704`）、`check:params` 0（`full.log:1727`）、`check:no-dead-handler` 0（`full.log:1747`）、`CHECK_FULL_EXIT=0`（`full.log:1765`）
- 专项：stage2 25/25、auto-verify-qasheet 7/7、knowledge-mesh 5/5、proactive-guidelines 5/5、worktree 12/12（`full.log:1558`）、AST 9/9（`full.log:1633`）、facade 7/7（`full.log:1696`）
- 测试隔离 `CARLOS_FLOW_HOME`/`HOME`/`USERPROFILE`/`TMP` 到 D 盘任务目录，日志含 `START`/`TEST_ALL_EXIT`/`CHECK_FULL_EXIT`/`END`。

## 未验证 / 未完成

1. **外部工具面默认值未翻转**：v3.0.0 需要把 `legacy` 改为 `external` 默认，并同步客户端、模板、README 与直连 `flow_*` 的测试；本轮只做到“开关可用且路由完整”。
2. **external 面未覆盖全部动作的端到端调用**：已有“真实 MCP 入口 + 门面调用 + 未知动作失败”的端到端用例，但 22 个动作只做了目录级逐一路由断言，没有全部经 MCP 实测。
3. **acorn 在 npm 安装产物与 Cindy 随包环境未实测**（计划要求两处分别核实）；本轮只验证了工作区 `node_modules` 下可用。
4. **AST 负对照只支持 JS/ESM 断言调用**，不覆盖其它语言与所有作弊方式；`assert.rejects` 等异步断言的参数结构未做专门比对。
5. **worktree 尚未接入派发/验证流程**（`flow_dispatch`/`flow_run_verify` 仍跑在主工作区），`running` 标记目前只有测试写入；崩溃恢复未做故障注入。
6. 原生 `flow_run_verify` / `flow_falsify` / 双轴 / 裁定仍因 Host 能力阻断未执行。
7. `acorn` 未在 npm 安装产物与 Cindy 随包环境实测；`npm ci` 未实跑（只按 lock 内容判断可装）。
8. 版本号仍为 2.28.1，未升到 3.0.0，未打标签、未发布、未安装。

## 边界

- 不自动安装、不重启、不公开发布、不删除用户项目。
- worktree 清理只作用于本工具登记过的目录，不使用 `git worktree prune`。
- AST 负对照不修改被测文件，只读取并比较。
- 未改动既有 26 操作契约的默认行为。

## 回滚

新增文件（`src/worktree.js`、`scripts/ast-negative-control.mjs`、三个专项测试）可直接删除；`src/handlers/facade.js`、`catalog.js`、`src/index.js`、`package.json`/`package-lock.json` 可用 `git checkout --` 还原；`FLOW_HOME/tasks/` 为新增目录。