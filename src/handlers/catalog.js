import { TOOLS as gateTools } from './gate.js'
import { TOOLS as verifyTools } from './verify.js'
import { TOOLS as auditTools } from './audit.js'
import { TOOLS as infraTools } from './infra.js'
import { createFacadeTools } from './facade.js'
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
