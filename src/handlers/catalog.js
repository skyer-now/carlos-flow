import { TOOLS as gateTools } from './gate.js'
import { TOOLS as verifyTools } from './verify.js'
import { TOOLS as auditTools } from './audit.js'
import { TOOLS as infraTools } from './infra.js'
import { createFacadeTools, FACADE_ACTIONS } from './facade.js'
const ORDER = [
  "flow_protocol",
  "flow_submit_requirement",
  "flow_claim",
  "flow_dispatch",
  "flow_audit_axes",
  "flow_audit_submit",
  "flow_audit_guard",
  "flow_verdict",
  "flow_mode",
  "flow_stats",
  "flow_status",
  "flow_audit",
  "flow_diff_hunks",
  "flow_cancel",
  "flow_bypass",
  "flow_add_user_msg",
  "flow_save_result",
  "flow_revert_plan",
  "flow_run_verify",
  "flow_falsify",
  "flow_check_scope",
  "flow_trigger_check",
  "carlos_task",
  "carlos_verify",
  "carlos_review",
  "carlos_manage"
]
export function createCatalog(callTool) {
  const tools = [...gateTools, ...verifyTools, ...auditTools, ...infraTools, ...createFacadeTools(callTool)]
  if (tools.length !== ORDER.length || tools.some(tool => !ORDER.includes(tool.name)))
    throw new Error('工具目录包含未登记操作或数量不符')
  return ORDER.map(name => {
    const matches = tools.filter(tool => tool.name === name)
    if (matches.length !== 1) throw new Error('工具目录缺失或重复：' + name)
    return matches[0]
  })
}

/**
 * 外部工具面（阶段三）：只暴露四个门面。
 *
 * 底层 22 个能力仍是内部实现，通过门面动作路由到达；
 * 装配时做覆盖校验，任何能力没有门面动作就直接拒绝启动，
 * 避免“工具变少了但没人发现少了哪一项”。
 */
export function createExternalCatalog(callTool) {
  const tools = createFacadeTools(callTool)
  const covered = new Set()
  for (const actions of Object.values(FACADE_ACTIONS)) {
    for (const target of Object.values(actions)) covered.add(target)
  }
  const missing = ORDER.filter((name) => !name.startsWith('carlos_') && !covered.has(name))
  if (missing.length) throw new Error('门面动作未覆盖底层能力：' + missing.join(', '))
  const extra = [...covered].filter((name) => !ORDER.includes(name))
  if (extra.length) throw new Error('门面动作指向未登记操作：' + extra.join(', '))
  if (tools.length !== 4) throw new Error('外部工具面必须恰好四个门面，实际 ' + tools.length)
  return tools
}

export const EXTERNAL_TOOL_NAMES = Object.freeze(['carlos_task', 'carlos_verify', 'carlos_review', 'carlos_manage'])
export { FACADE_ACTIONS }
