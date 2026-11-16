# Carlos-Flow 标准维护操作指南 (发布准则)

本文件是 Carlos-Flow 项目的唯一标准发布维护准则。后续维护操作必须严格遵循以下显式原子调用序列，严禁进行未经审计的自动化封装。

---

### 🚀 标准发布流程 (Atom Sequence)

发布操作需严格按顺序执行以下指令。在每一步完成后，确认返回 `ok: true` 再执行下一步。

#### 第一阶段：环境回归
1. 运行全量测试，确保门禁覆盖范围内所有逻辑正确。
   ```bash
   npm run test:all
   ```
   *准则：必须确保 199/199 全绿。*

#### 第二阶段：Carlos 审计门禁 (合规性)
必须按以下顺序调用 Carlos 插件工具：
1. **负对照验证**：证明测试用例对本次改动有效。
   ```bash
   carlos call_tool --name flow_falsify --args '{}'
   ```
2. **双轴审计派发**：派发 Standards/Spec 双轴审计 subagent。
   ```bash
   carlos call_tool --name flow_audit_axes --args '{}'
   ```
3. **门禁保护校验**：校验证据是否齐全且符合门禁口径。
   ```bash
   carlos call_tool --name flow_audit_guard --args '{}'
   ```

#### 第三阶段：裁定与发布 (Finalize)
1. **落定裁定**：正式记录审计结论，将项目标记为已复核。
   ```bash
   carlos call_tool --name flow_verdict --args '{"role":"auditor","verdict":"PASS"}'
   ```
2. **版本与发布**：更新版本号并推送远端。
   ```bash
   npm version patch -m "chore(release): 自动升级版本 %s"
   git push origin main --tags
   ```

---

### ⚠️ 重要维护准则
*   **严禁绕过**：禁止跳过任何审计步骤，禁止在未获得 `flow_verdict` 裁定前执行 `npm publish`。
*   **审计可溯源**：所有操作均在 Carlos 审计流水中留痕，严禁进行任何未经审计的快捷发布操作。
*   **零创新原则**：任何发布流程变更必须先经过 Carlos 工作流审核，严禁在未经过合规评估的情况下引入新的自动化脚本。
