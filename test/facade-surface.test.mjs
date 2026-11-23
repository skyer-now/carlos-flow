// 阶段三专项：四门面收敛与动作路由完整性。
//
// 验收点：
//   1. 外部工具面恰好四个门面；
//   2. 全部 22 个底层能力都能通过门面动作到达（不多不少）；
//   3. 每个动作真实路由到对应底层操作（不是只声明不接线）；
//   4. 装配期覆盖校验会拒绝缺失映射。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { startMcpClient } from './_mcp-client.mjs'

const { createCatalog, createExternalCatalog, EXTERNAL_TOOL_NAMES, FACADE_ACTIONS } =
  await import('../src/handlers/catalog.js')

const MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-surface-'))

after(() => {
  try { fs.rmSync(MCP_HOME, { recursive: true, force: true }) } catch {}
})

const LOW_LEVEL = [
  'flow_protocol', 'flow_submit_requirement', 'flow_claim', 'flow_dispatch',
  'flow_audit_axes', 'flow_audit_submit', 'flow_audit_guard', 'flow_verdict',
  'flow_mode', 'flow_stats', 'flow_status', 'flow_audit', 'flow_diff_hunks',
  'flow_cancel', 'flow_bypass', 'flow_add_user_msg', 'flow_save_result',
  'flow_revert_plan', 'flow_run_verify', 'flow_falsify', 'flow_check_scope',
  'flow_trigger_check',
  'flow_advisory_axes',
  'flow_advisory_submit',
  'flow_advisory_guard',
]

