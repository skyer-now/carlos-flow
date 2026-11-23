// advisory 领域：调研与方案的轻量互审（P1/P2）。
//
// 与 T2 的双轴（flow_audit_axes / flow_audit_submit）**完全独立**：
// - 不读写 card / audit_axes，不参与 flow_verdict 的 PASS 门禁；
// - 只服务“回答前的交付检查”：调研是否真的做了、方案是否可行且能回滚；
// - 常规核查（classifyAdvisory 判 none）不产生任何记录与 prompt。
import {
  audit,
  ok,
  fail,
  loadState,
  commitState,
  writeDispatchPrompt,
  RUNS_DIR,
  sanitizeId,
} from './shared.js'
import {
  classifyAdvisory,
  appendAdvisoryLog,
  requiredAxes,
  axisForSingle,
  advisoryIsExpired,
  unboundClaims,
  normalizeQuestion,
  buildAdvisoryPrompt,
  resolveArtifact,
  evidenceSimilarity,
  CANARY_DEFECT,
  CANARY_TEXT,
  ADVISORY_TTL_MS,
} from '../advisory.js'
import { pruneAdvisoryPrompts, verifyEvidenceRef } from '../advisory-evidence.js'
import { randomBytes, createHash } from 'node:crypto'
import path from 'node:path'

const AXES = new Set(['evidence', 'feasibility'])
const VERDICTS = new Set(['PASS', 'WARN', 'FAIL'])

function normalizeClaims(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 50).map((c) => ({
    text: String((c && c.text) || '').trim().slice(0, 500),
    status: ['done', 'verified', 'not_run', 'unknown'].includes(c && c.status) ? c.status : 'unknown',
    evidence_ref: String((c && c.evidence_ref) || '').trim().slice(0, 500),
  })).filter((c) => c.text)
}

function axisRecord(advisory, axis) {
  return advisory && advisory.axes ? advisory.axes[axis] : null
}


/**
 * 创建一次互审记录并生成轴 prompt。
 * 供 flow_advisory_axes 与 trigger 自动准备共用，避免两套口径。
 */
export async function createAdvisoryRecord(input = {}) {
  const sid = input.sessionId || 'unknown'
  const question = normalizeQuestion(input.question)
  if (!question || question.length < 4) return { ok: false, reason: 'question 必填（至少 4 个字符）' }
  const state = input.state || loadState(sid)
  const cls = classifyAdvisory({ text: question, state })
  const explicit = input.level && input.level !== 'none'
  const level = explicit ? input.level : cls.level
  if (!['none', 'single', 'dual'].includes(level)) return { ok: false, reason: 'level 只能是 none / single / dual' }
  if (level === 'none') return { ok: true, triggered: false, level: 'none', matched_rules: cls.matched_rules, reason: cls.reason }

  const claims = normalizeClaims(input.claims)
  const artifact = resolveArtifact({ artifact: input.artifact, report: input.report })
  let effectiveLevel = level
  let artifactReason = ''
  if (level === 'single' && !artifact && input.report) {
    effectiveLevel = 'dual'
    artifactReason = '交付物类型不明确，保守升级为双轴'
  }
  const chosenArtifact = artifact || (effectiveLevel === 'single' ? 'research' : null)
  const axesToRun = effectiveLevel === 'dual'
    ? requiredAxes('dual')
    : [chosenArtifact === 'plan' ? 'feasibility' : axisForSingle({ report: input.report })]
  const canary = input.canary === true
  const advisory = {
    id: randomBytes(8).toString('hex'),
    level: effectiveLevel,
    artifact: chosenArtifact,
    canary: canary ? { defect: CANARY_DEFECT } : null,
    question,
    question_hash: cls.topic_hash,
    created_at: Date.now(),
    expires_at: Date.now() + ADVISORY_TTL_MS,
    axes: { evidence: null, feasibility: null },
    required: axesToRun,
    claims,
    cwd: input.cwd || process.cwd(),
    passed_at: 0,
  }
  const cwd = input.cwd || process.cwd()
  const prompts = {}
  for (const axis of axesToRun) {
    const prompt = buildAdvisoryPrompt(axis, {
      question,
      claims,
      report: input.report,
      canary: canary && axis === 'feasibility' ? CANARY_TEXT : '',
    })
    const { file } = writeDispatchPrompt(sid, 'auditor', prompt, cwd)
    prompts[axis] = { prompt, file }
  }
  pruneAdvisoryPrompts(path.join(RUNS_DIR, sanitizeId(sid), 'dispatch'))
  await commitState(sid, (latest) => {
    latest.advisory = advisory
    latest.advisory_log = appendAdvisoryLog(latest.advisory_log, {
      level: effectiveLevel,
      topic_hash: cls.topic_hash,
      reason: explicit ? '调用方显式指定' : cls.reason,
    })
  })
  audit('decision', sid, {
    kind: 'advisory_axes',
    level: effectiveLevel,
    axes: axesToRun,
    matched_rules: cls.matched_rules,
    downgraded: cls.downgraded === true,
  })
  return {
    ok: true,
    triggered: true,
    advisory_id: advisory.id,
    level: effectiveLevel,
    artifact: chosenArtifact,
    axes: axesToRun,
    matched_rules: cls.matched_rules,
    reason: (explicit ? '调用方显式指定' : cls.reason) + (artifactReason ? '；' + artifactReason : ''),
    canary: canary === true,
    expires_at: advisory.expires_at,
    claims_unbound: unboundClaims(claims).map((c) => c.text),
    prompts,
  }
}

