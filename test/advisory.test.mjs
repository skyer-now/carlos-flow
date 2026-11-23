// 调研/方案互审（P1/P2）专项。
//
// 覆盖：
//   · 分类器：常规核查不触发、高风险双轴、时效/调研单轴、冷却与预算降级；
//   · 状态迁移 v4 → v5 的默认值；
//   · advisory_axes / submit / guard 的真实行为（证据绑定、过期、轴缺失、未绑定声明）；
//   · 与 T2 双轴互不干扰（不写 card/audit_axes，不改裁定字段）。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-advisory-'))
process.env.CARLOS_FLOW_HOME = path.join(home, 'flow')
process.env.HOME = process.env.USERPROFILE = path.join(home, 'home')
fs.mkdirSync(process.env.HOME, { recursive: true })

const {
  classifyAdvisory,
  appendAdvisoryLog,
  requiredAxes,
  DUAL_BUDGET_MAX,
  ADVISORY_TTL_MS,
} = await import('../src/advisory.js')
const { TOOLS } = await import('../src/handlers/advisory.js')
const { loadState, saveState, defaultState, migrate, CURRENT_SCHEMA_VERSION } = await import('../src/state.js')

const tool = (name) => TOOLS.find((t) => t.name === name).handler
const text = (res) => res?.content?.[0]?.text || ''
const json = (res) => {
  try { return JSON.parse(text(res)) } catch { return { __raw: text(res), __isError: res?.isError === true } }
}
const sid = 'advisory-sid'

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

describe('P2 · 互审分类器', () => {
  it('常规核查不触发', () => {
    for (const q of ['帮我看下 README 第一行是什么', '翻译这段话', '查一下最新 Node 版本']) {
      const r = classifyAdvisory({ text: q })
      assert.equal(r.level, 'none', q)
      assert.ok(Array.isArray(r.matched_rules))
    }
  })

  it('高风险与方案决策判为 dual', () => {
    for (const q of ['发布到 npm 前要做哪些检查', '这个架构方案可行吗，影响哪些模块', '给我一个迁移方案并评估风险']) {
      assert.equal(classifyAdvisory({ text: q }).level, 'dual', q)
    }
  })

  it('时效事实与排障结论判为 single', () => {
    assert.equal(classifyAdvisory({ text: '修复这个 bug 的根因是什么' }).level, 'single')
    assert.equal(classifyAdvisory({ text: '核实一下这个 API 的最新行为' }).level, 'single')
  })

  it('同一主题 30 分钟内降级为单轴', () => {
    const q = '发布到 npm 前要做哪些检查'
    const hash = classifyAdvisory({ text: q }).topic_hash
    const state = { advisory_log: [{ ts: Date.now() - 5 * 60 * 1000, level: 'dual', topic_hash: hash }] }
    const r = classifyAdvisory({ text: q, state })
    assert.equal(r.level, 'single')
    assert.equal(r.downgraded, true)
  })

  it('24 小时内双审达到预算后降级', () => {
    const log = Array.from({ length: DUAL_BUDGET_MAX }, (_, i) => ({
      ts: Date.now() - (i + 1) * 60 * 1000,
      level: 'dual',
      topic_hash: 'other-' + i,
    }))
    const r = classifyAdvisory({ text: '发布流程要不要调整', state: { advisory_log: log } })
    assert.equal(r.level, 'single')
    assert.ok(r.reason.includes('降级'))
  })

  it('日志有界，最多保留 50 条', () => {
    let log = []
    for (let i = 0; i < 60; i++) log = appendAdvisoryLog(log, { level: 'single', topic_hash: 't' + i, reason: 'x' }, Date.now() + i)
    assert.equal(log.length, 50)
  })
})

