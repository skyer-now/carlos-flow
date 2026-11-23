// 互审接入实际使用路径（集成）：trigger → 自动准备 → status → submit → guard。
//
// 约束验证：
//   · 会开卡的 T2 消息不创建互审（避免和 PASS 双轴重复）；
//   · 只读调研/方案消息在 trigger 阶段就把记录与两轴 prompt 准备好；
//   · flow_status 能看到 pending / missing / passed；
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
const { loadState } = await import('../src/state.js')

const trigger = infraTools.find((t) => t.name === 'flow_trigger_check').handler
const status = infraTools.find((t) => t.name === 'flow_status').handler
const submit = advisoryTools.find((t) => t.name === 'flow_advisory_submit').handler
const guard = advisoryTools.find((t) => t.name === 'flow_advisory_guard').handler

const text = (r) => r?.content?.[0]?.text || ''
const json = (r) => {
  try { return JSON.parse(text(r)) } catch { return { __raw: text(r), __isError: r?.isError === true } }
}

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

describe('互审 · 实际路径集成', () => {
  it('常规核查不创建记录', async () => {
    const r = json(await trigger({ sessionId: 'int-routine', message: '看一下 README 第一行是什么', execute: false }))
    assert.equal(r.advisory.level, 'none')
    assert.equal(r.advisory.prepared, false)
    assert.equal(loadState('int-routine').advisory, null)
  })

  it('方案类消息在 trigger 阶段自动准备双轴，且不开卡', async () => {
    const r = json(await trigger({ sessionId: 'int-plan', message: '这个架构方案可行吗，影响哪些模块', execute: false }))
    assert.equal(r.advisory.level, 'dual')
    assert.equal(r.advisory.prepared, true)
    assert.ok(r.advisory.advisory_id)
    assert.deepEqual(r.advisory.axes, ['evidence', 'feasibility'])
    assert.ok(r.advisory.prompts.evidence.prompt.includes('Evidence'))
    assert.ok(r.advisory.prompts.feasibility.prompt.includes('可行性'))
    assert.equal(loadState('int-plan').card, null, '不得开卡')

    const st = json(await status({ sessionId: 'int-plan' }))
    assert.equal(st.advisory.id, r.advisory.advisory_id)
    assert.equal(st.advisory.passed, false)
    assert.deepEqual(st.advisory.missing, ['evidence', 'feasibility'])
  })

  it('按提示提交两轴后 status 显示 passed', async () => {
    const sid = 'int-plan'
    const id = loadState(sid).advisory.id
    await submit({ sessionId: sid, advisoryId: id, axis: 'evidence', verdict: 'PASS', evidence: 'src/handlers/gate.js:120 复核调用方' })
    await submit({ sessionId: sid, advisoryId: id, axis: 'feasibility', verdict: 'PASS', evidence: 'npm run test:all 输出哈希 9f2c；回滚脚本已演练' })
    const st = json(await status({ sessionId: sid }))
    assert.equal(st.advisory.passed, true, JSON.stringify(st.advisory))
    assert.equal(st.advisory.expired, false)
  })

  it('会开卡的 T2 消息不创建互审（交给 PASS 双轴）', async () => {
    const r = json(await trigger({ sessionId: 'int-t2', message: '帮我开发登录功能并写好测试，走门禁流程', execute: false }))
    assert.equal(r.should_trigger, true, '用例本身必须真的会触发工作流')
    assert.equal(r.advisory.prepared, false, 'T2 路径不要再叠一层互审')
    assert.equal(loadState('int-t2').advisory, null)
  })

  it('同主题第二次自动降级为单轴', async () => {
    const sid = 'int-cooldown'
    const first = json(await trigger({ sessionId: sid, message: '发布前需要做哪些检查和回滚准备', execute: false }))
    assert.equal(first.advisory.level, 'dual')
    const second = json(await trigger({ sessionId: sid, message: '发布前需要做哪些检查和回滚准备', execute: false }))
    assert.equal(second.advisory.level, 'single', JSON.stringify(second.advisory))
    assert.equal(second.advisory.prepared, true)
    assert.deepEqual(second.advisory.axes, ['evidence'])
  })

  it('互审不产生任务卡，也不写 T2 双轴字段', async () => {
    const st = loadState('int-plan')
    assert.equal(st.card, null)
    assert.deepEqual(st.audit_axes, { standards: null, spec: null })
    assert.equal(st.verdict, null)
    assert.equal(st.completed_ok, false)
  })
})