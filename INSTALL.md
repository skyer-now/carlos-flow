# Carlos Flow 安装指南

本指南说明如何将 Carlos Flow 集成到你的编程平台。

## 准备工作
请确保你已获取 `CARLOS_BRIDGE_TOKEN`，并知道 Carlos Flow 项目的安装路径（下文记为 `<INSTALL_PATH>`，例如 `D:/cindy/publish-output/carlos-flow`）。

---

## 1. Cursor 集成
在 Cursor 中，将以下配置加入到你的 `.cursor/mcp.json`（若文件不存在则创建）：

```json
{
  "mcpServers": {
    "carlos-flow": {
      "command": "node",
      "args": ["<INSTALL_PATH>/bridge/mcp-bridge.js"],
      "env": {
        "CARLOS_BRIDGE_TOKEN": "YOUR_TOKEN_HERE",
        "CARLOS_FLOW_MCP_ROOT": "<INSTALL_PATH>"
      }
    }
  }
}
```

## 2. VS Code 集成
在 VS Code 中，将以下配置加入到你的 `.vscode/settings.json`：

```json
{
  "mcp.servers": {
    "carlos-flow": {
      "command": "node",
      "args": ["<INSTALL_PATH>/bridge/mcp-bridge.js"],
      "env": {
        "CARLOS_BRIDGE_TOKEN": "YOUR_TOKEN_HERE",
        "CARLOS_FLOW_MCP_ROOT": "<INSTALL_PATH>"
      }
    }
  }
}
```

## 3. Windsurf 集成
在 Windsurf 中，将以下配置加入到 `~/.windsurf/mcp.json`：

```json
{
  "mcpServers": {
    "carlos-flow": {
      "command": "node",
      "args": ["<INSTALL_PATH>/bridge/mcp-bridge.js"],
      "env": {
        "CARLOS_BRIDGE_TOKEN": "YOUR_TOKEN_HERE",
        "CARLOS_FLOW_MCP_ROOT": "<INSTALL_PATH>"
      }
    }
  }
}
```

*注意：请将 `<INSTALL_PATH>` 替换为你的真实路径。*
