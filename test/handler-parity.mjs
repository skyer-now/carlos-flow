// 阶段一固定契约与真实 RPC 安全负例；所有状态在临时目录。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const home = mkdtempSync(path.join(tmpdir(), 'carlos-handler-parity-'))
process.env.CARLOS_FLOW_HOME = path.join(home, 'flow')
process.env.HOME = process.env.USERPROFILE = path.join(home, 'home')
mkdirSync(process.env.HOME, { recursive: true })
const { createCatalog } = await import('../src/handlers/catalog.js')
const tools = createCatalog(() => { throw new Error('目录体检不得执行门面') })
const schemas = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
assert.equal(tools.length, 26)
assert.equal(createHash('sha256').update(JSON.stringify(schemas)).digest('hex'), '5bddbd3f337bb33ea8451ec0abc8b8591a5ac505ea8c02fc647bdd69ecabb5b0', '42b19d6 的工具顺序、描述、Schema 固定摘要')
for (const [domain, evidence] of Object.entries({ gate: ['validateCard(', 'snapshotFiles(', '门禁 9/9'], verify: ['runVerifyCommand(', 'runNegativeControl('], audit: ['audit_axis_submitted', 'readAuditDetailed('], infra: ['writeUserMessage(', 'enforceScope('], facade: ['callTool(targetTool, args, context, runtime)'] })) {
  const source = readFileSync(path.join(root, 'src/handlers', domain + '.js'), 'utf8')
  for (const token of evidence) assert.ok(source.includes(token), `${domain} 必须拥有真实领域实现 ${token}`)
  assert.ok(!source.includes('toolObj.handler('), '门面不得绕过统一校验')
}
const cases = [
  ['flow_claim', {}], ['carlos_task', { action: 'claim', role: 'invalid' }],
  ['carlos_review', { action: 'submit', verdict: 'PASS' }],
  ['carlos_review', { action: 'verdict', verdict: 'WARN' }],
  ['carlos_manage', { action: 'bypass' }], ['carlos_verify', { action: 'invalid' }],
  ['flow_mode', {}], ['flow_check_scope', { paths: ['existing.js', 123] }],
  ['flow_run_verify', { timeoutMs: 0 }], ['flow_falsify', { timeoutMs: 1000.5 }],
  ['flow_run_verify', { expected: {} }], ['flow_run_verify', { expected: { caseKey: 'x', extra: true } }],
  ['flow_submit_requirement', { verify: [] }],
]
const requests = [ { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...cases.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 3, method: 'tools/call', params: { name, arguments: { sessionId: 'negative', ...args } } })),
]
const rpc = spawnSync(process.execPath, [path.join(root, 'src/index.js')], { input: requests.map(r => JSON.stringify(r)).join('\n') + '\n', env: process.env, encoding: 'utf8', timeout: 30000, windowsHide: true })
assert.equal(rpc.status, 0, rpc.stderr)
const replies = rpc.stdout.trim().split('\n').map(line => JSON.parse(line))
assert.deepEqual(replies.find(r => r.id === 2).result.tools, schemas)
for (let i = 0; i < cases.length; i++) {
  const result = replies.find(r => r.id === i + 3)?.result
  assert.equal(result?.isError, true, `${cases[i][0]} 缺参或非法值必须拒绝`)
  // 原子 claim/审查提交无 required 字段：缺业务前置条件是领域拒绝，不伪称 Schema 缺参。
  if (i === 0 || i === 2) {
    assert.equal(result.structuredContent, undefined)
    continue
  }
  assert.equal(result.structuredContent.code, 'INVALID_TOOL_ARGUMENTS')
  assert.deepEqual(result.structuredContent.originalArguments, { sessionId: 'negative', ...cases[i][1] })
  assert.ok(result.structuredContent.schema)
  assert.ok(Array.isArray(result.structuredContent.missing))
}
const { auditRequests, guideError, fail } = await import('../src/handlers/shared.js')
const card = { goal: ' 已填目标 ', quote: '用户原话', scope: ['existing.js'], acceptance: [], verify: { cmd: '' }, confirmed: false }
const guided = auditRequests.run([], () => fail(guideError({ mode: 'guide', card, activation_pending: ['acceptance', 'verify.cmd'] }, '激活占位卡尚未补齐')))
assert.equal(guided.structuredContent.code, 'ACTIVATION_INCOMPLETE')
assert.deepEqual(guided.structuredContent.recovery.preservedCard, card)
assert.deepEqual(guided.structuredContent.recovery.missing, ['acceptance', 'verify.cmd'])
assert.equal(guided.structuredContent.recovery.requiresUserFacts, true)
assert.equal(auditRequests.run([], () => fail(guideError({ mode: 'pro', card, activation_pending: ['acceptance'] }, '激活占位卡尚未补齐'))).structuredContent, undefined)
const { loadState, saveState, defaultState } = await import('../src/state.js')
const project = path.join(home, 'project')
mkdirSync(project)
writeFileSync(path.join(project, 'existing.js'), 'export const value = 1\n')
const state = { ...defaultState(), card: { goal: 'fixture', quote: 'fixture', scope: ['existing.js'], acceptance: ['fixture'], verify: { cmd: 'node -e "process.exit(0)"' }, env: { project } }, card_ts: Date.now(), last_user_ts: Date.now(), claimed: true }
saveState('dispatch-race', state)
const raceRequests = [1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'flow_dispatch', arguments: { sessionId: 'dispatch-race', cwd: project } } }))
raceRequests.push({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flow_check_scope', arguments: { sessionId: 'dispatch-race', cwd: root } } })
const race = spawnSync(process.execPath, [path.join(root, 'src/index.js')], { input: raceRequests.map(r => JSON.stringify(r)).join('\n') + '\n', env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
assert.equal(race.status, 0, race.stderr)
const raceReplies = race.stdout.trim().split('\n').map(JSON.parse)
assert.equal(raceReplies.filter(r => r.id < 3 && !r.result.isError).length, 1, '单 claim 并发只能派发一次')
assert.equal(loadState('dispatch-race').dispatch_count, 1)
assert.equal(raceReplies.find(r => r.id === 3).result.isError, true, '显式异仓范围检查拒绝')
const versionFixture = path.join(home, 'version-fixture')
mkdirSync(path.join(versionFixture, 'scripts'), { recursive: true })
for (const name of ['package.json', 'package-lock.json', 'ghost.json', 'CHANGELOG.md']) cpSync(path.join(root, name), path.join(versionFixture, name))
cpSync(path.join(root, 'scripts/sync-version.mjs'), path.join(versionFixture, 'scripts/sync-version.mjs'))
const history = '# 历史 v2.12.0\n旧说明 v2.13.0，示例 v1.2.3\n'
writeFileSync(path.join(versionFixture, 'TRIGGER_GUIDE.md'), '> **版本**: v0.0.1\n' + history + '**版本**: v0.0.1\n')
const sync = spawnSync(process.execPath, [path.join(versionFixture, 'scripts/sync-version.mjs')], { encoding: 'utf8', env: process.env, windowsHide: true })
assert.equal(sync.status, 0, sync.stderr)
assert.equal(readFileSync(path.join(versionFixture, 'TRIGGER_GUIDE.md'), 'utf8'), '> **版本**: v2.28.1\n' + history + '**版本**: v2.28.1\n', '仅当前版本行更新，历史版本必须逐字保留')
console.log('handler parity：固定26工具契约、五域真实实现、RPC目录及安全负例通过；隔离目录：' + home)
