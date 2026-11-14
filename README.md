# Carlos-Flow

自动化 AI 审计工作流，通过 Claim-Dispatch-Audit-Verdict 四阶段门禁确保代码安全。

## 🚀 向导模式 (Wizard Mode)

Carlos-Flow 现已支持**向导模式**，通过“自动组队”与“风险分级”机制，大幅降低开发门槛：

- **智能组队**：系统根据任务风险 (Tier) 自动派遣 Executor/Auditor。
- **自动编排**：无需手动提交复杂的合同，Carlos 自动完成 Dispatch → Verify → Verdict 全循环。
- **双轴审计**：即使在向导模式下，所有改动依然通过“双轴审计”门禁，确保代码生产安全。

> 通过 `carlos flow_mode --mode guide` 即可一键激活。

## ❓ 常见问题 (FAQ)

**Q: 向导模式与专业模式有什么区别？**
A: 专业模式 (Pro) 适合熟练用户，所有派发需手动确认；向导模式 (Guide) 是“自动化陪伴”，系统会主动提示进度并自动触发回归测试。

**Q: 开启向导模式会降低安全性吗？**
A: 不会。向导模式仅优化了交互与指令注入，所有底层的安全门禁 (双轴审计、指纹校验、O1 越界拦截) 依然严格生效。

**Q: 如何在 GitHub 上查看详细的设计方案？**
A: 请参考仓库中的 `docs/PLAN_v4.md`。

## 🛠 核心机制

Carlos-Flow 是一个自动化 AI 审计工作流，通过 Claim-Dispatch-Audit-Verdict 四阶段门禁确保代码安全。
