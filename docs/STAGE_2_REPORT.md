# 阶段二报告：项目隔离避坑记忆与真实质检单（2.29.0 候选）

## 状态摘要（2026-11-22 北京时间）

阶段二的代码、测试与文档已完成，`test:all`、`check:full` 真实退出 0。**这不是 Carlos 正式 PASS**：原生 `flow_run_verify` 仍被“Host固定哈希能力不可用”前置阻断，未取得验证收据，也没有双轴裁定与 auditor 最终裁定。阶段一同样停留在该阻断上。

因此本报告只声明“工程实现完成并经真实回归与独立审查”，不声明“门禁验收通过”。

## 做了什么

### 1. 项目隔离的避坑记忆（`src/failure-memory.js`，新文件）

旧实现把经验写进 `FLOW_HOME/failure-memory.json` 单一文件，任何项目读同一份：A 仓库的坑会注入到 B 仓库的派发 Prompt，旧记录也无法判断归属。

新实现：

- **项目身份**：`git rev-parse --git-common-dir` 的真实路径作为身份源，同一仓库的多个 worktree 共享一个分区，不同仓库互不相通；非 Git 目录退化为真实路径。Windows 下按小写归一；解析 Git 时剔除继承的 `GIT_DIR`/`GIT_WORK_TREE` 等变量，避免被环境变量合并成同一项目。
- **存储**：`FLOW_HOME/projects/<key>/failure-memory.json`，仍复用同一个 `CARLOS_FLOW_HOME`，没有第二套知识库。
- **旧全局记忆**：只做只读计数（`legacy.count` / `legacy.ignored`），不自动归入任何项目，也不参与注入。
- **预算**：最多 40 条、单条 500 字符、文件 64KB；写入前裁剪，读取时同时校验文件大小与条数，被外部放大的文件按“降级”处理而不是整份读入。
- **并发安全**：读-改-写用 `O_EXCL` 锁文件互斥，等待上限 5 秒，持有者崩溃留下的陈旧锁（>10 秒）可回收；临时文件 + `fsync` + `rename` 原子落盘，rename 后尽力刷目录项。
- **失败不静默**：临时文件写入/rename 失败会清理 tmp 并返回 `ok=false`；`candidates.json` 或 `index.json` 损坏时拒绝覆盖（索引先改名保留 `.corrupt-<ts>` 再重建）。
- **脱敏**：与质检单共用 `src/redact.js` 一份实现，覆盖用户主目录、UNC、其余绝对路径（保留最后一段文件名）、`ghp_`/`github_pat_`/`AKIA`/`xox*`/`sk-`/Bearer/Basic、私钥块、JSON 与命令行两种键值凭据形态。
- **降级**：文件损坏时返回 `degraded=true` 与原因，注入中显式写“暂不可用”。

### 2. 采集与核实接线

- 分类器只把**明确业务断言失败**（`AssertionError`、`assert.xxx`、`expected … to …`）判为可采集；语法错误、缺模块、权限、网络错误、超时、未知退出码一律不入库；只有 `not ok N` + `✗` 而无断言证据时判为 `runner-failure`，同样不入库。
- 断言事实提取不再“匹配不到就取第一行”，宁可采集不到，也不把无关输出当事实。
- `flow_run_verify` 失败后写入“待核实候选”（`candidates.json`），**不直接进入注入**。
- `confirm <候选ID>` 核实后才转正为项目规则，此后才参与派发 Prompt 注入（最近 3 条）。
- 采集失败不影响验证结果，也不会向调用方谎报保存成功。
- 派发时若拿不到真实工作目录，**不注入任何记忆**，绝不回落到 MCP server 启动目录。

### 3. 质检单不再假绿（`ui/narrator.js`）

旧 `generateQASheet` 在缺字段时直接输出 `✅ PASS`、`exitCode = 0`、`已校验`，并把“恢复重来”说成一键还原。现在：

- **PASS 由证据派生**：必须先没有任何未验证项，才允许 `completed_ok && verdict PASS && auditor` 写 PASS。PASS 落盘后再跑一次失败的验证、负对照被清空、双轴缺失或属于旧卡，都会压制 PASS 头条。
- 验证证据要求：退出码存在、`ok===true`、输出哈希为 64 位、`card_ts` 与当前卡一致、命令与卡上命令一致。
- 负对照要求：命令一致、`verdict==='meaningful'`、改动前失败、改动后通过、还原核对通过；并用“改动后哈希 = 当前验证输出哈希”与时间顺序绑定同一次运行，旧卡证据不会被复用。
- 双轴要求：两条轴均有 PASS/WARN 结论、非空证据、`card_ts` 与当前卡一致。
- 过期由调用方传入真实 `isStale` 结果（`generateQASheet(state, notes, { stale })`，`flow_submit_requirement` 生成质检单时已接线）。
- 回滚只说明“可生成还原计划、不会自动执行”；门禁错误翻译里“一键回滚立即还原”的旧承诺同步改掉。

