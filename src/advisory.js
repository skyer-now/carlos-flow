/**
 * 调研 / 方案的互审判定（P2 分类器 + P1 记录约束）。
 *
 * 目标：把“我主动喊审核”变成“高风险才自动审”，并且**常规核查不打扰**。
 *
 * 设计约束：
 * - 纯规则、零模型调用、<5ms：分类器不能拖慢普通请求；
 * - 判定可解释：每次返回 matched_rules 与 reason；
 * - 不改变 T0/T1/T2 主路由，也不参与 T2 的 PASS 双轴门禁；
 * - 冷却与预算只做降级（dual → single），不静默丢弃审核。
 */

import { createHash } from 'node:crypto'
import { RULES } from './advisory-rules.js'

export const ADVISORY_LEVELS = Object.freeze(['none', 'single', 'dual'])

// 触发规则表在 src/advisory-rules.js（中英双语，独立文件便于维护与测试）。

const LEVEL_RANK = { none: 0, single: 1, dual: 2 }

const DUAL_COOLDOWN_MS = 30 * 60 * 1000
const DUAL_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000
export const DUAL_BUDGET_MAX = 6
export const ADVISORY_TTL_MS = 30 * 60 * 1000
export const ADVISORY_LOG_MAX = 50

export function normalizeQuestion(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

export function topicHash(text) {
  const norm = normalizeQuestion(text)
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()【】\[\]{}<>《》\-—_/\\]/g, '')
  return createHash('sha256').update(norm.slice(0, 80)).digest('hex').slice(0, 16)
}

function countDual(log, since) {
  return (Array.isArray(log) ? log : []).filter((e) => e && e.level === 'dual' && Number(e.ts) >= since).length
}

function lastDualSameTopic(log, hash, since) {
  return (Array.isArray(log) ? log : []).some(
    (e) => e && e.level === 'dual' && e.topic_hash === hash && Number(e.ts) >= since,
  )
}

/**
 * 判定一次调研/方案需要什么强度的互审。
 *
 * @param {object} input
 * @param {string} input.text        用户问题或交付主题
 * @param {object} [input.state]     会话状态（用于冷却与预算）
 * @param {number} [input.now]
 * @returns {{level:'none'|'single'|'dual', matched_rules:string[], reason:string, downgraded:boolean, budget:{used:number,max:number}}}
 */
export function classifyAdvisory(input = {}) {
  const text = normalizeQuestion(input.text)
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const log = Array.isArray(input.state?.advisory_log) ? input.state.advisory_log : []
  const matched = RULES.filter((r) => r.re.test(text)).map((r) => r.id)
  const matchedRules = RULES.filter((r) => matched.includes(r.id))

  let level = 'none'
  for (const rule of matchedRules) {
    if (LEVEL_RANK[rule.level] > LEVEL_RANK[level]) level = rule.level
  }
  // routine 只在没有 dual 时生效： “查一下发布流程” 仍然要审。
  if (level !== 'dual' && matched.includes('routine')) level = 'none'

  const hash = topicHash(text)
  let downgraded = false
  let reason = level === 'none'
    ? '常规核查，不触发互审'
    : level === 'single' ? '单轴复核（调研或时效事实）' : '双轴互审（高风险/方案决策）'

  if (level === 'dual') {
    if (lastDualSameTopic(log, hash, now - DUAL_COOLDOWN_MS)) {
      level = 'single'
      downgraded = true
      reason = '同一主题 30 分钟内已双审过，降级为单轴复核'
    } else if (countDual(log, now - DUAL_BUDGET_WINDOW_MS) >= DUAL_BUDGET_MAX) {
      level = 'single'
      downgraded = true
      reason = `24 小时内双审已达 ${DUAL_BUDGET_MAX} 次，降级为单轴复核`
    }
  }

  return {
    level,
    matched_rules: matched,
    reason,
    downgraded,
    budget: { used: countDual(log, now - DUAL_BUDGET_WINDOW_MS), max: DUAL_BUDGET_MAX },
    topic_hash: hash,
  }
}

/** 记录一次判定（有界）。返回新日志数组，不修改入参。 */
export function appendAdvisoryLog(log, entry, now = Date.now()) {
  const list = Array.isArray(log) ? log.slice(-(ADVISORY_LOG_MAX - 1)) : []
  list.push({
    ts: now,
    level: entry.level,
    topic_hash: entry.topic_hash || '',
    reason: entry.reason || '',
  })
  return list
}

/** 该级别要求哪些轴。 */
export function requiredAxes(level) {
  if (level === 'dual') return ['evidence', 'feasibility']
  if (level === 'single') return ['evidence']
  return []
}

/**
 * 单轴模式下按交付物类型选轴：有方案/选项 → feasibility，否则 evidence。
 */
export function axisForSingle(payload = {}) {
  const hasPlan = payload.report && (Array.isArray(payload.report.options) || payload.report.recommendation)
  return hasPlan ? 'feasibility' : 'evidence'
}

export function advisoryIsExpired(advisory, now = Date.now()) {
  return !advisory || !Number.isFinite(Number(advisory.expires_at)) || Number(advisory.expires_at) <= now
}