describe('P1 · 状态迁移与互审工具', () => {
  it('v4 状态迁移到 v5 且字段有默认值', () => {
    const migrated = migrate({ schemaVersion: 4 })
    assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(migrated.advisory, null)
    assert.deepEqual(migrated.advisory_log, [])
  })

  it('常规问题调用 axes 不生成记录', async () => {
    const res = json(await tool('flow_advisory_axes')({ sessionId: sid, question: '帮我看下 README 第一行是什么' }))
    assert.equal(res.triggered, false)
    assert.equal(res.level, 'none')
    assert.equal(loadState(sid).advisory, null)
  })

  it('方案问题生成双轴 prompt 并绑定 advisory', async () => {
    const res = json(await tool('flow_advisory_axes')({
      sessionId: sid,
      question: '这个架构方案可行吗，影响哪些模块',
      claims: [{ text: '已跑过全量测试', status: 'done', evidence_ref: 'npm run test:all: exit 0' }],
    }))
    assert.equal(res.triggered, true)
    assert.equal(res.level, 'dual')
    assert.deepEqual(res.axes, ['evidence', 'feasibility'])
    assert.ok(res.advisory_id)
    assert.ok(res.prompts.evidence.prompt.includes('Evidence'))
    assert.ok(res.prompts.feasibility.prompt.includes('可行性'))
    const st = loadState(sid)
    assert.equal(st.advisory.id, res.advisory_id)
    assert.equal(st.advisory.level, 'dual')
    globalThis.__advisoryId = res.advisory_id
  })

  it('guard 在轴未齐时拒绝，并指出缺哪一轴', async () => {
    const res = text(await tool('flow_advisory_guard')({ sessionId: sid, advisoryId: globalThis.__advisoryId }))
    assert.ok(res.includes('互审未通过'))
    assert.ok(res.includes('evidence') || res.includes('feasibility'))
  })

  it('无证据的 PASS 被拒绝', async () => {
    const res = text(await tool('flow_advisory_submit')({
      sessionId: sid, advisoryId: globalThis.__advisoryId, axis: 'evidence', verdict: 'PASS',
    }))
    assert.ok(res.includes('PASS 必须带证据'))
  })

  it('错误轴被拒绝（dual 之外不要求的轴不能顶替）', async () => {
    const res = text(await tool('flow_advisory_submit')({
      sessionId: sid, advisoryId: globalThis.__advisoryId, axis: 'standards', verdict: 'PASS', evidence: 'x'.repeat(20),
    }))
    assert.ok(res.includes('axis 只能是'))
  })

  it('两轴带证据后 guard 通过；声明缺引用会拦下', async () => {
    let res = text(await tool('flow_advisory_submit')({
      sessionId: sid, advisoryId: globalThis.__advisoryId, axis: 'evidence', verdict: 'PASS',
      findings: [], evidence: 'src/handlers/gate.js:1 与 npm run test:all 输出哈希',
    }))
    assert.ok(res.includes('"ok": true'), res)

    // 未绑定引用的声明会让 guard 失败
    await tool('flow_advisory_axes')({
      sessionId: sid,
      question: '这个架构方案可行吗，影响哪些模块',
      level: 'dual',
      claims: [{ text: '我看过所有调用方', status: 'verified' }],
    })
    const st = loadState(sid)
    const id2 = st.advisory.id
    await tool('flow_advisory_submit')({ sessionId: sid, advisoryId: id2, axis: 'evidence', verdict: 'PASS', evidence: 'src/handlers/gate.js:120 复核了调用方清单' })
    await tool('flow_advisory_submit')({ sessionId: sid, advisoryId: id2, axis: 'feasibility', verdict: 'PASS', evidence: 'npm run test:all 输出哈希 9f2c；回滚脚本已演练' })
    const blocked = text(await tool('flow_advisory_guard')({ sessionId: sid, advisoryId: id2 }))
    assert.ok(blocked.includes('没有证据引用'), blocked)
    globalThis.__advisoryId = id2
  })

  it('FAIL 轴会被 guard 拦下', async () => {
    await tool('flow_advisory_submit')({
      sessionId: sid, advisoryId: globalThis.__advisoryId, axis: 'feasibility', verdict: 'FAIL',
      findings: ['没有回滚方案'], evidence: '方案文档缺失回滚章节',
    })
    const blocked = text(await tool('flow_advisory_guard')({ sessionId: sid, advisoryId: globalThis.__advisoryId }))
    assert.ok(blocked.includes('FAIL'), blocked)
  })

  it('过期后 submit/guard 都被拒', async () => {
    const st = loadState(sid)
    st.advisory.expires_at = Date.now() - 1000
    saveState(sid, st)
    const sub = text(await tool('flow_advisory_submit')({
      sessionId: sid, advisoryId: st.advisory.id, axis: 'evidence', verdict: 'PASS', evidence: 'file:line 证据',
    }))
    assert.ok(sub.includes('不存在、已过期') || sub.includes('过期'), sub)
    const guard = text(await tool('flow_advisory_guard')({ sessionId: sid, advisoryId: st.advisory.id }))
    assert.ok(guard.includes('过期'), guard)
  })

  it('单轴模式只要求一个轴，且按报告类型选轴', async () => {
    const res = json(await tool('flow_advisory_axes')({
      sessionId: sid,
      question: '核实一下这个 API 的最新行为',
      report: { options: [{ name: 'A' }], recommendation: 'A' },
    }))
    assert.equal(res.level, 'single')
    assert.deepEqual(res.axes, ['feasibility'])
    await tool('flow_advisory_submit')({
      sessionId: sid, advisoryId: res.advisory_id, axis: 'feasibility', verdict: 'PASS',
      evidence: 'https://example.com/docs 2026-11-23 抓取',
    })
    const guard = json(await tool('flow_advisory_guard')({ sessionId: sid, advisoryId: res.advisory_id }))
    assert.equal(guard.ok, true, JSON.stringify(guard))
  })

  it('trigger_check 只附带审查提示，不改变原有决策', async () => {
    const { TOOLS: infraTools } = await import('../src/handlers/infra.js')
    const check = infraTools.find((t) => t.name === 'flow_trigger_check').handler
    const res = json(await check({ sessionId: 'advisory-trigger', message: '这个架构方案可行吗，影响哪些模块', execute: false }))
    assert.equal(res.ok, true)
    assert.ok(['trigger', 'ignore', 'review', 'throttled', 'read_only'].includes(res.decision), res.decision)
    assert.equal(res.advisory.level, 'dual')
    assert.ok(res.advisory.matched_rules.includes('architecture'))
    const st = loadState('advisory-trigger')
    assert.equal(st.card, null, 'execute=false 不得开卡')
  })

  it('互审不碰 T2 的卡与双轴，也不改裁定字段', async () => {
    const st = loadState(sid)
    assert.equal(st.card, null)
    assert.deepEqual(st.audit_axes, { standards: null, spec: null })
    assert.equal(st.verdict, null)
    assert.equal(st.completed_ok, false)
    assert.equal(requiredAxes('none').length, 0)
    assert.ok(ADVISORY_TTL_MS >= 60 * 1000)
  })
})

