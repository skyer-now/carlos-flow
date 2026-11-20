// Carlos Flow 协议 — 路由档位 / 四段合同 / 报告规格 / 错误分层 / 状态字段的唯一真源。
// 被协调器（coordinator）与各角色 Agent 共同引用。

// 状态字段从 defaultState() 生成，而不是手写常量 ——
// 手写副本会漂移（历史上就漏过 claimed / claimed_role / activation_* 等 9 个字段），
// 而协议是 Agent 运行时读取的权威依据，漂移会让 Agent 按错误的字段名做决策。
// 代价：protocol.js 依赖 state.js（纯数据模块，无副作用，无循环依赖），
// 并依赖 node:fs / node:path 读取项目级敏感规则配置（见文件末尾）。
import fs from "node:fs";
import path from "node:path";
import { defaultState } from "./state.js";

export const GUIDE_MODE = { ROSTER: "主agent(Orchestrator),开发(executor+developer),测试(executor+tester),审核(auditor+reviewer)", TALKING_POINTS: ["一次只说一件事", "术语给类比", "给选择题不抛开放式问题", "复述意图", "明示能力边界"], REPORT_TEMPLATE: "【在做什么】/【已经完成】/【要你选】/【还有什么风险】" };

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

  FULL_TASK_WIZARD: 'Cindy start_wizard 的 open/prepare 在当前 Host 本机可写任务只读采样并供准确意图卡；resume 只消费原生确认的独立expected，不进后端参数、不锁未来SID。普通call_tool不补SID/cwd、不碰向导KV，旧STALE expected保留。页面三项内存草稿只是未可信提案，按钮零Node/Agent；现有原生卡真票continue后新active resume，协调一个动作后本回合prepare下一意图卡，不要求用户催技术调用。目标→范围→执行→真实检查负对照与还原→独立审查→结果依据flow_status真源，不扩权限、免检、自动PASS或重放。缓存异常只影响展示；确认异常failclosed，LWW非CAS/exactlyonce，真实Host连续闭环仍待验。',

  STALE_WIZARD: '仅PASS真实指纹STALE供三按钮卡；查看/暂缓仅KV且不取消已提交重查。重新检查以真实点击票Agent continue后发新工具调用，沿原权限，不复活旧callId。expected可选；无效绝不fallback。不可变offer与永久wx claim按同旧验证代最多启动一次；满128代fail-closed，无GC，不封普通手动验证。未知结果不自动重放/PASS/falsify；不承诺硬件掉电exactly-once。',

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
  // 凭证与私钥（2026-11-14 补）：此前 .ssh/id_rsa、.npmrc、.aws/credentials
  // 这类高价值目标一律放行，executor 改它们不会触发 confirmed 确认。
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ed448",
  ".npmrc", ".netrc", ".pgpass", "credentials", "known_hosts", "authorized_keys",
]);

const SENSITIVE_SEGMENTS = new Set([
  "migrations", "deploy", "deployment", "k8s", "kube",
  ".github", ".gitlab", "secrets", "certs", "terraform",
  // 凭证目录（2026-11-14 补）：只检查目录段，所以 ".ssh" 能拦住 .ssh/id_rsa。
  ".ssh", ".aws", ".gnupg", ".docker", ".azure", ".gcloud",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".env",
  // 密码库与签名材料（2026-11-14 补）
  ".kdbx", ".kdb", ".gpg", ".asc", ".crt", ".cer", ".der",
]);

// ---- 项目级敏感路径扩展（只能追加，不能缩减）-------------------------------
//
// 为什么需要：内置名单（.env / 私钥 / 锁文件 / migrations 目录…）是**安全基线**，
// 但每个项目的敏感面并不相同 —— 有的私有证书目录叫 `secret_material/`，
// 有的对账账本放在 `billing/ledger/`。过去这些只能靠人肉提醒，
// 现在允许项目在仓库根放一个 `.carlos.json` 追加自己的规则：
//
//   { "sensitive": { "names": ["pay_api_key.txt"], "segments": ["ledger"],
//                     "extensions": [".vault"], "prefixes": ["billing/ledger/"] } }
//
// 红线（AGENTS.md 第 1 条「门禁只许收紧，不许放宽」）：
//   · 只能**追加**：本模块不提供任何删减 / 豁免 / 否定语法；
//   · 以 `!` 或 `-` 开头的条目一律忽略并写 stderr —— 防止有人用
//     `"!package.json"` 试图把内置基线里的项放出去；
//   · 配置读不到 / 解析失败 → 保持内置基线（不会因为配置坏了就放宽门禁）。
const PROJECT_CONFIG_FILE = ".carlos.json";
const MAX_CONFIG_WALK = 12; // 向上找配置的最大层数，防止符号链接成环

const EXTRA_SENSITIVE = {
  names: new Set(),
  segments: new Set(),
  extensions: new Set(),
  prefixes: [],
};
let extraConfigKey = "";
let extraConfigFile = "";

const normalizeRule = (v) => String(v == null ? "" : v).trim().replace(/\\/g, "/").toLowerCase();

function isNegated(rule) {
  return rule.startsWith("!") || rule.startsWith("-");
}