describe('阶段三 · 四门面收敛', () => {
  it('外部工具面恰好四个门面，且名称固定', () => {
    const tools = createExternalCatalog(() => {})
    assert.equal(tools.length, 4)
    assert.deepEqual(tools.map((t) => t.name), [...EXTERNAL_TOOL_NAMES])
  })

  it('25 个底层能力全部可经门面到达，且没有指向未登记操作', () => {
    const targets = new Set()
    for (const actions of Object.values(FACADE_ACTIONS)) {
      for (const target of Object.values(actions)) targets.add(target)
    }
    assert.equal(targets.size, 25, '映射目标数必须等于底层能力数')
    for (const name of LOW_LEVEL) assert.ok(targets.has(name), '缺少门面动作：' + name)
    for (const target of targets) assert.ok(LOW_LEVEL.includes(target), '指向未登记操作：' + target)
  })

  it('每个动作真实路由到对应底层操作', async () => {
    const calls = []
    const callTool = async (name, args) => {
      calls.push({ name, args })
      return { ok: true, routed: name }
    }
    const tools = createExternalCatalog(callTool)
    for (const [facadeName, actions] of Object.entries(FACADE_ACTIONS)) {
      const tool = tools.find((t) => t.name === facadeName)
      assert.ok(tool, '缺少门面：' + facadeName)
      for (const [action, target] of Object.entries(actions)) {
        const res = await tool.handler({ action }, {}, {})
        assert.equal(res.routed, target, `${facadeName}.${action} 应路由到 ${target}`)
      }
    }
    // 每个底层能力至少被真实路由一次
    const routed = new Set(calls.map((c) => c.name))
    for (const name of LOW_LEVEL) assert.ok(routed.has(name), '未被真实路由：' + name)
  })

  it('门面 schema 覆盖底层参数（含必填），转发时剔除 action', async () => {
    const { createCatalog } = await import('../src/handlers/catalog.js')
    const all = createCatalog(() => {})
    const tools = createExternalCatalog(() => {})
    for (const [facadeName, actions] of Object.entries(FACADE_ACTIONS)) {
      const facade = tools.find((t) => t.name === facadeName)
      const props = facade.inputSchema.properties
      for (const target of new Set(Object.values(actions))) {
        const inner = all.find((t) => t.name === target)
        // 底层必填字段必须能在门面 schema 里发现，否则客户端按 schema 调用必失败。
        for (const key of inner.inputSchema.required || []) {
          assert.ok(props[key], `${facadeName} 缺少底层 ${target} 的必填参数：${key}`)
        }
        // 底层声明的每个参数都必须在门面 schema 里可发现（全量包含，不做白名单抽查）
        for (const [key, schema] of Object.entries(inner.inputSchema.properties || {})) {
          assert.ok(props[key], `${facadeName} 缺少底层 ${target} 的参数：${key}`)
          // 类型也要一致：schema 驱动的客户端会按门面声明传值
          assert.equal(props[key].type, schema.type, `${facadeName} 参数 ${key} 类型与底层不一致`)
        }
      }
    }
    const calls = []
    const probe = createExternalCatalog(async (name, args) => { calls.push({ name, args }); return { ok: true } })
    await probe.find((t) => t.name === 'carlos_task').handler(
      { action: 'submit', appendScope: ['src/a.js'], reason: '追加', confirmed: true },
      {}, {},
    )
    assert.equal(calls[0].name, 'flow_submit_requirement')
    assert.equal(calls[0].args.action, undefined, '门面专属 action 不得透传给底层')
    assert.deepEqual(calls[0].args.appendScope, ['src/a.js'])
  })

  it('门面 schema 的 action 枚举与路由表一致', () => {
    const tools = createExternalCatalog(() => {})
    for (const tool of tools) {
      const enumValues = tool.inputSchema.properties.action.enum
      const mapped = Object.keys(FACADE_ACTIONS[tool.name])
      assert.deepEqual([...enumValues].sort(), [...mapped].sort(), `${tool.name} 的 action 枚举与路由表不一致`)
    }
  })

  it('external 面通过真实 MCP 入口仍能路由（不是只声明）', async () => {
    const client = startMcpClient({
      entry: path.join(process.cwd(), 'src', 'index.js'),
      cwd: process.cwd(),
      // 不注入 surface：验证的是“未配置时的默认面”
      surface: 'default',
      env: { CARLOS_FLOW_HOME: MCP_HOME },
    })
    try {
      await client.initialize()
      const list = await client.request('tools/list', {})
      const names = (list.result?.tools || []).map((t) => t.name)
      assert.deepEqual([...names].sort(), [...EXTERNAL_TOOL_NAMES].sort(), '外部面必须只暴露四个门面')
      const res = await client.request('tools/call', { name: 'carlos_manage', arguments: { action: 'status', sessionId: 'surface-e2e' } })
      const text = res.result?.content?.[0]?.text || ''
      assert.ok(!/Unknown tool/i.test(text), '门面动作必须能路由到底层：' + text.slice(0, 200))
      // 断言目标工具的真实返回（不是“只要不是 Unknown tool”就算过）
      assert.ok(/sessionId|has_card|verify_state/.test(text), '门面应返回 flow_status 的真实结构：' + text.slice(0, 300))
      const unknown = await client.request('tools/call', { name: 'carlos_manage', arguments: { action: 'no_such_action' } })
      const unknownText = unknown.result?.content?.[0]?.text || ''
      const unknownFailed = unknown.result?.isError === true || /未知 action|枚举|enum|INVALID/i.test(unknownText)
      assert.ok(unknownFailed, '未知动作必须明确失败，不得静默回退：' + unknownText.slice(0, 200))
    } finally {
      client.close()
    }
  })

  it('默认面下 chip 目录（main.js）不报漂移且能列出/调用门面', async () => {
    const client = startMcpClient({
      entry: path.join(process.cwd(), 'src', 'index.js'),
      cwd: process.cwd(),
      surface: 'default',
      env: { CARLOS_FLOW_HOME: MCP_HOME },
    })
    try {
      await client.initialize()
      let handler = null
      const sent = []
      const cindy = {
        onHostMessage(cb) { handler = cb },
        send(msg) { sent.push(msg) },
        node: {
          async request(req) {
            const res = await client.request(req.method, req.params || {})
            return res.error ? { ok: false, message: JSON.stringify(res.error) } : { ok: true, result: res.result }
          },
        },
      }
      const sandbox = { cindy, setInterval, clearInterval, console }
      vm.createContext(sandbox)
      vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'main.js'), 'utf8'), sandbox, { filename: 'main.js' })
      const invoke = async (tool, args) => {
        sent.length = 0
        await handler({ type: 'tool-call', tool, args, callId: 'c' + Math.random() })
        return sent[sent.length - 1]
      }
      const ov = (await invoke('list_tools', {})).result
      assert.equal(ov.ok, true, '默认面下概览必须可用')
      assert.equal(ov.total, 4, '默认面概览只应包含四个门面，实际 ' + ov.total)
      const gate = (await invoke('list_tools', { category: 'gate' })).result
      assert.equal(gate.ok, true, '默认面下 gate 类目不得报 CATALOG_DRIFT：' + JSON.stringify(gate).slice(0, 200))
      assert.ok(gate.tools.some((t) => t.name === 'carlos_task'))
      const call = await invoke('call_tool', { name: 'carlos_manage', args: { action: 'status', sessionId: 'main-e2e' } })
      const text = call?.result?.mcpResult?.content?.[0]?.text || ''
      assert.ok(!/Unknown tool/i.test(text), 'chip call_tool 必须能路由门面：' + text.slice(0, 200))
    } finally {
      client.close()
    }
  })

  it('内部目录仍保留 29 个操作（底层实现没有被删除）', () => {
    const tools = createCatalog(() => {})
    assert.equal(tools.length, 29)
    for (const name of LOW_LEVEL) assert.ok(tools.some((t) => t.name === name), '内部目录缺少：' + name)
  })
})