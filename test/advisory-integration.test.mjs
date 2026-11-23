// 互审接入实际使用路径（集成）：trigger 只提示 → 显式 axes → submit → guard 收据。
//
// 约束验证：
//   · 会开卡的 T2 消息不创建互审（避免和 PASS 双轴重复）；
//   · trigger 只提示，不自动建记录、不写 prompt（按确认的口径）；
//   · flow_status 能看到 pending / missing / passed_at / receipt；
//   · 常规核查不产生任何互审记录。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-adv-int-'))
process.env.CARLOS_FLOW_HOME = path.join(home, 'flow')
process.env.HOME = process.env.USERPROFILE = path.join(home, 'home')
fs.mkdirSync(process.env.HOME, { recursive: true })

const { TOOLS: infraTools } = await import('../src/handlers/infra.js')
const { TOOLS: advisoryTools } = await import('../src/handlers/advisory.js')
const { loadState, RUNS_DIR } = await import('../src/state.js')

const trigger = infraTools.find((t) => t.name === 'flow_trigger_check').handler
const status = infraTools.find((t) => t.name === 'flow_status').handler
const axes = advisoryTools.find((t) => t.name === 'flow_advisory_axes').handler
const submit = advisoryTools.find((t) => t.name === 'flow_advisory_submit').handler
const guard = advisoryTools.find((t) => t.name === 'flow_advisory_guard').handler

const text = (r) => r?.content?.[0]?.text || ''
const json = (r) => {
  try { return JSON.parse(text(r)) } catch { return { __raw: text(r), __isError: r?.isError === true } }
}

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

describe('互审 · 实际路径集成（只提示）', () => {
  it('常规核查：只给 none，不建记录', async () => {
    const r = json(await trigger({ sessionId: 'int-routine', message: '看一下 README 第一行是什么', execute: false }))
    assert.equal(r.advisory.level, 'none')
    assert.equal(r.advisory.prepared, false)
    assert.equal(r.advisory.next, null)
    assert.equal(loadState('int-routine').advisory, null)
  })

  it('方案消息：trigger 只提示，显式调用才创建', async () => {
    const r = json(await trigger({ sessionId: 'int-plan', message: '这个架构方案可行吗，影响哪些模块', execute: false }))
    assert.equal(r.advisory.level, 'dual')
    assert.equal(r.advisory.prepared, false)
    assert.ok(String(r.advisory.next).includes('advisory_axes'))
    assert.equal(loadState('int-plan').advisory, null, 'trigger 不得自动建记录')
    const dispatchDir = path.join(RUNS_DIR, 'int-plan', 'dispatch')
    assert.equal(fs.existsSync(dispatchDir), false, 'trigger 不得写 prompt')

    const created = json(await axes({ sessionId: 'int-plan', question: '这个架构方案可行吗，影响哪些模块' }))
    assert.equal(created.level, 'dual')
    assert.deepEqual(created.axes, ['evidence', 'feasibility'])
    assert.ok(created.advisory_id)

    const st = json(await status({ sessionId: 'int-plan' }))
    assert.equal(st.advisory.id, created.advisory_id)
    assert.equal(st.advisory.passed, false)
    assert.deepEqual(st.advisory.missing, ['evidence', 'feasibility'])
    assert.equal(st.advisory.passed_at, 0)
    assert.equal(st.card, null)
  })

  it('提交两轴后 status 显示 passed 并有持久收据', async () => {
    const sid = 'int-plan'
    const id = loadState(sid).advisory.id
    await submit({ sessionId: sid, advisoryId: id, axis: 'evidence', verdict: 'PASS', evidence: 'src/handlers/gate.js:120 复核调用方' })
    await submit({ sessionId: sid, advisoryId: id, axis: 'feasibility', verdict: 'PASS', evidence: 'npm run test:all 输出哈希 9f2c；回滚脚本已演练' })
    const guardRes = json(await guard({ sessionId: sid, advisoryId: id }))
    assert.equal(guardRes.ok, true, JSON.stringify(guardRes))
    assert.ok(guardRes.receipt)

    const st = json(await status({ sessionId: sid }))
    assert.equal(st.advisory.passed, true, JSON.stringify(st.advisory))
    assert.ok(st.advisory.passed_at > 0)
    assert.equal(st.advisory.receipt, guardRes.receipt)
  })

  it('声明引用无法离线核验时被拦', async () => {
    const sid = 'int-claims'
    const created = json(await axes({
      sessionId: sid,
      question: '这个架构方案可行吗',
      claims: [{ text: '我核对过所有调用方', status: 'verified', evidence_ref: 'src/not-exists.js:10' }],
    }))
    await submit({ sessionId: sid, advisoryId: created.advisory_id, axis: 'evidence', verdict: 'PASS', evidence: 'src/a.js:1 复核' })
    await submit({ sessionId: sid, advisoryId: created.advisory_id, axis: 'feasibility', verdict: 'PASS', evidence: '方案第 2 节；回滚已演练' })
    const blocked = text(await guard({ sessionId: sid, advisoryId: created.advisory_id }))
    assert.ok(blocked.includes('无法离线核验'), blocked)
  })

  it('会开卡的 T2 消息不创建互审', async () => {
    const r = json(await trigger({ sessionId: 'int-t2', message: '帮我开发登录功能并写好测试，走门禁流程', execute: false }))
    assert.equal(r.should_trigger, true, '用例本身必须真的会触发工作流')
    assert.equal(r.advisory.prepared, false)
    assert.equal(loadState('int-t2').advisory, null)
  })

  it('同主题第二次创建时降级为单轴（冷却按实际创建计）', async () => {
    const sid = 'int-cooldown'
    const q = '发布前需要做哪些检查和回滚准备'
    const first = json(await axes({ sessionId: sid, question: q }))
    assert.equal(first.level, 'dual')
    const second = json(await axes({ sessionId: sid, question: q }))
    assert.equal(second.level, 'single', JSON.stringify(second))
    assert.deepEqual(second.axes, ['evidence'])
  })

  it('互审不产生任务卡，也不写 T2 双轴字段', async () => {
    const st = loadState('int-plan')
    assert.equal(st.card, null)
    assert.deepEqual(st.audit_axes, { standards: null, spec: null })
    assert.equal(st.verdict, null)
    assert.equal(st.completed_ok, false)
  })
})