function addRules(list, target, kind) {
  let added = 0;
  let ignored = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const n = normalizeRule(raw);
    if (!n) continue;
    if (isNegated(n)) {
      // 不允许「取消敏感」语法：只提示，不生效（门禁只许收紧）
      ignored++;
      try {
        process.stderr.write(`[carlos-flow] 已忽略否定式敏感规则（不允许放宽门禁）：${raw}\n`);
      } catch { /* stderr 不可写时静默 */ }
      continue;
    }
    if (kind === "extension") {
      const ext = n.startsWith(".") ? n : "." + n;
      if (!target.has(ext)) { target.add(ext); added++; }
    } else if (kind === "prefix") {
      const p = n.endsWith("/") ? n : n + "/";
      if (!target.includes(p)) { target.push(p); added++; }
    } else if (!target.has(n)) {
      target.add(n);
      added++;
    }
  }
  return { added, ignored };
}

/** 清空项目级扩展，回到内置基线（测试与「换项目」场景用）。 */
export function resetSensitiveRules() {
  EXTRA_SENSITIVE.names.clear();
  EXTRA_SENSITIVE.segments.clear();
  EXTRA_SENSITIVE.extensions.clear();
  EXTRA_SENSITIVE.prefixes.length = 0;
  extraConfigKey = "";
  extraConfigFile = "";
}

/**
 * 追加一份项目级敏感规则（**只增不减**）。
 * 接受 `.carlos.json` 的整份内容（读 `sensitive` 键），也接受直接给出的规则对象。
 * 返回实际生效的条数与被忽略的否定式条数，便于 status / 测试断言「真的加上了」。
 */
export function addProjectSensitiveRules(cfg) {
  const root = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  const s = root.sensitive && typeof root.sensitive === "object" && !Array.isArray(root.sensitive)
    ? root.sensitive
    : root;
  const out = { names: 0, segments: 0, extensions: 0, prefixes: 0, ignored: 0 };
  const n = addRules(s.names, EXTRA_SENSITIVE.names, "name");
  out.names = n.added; out.ignored += n.ignored;
  const sg = addRules(s.segments, EXTRA_SENSITIVE.segments, "segment");
  out.segments = sg.added; out.ignored += sg.ignored;
  const ex = addRules(s.extensions, EXTRA_SENSITIVE.extensions, "extension");
  out.extensions = ex.added; out.ignored += ex.ignored;
  const px = addRules(s.prefixes, EXTRA_SENSITIVE.prefixes, "prefix");
  out.prefixes = px.added; out.ignored += px.ignored;
  return out;
}

/** 当前生效的敏感规则快照（内置基线 + 项目扩展），用于诊断与测试。 */
export function sensitiveRulesSnapshot() {
  return {
    builtin: {
      names: SENSITIVE_NAMES.size,
      segments: SENSITIVE_SEGMENTS.size,
      extensions: SENSITIVE_EXTENSIONS.size,
    },
    extra: {
      names: Array.from(EXTRA_SENSITIVE.names).sort(),
      segments: Array.from(EXTRA_SENSITIVE.segments).sort(),
      extensions: Array.from(EXTRA_SENSITIVE.extensions).sort(),
      prefixes: EXTRA_SENSITIVE.prefixes.slice().sort(),
    },
    configFile: extraConfigFile || null,
  };
}

/**
 * 从 startDir 逐级向上找 `.carlos.json`，加载其中的 `sensitive` 规则。
 *
 * 缓存：按「文件路径 + mtime + size」判定是否重复加载 —— 每次工具调用都会走一遍，
 * 不做缓存的话每个请求都要重新读盘解析。
 * 找不到配置时**清空扩展**（回到内置基线），避免上一个项目追加的规则污染本项目。
 */
export function loadProjectSensitiveConfig(startDir) {
  const start = typeof startDir === "string" && startDir ? path.resolve(startDir) : process.cwd();
  let dir = start;
  for (let i = 0; i < MAX_CONFIG_WALK; i++) {
    const file = path.join(dir, PROJECT_CONFIG_FILE);
    try {
      const st = fs.statSync(file);
      const key = file + "|" + st.mtimeMs + "|" + st.size;
      if (key === extraConfigKey) {
        return { loaded: extraConfigFile === file, file, cached: true };
      }
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        parseError = e && e.message ? e.message : String(e);
      }
      resetSensitiveRules();
      if (parseError) {
        // 配置坏了 → 保持内置基线，绝不因此放宽门禁
        try {
          process.stderr.write(`[carlos-flow] .carlos.json 解析失败，已退回内置敏感基线：${parseError}\n`);
        } catch { /* ignore */ }
        extraConfigKey = key;
        return { loaded: false, file, error: parseError };
      }
      const applied = addProjectSensitiveRules(parsed);
      extraConfigKey = key;
      extraConfigFile = file;
      return { loaded: true, file, applied };
    } catch (e) {
      if (!e || e.code !== "ENOENT") {
        // 权限等其它错误：保持当前规则继续向上找
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (extraConfigKey) resetSensitiveRules();
  return { loaded: false, file: null };
}

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

  // 项目级扩展（只能追加；为空时零开销）
  if (EXTRA_SENSITIVE.names.size && EXTRA_SENSITIVE.names.has(base)) return true;
  if (EXTRA_SENSITIVE.segments.size) {
    for (const seg of segments.slice(0, -1)) {
      if (EXTRA_SENSITIVE.segments.has(seg)) return true;
    }
  }
  if (EXTRA_SENSITIVE.extensions.size) {
    for (const ext of EXTRA_SENSITIVE.extensions) {
      if (base.endsWith(ext)) return true;
    }
  }
  for (const prefix of EXTRA_SENSITIVE.prefixes) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return true;
  }
  return false;
}

export function riskTier(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return "read_only";
  if (scope.some((p) => isSensitive(p))) return "sensitive";
  if (scope.length === 1) return "single_file";
  return "cross_module";
}