describe('P2 · 公用加固（选轴 / canary / 相似度 / 英文）', () => {
  it('英文触发词生效，常规查询仍不触发', () => {
    assert.equal(classifyAdvisory({ text: 'rollback plan for the release' }).level, 'dual')
    assert.equal(classifyAdvisory({ text: 'review this design for feasibility' }).level, 'dual')
    assert.equal(classifyAdvisory({ text: 'look up the latest version' }).level, 'none')
    assert.equal(classifyAdvisory({ text: 'check the file' }).level, 'none')
  })

  it('显式 artifact=plan 时单轴只要求 feasibility', async () => {
    const res = json(await tool('flow_advisory_axes')({
      sessionId: 'adv-plan', question: '核实一下这个 API 的最新行为', artifact: 'plan', report: { options: [{ name: 'A' }] },
    }))
    assert.equal(res.level, 'single')
    assert.deepEqual(res.axes, ['feasibility'])
    assert.equal(loadState('adv-plan').advisory.artifact, 'plan')
  })

  it('结构化报告类型不明时保守升级为 dual', async () => {
    const res = json(await tool('flow_advisory_axes')({
      sessionId: 'adv-ambiguous', question: '核实一下这个 API 的最新行为', report: { impact: { files: 2 } },
    }))
    assert.equal(res.level, 'dual')
    assert.deepEqual(res.axes, ['evidence', 'feasibility'])
    assert.ok(String(res.reason).includes('类型不明确'))
  })

  it('canary：审核 PASS 却没点出“缺回滚”时被拦', async () => {
    const sid2 = 'adv-canary'
    const created = json(await tool('flow_advisory_axes')({
      sessionId: sid2, question: '这个架构方案可行吗', canary: true,
    }))
    assert.equal(created.canary, true)
    await tool('flow_advisory_submit')({ sessionId: sid2, advisoryId: created.advisory_id, axis: 'evidence', verdict: 'PASS', evidence: 'src/a.js:1 复核调用方' })
    await tool('flow_advisory_submit')({ sessionId: sid2, advisoryId: created.advisory_id, axis: 'feasibility', verdict: 'PASS', findings: ['实现清晰'], evidence: '方案文档第 3 节' })
    const blocked = text(await tool('flow_advisory_guard')({ sessionId: sid2, advisoryId: created.advisory_id }))
    assert.ok(blocked.includes('canary'), blocked)

    await tool('flow_advisory_submit')({
      sessionId: sid2, advisoryId: created.advisory_id, axis: 'feasibility', verdict: 'PASS',
      findings: ['方案缺少回滚步骤，必须补上'], evidence: '方案文档第 3 节没有回滚章节',
    })
    const passed = json(await tool('flow_advisory_guard')({ sessionId: sid2, advisoryId: created.advisory_id }))
    assert.equal(passed.ok, true, JSON.stringify(passed))
  })

  it('两轴证据高度雷同被拦', async () => {
    const sid3 = 'adv-similar'
    const created = json(await tool('flow_advisory_axes')({ sessionId: sid3, question: '这个架构方案可行吗' }))
    const same = 'src/handlers/gate.js:1 复核完成 npm run test:all 通过'
    await tool('flow_advisory_submit')({ sessionId: sid3, advisoryId: created.advisory_id, axis: 'evidence', verdict: 'PASS', evidence: same })
    await tool('flow_advisory_submit')({ sessionId: sid3, advisoryId: created.advisory_id, axis: 'feasibility', verdict: 'PASS', evidence: same })
    const blocked = text(await tool('flow_advisory_guard')({ sessionId: sid3, advisoryId: created.advisory_id }))
    assert.ok(blocked.includes('雷同'), blocked)
  })
})


