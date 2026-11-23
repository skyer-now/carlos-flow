// 阶段一固定契约与真实 RPC 安全负例；所有状态在临时目录。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, unlinkSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const tempRoot = path.resolve(root, '../../.carlos-test-tmp')
mkdirSync(tempRoot, { recursive: true })
const home = mkdtempSync(path.join(tempRoot, 'carlos-handler-parity-'))
process.env.TMP = process.env.TEMP = home
process.env.CARLOS_FLOW_HOME = path.join(home, 'flow')
process.env.HOME = process.env.USERPROFILE = path.join(home, 'home')
mkdirSync(process.env.HOME, { recursive: true })
const { createCatalog } = await import('../src/handlers/catalog.js')
const tools = createCatalog(() => { throw new Error('目录体检不得执行门面') })
const schemas = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
// v3.1 起：底层 22 个操作保持原顺序与契约；4 个门面新增了动作（advisory_*），
// 另有 3 个内部互审操作追加在末尾。这里分别冻结，避免"门面扩展"把底层契约一起漂移。
assert.equal(tools.length, 29)
assert.equal(createHash('sha256').update(JSON.stringify(schemas.slice(0, 22))).digest('hex'), 'a3d83a86451b7fbf85f3b67ecd3e5746b089e0e42a623507c92a814ab0c1993c', '底层 22 个操作的顺序、描述、Schema 固定摘要')
const facadeNames = tools.slice(22, 26).map((t) => t.name)
assert.deepEqual(facadeNames, ['carlos_task', 'carlos_verify', 'carlos_review', 'carlos_manage'], '四个门面顺序固定')
assert.deepEqual(tools.slice(26).map((t) => t.name), ['flow_advisory_axes', 'flow_advisory_submit', 'flow_advisory_guard'], '互审操作追加在末尾')
for (const [domain, evidence] of Object.entries({ gate: ['validateCard(', 'snapshotFiles(', '门禁 9/9'], verify: ['runVerifyCommand(', 'runNegativeControl('], audit: ['audit_axis_submitted', 'readAuditDetailed('], infra: ['writeUserMessage(', 'enforceScope('], facade: ['callTool(targetTool, forwarded, context, runtime)'] })) {
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
const rpc = spawnSync(process.execPath, [path.join(root, 'src/index.js')], { input: requests.map(r => JSON.stringify(r)).join('\n') + '\n', env: { ...process.env, CARLOS_FLOW_TOOL_SURFACE: 'legacy' }, encoding: 'utf8', timeout: 30000, windowsHide: true })
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
  // 门面会把专属的 action 字段剔除后再转发（避免污染底层追加范围白名单），
  // 所以结构化回显里不应再出现 action。
  const expectedArgs = { sessionId: 'negative', ...cases[i][1] }
  // 只有转发到内层（tool=flow_*）时才剔除 action；门面自身 Schema 校验仍保留原参数回显。
  if (String(result.structuredContent.tool || '').startsWith('flow_')) delete expectedArgs.action
  assert.deepEqual(result.structuredContent.originalArguments, expectedArgs)
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
const currentVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const expectedGuide = '> **版本**: v' + currentVersion + String.fromCharCode(10) + history + '**版本**: v' + currentVersion + String.fromCharCode(10)
assert.equal(readFileSync(path.join(versionFixture, 'TRIGGER_GUIDE.md'), 'utf8'), expectedGuide, '仅当前版本行更新，历史版本必须逐字保留')
// 故障只注入隔离子进程的真实审计 write，生产代码没有测试开关。
const { startMcpClient } = await import('./_mcp-client.mjs')
const faultFile = path.join(home, 'audit-fault.json')
const faultEntry = path.join(home, 'audit-fault-server.mjs')
const faultHit = path.join(home, 'audit-fault-hit.json')
const raceAction = path.join(home, 'audit-race-action.json')
const lockProbe = path.join(home, 'trigger-lock-probe')
const lockReady = path.join(home, 'trigger-lock-ready')
const admissionSpec = path.join(home, 'admission-race.json')
writeFileSync(faultEntry, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const originalRead = fs.readFileSync;
const admissionReads = new Map();
fs.readFileSync = (file, ...args) => {
  const result = originalRead(file, ...args);
  if (fs.existsSync(${JSON.stringify(admissionSpec)})) {
    const spec = JSON.parse(originalRead(${JSON.stringify(admissionSpec)}, 'utf8'));
    if (String(file).replaceAll('\\\\', '/').endsWith('/runs/' + spec.sid + '/state.json')) {
      const count = (admissionReads.get(spec.sid) || 0) + 1;
      admissionReads.set(spec.sid, count);
      if (count === 2) {
        fs.unlinkSync(${JSON.stringify(admissionSpec)});
        const writer = ${JSON.stringify("import {withStateLock,saveState} from " + JSON.stringify(pathToFileURL(path.join(root, 'src/state.js')).href) + ";const spec=JSON.parse(process.argv[1]);await withStateLock(spec.sid,()=>saveState(spec.sid,spec.state));")};
        const peer = spawnSync(process.execPath, ['--input-type=module', '-e', writer, JSON.stringify(spec)], {env:process.env,encoding:'utf8',windowsHide:true,timeout:20000});
        if (peer.status !== 0) throw new Error('接纳屏障对手失败:' + peer.stderr);
      }
    }
  }
  return result;
};
const original = fs.writeSync;
let deferredSid;
const mkdir = fs.mkdirSync;
fs.mkdirSync = (dir, ...args) => {
  const normalized = String(dir).replaceAll('\\\\', '/');
  if (fs.existsSync(${JSON.stringify(lockProbe)}) && normalized.endsWith('/runs/' + fs.readFileSync(${JSON.stringify(lockProbe)}, 'utf8')) &&
      new Error().stack.includes('withStateLock')) fs.writeFileSync(${JSON.stringify(lockReady)}, '已到达短锁');
  if (deferredSid && normalized.endsWith('/runs/' + deferredSid) && fs.existsSync(${JSON.stringify(raceAction)})) {
    deferredSid = null;
    const action = JSON.parse(fs.readFileSync(${JSON.stringify(raceAction)}, 'utf8'));
    fs.unlinkSync(${JSON.stringify(raceAction)});
    const result = spawnSync(process.execPath, [${JSON.stringify(path.join(root, 'src/index.js'))}], {
      input: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:action}) + '\\n',
      env: process.env, encoding:'utf8', windowsHide:true, timeout:20000,
    });
    fs.writeFileSync(${JSON.stringify(raceAction + '.result')}, JSON.stringify({status:result.status, stdout:result.stdout, stderr:result.stderr}));
  }
  return mkdir(dir, ...args);
};
fs.writeSync = (fd, bytes, ...args) => {
  if (Buffer.isBuffer(bytes) && fs.existsSync(${JSON.stringify(faultFile)})) {
    const kinds = JSON.parse(fs.readFileSync(${JSON.stringify(faultFile)}, 'utf8'));
    let event; try { event = JSON.parse(bytes.toString()) } catch {}
    if (event && kinds.includes(event.kind)) {
      deferredSid = event.sessionID;
      fs.writeFileSync(${JSON.stringify(faultHit)}, JSON.stringify(event));
      throw new Error('真实RPC审计追加注入:' + event.kind);
    }
  }
  return original(fd, bytes, ...args);
};
await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/index.js')).href)});
`)
let client = startMcpClient({ entry: faultEntry, cwd: project, env: process.env })
const evidenceLog = []
const invoke = async (name, args) => {
  const response = await client.request('tools/call', { name, arguments: args })
  evidenceLog.push({ name, args, response })
  return response.result
}
const data = result => JSON.parse(result.content[0].text)
const pending = sid => loadState(sid).audit_pending?.entries || []
const ids = sid => pending(sid).map(e => e.id).sort()
const inject = (...kinds) => {
  if (existsSync(faultHit)) unlinkSync(faultHit)
  writeFileSync(faultFile, JSON.stringify(kinds))
}
const uninject = () => { if (existsSync(faultFile)) unlinkSync(faultFile) }
const fixture = sid => saveState(sid, { ...defaultState(), ...structuredClone(state),
  card: { ...state.card, files: [{ path: 'existing.js', line: 1 }] }, card_ts: Date.now(), claimed: false })
try {
  await client.initialize()
  const sid = 'audit-retry'
  fixture(sid)
  const claimArgs = { sessionId: sid, role: 'executor' }
  inject('claimed')
  assert.equal((await invoke('flow_claim', claimArgs)).isError, true)
  const failedIds = ids(sid)
  assert.equal(failedIds.length, 1)
  assert.equal(pending(sid)[0].event.kind, 'claimed', '必须抵达真实 claimed 追加')
  assert.equal(loadState(sid).claimed, true, '原业务已写入，不可假称未执行')
  uninject()
  await invoke('flow_claim', { sessionId: sid, role: 'auditor' })
  assert.deepEqual(ids(sid), failedIds, '同 kind 不同入参不能冒充恢复')
  for (const verdict of ['LOCAL', 'DIRECTION']) {
    assert.equal(data(await invoke('flow_verdict', { sessionId: sid, verdict })).ok, true)
    assert.deepEqual(ids(sid), failedIds, verdict + ' 不能删除其他失败')
  }
  inject('audit_recovery')
  assert.equal((await invoke('flow_claim', claimArgs)).isError, true, '补记审计不可用仍拒绝')
  assert.deepEqual(ids(sid), failedIds)
  evidenceLog.push({ restart_stderr: client.stderr })
  await client.close()
  client = startMcpClient({ entry: faultEntry, cwd: project, env: process.env })
  await client.initialize()
  uninject()
  const recovered = data(await invoke('flow_claim', claimArgs))
  assert.equal(recovered.business_replayed, false)
  assert.deepEqual(recovered.audit_recovered.sort(), failedIds)
  assert.equal(loadState(sid).claimed_role, 'auditor', '补记不能重跑旧 executor claim')
  assert.equal(loadState(sid).audit_pending, undefined)

  // 原 dispatch 已消费 claim：真实重试必须可补记而不再消费派发次数。
  const dsid = 'audit-consumed-dispatch'
  fixture(dsid)
  await invoke('flow_claim', { sessionId: dsid, role: 'executor' })
  inject('snapshot')
  const dispatchArgs = { sessionId: dsid, cwd: project }
  assert.equal((await invoke('flow_dispatch', dispatchArgs)).isError, true)
  assert.equal(pending(dsid)[0].kind, 'snapshot')
  assert.equal(loadState(dsid).dispatch_count, 1)
  assert.equal(loadState(dsid).claimed, false)
  uninject()
  assert.equal(data(await invoke('flow_dispatch', dispatchArgs)).business_replayed, false)
  assert.equal(loadState(dsid).dispatch_count, 1)
  assert.equal(loadState(dsid).audit_pending, undefined)

  // 多个并发失败逐项合并；成功事件及只读查询不能清 pending。
  const csid = 'audit-concurrent'
  fixture(csid)
  inject('claimed')
  await Promise.all(['executor', 'auditor'].map(role => invoke('flow_claim', { sessionId: csid, role })))
  assert.equal(pending(csid).length, 2)
  const concurrentIds = ids(csid)
  uninject()
  await invoke('flow_status', { sessionId: csid })
  assert.deepEqual(ids(csid), concurrentIds)
  await invoke('flow_claim', { sessionId: csid, role: 'executor' })
  assert.equal(pending(csid).length, 1)
  assert.equal(pending(csid)[0].event.role, 'auditor')

  // 真实扩 scope / 换卡不能丢历史；旧原请求只能补记旧代，不重放到新卡。
  writeFileSync(path.join(project, 'extra.js'), 'export const extra = 1\n')
  const beforeScope = ids(csid)
  const quote = '用户确认扩展范围并重新提交任务'
  await invoke('flow_add_user_msg', { sessionId: csid, text: quote })
  const scopeResult = data(await invoke('flow_submit_requirement', { sessionId: csid,
    appendScope: ['extra.js'], reason: quote, confirmed: true, cwd: project }))
  assert.equal(scopeResult.ok, true, JSON.stringify(scopeResult))
  assert.deepEqual(ids(csid), beforeScope)
  const oldTs = pending(csid)[0].card_ts
  const replacement = data(await invoke('flow_submit_requirement', { sessionId: csid, goal: '新卡', quote,
    scope: ['existing.js'], acceptance: ['新卡验收'], verify: { cmd: 'node -e "process.exit(0)"' }, cwd: project }))
  assert.equal(replacement.ok, true, JSON.stringify(replacement))
  assert.deepEqual(ids(csid), [])
  assert.deepEqual(loadState(csid).audit_history_pending.map(e => e.id).sort(), beforeScope, '明确完整换卡将已知旧活动项合并历史，ID不丢')
  assert.notEqual(loadState(csid).card_ts, oldTs)
  assert.equal(data(await invoke('flow_claim', { sessionId: csid, role: 'auditor' })).business_replayed, false)
  assert.equal(loadState(csid).claimed, false)
  assert.equal(loadState(csid).audit_pending, undefined)
  assert.equal(loadState(csid).audit_history_pending, undefined)

  // 旧请求失败在等状态锁时真正换卡：只追加历史，不取消新卡完成或覆盖验证/领取。
  const { withStateLock } = await import('../src/state.js')
  const rsid = 'audit-replacement-race'
  fixture(rsid)
  const originalCardTs = loadState(rsid).card_ts
  const oldVerdictArgs = { sessionId: rsid, verdict: 'PASS', role: 'auditor' }
  inject('verdict_denied')
  let lateFailure
  let replacementSnapshot
  await withStateLock(rsid, async () => {
    lateFailure = invoke('flow_verdict', oldVerdictArgs)
    const deadline = Date.now() + 10000
    while (!existsSync(faultHit)) {
      assert.ok(Date.now() < deadline, '必须实际抵达旧请求审计故障')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const latest = loadState(rsid)
    Object.assign(latest, { card: { ...latest.card, goal: '真正的新任务' }, card_ts: originalCardTs + 10,
      completed_ok: true, verdict: 'PASS', last_verify: { ok: true, marker: 'new-card-evidence' },
      claimed: true, claimed_role: 'auditor' })
    saveState(rsid, latest)
    replacementSnapshot = latest
  })
  assert.equal((await lateFailure).isError, true)
  const archived = loadState(rsid).audit_history_pending
  assert.equal(archived.length, 1)
  assert.equal(archived[0].card_ts, originalCardTs)
  assert.equal(loadState(rsid).audit_pending, undefined)
  const withoutHistory = latest => { const copy = structuredClone(latest); delete copy.audit_history_pending; return copy }
  assert.deepEqual(withoutHistory(loadState(rsid)), replacementSnapshot)
  inject('audit_recovery')
  assert.equal((await invoke('flow_verdict', oldVerdictArgs)).isError, true)
  assert.deepEqual(withoutHistory(loadState(rsid)), replacementSnapshot, '失败的旧事件补记也不能改新卡')
  assert.deepEqual(loadState(rsid).audit_history_pending, archived)
  uninject()
  const historyRecovered = data(await invoke('flow_verdict', oldVerdictArgs))
  assert.equal(historyRecovered.business_replayed, false)
  assert.equal(historyRecovered.completed_ok, true, '如实返回新卡已有完成状态，不是旧事件补记生成PASS')
  assert.deepEqual(loadState(rsid), replacementSnapshot, '历史恢复只清历史条目，新卡业务状态逐字段不变')

  // 真 appendScope 先完成、旧审计失败后补偿：同任务旧版本仍须阻断，不能遁入历史。
  const ssid = 'audit-scope-race'
  fixture(ssid)
  const beforeAppendTs = loadState(ssid).card_ts
  writeFileSync(raceAction, JSON.stringify({ name: 'flow_submit_requirement', arguments: {
    sessionId: ssid, appendScope: ['extra.js'], reason: '真实并发扩scope', confirmed: true, cwd: project,
  } }))
  inject('verdict_denied')
  assert.equal((await invoke('flow_verdict', { sessionId: ssid, verdict: 'PASS' })).isError, true)
  const racedAppend = JSON.parse(readFileSync(raceAction + '.result', 'utf8'))
  evidenceLog.push({ racedAppend })
  assert.equal(racedAppend.status, 0, racedAppend.stderr)
  assert.equal(data(JSON.parse(racedAppend.stdout.trim()).result).ok, true)
  assert.ok(loadState(ssid).card_ts > beforeAppendTs)
  assert.equal(pending(ssid).length, 1, 'scope代变化后的迟到失败仍是活跃pending')
  assert.equal(pending(ssid)[0].card_ts, beforeAppendTs)
  assert.equal(loadState(ssid).audit_history_pending, undefined)
  assert.equal(loadState(ssid).completed_ok, false)
  uninject()

  // 提交新卡后审计失败必须绑定已提交的新卡，不得错误归属请求开始时的旧卡。
  const nsid = 'audit-submit-new-generation'
  fixture(nsid)
  const submitArgs = { sessionId: nsid, goal: '提交审计故障 合成sk_live_synthetic_only_1234567890', quote: '用户要求提交新卡',
    userMessages: ['用户要求提交新卡'], scope: ['existing.js'], cwd: project }
  inject('record')
  assert.equal((await invoke('flow_submit_requirement', submitArgs)).isError, true)
  const submittedTs = loadState(nsid).card_ts
  assert.equal(pending(nsid)[0].card_ts, submittedTs)
  assert.equal(pending(nsid)[0].event.kind, 'record')
  assert.equal(loadState(nsid).audit_history_pending, undefined, '提交后脱敏不能将当前卡失败错分历史')
  const { auditCardIdentity } = await import('../src/handlers/shared.js')
  assert.equal(pending(nsid)[0].card_identity, auditCardIdentity(loadState(nsid)).card_identity)
  assert.ok(!loadState(nsid).card.goal.includes('synthetic_only'), '只用合成秘密确认实际发生落盘脱敏')
  uninject()
  assert.equal(data(await invoke('flow_submit_requirement', submitArgs)).business_replayed, false)
  assert.equal(loadState(nsid).card_ts, submittedTs, '补记不能再提交一张卡')

  // 触发激活自身也需绑定脱敏落盘卡；等待短锁时出现B，必须不覆盖B或伪记activation。
  const triggerMessage = '实现工作流门禁功能，修改代码并运行测试验证，修复bug和重构模块'
  const tsid = 'audit-trigger-sanitized'
  const triggerArgs = { sessionId: tsid, message: triggerMessage + ' 合成sk_live_trigger_only_1234567890', cwd: project }
  inject('activation')
  assert.equal((await invoke('flow_trigger_check', triggerArgs)).isError, true)
  assert.equal(pending(tsid).length, 1)
  assert.equal(loadState(tsid).audit_history_pending, undefined)
  assert.equal(pending(tsid)[0].card_identity, auditCardIdentity(loadState(tsid)).card_identity)
  uninject()
  assert.equal(data(await invoke('flow_trigger_check', triggerArgs)).business_replayed, false)
  const trsid = 'audit-trigger-race'
  saveState(trsid, defaultState())
  writeFileSync(lockProbe, trsid)
  let triggerResponse
  let newCardSnapshot
  await withStateLock(trsid, async () => {
    triggerResponse = invoke('flow_trigger_check', { sessionId: trsid, message: triggerMessage, cwd: project })
    const deadline = Date.now() + 10000
    while (!existsSync(lockReady)) {
      assert.ok(Date.now() < deadline, 'trigger必须经过锁外空卡观察并抵达短锁')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    newCardSnapshot = { ...defaultState(), card: { goal: '并发B不得覆盖', scope: ['existing.js'], env: { project } },
      card_ts: Date.now(), claimed: true, claimed_role: 'auditor', completed_ok: true, verdict: 'PASS',
      last_verify: { ok: true, marker: 'B保留验证' } }
    saveState(trsid, newCardSnapshot)
    newCardSnapshot = loadState(trsid)
  })
  assert.equal(data(await triggerResponse).activated, false)
  assert.deepEqual(loadState(trsid), newCardSnapshot, 'trigger等锁前空卡不是覆盖新B的许可')
  unlinkSync(lockProbe)
  unlinkSync(lockReady)
  const activSid = 'audit-cli-activation-race'
  saveState(activSid, defaultState())
  writeFileSync(lockProbe, activSid)
  let activationResponse
  let activationB
  await withStateLock(activSid, async () => {
    activationResponse = invoke('flow_submit_requirement', { sessionId: activSid, activation: true,
      goal: 'CLI占位激活', quote: '用户激活门禁', userMessages: ['用户激活门禁'], cwd: project })
    const deadline = Date.now() + 10000
    while (!existsSync(lockReady)) {
      assert.ok(Date.now() < deadline, 'CLI activation必须抵达短锁')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    activationB = { ...newCardSnapshot, card: { ...newCardSnapshot.card, goal: 'CLI并发B' }, card_ts: Date.now() }
    saveState(activSid, activationB)
    activationB = loadState(activSid)
  })
  assert.equal(data(await activationResponse).activated, false)
  assert.deepEqual(loadState(activSid), activationB, 'CLI activation也不能覆盖/归档并发B')
  unlinkSync(lockProbe)

  // 入口捕获A→recover的await期间真实对手写B→handler实际接纳B。各业务失败必须欠账在B。
  for (const [tool, kind, extra] of [
    ['flow_claim', 'claimed', { role: 'executor' }],
    ['flow_dispatch', 'snapshot', { cwd: project }],
    ['flow_audit_submit', 'audit_axis_submitted', { axis: 'standards', verdict: 'PASS', evidence: '接纳B证据' }],
    ['flow_mode', 'mode_on', { mode: 'guide' }],
    ['flow_bypass', 'bypass_on', { on: true, confirmed: true }],
    ['flow_save_result', 'agent_result', { role: 'executor', stdout: 'B结果', code: 0 }],
    ['flow_falsify', 'falsify_denied', { cwd: project }],
    ['flow_run_verify', null, { cwd: project }],
  ]) {
    const sid = 'audit-admission-' + tool
    fixture(sid)
    const a = loadState(sid)
    const b = { ...a, card: { ...a.card, goal: 'B实际接纳', verify: { cmd: 'node -e "process.exit(0)"' } },
      card_ts: a.card_ts + 1000, completed_ok: true, claimed: true, claimed_role: 'auditor' }
    writeFileSync(admissionSpec, JSON.stringify({ sid, state: b }))
    if (kind) inject(kind)
    const response = await invoke(tool, { sessionId: sid, ...extra })
    assert.equal(loadState(sid).card_ts, b.card_ts)
    if (kind) {
      assert.equal(response.isError, true, tool)
      assert.equal(pending(sid).length, 1, tool + '实际接纳B后失败不能误分A历史')
      assert.equal(pending(sid)[0].kind, kind)
      assert.equal(pending(sid)[0].card_ts, b.card_ts)
      assert.equal(pending(sid)[0].card_identity, auditCardIdentity(loadState(sid)).card_identity)
      assert.equal(loadState(sid).audit_history_pending, undefined)
      assert.equal(loadState(sid).completed_ok, false)
      uninject()
    } else {
      assert.equal(data(response).ok, true)
      assert.equal(loadState(sid).last_verify.card_ts, b.card_ts, '真实验证采用handler接纳的B')
    }
  }

  // 已观察A后等短锁：mode实际作用于B必须绑定B；卡绑定业务则CAS拒绝，不覆盖B。
  for (const [tool, extra, kind] of [
    ['flow_mode', { mode: 'guide' }, 'mode_on'],
    ['flow_claim', { role: 'executor' }, null],
    ['flow_dispatch', { cwd: project }, null],
    ['flow_audit_submit', { axis: 'spec', verdict: 'PASS', evidence: '旧A' }, null],
    ['flow_bypass', { on: true, confirmed: true }, null],
    ['flow_falsify', { cwd: project }, 'falsify_denied'],
  ]) {
    const sid = 'audit-locked-admission-' + tool
    fixture(sid)
    const a = loadState(sid)
    a.claimed = true
    saveState(sid, a)
    if (existsSync(lockReady)) unlinkSync(lockReady)
    writeFileSync(lockProbe, sid)
    if (kind) inject(kind)
    let operation
    let b
    await withStateLock(sid, async () => {
      operation = invoke(tool, { sessionId: sid, ...extra })
      const deadline = Date.now() + 10000
      while (!existsSync(lockReady)) {
        assert.ok(Date.now() < deadline, tool + '必须已观察A并等待短锁')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      b = { ...a, card: { ...a.card, goal: '锁期间B' }, card_ts: a.card_ts + 1000,
        completed_ok: true, claimed: true, claimed_role: 'auditor', last_verify: { ok: true, marker: 'B证据保留' } }
      saveState(sid, b)
      b = loadState(sid)
    })
    const response = await operation
    assert.equal(response.isError, true)
    if (tool === 'flow_mode') {
      assert.equal(pending(sid)[0].card_ts, b.card_ts)
      assert.equal(loadState(sid).audit_history_pending, undefined)
      assert.equal(loadState(sid).completed_ok, false)
    } else if (tool === 'flow_falsify') {
      assert.equal(loadState(sid).audit_pending, undefined)
      assert.equal(loadState(sid).audit_history_pending[0].card_ts, a.card_ts, '旧负对照失败仍绑定原A，不追认B')
      assert.deepEqual(withoutHistory(loadState(sid)), b)
    } else {
      assert.deepEqual(loadState(sid), b, '旧A的卡绑定业务未改B任一字段')
    }
    uninject()
    unlinkSync(lockProbe)
  }

  // 真实完整链：改前失败/改后成功的负对照、两轴、PASS；待确认时负例不得变成 PASS。
  const vsid = 'audit-verdict-retry'
  const verifyCmd = `node -e "process.exit(require('fs').readFileSync('existing.js','utf8').includes('= 2')?0:1)"`
  fixture(vsid)
  const firstCardClaim = { sessionId: vsid }
  inject('claimed')
  assert.equal((await invoke('flow_claim', firstCardClaim)).isError, true)
  const firstCardPending = ids(vsid)
  uninject()
  assert.equal(data(await invoke('flow_submit_requirement', { sessionId: vsid,
    goal: '独立新卡闭环', quote: '用户要求新任务独立闭环', userMessages: ['用户要求新任务独立闭环'],
    scope: ['existing.js'], verify: { cmd: verifyCmd }, cwd: project })).ok, true)
  assert.equal(loadState(vsid).audit_pending, undefined)
  assert.deepEqual(loadState(vsid).audit_history_pending.map(e => e.id).sort(), firstCardPending)
  await invoke('flow_claim', { sessionId: vsid, role: 'executor' })
  assert.equal(data(await invoke('flow_dispatch', { sessionId: vsid, cwd: project })).ok, true)
  writeFileSync(path.join(project, 'existing.js'), 'export const value = 2\n')
  assert.equal(data(await invoke('flow_run_verify', { sessionId: vsid, cwd: project })).ok, true)
  assert.equal(data(await invoke('flow_falsify', { sessionId: vsid, cwd: project })).verdict, 'meaningful')
  for (const axis of ['standards', 'spec'])
    await invoke('flow_audit_submit', { sessionId: vsid, axis, verdict: 'PASS', evidence: '真实RPC测试' })
  inject('claimed')
  const auditorArgs = { sessionId: vsid, role: 'auditor' }
  assert.equal((await invoke('flow_claim', auditorArgs)).isError, true)
  uninject()
  const verdictArgs = { sessionId: vsid, verdict: 'PASS', role: 'auditor', cwd: project }
  assert.equal((await invoke('flow_verdict', verdictArgs)).isError, true, '真实有效证据也必须被未确认审计阻断')
  assert.equal(loadState(vsid).completed_ok, false)
  await invoke('flow_verdict', { sessionId: vsid, verdict: 'LOCAL' })
  assert.equal((await invoke('flow_verdict', verdictArgs)).isError, true, 'LOCAL 不能洗掉审计失败后 PASS')
  await invoke('flow_claim', auditorArgs)
  inject('verdict')
  assert.equal((await invoke('flow_verdict', verdictArgs)).isError, true)
  assert.equal(pending(vsid).at(-1).event.type, 'resolution', '必须实际抵达最终 verdict 追加')
  assert.equal(loadState(vsid).completed_ok, false)
  uninject()
  assert.equal(data(await invoke('flow_verdict', verdictArgs)).completed_ok, true, '最终裁定失败仍可重审全部门禁恢复')
  assert.equal(loadState(vsid).audit_pending, undefined)
  assert.deepEqual(loadState(vsid).audit_history_pending.map(e => e.id).sort(), firstCardPending,
    'B必须在A历史尚未补记时真实完成全部门禁')
  const completedReplacement = withoutHistory(loadState(vsid))
  inject('audit_recovery')
  assert.equal((await invoke('flow_claim', firstCardClaim)).isError, true)
  assert.deepEqual(withoutHistory(loadState(vsid)), completedReplacement)
  uninject()
  assert.equal(data(await invoke('flow_claim', firstCardClaim)).business_replayed, false)
  assert.deepEqual(loadState(vsid), completedReplacement, '先落盘A失败的补记成功/失败均不改B完成/验证/领取')
  // A失败先落盘→扩scope→取消→B独立完成；取消成功和自身审计失败两条路径都保留全部旧事件。
  for (const cancelAuditFailure of [false, true]) {
    const sid = 'audit-cancel-chain-' + cancelAuditFailure
    fixture(sid)
    const oldClaimArgs = { sessionId: sid }
    inject('claimed')
    assert.equal((await invoke('flow_claim', oldClaimArgs)).isError, true)
    const oldIds = ids(sid)
    uninject()
    assert.equal(data(await invoke('flow_submit_requirement', { sessionId: sid, appendScope: ['extra.js'],
      reason: '同一A扩scope后取消', confirmed: true, cwd: project })).ok, true)
    assert.deepEqual(ids(sid), oldIds)
    const cancelArgs = { sessionId: sid, reason: '明确取消A，之后是独立B' }
    if (cancelAuditFailure) inject('card_cancelled')
    const cancelled = await invoke('flow_cancel', cancelArgs)
    assert.equal(!!cancelled.isError, cancelAuditFailure)
    uninject()
    const cancelledState = loadState(sid)
    assert.equal(cancelledState.card, null)
    assert.equal(cancelledState.audit_pending, undefined)
    assert.equal(cancelledState.audit_scope_ancestors, undefined)
    assert.equal(cancelledState.audit_history_pending.length, cancelAuditFailure ? 2 : 1)
    assert.ok(cancelledState.audit_history_pending.some(e => e.id === oldIds[0]))
    const cancellationIds = cancelledState.audit_history_pending.map(e => e.id).sort()
    const work = path.join(home, 'cancel-project-' + cancelAuditFailure)
    mkdirSync(work)
    writeFileSync(path.join(work, 'value.js'), 'export const value = 1\n')
    const cmd = `node -e "process.exit(require('fs').readFileSync('value.js','utf8').includes('= 2')?0:1)"`
    assert.equal(data(await invoke('flow_submit_requirement', { sessionId: sid, goal: '独立B', quote: '用户要求独立B',
      userMessages: ['用户要求独立B'], scope: ['value.js'], verify: { cmd }, cwd: work })).ok, true)
    await invoke('flow_claim', { sessionId: sid, role: 'executor' })
    assert.equal(data(await invoke('flow_dispatch', { sessionId: sid, cwd: work })).ok, true)
    writeFileSync(path.join(work, 'value.js'), 'export const value = 2\n')
    assert.equal(data(await invoke('flow_run_verify', { sessionId: sid, cwd: work })).ok, true)
    assert.equal(data(await invoke('flow_falsify', { sessionId: sid, cwd: work })).verdict, 'meaningful')
    for (const axis of ['standards', 'spec'])
      await invoke('flow_audit_submit', { sessionId: sid, axis, verdict: 'PASS', evidence: '真实取消隔离RPC' })
    await invoke('flow_claim', { sessionId: sid, role: 'auditor' })
    assert.equal(data(await invoke('flow_verdict', { sessionId: sid, verdict: 'PASS', role: 'auditor', cwd: work })).completed_ok, true)
    assert.deepEqual(loadState(sid).audit_history_pending.map(e => e.id).sort(), cancellationIds)
    const completedB = withoutHistory(loadState(sid))
    for (const [tool, args] of [['flow_claim', oldClaimArgs], ...(cancelAuditFailure ? [['flow_cancel', cancelArgs]] : [])]) {
      inject('audit_recovery')
      assert.equal((await invoke(tool, args)).isError, true)
      assert.deepEqual(withoutHistory(loadState(sid)), completedB, '旧恢复失败不得动B完成/验证/领取')
      uninject()
      assert.equal(data(await invoke(tool, args)).business_replayed, false)
      assert.deepEqual(withoutHistory(loadState(sid)), completedB, '旧恢复成功不得重跑取消或修改B')
    }
    assert.deepEqual(loadState(sid), completedB)
  }
  // 无可信载荷的旧标记取消时仍保留，不能猜测归档后放行。
  fixture('audit-cancel-legacy')
  const legacyState = loadState('audit-cancel-legacy')
  legacyState.audit_pending = { kind: 'claimed', card_ts: legacyState.card_ts, error: '旧未知载荷' }
  saveState('audit-cancel-legacy', legacyState)
  await invoke('flow_cancel', { sessionId: 'audit-cancel-legacy' })
  assert.deepEqual(loadState('audit-cancel-legacy').audit_pending, legacyState.audit_pending)

  const auditResult = data(await invoke('flow_audit', { verifyChain: true, limit: 1000 }))
  assert.equal(auditResult.chain.ok, true, JSON.stringify(auditResult.chain))
  const recoveryEvents = auditResult.events.filter(e => e.kind === 'audit_recovery')
  assert.ok(recoveryEvents.length >= 5)
  assert.ok(recoveryEvents.every(e => e.business_replayed === false && e.original_event && e.pending_id))
  assert.ok(recoveryEvents.some(e => e.card_ts === oldTs), '旧代补记明确绑定原卡代')
} finally {
  uninject()
  await client.close()
  evidenceLog.push({ stderr: client.stderr, noise: client.noise })
  writeFileSync(path.join(home, 'rpc-audit-evidence.json'), JSON.stringify(evidenceLog, null, 2))
}
console.log('审计恢复真实RPC日志 SHA256：' + createHash('sha256').update(readFileSync(path.join(home, 'rpc-audit-evidence.json'))).digest('hex'))
console.log('handler parity：固定26工具契约、五域真实实现、RPC目录及安全负例通过；隔离目录：' + home)
