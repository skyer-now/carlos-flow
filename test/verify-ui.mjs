import { narrate, deriveWizardStatus } from "../ui/narrator.js";
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const mock = { kind: "blocked", reason: "操作范围越界" };
const res = narrate(mock);

if (res.text.includes("抱歉") && res.text.includes("越界")) {
  console.log("✅ 语义翻译风格校验通过");
  // 原语义断言通过后继续验证只读向导投影。
} else {
  console.error("❌ 风格不符，实际输出: " + res.text);
  process.exit(1);
}

const proof = { verify_state: 'pass', verify_passed: true, fingerprint_available: true, sampled_at: 5000 }
const good = () => ({
  card: { goal: '修复问题', scope: ['private/file.js'], acceptance: ['行为通过'], verify: { cmd: 'secret-command' } },
  card_ts: 1000, activation_pending: [], dispatch_count: 1,
  last_verify: { card_ts: 1000, ts: 2001, cmd: 'secret-command', ok: true, exitCode: 0, output_hash: 'a'.repeat(64) },
  last_falsify: { ts: 2000, cmd: 'secret-command', verdict: 'meaningful', before: { ok: false, exitCode: 1, hash: 'b'.repeat(64) }, after: { ok: true, exitCode: 0, hash: 'a'.repeat(64) }, restore: { ok: true, checked: 1, mismatched: [] } },
  audit_axes: { standards: { card_ts: 1000, ts: 3000, verdict: 'PASS', evidence: 'private-output' }, spec: { card_ts: 1000, ts: 3000, verdict: 'PASS', evidence: 'private-output' } },
  verdict: 'PASS', verdict_role: 'auditor', completed_ok: true, verdict_ts: 4000,
})
let cases = 0
function check(name, modify, expected, observation = proof) {
  const s = good(); modify(s)
  const before = JSON.stringify(s)
  const out = deriveWizardStatus(s, observation)
  assert.equal(out.stage, expected, name)
  assert.equal(out.completed_ok, expected === 'complete', name)
  assert.equal(JSON.stringify(s), before, '投影不得修改状态：' + name)
  const encoded = JSON.stringify(out)
  for (const secret of ['secret-command', 'private/file.js', 'private-output', 'RAW_SECRET']) assert.ok(!encoded.includes(secret), '摘要不得暴露原始信息')
  cases++
}
check('合法当前证据', () => {}, 'complete')
check('无卡自报完成', s => { s.card = null }, 'start')
check('目标缺失', s => { s.card.goal = '' }, 'goal')
check('空范围', s => { s.card.scope = [] }, 'scope')
check('占位卡', s => { s.activation_pending = ['scope'] }, 'scope')
check('验收缺失', s => { s.card.acceptance = [] }, 'scope')
check('未知卡代', s => { s.card_ts = 0 }, 'scope')
check('只派发不完成', s => { s.last_verify = null; s.dispatch_count = 99 }, 'execution')
check('旧卡验证', s => { s.last_verify.card_ts = 999 }, 'checks')
check('缺少验证卡代', s => { delete s.last_verify.card_ts }, 'checks')
check('旧验证时间', s => { s.last_verify.ts = 999 }, 'checks')
check('命令不匹配', s => { s.last_verify.cmd = 'other' }, 'checks')
check('验证失败', s => { s.last_verify.ok = false }, 'checks')
check('权威失败', () => {}, 'checks', { ...proof, verify_state: 'fail' })
check('权威陈旧', () => {}, 'checks', { ...proof, verify_state: 'stale' })
check('权威未知', () => {}, 'checks', {})
check('指纹未知', () => {}, 'checks', { ...proof, fingerprint_available: false })
check('权威通过缺失', () => {}, 'checks', { ...proof, verify_passed: false })
check('还原失败', s => { s.last_falsify.restore.ok = false; s.last_falsify.restore.mismatched = ['RAW_SECRET'] }, 'problem')
check('还原未知', s => { s.last_falsify.restore = null }, 'checks')
check('空还原证据', s => { s.last_falsify.restore.checked = 0 }, 'checks')
check('负对照缺失', s => { s.last_falsify = null }, 'checks')
check('旧负对照', s => { s.last_falsify.ts = 999 }, 'checks')
check('显式旧负对照卡代', s => { s.last_falsify.card_ts = 999 }, 'checks')
check('空测试', s => { s.last_falsify.verdict = 'vacuous' }, 'checks')
check('负对照超时不算失败', s => { s.last_falsify.before.exitCode = null }, 'checks')
check('负对照哈希不匹配', s => { s.last_falsify.after.hash = 'c'.repeat(64) }, 'checks')
check('验证哈希未知', s => { s.last_verify.output_hash = '' }, 'checks')
check('双轴失败', s => { s.audit_axes.spec.verdict = 'FAIL' }, 'review')
check('双轴缺失', s => { s.audit_axes.spec = null }, 'review')
check('双轴未知', s => { s.audit_axes.spec.verdict = 'UNKNOWN' }, 'review')
check('双轴旧卡', s => { s.audit_axes.standards.card_ts = 999 }, 'review')
check('审查早于验证', s => { s.audit_axes.spec.ts = 1500 }, 'review')
check('审查证据未知', s => { s.audit_axes.spec.evidence = '' }, 'review')
check('双轴提醒不硬拦', s => { s.audit_axes.spec.verdict = 'WARN' }, 'complete')
assert.equal(deriveWizardStatus({ ...good(), audit_axes: { ...good().audit_axes, spec: { ...good().audit_axes.spec, verdict: 'WARN' } } }, proof).warning_count, 1)
check('执行者自批', s => { s.verdict_role = 'executor' }, 'review')
check('裁定角色未知', s => { s.verdict_role = null }, 'review')
check('旧最终裁定', s => { s.verdict_ts = 999 }, 'review')
check('裁定早于审查', s => { s.verdict_ts = 2500 }, 'review')
check('自报完成不是裁定', s => { s.verdict = null; s.verified = true; s.step = 7 }, 'review')
check('未派发', s => { s.dispatch_count = 0 }, 'review')
check('审计待确认', s => { s.audit_pending = { error: 'RAW_SECRET' } }, 'problem')
check('权威时间过期', () => {}, 'problem', { ...proof, task_stale: true })
check('任务陈旧', s => { s.stale = true }, 'problem')
check('免检不能假绿', s => { s.bypass = true }, 'problem')