describe('P1 · 长期可用性（清理 / 引用核验 / 收据）', () => {
  it('只清理互审 prompt，不动其它 prompt', async () => {
    const { pruneAdvisoryPrompts, ADVISORY_MARKER } = await import('../src/advisory-evidence.js')
    const dir = path.join(home, 'prompts')
    fs.mkdirSync(dir, { recursive: true })
    const mk = (name, body, ageMs) => {
      const file = path.join(dir, name)
      fs.writeFileSync(file, body, 'utf8')
      const t = new Date(Date.now() - ageMs)
      fs.utimesSync(file, t, t)
    }
    mk('1_auditor.prompt.txt', ADVISORY_MARKER + String.fromCharCode(10) + '旧互审', 5000)
    mk('2_auditor.prompt.txt', ADVISORY_MARKER + String.fromCharCode(10) + '次新互审', 3000)
    mk('3_auditor.prompt.txt', ADVISORY_MARKER + String.fromCharCode(10) + '最新互审', 1000)
    mk('4_auditor.prompt.txt', 'Standards 轴' + String.fromCharCode(10) + 'T2 审计 prompt', 5000)
    const res = pruneAdvisoryPrompts(dir, { keep: 1, maxAgeMs: 60 * 60 * 1000 })
    assert.equal(res.removed, 2)
    const left = fs.readdirSync(dir).sort()
    assert.deepEqual(left, ['3_auditor.prompt.txt', '4_auditor.prompt.txt'])
  })

  it('证据引用离线核验：path:line / URL / 自由文本', async () => {
    const { verifyEvidenceRef } = await import('../src/advisory-evidence.js')
    assert.equal(verifyEvidenceRef('src/advisory.js:1').status, 'verified')
    assert.equal(verifyEvidenceRef('src/not-exists.js:1').status, 'unverified')
    assert.equal(verifyEvidenceRef('https://example.com/x').status, 'external')
    assert.equal(verifyEvidenceRef('我印象里是对的').status, 'unverified')
  })
})
