# 贡献指南

感谢您考虑为 Carlos 工作流做贡献！

## 🚀 快速开始

```bash
# 1. Fork 并克隆（单一仓库，Cindy / OpenCode / Cursor / Cline / VS Code / Claude Desktop 共用）
git clone https://github.com/skyer-now/carlos-flow.git

# 2. 安装依赖
npm install

# 3. 运行测试
npm test
```

## 📋 开发规范

### 分支策略
- `main` - 稳定发布分支，仅接受 PR 合并
- `develop` - 开发分支（如有）
- `feature/*` - 新功能
- `fix/*` - Bug 修复
- `docs/*` - 文档更新

### 提交规范
遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
```
feat: 添加新工具 flow_xxx
fix: 修复 Bridge 启动竞态
docs: 更新 README 安装说明
test: 增加冒烟测试用例
refactor: 重构 state.js 审计链逻辑
```

### 代码风格
- ESM 模块 (`type: "module"`)
- 2 空格缩进
- 单引号字符串
- 尾逗号（多行对象/数组）
- 无分号（JS 标准风格）

## 🧪 测试要求

所有 PR 必须通过：
```bash
npm test          # 冒烟测试（隔离临时目录）
npm run test:e2e  # 端到端测试（需配置环境变量）
```

新增功能需添加对应测试用例。

## 🔒 安全相关

- 发现安全漏洞请**私下报告**（见 SECURITY.md）
- 不要在代码/测试/提交中包含真实密钥、Token、路径
- 所有敏感配置必须走环境变量或 Cindy 密钥库

## 📦 发布流程

维护者操作：
1. 更新版本号：`npm version patch|minor|major`
2. 推送标签：`git push origin main --tags`
3. GitHub Actions 自动发布到 npm

## 🤝 行为准则

请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

**单一仓库**：v2.6.0 起已合并为单一仓库 `carlos-flow`，本文件适用于全部支持的平台。