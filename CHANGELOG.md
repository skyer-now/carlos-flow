# 变更日志 | Changelog

> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)  
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows [SemVer](https://semver.org/)

---

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

