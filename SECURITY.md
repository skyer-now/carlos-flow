# 安全策略

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| 2.7.x | ✅ 活跃维护（当前发布版） |
| 2.6.x | ⚠️ 仅修安全问题 |
| 2.5.x | ⚠️ 仅修安全问题 |
| < 2.5 | ❌ 不再维护 |

## 报告漏洞

**请勿在公开 Issue 中披露安全漏洞。**

请通过以下方式私下报告：
- 📧 邮件：security@<YOUR_DOMAIN>
- 🔐 GitHub Security Advisories：[私下报告](https://github.com/skyer-now/carlos-flow/security/advisories/new)

报告请包含：
1. 漏洞描述与影响范围
2. 复现步骤（最小化 PoC）
3. 受影响版本
4. 建议修复方案（如有）

我们承诺在 **72 小时内确认收到**，并在 **30 天内修复并发布补丁**。

## 安全设计原则

本项目遵循以下安全原则：

### 1. 最小权限
- Bridge 仅监听 `127.0.0.1`，拒绝外部连接
- Token 认证（fail-closed：无 Token 即拒绝）
- 请求体上限 1MB，防止内存耗尽
- 单连接限流 10 req/s

### 2. 密钥管理
- **Cindy 版**：Bridge Token 等敏感信息存入 Cindy 加密保险库（DPAPI/Keychain），代码不含明文
- **OpenCode 版**：配置文件明文存储，**用户自行负责权限控制**（建议 `chmod 600`）
- 无硬编码密钥、API Key、密码
- **Bridge Token 不再有硬编码默认值**：优先读 `CARLOS_BRIDGE_TOKEN`；
  未设置时首次运行生成 256 位随机 token 写入 `$CARLOS_FLOW_HOME/bridge-token`（权限 0600），跨进程复用。
  任何本机进程都无法从代码里猜到它（早先版本用的固定字符串已移除）。

### 3. 审计链完整性
- 每条审计记录含 `prevHash`/`hash` 链式结构
- 文件级作用域，切换目录/多实例不断链
- 提供 `verifyAuditChain()` 校验工具
- 审计文件按本地日期分片（`YYYY-MM-DD.jsonl`），`prevHash` 一律联动**前一天 tail**，跨天不断链
- 审计记录（`audit()`）和状态文件（`saveState()`）写之前先脱敏——敏感值（`token`/`password`/`verify.cmd`）只留掩码，不入盘
- **两种哈希模式，强度不同，请如实区分**：
  | 模式 | 条件 | 能发现什么 | 不能发现什么 |
  |------|------|-----------|-------------|
  | `plain` | 未设 `CARLOS_FLOW_AUDIT_KEY`（默认） | 意外损坏：截断、位翻转、误删 | **有意篡改** —— 攻击者能读文件就能重算整条链 |
  | `hmac` | 设置了 `CARLOS_FLOW_AUDIT_KEY`（≥16 字符） | 意外损坏 + **有意篡改**（无密钥者重算不出正确 hash） | 密钥本身泄露后的攻击 |
- `verifyAuditChain()` 的返回值含 `mode` 字段（`plain` / `hmac`）—— **调用方应据此判断保证强度**，
  不要把 `plain` 模式的 `ok: true` 当成「没被篡改过」的证明。
- 想获得完整防篡改能力：设置 `CARLOS_FLOW_AUDIT_KEY`（如 `export CARLOS_FLOW_AUDIT_KEY=$(openssl rand -hex 32)`）。
- **落盘脱敏**：审计记录（`audit()`）和状态文件（`saveState()`）写之前先脱敏；`verify.cmd`/`token`/`password` 等只留掩码，不入盘。

### 4. 路径穿越防护
- `sessionId` 严格清洗（仅允许 `A-Za-z0-9_.-`）
- 拒绝包含 `..` 的 ID
- 所有文件操作限制在 `CARLOS_FLOW_HOME` 子目录

## 已知风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Bridge Token 泄露 | 仅本地回环；Token 随机生成并落盘 0600，不在代码里；泄露后删除 `bridge-token` 文件即可轮换 |
| 审计日志篡改 | 链式哈希能发现意外损坏；**要发现有意篡改必须启用 HMAC 模式**（设 `CARLOS_FLOW_AUDIT_KEY`）。校验结果的 `mode` 字段会如实标注当前强度 |
| 敏感信息落盘脱敏 | 审计/状态文件中的敏感 key（`token`/`password`/`secret`/`key`/`credential`/`auth`）和含 `sk_|api_key|token=` 的值脱敏为 `[脱敏]` 或 `head *** tail`，不保留原值 |
| 敏感路径误操作 | `isSensitive()` 多层校验，`confirmed=true` 强制用户确认 |
| 依赖供应链攻击 | `package-lock.json` 锁定版本，CI 执行 `npm audit` |

## 致谢

感谢所有负责任披露漏洞的研究员！

---

**单一仓库**：v2.6.0 起已合并为单一仓库 `carlos-flow`，本文件适用于全部支持的平台。