export const PROMPT_PROFILES = {
  developer: {
    objective: "审计：任务卡执行与代码修改",
    format: "判定（PASS / WARN / FAIL） / 改动证据（file:line）",
    guidance: "只改 scope 内文件；验证命令由主 Agent 指定，不得自选。"
  },
  tester: {
    objective: "审计：验证命令执行与负对照",
    format: "验证记录（命令 → exit code → 输出摘要）+ 失败复现步骤",
    guidance: "跑验证命令与负对照；零文件改动；不轻信开发自述。"
  },
  reviewer: {
    objective: "审计：任务卡验收标准忠实度",
    format: "裁定（通过/不通过） / 失败类型 / scope 标注 / 证据 / 附注",
    guidance: "只读取证，逐条给 file:line 证据；PASS 须由 reviewer 身份落下。"
  }
};