### 4. 明确导出操作（`scripts/failure-memory.mjs`，新文件）

```
node scripts/failure-memory.mjs list    --cwd <项目目录>
node scripts/failure-memory.mjs confirm <候选ID> --cwd <项目目录> [--note <说明>]
node scripts/failure-memory.mjs qa-sheet --session <会话ID> --out <绝对输出目录> [--notes <说明>]
```

`qa-sheet` 必须显式给出绝对输出目录，原子写入并返回 `sha256` 与字节数；未给目录、相对路径、写入失败都返回 `ok=false`。

## 验证证据

命令与结果（隔离 `CARLOS_FLOW_HOME`/`HOME`/`USERPROFILE`/`TMP` 到 D 盘任务目录）：

| 命令 | 结果 |
|---|---|
| `npm run test:all` | 见下方“最终证据” |
| `npm run check:full` | 见下方“最终证据” |

阶段二专项 `test/stage2-failure-memory.test.mjs` 共 25 项，覆盖：

- 项目身份：worktree 共享、跨仓库隔离、`GIT_DIR` 不污染身份；
- 写入：去重、条数上限、**8 个进程真实并发同时写入后 8 条全部保留**、坏 `failure-memory.json` 与坏 `candidates.json` 均拒绝覆盖；
- 旧全局记忆不注入、降级提示可见；
- 脱敏：用户名、家目录、JSON 凭据、GitHub PAT、AWS Key、Basic 头、非家目录绝对路径；
- 分类：断言/语法/缺模块/超时/未知/运行器失败，只有断言入候选；
- 核实转正后才进入注入；
- 质检单：缺证据不假绿、证据齐全才 PASS、PASS 后验证失败/负对照缺失/负对照属于旧卡/双轴缺失均压制 PASS、过期（字段与真实 `isStale` 两条路径）不得 PASS；
- 导出：文件真实存在且哈希一致、内容脱敏、拒绝缺失或相对输出目录；
- 测试结束清理临时仓库与 worktree。

另有三份既有专项接入自动化入口（`test:unit`，并挂在 `test:all` 链尾）：`test/auto-verify-qasheet.test.mjs`（7 项，含新增的“证据齐全才 PASS”与“缺证据不得 PASS”）、`test/knowledge-mesh.test.mjs`（5 项）、`test/proactive-guidelines.test.mjs`（5 项，已补导入前隔离与“无工作目录不注入”）。

## 独立审查与修复

第一轮独立只读审查给出 FAIL，指出 16 项问题；第二轮复审确认大部分已修，但指出 3 项未修/部分修与 4 个新问题。两轮问题均已处理：

第一轮（16 项）：

1. PASS 头条与证据脱钩（可达假绿）→ 改为证据派生，并补反向用例；
2. 过期只认自报字段 → 接真实 `isStale`（门禁生成质检单与 CLI 导出两处），并保留字段路径；
3. 并发无锁会丢记录、原“并发测试”实为串行 → 加互斥锁，测试改为 8 进程真实同时写入；
4. 负对照/双轴未绑定当前卡 → 加 `card_ts`、命令、哈希、时间绑定；
5. `candidates.json`/`index.json` 损坏被静默覆盖 → 拒绝覆盖 / 改名保留；
6. tmp 失败不清理、无目录 fsync → 清理 + 尽力 fsync；
7. 分类过宽（`not ok`/`✗` 误判断言）→ 收窄并新增 `runner-failure`；
8. 预算与读路径不一致 → 读写两侧都校验；
9. 脱敏遗漏且两套实现 → 合并为 `src/redact.js` 并补形态；
10. 三份被修改专项不在任何 npm 脚本 → 新增 `test:unit` 并入 `test:all`；
11. 无工作目录时回落到进程目录 → 不注入；
12. 测试临时目录不清理 → 三份专项均加 `after()` 清理；
13. `proactive-guidelines` 未隔离 → 导入前隔离；
14. 索引先写导致“项目已存在”谎报 → 先写数据再登记；
15. CLI 输出泄露绝对 `flowHome` 与项目真实路径 → 统一脱敏输出；
16. 门禁错误翻译仍承诺“一键回滚立即还原” → 改为还原计划、不自动执行。

第二轮（3 项未修 + 4 项新问题）：

