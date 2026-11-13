# Carlos v2.11.0 发布说明

## 🪟 Windows 修复：启动黑窗问题
* 已修复：修正了 MCP Bridge 启动子进程时的控制台弹出问题（通过添加 `windowsHide: true`）。

## ⚙️ CI：release workflow 加发布闸
* 限制：仅在推 v* tag 时触发自动 npm 发布。

## 🔬 验证
* 已验证：启动无可见黑窗，`GET /health` 正常，stderr 日志留存。
