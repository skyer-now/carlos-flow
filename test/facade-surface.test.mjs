// 阶段三专项：四门面收敛与动作路由完整性。
//
// 验收点：
//   1. 外部工具面恰好四个门面；
//   2. 全部 22 个底层能力都能通过门面动作到达（不多不少）；
//   3. 每个动作真实路由到对应底层操作（不是只声明不接线）；
//   4. 装配期覆盖校验会拒绝缺失映射。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { createCatalog, createExternalCatalog, EXTERNAL_TOOL_NAMES, FACADE_ACTIONS } =
  await import('../src/handlers/catalog.js')

const LOW_LEVEL = [
  'flow_protocol', 'flow_submit_requirement', 'flow_claim', 'flow_dispatch',
  'flow_audit_axes', 'flow_audit_submit', 'flow_audit_guard', 'flow_verdict',
  'flow_mode', 'flow_stats', 'flow_status', 'flow_audit', 'flow_diff_hunks',
  'flow_cancel', 'flow_bypass', 'flow_add_user_msg', 'flow_save_result',
  'flow_revert_plan', 'flow_run_verify', 'flow_falsify', 'flow_check_scope',
  'flow_trigger_check',
]

describe('阶段三 · 四门面收敛', () => {
  it('外部工具面恰好四个门面，且名称固定', () => {
    const tools = createExternalCatalog(() => {})
    assert.equal(tools.length, 4)
    assert.deepEqual(tools.map((t) => t.name), [...EXTERNAL_TOOL_NAMES])
  })

  it('22 个底层能力全部可经门面到达，且没有指向未登记操作', () => {
    const targets = new Set()
    for (const actions of Object.values(FACADE_ACTIONS)) {
      for (const target of Object.values(actions)) targets.add(target)
    }
    assert.equal(targets.size, 22, '映射目标数必须等于底层能力数')
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

  it('门面 schema 的 action 枚举与路由表一致', () => {
    const tools = createExternalCatalog(() => {})
    for (const tool of tools) {
      const enumValues = tool.inputSchema.properties.action.enum
      const mapped = Object.keys(FACADE_ACTIONS[tool.name])
      assert.deepEqual([...enumValues].sort(), [...mapped].sort(), `${tool.name} 的 action 枚举与路由表不一致`)
    }
  })

  it('内部目录仍保留 26 个操作（底层实现没有被删除）', () => {
    const tools = createCatalog(() => {})
    assert.equal(tools.length, 26)
    for (const name of LOW_LEVEL) assert.ok(tools.some((t) => t.name === name), '内部目录缺少：' + name)
  })
})