- **预算自愈**：原预算用紧凑 JSON 估算，pretty 落盘会超 64KB，写完自己读不回来。改为按真实落盘形式计预算（含 `project` 字段、保留 1KB 余量），读侧放宽到硬上限 1MB 并对超预算文件裁剪 + 标记 `trimmed`，下一次写入即落盘为裁剪后内容；已加“写满后仍可读可写”测试。
- **CLI 绕过过期判定**：`qa-sheet` 现调用门禁同一口径的 `isStale`，并禁止把交付物写进 `CARLOS_FLOW_HOME`；已加 CLI 级测试（过期卡导出无 PASS、状态目录被拒）。
- **CLI 泄露绝对路径**：`list` 与项目身份输出统一脱敏，测试断言输出不含绝对 `FLOW_HOME` 与盘符路径。
- **“自动派发复核/自动完成验收”与 README“一键还原”承诺**：翻译器与三份 README 改为“还原计划、确认后执行”，不再宣称自动验收。
- **验证失败后 `flow_status.completed_ok` 仍报绿**：`flow_run_verify` 失败时在同一短锁内清除 `completed_ok`/`verdict`/`verdict_role`/`verdict_ts`，只清裁定字段，不动卡与快照。
- **锁的健壮性**：锁目录不可写时返回 `ok=false` 而不是抛出；临界区必须是同步函数（异步直接报错），避免解锁后继续写；`candidates` 读侧也限制条数。
- **脱敏遗漏 UNC 与任意 POSIX 绝对路径**：补通用 UNC 与“至少两段且带文件名”的 POSIX 路径，家目录只保留最后一段；用户名目录规则修正为匹配整段路径（原实现只匹配到第一段，会漏出用户名）。

第三轮终审结论为 PASS（可提交），遗留低危项已顺手处理：

- 超预算文件裁剪后仍注入规则（附“已裁剪”提示），不再整体作废；新增“70KB 合法文件 → 仍注入 + 下一次写入自愈”测试；
- 路径恰好止于用户目录时不再回填用户名（`C:Usersalice`、`/home/bob` 不再泄露）；
- 锁释放前核对 token，避免临界区超时被抢占后误删他人的锁；
- `confirm` 读取候选改用硬上限，与 `list` 口径一致；
- 索引登记写入失败不再抛异常，按 `index_warning` 返回。

仍留 backlog（不阻塞提交）：验证失败清除裁定的回归测试、陈旧锁回收与高竞争吞吐压力测试、macOS/Linux 脱敏实测、索引损坏改名分支测试、CLI `confirm` 子命令测试。`projectLessons` 目前无调用方，保留为导出 API。

## 最终证据

- 最终证据目录：`D:/cindy/task-evidence/stage2-validation-20261122-233727/`
- 完整日志：`full.log`，SHA256 `ad23cd24e4b2512d2a529b2dd2218f20e735ba7dbec0b9925987003d373e7850`
- 开始 `2026-11-22T23:37:27+08:00`，结束 `2026-11-22T23:46:18+08:00`
- `TEST_ALL_EXIT=0`（`full.log:1473`）、`CHECK_FULL_EXIT=0`（`full.log:1491`）
- 专项：`test:stage2` 25/25 通过、`test:unit` 中 auto-verify-qasheet 7/7、knowledge-mesh 5/5、proactive-guidelines 5/5（`full.log:1351-1462`）

首次全量（早于独立审查修复，不作为最终成绩）：`stage2-validation-20261122-223009/full.log`，`TEST_ALL_EXIT=0`、`CHECK_FULL_EXIT=0`，SHA256 `f16d342fcc01f486bce17421aeacd406d62b80e4f30add89d85d1162ebe29850`。

## 未验证 / 未完成

1. 原生 `flow_run_verify` / `flow_falsify` 未执行，阶段二没有门禁收据。
2. 双轴审查与 auditor 裁定未提交（与阶段一同因 Host 能力阻断）。
3. 采集接线只验证了分类与存储逻辑，未在真实长测失败上跑通一次端到端采集（需要原生验证失败现场）。
4. 跨平台仅覆盖 Windows 本机；macOS/Linux 的大小写敏感分支与 `/home`、`/Users` 脱敏未实测。
5. 版本号仍为 2.28.1，未升到 2.29.0，也未打标签或发布。
6. 锁的跨进程公平性与高竞争下的吞吐未做压力测试（只验证了 8 进程不丢记录）。

## 边界

- 不修改用户真实失败记忆：所有测试使用 D 盘临时 `CARLOS_FLOW_HOME`。
- 不自动安装、不重启、不公开发布、不删除项目。
- 旧全局 `failure-memory.json` 保留原样，不迁移、不删除。
- 导出只写显式给出的目录，不猜默认位置。

## 回滚

本次改动均为未提交工作区变更，可用 `git checkout -- <file>` 与删除四个新文件（`src/failure-memory.js`、`src/redact.js`、`scripts/failure-memory.mjs`、`test/stage2-failure-memory.test.mjs`）回滚；`FLOW_HOME/projects/` 为新增目录，删除不影响既有 `gate-state` 与 `gate-audit`。