import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(process.env.CARLOS_STALE_MAIN || new URL('../main.js', import.meta.url), 'utf8')
const key = 'a'.repeat(64)
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
// 真实主逻辑，桩仅位于 Host 网络、票与 Node 边界；不冒充桌面点击验收。
function harness(initial = {}) {
  let handler; let kv = initial; let now = 1000
  const h = { sent: [], nodes: [], agents: [], failure: '', getGate: null, putGate: null, agentGate: null, structured: true }
  const sandbox = {
    Date: class extends Date { static now() { return now } }, setInterval, clearInterval,
    fetch: async (url, options) => {
      assert.equal(url, '/kv')
      const phase = options ? 'put' : 'get'
      if (h[phase + 'Gate']) await h[phase + 'Gate'].promise
      if (h.failure === phase + '-throw') throw new Error('秘密路径和命令')
      if (h.failure === phase + '-bad') return { ok: false, json: async () => kv }
      if (options) kv = JSON.parse(options.body)
      return { ok: true, json: async () => { if (h.failure === 'json') throw new Error('秘密'); return structuredClone(kv) } }
    },
    cindy: {
      onHostMessage: fn => { handler = fn }, send: msg => h.sent.push(msg),
      node: { request: async request => {
        h.nodes.push(request)
        if (request.method === 'tools/list') return { ok: true, result: { tools: [{ name: 'flow_verdict', inputSchema: {} }] } }
        return { ok: true, result: { isError: h.structured, content: [{ type: 'text', text: 'VERIFY_STALE' }],
          structuredContent: h.structured ? { code: 'VERIFY_STALE', expected: { caseKey: key }, detectedAt: 1000, expiresAt: h.expiry ?? 10000 } : undefined } }
      } },
      agent: { run: async args => { h.agents.push(args); if (h.agentGate) await h.agentGate.promise; if (h.failure === 'agent') throw new Error('秘密'); return { ok: h.failure !== 'agent-bad' } } },
    },
  }
  vm.runInNewContext(source, sandbox)
  h.issue = (id = '卡', context = {}) => handler({ type: 'tool-call', tool: 'call_tool', callId: id,
    args: { name: 'flow_verdict', args: { verdict: 'PASS', sessionId: '原会话' }, session_context: { session_id: '原会话', workdir_is_local: true, workdir_is_read_only: false, ...context } } })
  h.click = (action, extra = {}) => handler({ type: 'event', name: 'card-action', callId: '卡', sessionId: '原会话', actionId: 'stale-' + action, userActionToken: '真票', ...extra })
  h.cards = () => h.sent.filter(m => m.type === 'card-update')
  h.advance = () => { now = 10001 }
  h.cache = () => structuredClone(kv)
  return h
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('三按钮、真工具续接、双意图独立且不复用旧 RPC', async () => {
  const h = harness(); await h.issue()
  assert.equal((h.cards()[0].html.match(/data-ghost-action=/g) || []).length, 3)
  const nodes = h.nodes.length
  await h.click('view', { userActionToken: undefined }); assert.equal(h.agents.length, 0)
  await h.click('view'); await h.click('view'); await h.click('retry'); await h.click('retry')
  assert.equal(h.agents.length, 2); assert.equal(h.nodes.length, nodes)
  const view = h.agents[0]
  assert.equal(view.mode, 'continue'); assert.equal(view.event.sessionId, '原会话')
  assert.match(view.promptTemplate, /flow_status.*flow_diff_hunks/s)
  for (const term of ['未暂存', '非验证时快照', '错误', '空结果', '数量', '行区间', '不执行验证']) assert.ok(view.promptTemplate.includes(term))
  assert.equal(h.agents[1].event.expected.caseKey, key); assert.match(h.agents[1].promptTemplate, /不得省略 expected.*回退/s)
  assert.ok(!JSON.stringify(h.cache()).includes('真票'))
})

test('正常静默、关键词不触发、远程只读与非法期限不发卡', async () => {
  for (const context of [{ workdir_is_local: false }, { workdir_is_read_only: true }]) { const h = harness(); await h.issue('卡', context); assert.equal(h.cards().length, 0) }
  for (const expiry of [1000, Infinity, NaN]) { const h = harness(); h.expiry = expiry; await h.issue(); assert.equal(h.cards().length, 0) }
  const h = harness(); h.structured = false; await h.issue(); assert.equal(h.cards().length, 0)
})

test('跨SID、过期与重启均无资格且不能改真实卡', async () => {
  const h = harness(); await h.issue(); const count = h.cards().length
  await h.click('retry', { sessionId: '别会话' }); assert.equal(h.cards().length, count)
  const reboot = harness(h.cache()); await reboot.click('retry'); assert.equal(reboot.agents.length, 0)
  h.advance(); await h.click('view'); await h.click('retry'); assert.equal(h.agents.length, 0)
})

test('双击跨GET和PUT的同步去重', async () => {
  for (const phase of ['getGate', 'putGate']) {
    for (const action of ['view', 'retry']) {
      const h = harness(); await h.issue(); h[phase] = gate()
      const one = h.click(action); const two = h.click(action); await tick(); h[phase].release()
      await Promise.all([one, two]); assert.equal(h.agents.length, 1)
    }
  }
})

test('await期间过期或换同callId对象阻止旧请求', async () => {
  const h = harness(); await h.issue(); h.getGate = gate(); const pending = h.click('retry'); await tick(); h.advance(); h.getGate.release(); await pending; assert.equal(h.agents.length, 0)
  const k = harness(); await k.issue(); k.putGate = gate(); const old = k.click('retry'); await tick(); const replacement = k.issue(); await tick(); k.putGate.release(); await Promise.all([old, replacement]); assert.equal(k.agents.length, 0)
})

test('暂缓阻断待提交，已提交Agent不撤回也不复活卡', async () => {
  const h = harness(); await h.issue(); h.putGate = gate(); const pending = h.click('retry'); await tick(); const deferred = h.click('defer'); h.putGate.release(); await Promise.all([pending, deferred]); assert.equal(h.agents.length, 0)
  const k = harness(); await k.issue(); k.agentGate = gate(); const submitted = k.click('view'); await tick(); assert.equal(k.agents.length, 1); await k.click('defer'); k.agentGate.release(); await submitted; await k.click('retry'); assert.equal(k.agents.length, 1); assert.ok(!k.cards().at(-1).html.includes('data-ghost-action'))
})

test('KV与Agent未知中文收敛，无重放无秘密', async () => {
  for (const failure of ['get-throw', 'get-bad', 'json', 'put-throw', 'put-bad', 'agent', 'agent-bad']) {
    const h = harness(); await h.issue(); h.failure = failure; await h.click('retry'); const count = h.agents.length; h.failure = ''; await h.click('retry'); await h.click('view'); assert.equal(h.agents.length, count)
    assert.match(h.cards().at(-1).html, /未知/); assert.ok(!JSON.stringify(h.sent).includes('秘密'))
  }
  const h = harness(); h.failure = 'get-bad'; await h.issue(); h.failure = ''; await h.click('retry'); assert.equal(h.agents.length, 0)
})
