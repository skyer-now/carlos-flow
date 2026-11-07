# 安全策略

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| 2.5.x | ✅ 活跃维护 |
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

### 3. 审计链完整性
- 每条审计记录含 `prevHash`/`hash`（SHA-256）
- 文件级作用域，切换目录/多实例不断链
- 提供 `verifyAuditChain()` 校验工具

### 4. 路径穿越防护
- `sessionId` 严格清洗（仅允许 `A-Za-z0-9_.-`）
- 拒绝包含 `..` 的 ID
- 所有文件操作限制在 `CARLOS_FLOW_HOME` 子目录

## 已知风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Bridge Token 泄露 | 仅本地回环，Token 定期轮换，建议设置复杂随机值 |
| 审计日志篡改 | SHA-256 哈希链，任何篡改可被 `verifyAuditChain` 检测 |
| 敏感路径误操作 | `isSensitive()` 多层校验，`confirmed=true` 强制用户确认 |
| 依赖供应链攻击 | `package-lock.json` 锁定版本，CI 执行 `npm audit` |

## 致谢

感谢所有负责任披露漏洞的研究员！

---

**单一仓库**：v2.6.0 起已合并为单一仓库 `carlos-flow`，本文件适用于全部支持的平台。