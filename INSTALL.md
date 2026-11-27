# Carlos Flow 安装与适配分级

## 准备条件

- 需要 **Node.js >=22**，与 `package.json` 的运行时要求保持一致。
- 当前仅声明 Windows 支持；macOS/Linux 验证暂停。通用路径实现不等于这些系统已经验收，参见 `docs/PORTABILITY.md`。
- 使用完整安装包，确保 `client/carlos.js` 与 `src/index.js` 存在。不把只复制某个脚本称为完整安装。

## 三种状态不要混淆

| 状态 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| 通用导出 | 生成标准 MCP stdio 配置 | 不代表宿主已经加载、连接或执行成功 |
| 配置合并 | 在明确的严格 JSON 容器中加入条目 | 不代表任意平台原生 schema 都适用 |
| 真实宿主验收 | 在指定版本宿主中完成加载、握手、工具调用并保留回执 | 不能推导其他客户端、版本或操作系统也已验证 |

未完成逐一验收的平台，不宣称完全支持。初始化隔离测试与文档静态检查也不能替代宿主验收。

## 通用 stdio 配置

安装包后，初始化入口如下：

```text
carlos-flow init --target generic
```

在当前项目输出 `carlos-mcp.json`。配置中的 `command` 是执行初始化所用的 Node 绝对路径，即 `process.execPath`；`args` 直接指向安装包内 `src/index.js` 的绝对路径。不要把 CLI 工具调用参数附加到这个服务入口。

**标准 MCP stdio 不经过 Bridge，不需要准备 Bridge Token，也不要求客户端在 MCP 请求中附带 `_token`。** Bridge 是快速客户端的另一条内部连接路线，不是宿主通用 stdio 服务入口。`init` 不启动 Bridge、不生成令牌、不写全局宿主配置。

将导出的条目按照宿主当前官方文档导入；不要把本文的通用容器当成宿主原生 schema 的保证。尤其不能把 JSON 配置原样写入 TOML、YAML 或 JSONC。

## 显式文件合并与别名

```text
carlos-flow init --target custom-file --file ./host.json --container mcpServers
carlos-flow init --target custom-path --path ./host.json --container servers
```

- `custom-file` / `custom-path` 与 `--file` / `--path` 为等价别名。
- 必须显式指定已知容器 `mcpServers` 或 `servers`；保留其他配置键，不互相转换容器。
- 已有 `carlos-flow` 条目不覆盖；幂等调用保留原字节。
- 仅接受 `.json` 与严格 JSON 对象。坏 JSON、JSONC、注释、尾逗号、非对象根或容器、未知容器都拒绝并报告“初始化拒绝”，原文件字节保持不变。
- 校验目标及整条父目录链，拒绝符号链接和 Windows junction；原始路径中的“链接/..”也不能绕过校验。
- 写入采用同目录独占锁、随机临时文件、刷盘、文件与父目录身份重检及原子 rename；本工具的并发写入发生冲突时拒绝。目录身份改变后停止沿新路径清理，可能保留旧目录中的现场临时文件。
- **安全边界**：Node 的跨平台路径 API 不能提供目录句柄绑定的原子条件 rename；同权限恶意进程在最后检查与 rename 之间抢换目录的窗口不能被声称彻底消除。只在本人控制的目录执行，不用于不可信共享目录。

## 自动识别、双向接入与规则文件

### 两种安装顺序都支持

| 顺序 | 做法 | 说明 |
| --- | --- | --- |
| **先装编程平台，后装 Carlos** | `carlos-flow init --discover` 先只读看清本机装了哪些平台；再 `carlos-flow init --all` 或 `carlos-flow init --target <平台>` 接入 | 只接已存在的配置，绝不凭空创建平台目录 |
| **先装 Carlos，后装编程平台** | 装好平台后跑一次 `carlos-flow init --target <平台>` | 直接定位该平台已有配置文件并增量追加 |

### 只读识别：`--discover`

```text
carlos-flow init --discover
```

只做 `lstat`/读取，**不创建任何目录、不改任何文件**。输出每个平台的 `id` / `label` / `path` / `installed` / `format` / `injectable` / `note`。`--discover` 不能与 `--target`、`--all`、`--file`、`--path`、`--container` 混用。

### 消息拦截钩子与规则自动装配：`--hooks` / `--unhook`

为了在日常开发对话中无需手动输入 `$门禁` 即可自动感知意图与情绪唤醒门禁，支持分层自动装配：

```bash
# 自动部署各平台原生规则文件与 OpenCode 消息钩子
carlos-flow init --hooks

# 一键安全清理/回滚生成的钩子与规则（保护用户自建内容）
carlos-flow init --unhook
```