/** 声明与证据的绑定检查：只有 done/verified 需要证据引用。 */
export function unboundClaims(claims) {
  return (Array.isArray(claims) ? claims : []).filter(
    (c) => c && (c.status === 'done' || c.status === 'verified') && !String(c.evidence_ref || '').trim(),
  )
}
const AXIS_CHECKLISTS = {
  evidence: [
    '逐条核对“已执行/已核实”的声明：是否真有工具调用、文件行号、命令输出或可访问来源；没有就标“未验证”。',
    '来源质量：一手来源优于二手转述；引用必须能定位（file:line 或 URL + 抓取时间）。',
    '覆盖与反面：是否只挑了支持结论的材料？有没有主动找反例或替代解释？',
    '时效：版本、价格、政策、API 行为等是否可能已变化；用了旧资料必须指出。',
    '结论与证据是否一一对应：结论里出现但证据没有覆盖的部分，必须列出来。',
  ],
  feasibility: [
    '是否给出至少两个选项（含“不做/维持现状”），并说明取舍理由？',
    '技术可行性：依赖、版本、平台限制、权限、数据迁移是否需要；有没有未验证的假设？',
    '成本与影响面：涉及哪些文件/系统/数据/权限，谁会受影响，最坏情况是什么？',
    '可逆性：失败怎么回滚？回滚是否经过验证，还是只写在纸上？',
    '验收：方案落地后如何判定成功？有没有可执行的检查或指标？',
  ],
}

/**
 * 生成审核合同 prompt。只读、零文件改动；审核者不得重跑长测，
 * 也不得把“没查到”说成“没问题”。
 */
export function buildAdvisoryPrompt(axis, payload = {}) {
  const checklist = AXIS_CHECKLISTS[axis] || AXIS_CHECKLISTS.evidence
  const claims = Array.isArray(payload.claims) ? payload.claims : []
  const claimLines = claims.length
    ? claims.map((c, i) => `  ${i + 1}. [${c.status || 'unknown'}] ${c.text}${c.evidence_ref ? `（引用：${c.evidence_ref}）` : '（无引用）'}`).join('\n')
    : '  （交付方未提供声明清单 —— 这本身就是缺陷，必须在 findings 里指出）'
  const report = payload.report ? JSON.stringify(payload.report, null, 2) : '（未提供结构化报告）'
  const axisName = axis === 'feasibility' ? 'Spec/可行性轴（方案合理性、技术可行性、影响与回滚）' : 'Evidence/调研轴（是否真的查了、来源是否支撑结论）'
  return [
    `role: auditor（只读复核，零文件改动）`,
    `axis: ${axisName}`,
    ``,
    `objective: 独立复核下面这份${axis === 'feasibility' ? '方案' : '调研结论'}，不要替交付方补理由。`,
    ``,
    `question: ${payload.question || '（缺失）'}`,
    ``,
    `交付方声明（claims）：`,
    claimLines,
    ``,
    payload.canary ? `已知风险（交付方自述）：${payload.canary}` : '',
    payload.canary ? `` : '',
    `交付方结构化报告：`,
    report,
    ``,
    `核对清单：`,
    ...checklist.map((line) => `- ${line}`),
    ``,
    `输出格式（≤200 字）：`,
    `1. 裁定：PASS / WARN / FAIL（FAIL = 有未验证的关键结论、缺回滚、或证据不支撑结论）`,
    `2. findings：每条带 file:line 或 URL/命令；没有证据的结论必须标“未验证”`,
    `3. 建议的最小修复动作（一句话）`,
    ``,
    `边界：不得改动任何文件；不得重跑长测；无法核实就写“未验证”，不许猜。`,
  ].join('\n')
}


/**
 * 解析交付物类型：research | plan。
 * 显式给出优先；否则按 report 结构推断；推断不出来时返回 null，
 * 由调用方按“保守升级为 dual”处理，避免猜错后静默降级。
 */
export function resolveArtifact(payload = {}) {
  if (payload.artifact === 'research' || payload.artifact === 'plan') return payload.artifact
  const report = payload.report
  if (report && typeof report === 'object') {
    if (Array.isArray(report.options) || typeof report.recommendation === 'string' || report.rollback) return 'plan'
    if (Array.isArray(report.claims) || report.sources) return 'research'
  }
  return null
}

/** 证据/结论的文本相似度：用于识别两轴互相抄袭。 */
export function evidenceSimilarity(a, b) {
  const norm = (t) => String(t || '').toLowerCase().replace(/s+/g, ' ').trim()
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return { identical: false, jaccard: 0 }
  if (x === y) return { identical: true, jaccard: 1 }
  const tokens = (t) => new Set(t.split(/[^p{L}p{N}_]+/u).filter((w) => w.length > 1))
  const tx = tokens(x)
  const ty = tokens(y)
  let inter = 0
  for (const t of tx) if (ty.has(t)) inter++
  const union = tx.size + ty.size - inter
  return { identical: false, jaccard: union === 0 ? 0 : inter / union }
}

export const CANARY_DEFECT = 'missing-rollback'
export const CANARY_TEXT = 'CANARY（交付方自述）：本方案没有提供回滚步骤，失败后只能人工恢复。'
