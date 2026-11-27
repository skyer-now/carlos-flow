# Carlos Flow v3.4.0 发布说明

> 一句话：**现在无论是先装编程平台、还是先装 Carlos，都能一次接上**；接不上的平台只给提示，绝不乱改你的配置。

## 一、这版最想解决的问题

以前的痛点很具体：Carlos 装好了，但你电脑里早就在用 Cursor、VS Code、Claude Desktop、WorkBuddy 这些工具，**还得自己找配置文件、手写路径、小心翼翼别覆盖掉原来的 MCP 服务**。

这一版把这件事变成一条命令。

## 二、核心新特性

### 1. `init --discover`：先看清，再动手

```bash
carlos-flow init --discover
```

一条命令列出本机每个平台的：配置在哪、装没装、是什么格式、能不能自动写入。

**全程只读**——不建目录、不改文件、不碰你任何真实配置。

### 2. `init --target <平台>`：单个平台精准接入

```bash
carlos-flow init --target claude-desktop
```

按注册表直接定位该平台**已有的**配置文件，增量追加 `carlos-flow` 条目：

- 你原有的其他 MCP 服务**完整保留**
- 已有同名 `carlos-flow` 条目**不覆盖**
- 重复执行**幂等**，不会越加越多

### 3. `init --all`：扫描已装平台，一次接完

```bash
carlos-flow init --all
```

扫描本机所有已安装平台，逐个接入。每个平台都会给出明确状态：`injected`（已接入）、`deferred`（只提示不改写）、`not_installed`（未安装）、`failed`（失败原因）。

### 4. 两种安装顺序，双向兼容

| 你的情况 | 怎么做 |
| --- | --- |
| 先装了编程平台，后装 Carlos | `init --discover` 看清 → `init --all` 或 `init --target <平台>` |
| 先装了 Carlos，后装编程平台 | 装好平台后跑一次 `init --target <平台>` |

## 三、支持范围（说清楚，不吹）

### 可自动写入（严格 JSON + 标准 `{command,args}` 结构）

| 平台 | 配置文件 |
| --- | --- |
| Cursor（全局） | `~/.cursor/mcp.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windsurf / Devin | `~/.codeium/windsurf/mcp_config.json` |
| WorkBuddy | `~/.workbuddy/mcp.json` |
| Trae / Trae CN | `%APPDATA%\Trae[ CN]\User\mcp.json` |
| Qoder | `%APPDATA%\Qoder\User\mcp.json` |
| VS Code | `%APPDATA%\Code\User\mcp.json`（`servers` 容器） |
| Cline | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |

### 只识别、只提示、**绝不改写**

| 平台 | 为什么不能直接写 |
| --- | --- |
| VS Code / Cursor `settings.json` | JSONC，含注释与尾逗号；按 JSON 重写会**毁掉你的注释和格式** |
| Codex | `config.toml`，TOML 不是 JSON |
| OpenCode | 使用自有 `mcp` 结构（`type` + 数组命令），与标准 `mcpServers` 不同 |

这三类会输出**可直接粘贴的配置片段**，原文件一个字节都不动。

## 四、安全边界（这版刻意保守）

- **不猜路径**：平台没装就报 `not_installed` 并退回通用导出，绝不凭空创建平台目录。
- **不破坏格式**：非严格 JSON 一律不改写。
- **拒绝异常目标**：符号链接、junction、非普通文件一律拒写。
- **不静默改全机**：不在安装钩子里偷偷改所有客户端配置，必须你显式执行命令。

## 五、修复

### 已发布宿主的哈希误判（真实阻塞 bug）

已发布的 Cindy 宿主只暴露 `spawnEntry`，没有 `bindLaunch`。旧代码只认后者，于是把"宿主有能力"误判成 `HOST_HASH_UNSUPPORTED`，**验证和 PASS 裁定全被拦住**。

新增 `bindSpawnEntryLaunch()` 做接口适配。**哈希仍然在独立子进程里计算**，没有退回同进程自证，安全底线不破。

### 审计脚本假红

`full-audit` 会扫到 `.cindy-worktrees/`（Cindy 为其他任务创建的 worktree），把别的分支旧文件当成本仓问题，报 17 项假红。现已跳过该目录。

## 六、文档与门禁

- 三份 README 同步补充双向接入、平台注册表、可写入与只写提示的平台清单。
- 撤回"单一包支持多平台"的过度承诺，改为「标准导出 + 未实测不宣称支持」。
- `README.en.md` 正文改为全英文。
- 新增 `check-claims` 平台宣称检查：混淆 Qoder/通义灵码、Cline/Claude Desktop 会直接报错。
- 新增 `check-portability` 初始化回归接线检查。

## 七、已知边界（必须知道）

1. **配置写入 ≠ 平台可用**：条目就位只代表 MCP 服务被声明；平台是否加载、能否真正调用，仍需逐个实测。未实测的平台不宣称完全支持。
2. **晚期父目录替换**在 Windows 上受 EPERM 限制，相关测试如实标记 SKIP，不冒充通过。
3. **仅 Windows**：macOS / Linux 支持与验证暂停。

## 八、升级方式

```bash
npm install -g carlos-flow@3.4.0
carlos-flow init --discover
```

先看清装了哪些平台，再决定接哪个。不会自动改动任何现有配置。