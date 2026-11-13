# Carlos Flow 安装指南

本指南说明如何把 Carlos Flow 接入 Cursor、VS Code、Windsurf 等编程平台。

## 准备工作

1. 确认已安装 **Node.js 18+**（`node -v`）。
2. 准备一个 Token 字符串（自行生成，例如 `openssl rand -hex 16`），客户端与 Bridge 用同一个。
3. 记下 Carlos Flow 项目的安装路径，下文记为 `<INSTALL_PATH>`（例如 `D:/cindy/publish-output/carlos-flow`）。

> **Bridge 自带路径自探测**：只要 `<INSTALL_PATH>/bridge/mcp-bridge.js` 在正确位置，
> Bridge 会自动定位同级的 `src/index.js`，**不需要**再手动设置 `CARLOS_FLOW_MCP_ROOT`。
> 该环境变量仅在项目被拆分到其他目录时才需要保留。

---

## 1. Cursor

写入 `.cursor/mcp.json`（文件不存在则新建）：

```json
{
  "mcpServers": {
    "carlos-flow": {
      "command": "node",
      "args": ["<INSTALL_PATH>/bridge/mcp-bridge.js"],
      "env": {
        "CARLOS_BRIDGE_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

## 2. VS Code

写入 `.vscode/settings.json`：

```json
{
  "mcp.servers": {
    "carlos-flow": {
      "command": "node",
      "args": ["<INSTALL_PATH>/bridge/mcp-bridge.js"],
      "env": {
        "CARLOS_BRIDGE_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

## 3. Windsurf

写入 `~/.windsurf/mcp.json`：

```json
{
  "mcpServers": {
    "carlos-flow": {
      "command": "node",
      "args": ["<INSTALL_PATH>/bridge/mcp-bridge.js"],
      "env": {
        "CARLOS_BRIDGE_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

---

## 配置自检

配置完成后，可在项目目录运行：

```bash
./check-all.sh
```

它会做两件事：

1. `node --check` 校验 `bridge/mcp-bridge.js`、`src/index.js`、`smoke-test.js` 语法；
2. **真 RPC 往返冒烟测试**：真起一个 Bridge，发 `initialize` + `tools/list`，
   断言能拿回全部 **19 个工具**。这排除了「进程起来了但转发断了」的假阳性。

预期输出：

```
✅ initialize 握手成功
>>> RPC 往返总耗时：360.98ms
>>> 发现工具数：19
🎉 深度兼容性验证通过（真 RPC 往返拿到 19 个工具）
```

## 常见问题

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| Bridge 启动即退出，日志提示 `CARLOS_BRIDGE_TOKEN 未设置` | 客户端配置里没传 Token | 按上面的 `env` 补上 |
| 日志提示 `MCP server 子进程启动失败` | 项目目录不完整，或 `src/index.js` 不在 Bridge 同级父目录 | 确认 `<INSTALL_PATH>/src/index.js` 存在；必要时设 `CARLOS_FLOW_MCP_ROOT` |
| 连上了但工具列表为空 | 客户端没带 `_token` | 检查客户端是否按 MCP 规范在请求里传 Token |
| Windows 上 Bridge 重启时弹黑框 | 已修复 | 升级到 **v2.11.2 及以上**（`windowsHide: true`） |
