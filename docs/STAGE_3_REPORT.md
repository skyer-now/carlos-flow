# 阶段三报告：四门面收敛、AST 负对照与任务工作区隔离（3.0.0 候选）

## 状态摘要（2026-11-22 / 23:xx 北京时间）

阶段三的三块实现已落地并接入自动化测试，`test:all`、`check:full` 真实退出 0。**这不是 Carlos 正式 PASS**：原生 `flow_run_verify` 仍被“Host固定哈希能力不可用”前置阻断，没有门禁收据、双轴裁定与 auditor 最终裁定。阶段一、二同样停留在该阻断上。

对外工具面默认已翻转为四个门面；旧客户端/脚本可用 `CARLOS_FLOW_TOOL_SURFACE=legacy` 恢复 26 个底层工具目录。仓库内以底层契约为主的协议、包级与端到端测试显式使用 legacy 面，四门面的对外默认行为由 `test/facade-surface.test.mjs` 经真实 MCP 入口覆盖。

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
- `src/index.js`：对外默认只暴露四个门面（v3），`CARLOS_FLOW_TOOL_SURFACE=legacy` 恢复 26 个底层工具目录。分发与参数校验查的是**完整目录**，对外可见面只影响 `tools/list`，因此门面动作在 external 面下仍能路由（首版实现把两者混成一个数组，导致 external 面全部动作返回 Unknown tool，已修并补端到端测试）。
- 新增 `test/facade-surface.test.mjs`（7 项）：外部面恰好 4 个且名称固定；22 个能力全部可达且无多余目标；**每个动作真实路由**；schema 枚举与路由表一致；**external 面经真实 MCP 入口**列工具并调用门面（并断言返回目标工具的真实结构）；门面 schema 覆盖底层必填与关键参数、转发时剔除 `action`；未知动作明确失败；内部 26 个操作仍在。

## 2. AST 自动负对照

- 新增 `scripts/ast-negative-control.mjs`：
  - 用 **acorn 8.15.0**（MIT，官方 ESM 构建，约 230KB）解析，不用正则冒充 AST；**随包 vendored 到 `vendor/acorn.mjs`**（附 `acorn-LICENSE`），不依赖宿主 `node_modules`；
  - 支持 `assert.*`、`t.assert.*`、`expect(...).toBe/toEqual` 等链式断言；
  - 新增 `scripts/check-ast-assertions.mjs`（`check:ast`）：对 `git diff HEAD` 中改动的测试文件做前后比对，删除断言/改期望值/新增 skip 退出 1，无法判断退出 2。
  - 比较基线/候选的断言签名多重集；签名只含“方法名 + 字面量”，因此重命名变量不会误报，而改期望值（`2`→`3`）会作为 `changed` 被检出；同时识别**弱化**（`strictEqual` → `ok`）与**新增 skip/todo**；
  - 预算：单文件 2MB、AST 节点 20 万；超预算/解析失败/基线无可比较断言一律退出 2（“无法判断”），绝不当作通过；
  - 退出码：0 无退化 / 1 发现退化 / 2 无法判断。
- 新增 `test/ast-negative-control.test.mjs`（9 项），包含计划要求的真实负例：**候选实现是坏的（排序没生效）但唯一能发现它的断言被删掉，直接跑候选测试仍然退出 0**，AST 比较必须检出（退出 1）。另有 skip 检出、弱化检出、重命名不误报、改期望值检出、语法错误退出 2、无断言退出 2、缺参退出 2。
- 依赖取舍：**不新增 npm 依赖**，改为随包携带 acorn；理由是 Cindy 插件以 `.cindy` 形态运行、宿主不保证安装 `node_modules`（已实测本机插件目录无依赖）。
- 打包实测：`npm pack` 产物解包后**没有 node_modules**，直接运行 `scripts/ast-negative-control.mjs` 仍能检出断言删除（退出 1）与无退化（退出 0）。回执见 `D:/cindy/task-evidence/acorn-pack-verify-20261123-072337/receipt.json`：tarball SHA256 `496b6f53…`、vendored acorn SHA256 `b4c8c702…`、`node_modules_present=false`。

## 3. 单人任务 Git Worktree 隔离

