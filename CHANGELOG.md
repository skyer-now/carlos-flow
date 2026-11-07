# 变更日志 | Changelog

> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)  
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows [SemVer](https://semver.org/)

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

