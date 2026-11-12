// Carlos Flow 协议 — 路由档位 / 四段合同 / 报告规格 / 错误分层 / 状态字段的唯一真源。
// 被协调器（coordinator）与各角色 Agent 共同引用。

// 状态字段从 defaultState() 生成，而不是手写常量 ——
// 手写副本会漂移（历史上就漏过 claimed / claimed_role / activation_* 等 9 个字段），
// 而协议是 Agent 运行时读取的权威依据，漂移会让 Agent 按错误的字段名做决策。
// 代价：protocol.js 依赖 state.js（纯数据模块，无副作用，无循环依赖）。
import { defaultState } from "./state.js";

export const PROTOCOL = {
  ROUTE_TABLE: `| 档 | 场景 | 动作 |
|---|---|---|
| T0 | 讨论 / 解释 / 概念澄清 | 直接答，不派发、不填卡，0 个子 Agent，无门禁 |
| T1 | 只读调研（摸清代码现状） | 派 explore，1 个子 Agent，免门禁 |
| T2 | 修改代码 / 配置 / 文档 | 留痕 → 派 executor → 派 auditor，2 个子 Agent，机械门禁 + 独立复核 |

判定口径：要写文件 = T2；要读文件但不写 = T1；两者都不需要 = T0`,

  FOUR_CONTRACT: `四段合同（每段一行，主 Agent 必须在任务卡里写全）：
1. objective：一句话目标。
2. output format：executor 报告 ≤300 字，四段式 —— 结论 / 改动（file:line 逐条）/ 验证结果 / 遗留风险。
3. tool guidance：验证命令由主 Agent 指定，executor 不得自选测试项。
4. task boundaries：只准改清单里的文件，一个不多；要改别的 → 停下来在报告里说明，不要自己扩大范围。`,

  REPORT_SPEC: `executor 报告 ≤300 字，四段式：结论 / 改动 / 验证 / 遗留风险。
auditor 报告 ≤200 字，五段式：裁定 / 失败类型 / scope 标注 / 证据 / 附注。`,

  ERROR_LAYERS: `| 层 | 触发 | 处置 |
|---|---|---|
| 基础设施故障 | 网络抖动、模型不可用、配额耗尽 | 静默降级或改用 Explore / 自读只读验证，不把原始错误喂回 |
| Agent 故障 | 工具名错、参数错 | 把错误喂回并附恢复指引 |
| 接管 | 同一子 Agent 连续 2 次失败 | 接管 = 只读验证，不写文件 |
| 门禁拒绝（非错误） | 闸门拦下当前动作（如 PASS 裁定角色不对、验证未跑通、验证已过期、scope 越界、双轴未齐） | **这不是工具坏了**，是门禁在正常工作。按错误信息里的下一步修正后重试：补齐缺失动作（如先 flow_claim role=auditor）再重试。**不要重试同一调用** |`,

  // 从 defaultState() 生成，保证与状态结构永远一致（漂移防护）。
  // 测试 test/protocol-consistency.mjs 会逐字段比对，手工改回常量会红。
  STATE_FIELDS: JSON.stringify(defaultState()),

  AUDIT_EVENTS: `["run","finding","decision","resolution"]`,

  BYPASS_WORDS: `["直接干","跳过门禁","免检","别管流程","不用走流程"]`,

  CARD_TEMPLATE: `FLOW_CARD:{"goal":"一句话目标","quote":"用户原话摘录","scope":["只准改的文件"],"acceptance":["可判定的验收标准"],"unknowns":[],"assumptions":[],"files":[{"path":"a/b.py","line":1}],"verify":{"cmd":"pytest -q tests/x.py"},"confirmed":false}`,
};

// 敏感文件名单（三种匹配方式：文件名命中 / 路径段命中 / 扩展名命中）
const SENSITIVE_NAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production", ".env.test",
  "settings.json", "settings.local.json",
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "poetry.lock", "requirements.txt",
  "dockerfile", "docker-compose.yml", "docker-compose.yaml", "makefile",
]);

const SENSITIVE_SEGMENTS = new Set([
  "migrations", "deploy", "deployment", "k8s", "kube",
  ".github", ".gitlab", "secrets", "certs", "terraform",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".env",
]);

export function isSensitive(rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  const normalized = rel.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter((s) => s.length > 0);
  const base = segments.length ? segments[segments.length - 1] : normalized;

  if (SENSITIVE_NAMES.has(base)) return true;
  // 只检查目录段（不含最后一段文件名）：与 card.js 保持一致
  for (const seg of segments.slice(0, -1)) {
    if (SENSITIVE_SEGMENTS.has(seg)) return true;
  }
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }
  return false;
}

export function riskTier(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return "read_only";
  if (scope.some((p) => isSensitive(p))) return "sensitive";
  if (scope.length === 1) return "single_file";
  return "cross_module";
}