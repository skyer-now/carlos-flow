// audit 领域：真实工具实现与原始契约。
import {
  audit,
  ok,
  fail,
  loadState,
  readAuditDetailed,
  verifyAuditChain,
  commitState,
  auditHashMode,
  buildContractPrompt,
  writeDispatchPrompt,
} from './shared.js'
const TOOLS = [
{
    name: 'flow_audit_axes',
    description:
      '派发两个并行审计 subagent（Standards 轴 / Spec 轴），生成两段审计合同 prompt。' +
      'executor 改动通过 flow_run_verify 与负对照后、落 PASS 裁定前必须先调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        cwd: {
          type: 'string',
          description: '仓库工作目录，默认 process.cwd()',
        },
      },
    },
    handler: async (args) => {
      try {
        const sid = args.sessionId || 'unknown'
        const state = loadState(sid)
        if (!state.card) return fail('无卡，无法派发审计轴')

        const cwd = args.cwd || process.cwd()
        const res = { standards: null, spec: null }
        for (const axis of ['standards', 'spec']) {
          const prompt = buildContractPrompt('auditor', state.card, '', axis)
          const { file } = writeDispatchPrompt(sid, 'auditor', prompt, cwd)
          res[axis] = { prompt, file }
        }
        return ok({ ok: true, ...res })
      } catch (e) {
        return fail(String(e))
      }
    },
  },
{
    name: 'flow_audit_submit',
    description:
      '保存某一审计轴（standards|spec）的结论与证据到会话状态。' +
      'PASS 裁定前必须两轴都提交，且各自绑定的 card_ts 与当前卡一致。同轴可重复提交（后者覆盖）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        axis: {
          type: 'string',
          enum: ['standards', 'spec'],
          description: '审计轴',
        },
        verdict: {
          type: 'string',
          enum: ['PASS', 'FAIL', 'WARN'],
          description: '轴判定；WARN=坏味道等 judgement call，不硬拦',
        },
        findings: {
          type: 'array',
          items: { type: 'string' },
          description: '每条含 file:line 或证据',
        },
        evidence: { type: 'string', description: '实跑命令输出 / diff 摘录' },
      },
    },
    handler: async (args) => {
      try {
        const sid = args.sessionId || 'unknown'
        const state = loadState(sid)
        if (!state.card) return fail('无卡，无法提交审计轴结论')
        const axisCardTs = state.card_ts
        await commitState(sid, (latest) => {
          if (!latest.card) return
          latest.audit_axes[args.axis] = {
            verdict: args.verdict,
            findings: args.findings,
            evidence: args.evidence,
            // 绑定提交时的卡片：换卡后该轴证据立即失效，必须重审
            card_ts: axisCardTs,
            ts: Date.now(),
          }
          latest.audit_axes_ts = Date.now()
          state.audit_axes = latest.audit_axes
        })

        // 审计留痕：只落在 state 里的轴结论可被覆盖、不可追溯。
        // 因此补一条审计事件，回答「这条结论是谁在什么时候提交的」。
        // 只记结论与证据摘要，不整段拷贝 evidence（验证输出可能很长）。
        audit('decision', sid, {
          kind: 'audit_axis_submitted',
          axis: args.axis,
          verdict: args.verdict,
          findings: Array.isArray(args.findings) ? args.findings : [],
          has_evidence:
            typeof args.evidence === 'string' && args.evidence.trim() !== '',
          card_ts: state.card_ts,
        })
        const stored = [
          state.audit_axes.standards,
          state.audit_axes.spec,
        ].filter(Boolean).length
        return ok({ ok: true, axis: args.axis, stored_axes_count: stored })
      } catch (e) {
        return fail(String(e))
      }
    },
  },
{
    name: 'flow_audit_guard',
    description:
      '校验两轴是否已通过且证据齐全（与 flow_verdict 内的双轴门禁同口径）。' +
      '主 Agent 落 PASS 前可主动自查；flow_verdict 不受此调用影响，仍会再拦一道。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '会话 ID' } },
    },
    handler: async (args) => {
      try {
        const sid = args.sessionId || 'unknown'
        const state = loadState(sid)
        const ax = state.audit_axes
        // 口径与 flow_verdict 的双轴门禁完全一致：
        // 两轴都有 verdict（不能缺失/空）、card_ts 与当前卡一致、且无轴 FAIL。
        const axisOk = (a) =>
          ax && ax[a] && ax[a].verdict && ax[a].card_ts === state.card_ts
        if (!axisOk('standards') || !axisOk('spec')) {
          return fail(
            '两轴审计未齐或证据失效（需 flow_audit_axes 派发 + flow_audit_submit 两轴且 card_ts 与当前卡一致）',
          )
        }
        if (ax.standards.verdict === 'FAIL' || ax.spec.verdict === 'FAIL') {
          return fail(
            '两轴中至少一轴 FAIL（standards=' +
              ax.standards.verdict +
              ', spec=' +
              ax.spec.verdict +
              '）。',
          )
        }
        return ok({ ok: true })
      } catch (e) {
        return fail(String(e))
      }
    },
  },
{
    name: 'flow_audit',
    description:
      '读取审计流水（gate-audit/*.jsonl），返回事件列表与按 type / kind 的统计。可按 sessionId、type（run/finding/decision/resolution）、日期过滤。' +
      '不给 sessionId 则聚合全部会话。用于复核“到底派发了什么、改了什么、谁批的”，也用于事后追溯。' +
      '同时可验证审计链完整性。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID；不传则聚合全部' },
        type: {
          type: 'string',
          description: '事件类型过滤：run / finding / decision / resolution',
        },
        limit: { type: 'number', description: '最多返回最近 N 条' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        verifyChain: { type: 'boolean', description: '是否验证审计链完整性' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const opts = {}
        if (a.sessionId != null && a.sessionId !== '')
          opts.sessionId = a.sessionId
        if (a.type != null && a.type !== '') opts.type = a.type
        if (typeof a.limit === 'number') opts.limit = a.limit
        if (typeof a.date === 'string' && a.date !== '') opts.date = a.date

        const readResult = readAuditDetailed(opts)
        const rows = readResult.rows
        const by_type = {}
        const by_kind = {}
        for (const row of rows) {
          const t = row.type || 'none'
          by_type[t] = (by_type[t] || 0) + 1
          const k = row.kind || 'none'
          by_kind[k] = (by_kind[k] || 0) + 1
        }

        let chainResult = null
        if (a.verifyChain) {
          chainResult = verifyAuditChain(opts)
        }

        return ok({
          ok: readResult.complete,
          complete: readResult.complete,
          readErrors: readResult.readErrors,
          invalidLines: readResult.invalidLines,
          empty: readResult.empty,
          coverage: readResult.coverage,
          total: rows.length,
          by_type,
          by_kind,
          events: rows,
          chain: chainResult,
          mode: auditHashMode(),
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
]
export { TOOLS }