// 独立目录中的正常 fixture 写入；真实 stdio 工具调用验证投影接线与只读。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-phase1-'))
process.env.CARLOS_FLOW_HOME = home
const { saveState, defaultState, RUNS_DIR } = await import('../src/state.js')
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url))
async function statusFixture(sid, state) {
  saveState(sid, state)
  const stateFile = path.join(RUNS_DIR, sid, 'state.json')
  const before = fs.readFileSync(stateFile)
  const child = spawn(process.execPath, [entry], { env: { ...process.env, CARLOS_FLOW_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flow_status', arguments: { sessionId: sid } } }) + '\n')
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  assert.equal(code, 0, stderr)
  const reply = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.id === 1)
  assert.ok(reply?.result && !reply.result.isError, stdout)
  const result = JSON.parse(reply.result.content[0].text)
  assert.deepEqual(fs.readFileSync(stateFile), before, '真实 flow_status 不得写 fixture 状态')
  assert.ok(Number.isFinite(result.wizard.sampled_at), '采样时间来自真实 handler')
  return result
}
const empty = await statusFixture('wizard-empty', defaultState())
assert.equal(empty.wizard.stage, 'start')
assert.equal(empty.wizard.completed_ok, false)
const half = await statusFixture('wizard-half', { ...defaultState(), card: good().card, card_ts: 1000, activation_pending: ['verify.cmd'] })
assert.equal(half.wizard.stage, 'scope')
const nonGit = good(); nonGit.last_verify.cwd = home
const now = Date.now()
nonGit.card_ts = now - 4000
nonGit.last_verify.card_ts = nonGit.card_ts
nonGit.last_verify.ts = now - 2000
nonGit.last_falsify.ts = now - 2001
for (const axis of Object.values(nonGit.audit_axes)) { axis.card_ts = nonGit.card_ts; axis.ts = now - 1000 }
nonGit.verdict_ts = now
nonGit.last_verify.fingerprint = { ok: false, reason: 'not_a_git_repo' }
const unknown = await statusFixture('wizard-nongit', { ...defaultState(), ...nonGit })
assert.equal(unknown.verify_state, 'pass', '保留原非 Git 兼容字段')
assert.equal(unknown.wizard.stage, 'checks', '没有可用指纹不冒充完整向导完成')
assert.equal(unknown.wizard.completed_ok, false)
console.log(`✅ 只读向导 ${cases} 条矩阵及 3 条真实 Node 工具响应通过；fixture 保留于 ${home}`)