- 新增 `src/worktree.js`，并接入验证路径：任务卡 `env.worktree` 指向已登记工作区时，`flow_run_verify` 优先在该目录执行并写运行标记，裁定落盘后清除；派发 Prompt 的记忆解析也按该工作区项目取：
  - 任务标识白名单（字母数字与 `._-`，最长 40，拒绝 `..` 与路径分隔符）；
  - 基线必须是有效提交；主工作区脏且未显式给基线时**拒绝隐式迁移**；
  - 工作区根必须是已存在目录；目标用 `lstat` 检查，已存在同名文件/目录/悬空链接一律拒绝；登记记录要求 `path` 位于登记时的受控根下；
  - **先登记再创建**：`FLOW_HOME/tasks/<id>/worktree.json` 记录 repo、真实路径、受控根、基线 ref/commit、状态；`worktree add` 失败或 HEAD 不一致时保留登记（标记 `failed`/`mismatch`），不销毁唯一记录；
  - 清理只针对已登记工作区：登记内容不合法（非对象、`task_id` 不一致、缺路径）直接拒绝；有 `running` 标记拒绝；有未提交/未跟踪改动拒绝（除非显式 force）；用 Git 原生 `worktree remove`，**不做全局 prune**。
  - 任务标识额外拒绝 Windows 尾点与保留设备名（`CON`/`NUL`/`COM1` 等）。
- 新增 `test/worktree-isolation.test.mjs`（15 项）：标识穿越拒绝、从明确提交创建并登记、两个任务互不污染、脏主工作区拒绝隐式迁移（显式基线仍可建）、无效基线拒绝且不留登记、越界路径拒绝、未交付改动拒绝清理（force 后可清）、运行中标记阻止清理、未登记目录不被触碰、清理后主仓库 worktree 列表同步。

## 验证证据

- 证据目录：`D:/cindy/task-evidence/stage3-v3final4-20261123-080423/`
- 完整日志：`full.log`，SHA256 `9387684f3dee963bb2d25416d29625b3c1586b4eacc989760c0a6ee01731fce7`
- 开始 `2026-11-23T08:04:23+08:00`，结束 `2026-11-23T08:10:26+08:00`
- `TEST_ALL_EXIT=0`（`full.log:1793`）、`check:params` 0（`:1816`）、`check:no-dead-handler` 0（`:1836`）、`check:readme` 0（`:1847`）、`check:identity` 0（`:1919`）、`check:ast` 0（`:1925`；本次无改动测试文件，判别力由 `test/check-ast-assertions.test.mjs` 覆盖）、`smoke-test.js` 0（`:1932`）、`CHECK_FULL_EXIT=0`（`:1950`）
- 专项：stage2 25/25、auto-verify-qasheet 7/7、knowledge-mesh 5/5、proactive-guidelines 5/5、worktree 15/15（`full.log:1576`）、AST 9/9（`:1651`）、AST 门禁 8/8（`:1716`）、facade 8/8（`:1785`）
- 测试隔离 `CARLOS_FLOW_HOME`/`HOME`/`USERPROFILE`/`TMP` 到 D 盘任务目录，日志含 `START`/`TEST_ALL_EXIT`/`CHECK_FULL_EXIT`/`END`。

## 已知波动

首轮完整回归（`stage3-v3final3-20261123-075417`）在 `test:concurrency` 的 M12 屏障等待处报 `FATAL UNKNOWN 运行未确认`（10 秒等待超时），同一命令单独重跑 4/4 通过、整体重跑全绿。该用例按设计把未知执行判为 UNKNOWN 而不是放行；这里如实记录为“高负载下的偶发超时”，不当作代码缺陷，也没有修改测试阈值。

## 未验证 / 未完成

1. **external 面未覆盖全部动作的端到端调用**：已有“真实 MCP 入口 + 门面调用 + 未知动作失败”的端到端用例，但 22 个动作只做了目录级逐一路由断言，没有全部经 MCP 实测。
2. acorn 已随包 vendored，并用无 node_modules 的打包产物实测；未在真实 Cindy 插件进程内再跑一次（同一份文件）。（计划要求两处分别核实）；本轮只验证了工作区 `node_modules` 下可用。
3. **AST 负对照只支持 JS/ESM 断言调用**，不覆盖其它语言与所有作弊方式；`assert.rejects` 等异步断言的参数结构未做专门比对。
4. **worktree 只接入验证路径**：`flow_dispatch` 仍以卡上项目目录为准；崩溃恢复未做故障注入。
5. 原生 `flow_run_verify` / `flow_falsify` / 双轴 / 裁定仍因 Host 能力阻断未执行。
6. `npm ci` 未实跑（只按 lock 内容判断可装）。
7. 版本号已对齐 3.0.0（package/lock/ghost/TRIGGER_GUIDE/CHANGELOG），未打标签、未发布、未安装。

## 边界

- 不自动安装、不重启、不公开发布、不删除用户项目。
- worktree 清理只作用于本工具登记过的目录，不使用 `git worktree prune`。
- AST 负对照不修改被测文件，只读取并比较。
- 未改动既有 26 操作契约的默认行为。

## 回滚

新增文件（`src/worktree.js`、`scripts/ast-negative-control.mjs`、三个专项测试）可直接删除；`src/handlers/facade.js`、`catalog.js`、`src/index.js`、`package.json`/`package-lock.json` 可用 `git checkout --` 还原；`FLOW_HOME/tasks/` 为新增目录。