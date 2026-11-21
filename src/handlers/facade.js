// facade 领域：真实工具实现与原始契约。
import {
  enforceScope,
} from './shared.js'
export function createFacadeTools(callTool) {
const TOOLS = [
{
    name: 'carlos_task',
    description:
      '【高阶复合门面】统一管理任务的留痕、开卡、认领与派发流程。' +
      '支持 action: "submit"（提交卡片）/ "claim"（认领角色）/ "dispatch"（派发执行）/ "start"（留痕并直接开卡）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'claim', 'dispatch', 'start'],
          description: '操作类型：submit/claim/dispatch/start',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        goal: { type: 'string', description: '任务目标' },
        quote: { type: 'string', description: '用户原话摘录' },
        scope: { type: 'array', items: { type: 'string' }, description: '允许修改的文件范围' },
        newFiles: { type: 'array', items: { type: 'string' }, description: '获授权新建的文件' },
        newFilesReason: { type: 'string', description: '新建文件授权说明' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准' },
        role: { type: 'string', enum: ['executor', 'auditor'], description: '认领/派发角色' },
        verify: { type: 'object', description: '验证命令配置，如 { cmd: "npm test" }' },
        confirmed: { type: 'boolean', description: '敏感路径或新文件确认' },
        message: { type: 'string', description: '派发附加说明' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'submit'
      const {
        sessionId,
        goal,
        quote,
        scope,
        newFiles,
        newFilesReason,
        acceptance,
        role,
        verify,
        confirmed,
        message,
        cwd,
      } = a
      void sessionId
      void goal
      void quote
      void scope
      void newFiles
      void newFilesReason
      void acceptance
      void role
      void verify
      void confirmed
      void message
      void cwd
      const toolMap = {
        submit: 'flow_submit_requirement',
        start: 'flow_submit_requirement',
        claim: 'flow_claim',
        dispatch: 'flow_dispatch',
      }
      const targetTool = toolMap[action] || 'flow_submit_requirement'
      return callTool(targetTool, args, context, runtime)
    },
  },
{
    name: 'carlos_verify',
    description:
      '【高阶复合门面】统一执行真实验证命令、反向负对照证伪与越界自查。' +
      '支持 action: "run"（执行验证）/ "falsify"（负对照证伪）/ "check_scope"（越界检查）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'falsify', 'check_scope'],
          description: '操作类型：run/falsify/check_scope',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        cmd: { type: 'string', description: '验证命令' },
        paths: { type: 'array', items: { type: 'string' }, description: '待查路径列表' },
        timeoutMs: { type: 'number', description: '超时毫秒数' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'run'
      const { sessionId, cmd, paths, timeoutMs, cwd } = a
      void sessionId
      void cmd
      void paths
      void timeoutMs
      void cwd
      // 代理调用：若 action === 'check_scope' 且提供了 paths，先委托 enforceScope 做预检
      if (action === 'check_scope' && Array.isArray(paths)) {
        enforceScope(paths, cwd || process.cwd())
      }
      const toolMap = {
        run: 'flow_run_verify',
        falsify: 'flow_falsify',
        check_scope: 'flow_check_scope',
      }
      const targetTool = toolMap[action] || 'flow_run_verify'
      return callTool(targetTool, args, context, runtime)
    },
  },
{
    name: 'carlos_review',
    description:
      '【高阶复合门面】统一派发双轴独立审查、提交审查结论与记录最终裁定。' +
      '支持 action: "axes"（派发审查）/ "submit"（提交单轴结论）/ "guard"（双轴自查）/ "verdict"（记录裁定）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['axes', 'submit', 'guard', 'verdict'],
          description: '操作类型：axes/submit/guard/verdict',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        axis: { type: 'string', enum: ['standards', 'spec'], description: '审查轴' },
        verdict: { type: 'string', enum: ['PASS', 'DIRECTION', 'LOCAL', 'WARN', 'FAIL'], description: '裁定结论' },
        notes: { type: 'string', description: '审查说明或证据' },
        role: { type: 'string', description: '裁定角色' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'verdict'
      const { sessionId, axis, verdict, notes, role, cwd } = a
      void sessionId
      void axis
      void verdict
      void notes
      void role
      void cwd
      const toolMap = {
        axes: 'flow_audit_axes',
        submit: 'flow_audit_submit',
        guard: 'flow_audit_guard',
        verdict: 'flow_verdict',
      }
      const targetTool = toolMap[action] || 'flow_verdict'
      return callTool(targetTool, args, context, runtime)
    },
  },
{
    name: 'carlos_manage',
    description:
      '【高阶复合门面】统一管理门禁状态查询、撤销任务、一键回滚计划与存储度量。' +
      '支持 action: "status"（查状态）/ "cancel"（一键撤销）/ "revert"（回滚计划）/ "stats"（存储分析）/ "bypass"（免检开关）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'cancel', 'revert', 'stats', 'bypass'],
          description: '操作类型：status/cancel/revert/stats/bypass',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        reason: { type: 'string', description: '撤销或操作理由' },
        on: { type: 'boolean', description: '免检开关' },
        confirmed: { type: 'boolean', description: '确认授权' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'status'
      const { sessionId, reason, on, confirmed, cwd } = a
      void sessionId
      void reason
      void on
      void confirmed
      void cwd
      const toolMap = {
        status: 'flow_status',
        cancel: 'flow_cancel',
        revert: 'flow_revert_plan',
        stats: 'flow_stats',
        bypass: 'flow_bypass',
      }
      const targetTool = toolMap[action] || 'flow_status'
      return callTool(targetTool, args, context, runtime)
    },
  },
]
return TOOLS
}
