# Carlos Flow 发布说明 · v2.13.1

> 本版是**轻量化 + 降门槛**版本：不改门禁语义，只减负担、减噪音、减误报。
> 上一版：v2.13.0（CI 锚点修复与守护加固）。

## 1. 轻量化：进程与内存

`ghost.json` 一直声明 `idleTimeoutSeconds: 300` 和 `lifecycle: on-demand`，但 bridge 里**从未实现过空闲退出**。实测后果：常驻 14 个进程、私有内存 430MB、仓库根堆了 40 个 `bridge-*.pid`（36 个指向已死进程）。

本版补齐：

- bridge 空闲巡检：**无活跃连接 + 无待回包请求**才算空闲，超过 `CARLOS_BRIDGE_IDLE_MS`（默认 30 分钟，设为 0 关闭）自行退出
- 子进程退出时 bridge 跟着退出 —— 消除「端口活着、服务死了」的僵尸（这种只能等到 180s 超时，最难排查）
- 退出时只删除「内容等于自己 pid」的工牌文件，避免两个桥互删
- 客户端启动前回收指向已死进程的 pid 文件

实测：进程 **14 → 5**，私有内存 **430.2 → 94.6 MB**。空闲退出代价很低（bridge 从启动到 `/health` 就绪约 118ms）。

## 2. 止住测试污染

旧写法用 `19100/19500 + (pid % 400)` 选端口，只有 400 个槽位；几百次运行后必然撞上**以前残留的 bridge**，请求被它接走，状态写进别人的 `CARLOS_FLOW_HOME`。

污染实测量级：840 个会话目录里 587 个是测试残留（其中 330 个 `env.project` 直接指向开发仓库）；当天 928 条审计事件里 723 条（78%）是测试噪音。

本版做法：

- 端口改为向操作系统申请**确定空闲**端口（`test/_free-port.mjs`）
- 启动后读 `/health` 校验 `flow_home` 身份，不符**立即中止**（宁可红，也不污染）
- e2e 新增用例 **1b** 守护这条

实测：再跑 `test:e2e` + `test:p0`，向真实状态目录新增会话 **0 个**。

## 3. 降门槛：路径自动认路

实测事实：`git diff` 即使在子目录执行，输出的也是**仓库根相对路径**；而 scope 校验此前用的是 `process.cwd()`（MCP server 启动目录）。两边基准不一致 → 合法卡片被拒，报错只说「路径不存在」，使用者根本猜不到真因。

- 新增 `resolveRepoRoot()`，留痕 / 派发 / 裁定 / 自查**四处统一**到 git 仓库根
- 非 git 项目退回原目录（保持旧行为）
- 显式传入的 `cwd` 仍作为验证执行目录（不改变已有用法）
- e2e 新增用例 **3d** 守护

## 4. 报错解释层

- pro 模式：错误附「💡 为什么被拦」机制说明（29 条映射）
- guide 模式：只保留中文人话，**不再叠加**机制说明（一次性闸门，避免两层重复）
- 覆盖验证 / 越界 / 负对照 / 留痕 / 双轴 / claim / 卡片校验等主路径
- e2e 新增 **30d / 30e** 双向守护（guide 不许叠、pro 不许丢）

## 5. 运维入口 `carlos clean`

```
node carlos.js clean                      # 预览：只列不删
node carlos.js clean --apply              # 真删（只动测试前缀会话）
node carlos.js clean --apply --older-than 7   # 只清 7 天前的
node carlos.js clean --apply --prefix p0-     # 只清指定前缀
```

安全口径：

- 默认 **dry-run**，必须显式 `--apply`
- 默认只动测试前缀（`e2e- / p0- / probe- / guide- / test- / smoke- / unknown`）
- **永不删除 `gate-audit`** —— 审计是逐日哈希链，删一天就断链，追溯能力永久丢失
- 新增 `test/clean-command.mjs`（7 条）守护：预览不删、真实会话不删、审计不删、`--older-than` / `--prefix` 生效

## 6. 装机清单修正

`~/.cindy/ghosts/carlos-flow.json` 此前是 **2.12.0** 且缺少 `flow_mode` 工具（19 个 vs 仓库 20 个），entry 还写着死地址。本版已按仓库清单重建（替换 `__ROOT__` 为实际路径）。

## 7. 验证数字

- 测试套件：smoke · baseline 10 · e2e **92** · p0 22 · trigger 29 · concurrency 4 · acceptance 13 · gate 13 · stale 14 · scope 10 · audit 25 · bridge 6 + idle 8 · clean 7 · ui
- 门禁：`check:anchors` **17/17** · `check:identity` · `check:params` · `check:full` · `check:no-dead-handler` · `check:templates` · `check:version` 全通过