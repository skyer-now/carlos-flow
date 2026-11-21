# 阶段一候选报告（2.28.1，本地发布准备）

## 结论与边界

基线 `42b19d6`。阶段一代码与本地版本准备已完成，最新短专项和 `npm run test:all` 实际退出 0。**尚未完成完整 26 类变异与最终独立双轴审查，不构成阶段 PASS。** 按父任务安排暂停完整长变异，留待同一候选冻结后续跑。

未提交、推送、公开发布或安装；未修改用户真实状态、失败记忆或结束用户应用。版本由父任务后续授权准备为 2.28.1，不代表已经发行。父任务单独维护 THREE_STAGE_PLAN。

## 基线真实失败

- 基线全量退出 1；e2e 97/97 等通过，但 Bridge fixture 对既有空 `src/handlers/` 按普通文件读取，出现 EISDIR，Bridge 0 条断言执行，后续链未运行。追加授权后仅改为递归复制，原断言不删。
- 原 M13 锚点已失效，不能把定位失败算检出。现在故障靶点为真实 classifySideEffect 的改动动词分支。
- 施工首次拆分遗漏动态 trigger 导入相对路径，出现缺模块真失败，已修复；旧变异冻结基线因此失败，**不计有效安全证伪**。
- 施工隔离启动环境的 HOME 路径分隔符一度导致旧测试前缀比较失败，仅修正启动环境，不改原测试。
- 预审增加 audit_pending 防线时发现原审计契约允许最终 verdict 追加失败后完整重审与重新持久化恢复，已保留该路径，其他待确认审计不能消费旧 PASS。

原始日志与失败副本在私有任务证据目录保留，真实路径单独提供给父任务，不写入公开报告。

## 修改清单与架构

### 新建

- `src/handlers/{gate,verify,audit,infra,facade,shared,catalog}.js`：五域拥有真实实现；shared 只放共同上下文/助手，不依赖领域/目录/入口；catalog 固定原 26 操作顺序，拒绝重名、缺项、额外操作；facade 注入统一路由，避免循环。
- `test/handler-parity.mjs`：固定原顺序/描述/Schema 摘要，真实 RPC、安全负例、结构化恢复、单 claim 双派发竞争、异仓检查、历史版本同步保护。
- `docs/STAGE_1_REPORT.md`：本报告。

### 修改现有文件

- `src/index.js`：服务与统一校验/路由/请求补偿。四门面不直接调用底层 handler，目标操作也经过原 Schema、Host 故障检查及 AsyncLocalStorage 补偿。缺参/非法值返回 missing/schema/原参数/恢复说明。递归检查 object、有限数、integer、上下限、嵌套 required、声明禁止的未知字段；原 26 工具 Schema 与描述不改。
- `src/dispatch.js`：失败记忆使用状态层权威 `FLOW_HOME`，继承波浪线路径展开，不读取旧用户目录作为测试兜底。
- `test/knowledge-mesh.test.mjs`：模块导入前临时目录隔离 HOME/状态，业务断言保留；`test/bridge-identity.mjs`：仅 fixture 递归复制真实 src。
- `scripts/{check-params,check-claims,check-no-dead-handler,check-stubs,full-audit,mutation-check}.mjs`：真实模块定位，保留解析格式/表达式空壳/日期贯通正负断言与真实唯一注入；变异副本带必需 ui，M13 更新真实靶点。
- `scripts/sync-version.mjs`：仅同步当前版本标识行，不全局覆盖历史版本。
- `package.json`：新增 test:handlers；`package-lock.json`、`ghost.json`：当前版本准备 2.28.1，宿主权限不扩展。
- `AGENTS.md`、`README.md`、`README.zh.md`、`README.en.md`、`docs/TOOL_CONTRACTS.md`、`TRIGGER_GUIDE.md`、`CHANGELOG.md`、`RELEASE_NOTES.md`：同步领域定位、真实恢复边界和本地版本准备，历史记录保留。

### 安全口径

- 领取/派发在短锁内再次核对卡身份、pending、额度及 claim，原子消费；快照后仅同卡同派发计数合并基线。长操作仍在锁外，原锁实现未改。
- 裁定及范围自查使用卡项目根；显式异仓 cwd 拒绝。
- 新卡保存后审计上下文绑定真实新版本；负对照失败先按完整旧证据 CAS 作废，再审计，审计异常不能跳过作废或清掉新卡证据。
- guide 保留原文本骨架并返回实际 preservedCard/missing；缺授权、范围、验收事实须澄清，不代填/自动确认；pro 的占位卡路径不变。

## 最新验证（真实退出码）

以下均在导入前设置临时 CARLOS_FLOW_HOME/HOME/USERPROFILE；后续临时副本、缓存与 TMP/TEMP 使用任务私有 D 盘目录，RPC 子进程 windowsHide。

| 命令 | 结果 |
|---|---|
| npm run test:handlers | 0 |
| npm run test:all | 0，完整链执行至 prune |
| npm run check:full | 0 |
| npm run check:params / check:claims | 均 0 |
| npm run check:anchors | 0，26/26 唯一且注入语法有效 |
| npm run check:no-dead-handler / check:readme / check:portability | 均 0 |
| node scripts/check-stubs.mjs | 0 |
| node scripts/sync-version.mjs --check | 0 |
| node test/knowledge-mesh.test.mjs | 0，原业务断言保留 |

固定 42b19d6 工具顺序/描述/Schema SHA256 为 `5bddbd3f337bb33ea8451ec0abc8b8591a5ac505ea8c02fc647bdd69ecabb5b0`，最新专项与真实 RPC 清单一致。专项另验证当前版本同步后历史版本逐字不变。

M2 短实验更新为**仅禁用 claim 的外层和锁内两道占位检查**，卡代/额度 CAS 保留；真实独占副本 e2e 退出 1，并实际出现 15c 占位卡 claim 放行断言失败，无语法/缺模块冒充检出。其余全部 26 类仍须完整冻结变异验证；26/26 锚点有效不等于 26/26 安全检出。

## 明确未完成

1. 完整最终冻结 mutation 未完成；旧冻结基线失败不采信。父任务将用更长超时续跑，当前未启动新的长变异，无需接管活跃 PID。
2. 最终独立双轴审查、正式 Carlos 验收及父任务提交未完成，不声称 PASS。
3. 阶段二业务闭环/项目分库、阶段三宿主安装及桌面/手机真人点击验收未做。
4. 不声明任意外部旧 writer 或外部文件替换的全生命周期原子性、硬件 exactly-once；Host/UI 权限边界和原存储契约仍有效。

架构缺文件失败仅证明架构未落地，不等于充分业务证伪；公开发布、安装、用户授权或自动重放不得从本报告推导。
