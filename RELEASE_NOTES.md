# Carlos v2.11.2 发布说明

## 🪟 Windows 修复：Bridge 重启弹黑控制台窗口
* **已修复**：MCP server 子进程改用 `windowsHide: true` 启动，Windows 下不再弹出黑色控制台窗口。
* 依据：诊断文档《carlos-flow-windows-blackwindow-fix.md》——原实现缺失 Windows 进程隐藏参数。

## 🔧 兼容性修复：Bridge 转发通路与路径自探测
* **已修复**：Bridge 恢复完整的 JSON-RPC 转发通路（TCP 连接 → 子进程 stdin → 按 reqId 回包）。
  此前一版误将 Bridge 精简为「只 spawn、不转发」，导致平台侧 `tools/list` 拿不到任何工具。
* **新增**：路径自探测。Bridge 依据自身文件位置自动定位 `../src/index.js`，
  不再强制依赖 `CARLOS_FLOW_MCP_ROOT` 绝对路径；该环境变量仍保留为可选覆盖，保持向后兼容。
* **新增**：`/health` 返回解析后的真实项目根目录，供客户端做 Bridge 身份比对，避免重复拉起。

## 🔬 验证：真 RPC 往返冒烟测试
* `smoke-test.js` 重写为**真协议验证**：起真实 Bridge → 发 `initialize` → 发 `tools/list` →
  断言拿回全部 **19 个工具**。此前版本只看一行启动日志，属于假阳性。
* `check-all.sh` 升级为 Gatekeeper 统一入口：语法校验 + 冒烟测试一体，退出码非 0 即阻断提交。

## 📖 文档
* 新增 `INSTALL.md`：Cursor / VS Code / Windsurf 三平台接入步骤、配置自检与常见问题对照表。
* 模板文件（`templates/`）去掉了强制的 `CARLOS_FLOW_MCP_ROOT` 绝对路径。

## ⚙️ CI
* release workflow 的发布闸保持不变：仅当 tag 版本**高于** npm 已发布最新版时才 `npm publish`。
* 新增约束：tag 版本必须与 `package.json` 的 `version` 一致，否则发布中止。

## 📝 版本信息
* 版本号：**v2.11.2**
* 上一版：v2.11.1（Bridge 转发通路存在缺陷，且 tag 与 package.json 版本不一致导致发布流程中止，未进入 npm）
* npm 上当前最新版仍为 2.11.0，本次发布后升级为 2.11.2