const TOOLS = [
  {
    name: 'flow_advisory_axes',
    description:
      '【调研/方案互审】判定是否需要互审并生成审核合同 prompt（Evidence 轴：是否真的查了；Feasibility 轴：方案合理性/可行性/影响/回滚）。' +
      '常规核查判定为 none 时不生成任何记录；显式传 level 可覆盖。与 T2 的 flow_audit_axes 相互独立。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        question: { type: 'string', description: '本次调研/方案要回答的问题（必填）' },
        level: { type: 'string', enum: ['none', 'single', 'dual'], description: '显式指定互审强度（缺省按规则判定）' },
        claims: {
          type: 'array',
          description: '交付方声明清单：{text, status: done|verified|not_run|unknown, evidence_ref}',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['done', 'verified', 'not_run', 'unknown'] },
              evidence_ref: { type: 'string' },
            },
            required: ['text'],
          },
        },
        report: { type: 'object', description: '结构化报告/方案（options / recommendation / impact / rollback 等）' },
        artifact: { type: 'string', enum: ['research', 'plan'], description: '交付物类型：research=调研结论，plan=方案（缺省按 report 结构推断）' },
        canary: { type: 'boolean', description: '注入一个已知缺陷用于检验审核是否形式化（内部负对照）' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
      required: ['question'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sid = a.sessionId || 'unknown'
        const created = await createAdvisoryRecord({
          sessionId: sid,
          question: a.question,
          level: a.level,
          claims: a.claims,
          report: a.report,
          artifact: a.artifact,
          canary: a.canary,
          cwd: a.cwd,
        })
        if (!created.ok) return fail(created.reason)
        if (!created.triggered) {
          return ok({
            ok: true,
            triggered: false,
            level: 'none',
            matched_rules: created.matched_rules,
            reason: created.reason,
            note: '常规核查不触发互审。如确需审核，显式传 level=single 或 dual。',
          })
        }
        return ok({
          ...created,
          next: '用 subagent 并行派发只读审核者，完成后分别 flow_advisory_submit（axis=evidence/feasibility），再 flow_advisory_guard。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
  {
    name: 'flow_advisory_submit',
    description:
      '【调研/方案互审】提交单轴结论（evidence | feasibility）。必须绑定当前 advisory_id 且在有效期内；' +
      'PASS 必须带证据（file:line / URL / 命令输出），无证据的 PASS 会被拒。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        advisoryId: { type: 'string', description: 'flow_advisory_axes 返回的 advisory_id' },
        axis: { type: 'string', enum: ['evidence', 'feasibility'], description: '审核轴' },
        verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL'], description: '轴判定' },
        findings: { type: 'array', items: { type: 'string' }, description: '问题清单（每条带证据）' },
        evidence: { type: 'string', description: '核验依据摘要（命令/文件/来源）' },
      },
      required: ['advisoryId', 'axis', 'verdict'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sid = a.sessionId || 'unknown'
        const advisoryId = String(a.advisoryId || '').trim()
        if (!advisoryId) return fail('advisoryId 必填')
        if (!AXES.has(a.axis)) return fail('axis 只能是 evidence 或 feasibility')
        if (!VERDICTS.has(a.verdict)) return fail('verdict 只能是 PASS / WARN / FAIL')
        const evidence = String(a.evidence || '').trim()
        if (a.verdict === 'PASS' && evidence.length < 8) {
          return fail('PASS 必须带证据（至少 8 个字符，例如 file:line、URL、命令输出摘要）；无证据的 PASS 无效。')
        }
        const findings = Array.isArray(a.findings) ? a.findings.map((f) => String(f).slice(0, 500)).slice(0, 50) : []
        let result = null
        await commitState(sid, (latest) => {
          const advisory = latest.advisory
          if (!advisory || advisory.id !== advisoryId) return
          if (advisoryIsExpired(advisory)) return
          const need = Array.isArray(advisory.required) && advisory.required.length
            ? advisory.required
            : requiredAxes(advisory.level)
          if (!need.includes(a.axis)) return
          advisory.axes[a.axis] = {
            verdict: a.verdict,
            findings,
            evidence,
            ts: Date.now(),
          }
          result = { level: advisory.level, axes: { ...advisory.axes } }
        })
        if (!result) return fail('advisory 不存在、已过期、或该级别不要求这个轴；请重新 flow_advisory_axes。')
        audit('decision', sid, { kind: 'advisory_submit', axis: a.axis, verdict: a.verdict })
        return ok({ ok: true, advisoryId, axis: a.axis, verdict: a.verdict, level: result.level, axes: result.axes })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
  {
    name: 'flow_advisory_guard',
    description:
      '【调研/方案互审】交付前自查：该级别的轴是否齐、是否 FAIL、证据是否为空、声明是否都有引用、是否过期。' +
      '不通过时返回 missing / unbound_claims / expired，按提示补齐后重试；通过时落一条持久复核收据（advisory.passed_at + 证据摘要哈希）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        advisoryId: { type: 'string', description: 'flow_advisory_axes 返回的 advisory_id' },
      },
      required: ['advisoryId'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sid = a.sessionId || 'unknown'
        const advisoryId = String(a.advisoryId || '').trim()
        const state = loadState(sid)
        const advisory = state.advisory
        if (!advisory || advisory.id !== advisoryId) {
          return fail('advisory 不存在或不属于当前交付；请先 flow_advisory_axes。')
        }
        if (advisoryIsExpired(advisory)) {
          return fail('advisory 已过期（有效期 30 分钟）；请重新 flow_advisory_axes。')
        }
        const need = Array.isArray(advisory.required) && advisory.required.length
          ? advisory.required
          : requiredAxes(advisory.level)
        const missing = []
        const failed = []
        const emptyEvidence = []
        const warnings = []
        for (const axis of need) {
          const rec = axisRecord(advisory, axis)
          if (!rec || !rec.verdict) { missing.push(axis); continue }
          if (rec.verdict === 'FAIL') failed.push(axis)
          if (rec.verdict === 'WARN') warnings.push(axis)
          if (!String(rec.evidence || '').trim()) emptyEvidence.push(axis)
        }
        const unbound = unboundClaims(advisory.claims).map((c) => c.text)
        const problems = []

        // 证据引用核验：done/verified 的声明必须能被离线核验（path:line）或至少是外部链接。
        const unverifiedClaims = []
        for (const claim of Array.isArray(advisory.claims) ? advisory.claims : []) {
          if (claim.status !== 'done' && claim.status !== 'verified') continue
          const ref = String(claim.evidence_ref || '').trim()
          if (!ref) continue // 已在 unbound 里报过
          const checked = verifyEvidenceRef(ref, { cwd: advisory.cwd })
          if (checked.status === 'unverified') {
            unverifiedClaims.push(claim.text + '（' + checked.reason + '）')
          }
        }

        // canary：审核者拿到的是“已知缺陷”的方案，PASS 却没点出来 → 判定形式化。
        if (advisory.canary && advisory.axes.feasibility && advisory.axes.feasibility.verdict === 'PASS') {
          const rec = advisory.axes.feasibility
          const said = [...(rec.findings || []), String(rec.evidence || '')].join(' ')
          if (!/回滚|rollback|恢复|不可逆|revert/i.test(said)) {
            problems.push('canary 未被识别：方案缺少回滚步骤，但审核给出 PASS 且未指出（疑似形式化审核）')
          }
        }

        // 两轴互相抄袭：证据高度雷同视为未独立取证。
        if (need.length === 2 && advisory.axes.evidence && advisory.axes.feasibility) {
          const sim = evidenceSimilarity(advisory.axes.evidence.evidence, advisory.axes.feasibility.evidence)
          if (sim.identical || sim.jaccard >= 0.8) {
            problems.push('两轴证据高度雷同（jaccard=' + sim.jaccard.toFixed(2) + '），需要独立取证')
          }
        }
        if (missing.length) problems.push('缺少轴结论：' + missing.join(', '))
        if (failed.length) problems.push('轴判定 FAIL：' + failed.join(', '))
        if (emptyEvidence.length) problems.push('轴证据为空：' + emptyEvidence.join(', '))
        if (unbound.length) problems.push('声明没有证据引用：' + unbound.join('；'))
        if (unverifiedClaims.length) problems.push('声明证据无法离线核验：' + unverifiedClaims.join('；'))
        if (problems.length) {
          return fail('互审未通过：' + problems.join(' | ') + '。补齐后重试 flow_advisory_guard。')
        }
        // 通过后落持久收据：只记录摘要哈希，不复制证据正文。
        const receiptHash = createHash('sha256')
          .update(JSON.stringify({
            id: advisory.id,
            level: advisory.level,
            axes: need.map((axis) => [axis, advisory.axes[axis] && advisory.axes[axis].verdict]),
            claims: (advisory.claims || []).map((c) => [c.text, c.status, c.evidence_ref]),
          }))
          .digest('hex')
        const passedAt = Date.now()
        await commitState(sid, (latest) => {
          if (!latest.advisory || latest.advisory.id !== advisoryId) return
          latest.advisory.passed_at = passedAt
          latest.advisory.passed_hash = receiptHash
        })
        audit('resolution', sid, { kind: 'advisory_passed', advisoryId, level: advisory.level, receipt: receiptHash })

        return ok({
          ok: true,
          advisoryId,
          level: advisory.level,
          passed_at: passedAt,
          receipt: receiptHash,
          axes: { evidence: advisory.axes.evidence, feasibility: advisory.axes.feasibility },
          warnings,
          claims: advisory.claims.length,
          note: warnings.length
            ? '互审通过但有 WARN：汇报时必须显式说明这些保留意见，不能吞。'
            : '互审通过。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
]

export { TOOLS }