- **OpenCode 消息拦截**：当检测到 `~/.config/opencode` 存在时，自动将 `carlos-flow-trigger.js` 部署至 `plugins/`，监听 `chat.message` 钩子并在后台无阻塞触发 `flow_trigger_check`；
- **工作区规则常驻**：为当前项目部署 `.cursorrules`、`.traerules`、`.github/copilot-instructions.md`、`.qoder/rules/carlos-flow.md`、`CLAUDE.md` 等原生规则文件；已有文件绝对不覆盖；
- **安全回滚**：`--unhook` 自动清理生成的钩子，且仅删除内容与 Carlos 模板完全匹配的规则文件，绝不误删用户自己编写的规则。

### 平台注册表（仅 Windows 实测路径）

| id | 配置文件 | 容器 | 格式 | 能否自动写入 |
| --- | --- | --- | --- | --- |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` | 严格 JSON | 是 |
| `claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` | 严格 JSON | 是 |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | 严格 JSON | 是 |
| `workbuddy` | `~/.workbuddy/mcp.json` | `mcpServers` | 严格 JSON | 是 |
| `trae` / `trae-cn` | `%APPDATA%\Trae[ CN]\User\mcp.json` | `mcpServers` | 严格 JSON | 是 |
| `qoder` | `%APPDATA%\Qoder\User\mcp.json` | `mcpServers` | 严格 JSON | 是 |
| `vscode` | `%APPDATA%\Code\User\mcp.json` | `servers` | 严格 JSON | 是 |
| `cline` | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` | `mcpServers` | 严格 JSON | 是 |
| `vscode-settings` / `cursor-settings` | `%APPDATA%\Code|Cursor\User\settings.json` | — | JSONC | **否，只输出片段** |
| `codex` | `~/.codex/config.toml` | — | TOML | **否，只输出片段** |
| `opencode` | `~/.config/opencode/opencode.json` | — | 自有 schema | **否，只输出片段** |

### 三条硬规则

1. **不猜路径、不建目录**：平台未安装（配置文件不存在）时返回 `not_installed` 并退回通用导出，绝不创建平台配置目录。
2. **非严格 JSON 一律不写**：JSONC（含注释/尾逗号）、TOML、自有 schema 的平台只输出可直接粘贴的片段（`status: deferred`），原文件零改动。
3. **安全增量合并**：严格 JSON 平台复用与 `custom-file` 相同的合并与发布路径——保留其他服务与设置、同名 `carlos-flow` 不覆盖、重复执行幂等；链接/不安全文件拒绝写入。

`init --all` 会扫描注册表：已存在的严格 JSON 平台逐个接入，非严格格式标记 `deferred`，未安装标记 `not_installed`；同时仍处理当前目录已有的 `.cursor` 标记并导出通用配置。

**接入成功不等于可用**：配置写入只代表条目就位，宿主是否加载、能否真正调用仍需按「真实宿主验收」逐项取证；未实测的平台不声称支持。

`AGENTS.md` 与 `AI-DEV-CONSTRAINTS.md` 只在不存在时生成，不覆盖用户已有文件。它们只是提示，不保证所有宿主自动读取，更不能替代真实门禁。

## 产品与旧目标说明

- **Qoder 与通义灵码是不同产品**，不能因为同属某厂商就互认配置路径。
- **Claude Desktop 与 Claude Code 是不同客户端**；`cline` 也不是 Claude Desktop 的别名。
- `cindy`、`opencode`、`claude` 等旧目标目前降级通用导出，不等同原生安装。不再直写 Cindy 旧 `.cindy/ghosts` 或 OpenCode 旧 `plugin` 目录。
- VS Code 等宿主必须核对当前版本 schema；本文只说明 `servers` 容器可以显式合并，不据此承诺某个宿主已验收。

官方参考（规范/产品说明，不是本项目实测凭据）：

- [MCP stdio](https://modelcontextprotocol.io/specification/latest/basic/transports)
- [Claude Desktop](https://modelcontextprotocol.io/quickstart/user)
- [Claude Code](https://code.claude.com/docs/en/mcp)
- [OpenCode](https://opencode.ai/docs/mcp-servers/)
- [Qoder](https://docs.qoder.com/)
- [通义灵码](https://help.aliyun.com/zh/lingma/)

## 验证与故障回执

交付验收应分别保存初始化隔离测试、静态检查和真实宿主加载/握手/工具调用回执。配置生成或 JSON 解析成功不能代替服务就绪。本文不预置耗时、工具数或“兼容性通过”样例，避免把示例冒充执行结果。

出现“初始化拒绝”时先保留原配置和错误回执；检查是否缺少显式容器、容器类型错误、JSONC 或链接路径。确认修改目标后再操作，不能靠去注释、改扩展名或覆盖旧配置绕过拒绝。测试未执行或链接创建受宿主限制而跳过时，均应标为“未验证”。
