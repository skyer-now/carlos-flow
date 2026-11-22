// facade 领域：真实工具实现与原始契约。
import { fail } from './shared.js'
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
          enum: ['submit', 'claim', 'dispatch', 'start', 'protocol', 'add_user_msg', 'save_result'],
          description: '操作类型：submit/claim/dispatch/start/protocol/add_user_msg/save_result',
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
        text: { type: 'string', description: '用户原话（add_user_msg）' },
        appendScope: { type: 'array', items: { type: 'string' }, description: '追加授权范围（submit）' },
        unknowns: { type: 'array', items: { type: 'string' }, description: '未知项（submit）' },
        assumptions: { type: 'array', items: { type: 'string' }, description: '假设（submit）' },
        files: { type: 'array', items: { type: 'object' }, description: '关注文件与行号（submit）' },
        userMessages: { type: 'array', items: { type: 'string' }, description: '用户原话列表（submit）' },
        cardText: { type: 'string', description: '卡片原文（submit）' },
        activation: { type: 'boolean', description: '占位卡是否按门禁激活（submit，与底层 boolean 一致）' },
        reason: { type: 'string', description: '理由（submit/cancel）' },
        run: { type: 'boolean', description: '派发后立即执行（dispatch）' },
        stdout: { type: 'string', description: '子 Agent 输出（save_result）' },
        stderr: { type: 'string', description: '子 Agent 错误输出（save_result）' },
        code: { type: 'number', description: '退出码（save_result）' },
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
      void a.text
      void a.appendScope
      void a.unknowns
      void a.assumptions
      void a.files
      void a.userMessages
      void a.cardText
      void a.activation
      void a.reason
      void a.run
      void a.stdout
      void a.stderr
      void a.code
      const targetTool = FACADE_ACTIONS.carlos_task[action]
      if (!targetTool) return fail('未知 action：' + action)
      const forwarded = { ...args }
      delete forwarded.action
      return callTool(targetTool, forwarded, context, runtime)
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
          enum: ['run', 'falsify', 'check_scope', 'trigger_check', 'diff_hunks'],
          description: '操作类型：run/falsify/check_scope/trigger_check/diff_hunks',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        message: { type: 'string', description: '待检查的消息（trigger_check）' },
        paths: { type: 'array', items: { type: 'string' }, description: '待查路径列表' },
        timeoutMs: { type: 'number', description: '超时毫秒数' },
        isolateHome: { type: 'boolean', description: '隔离 HOME 后执行（run/falsify）' },
        expected: { type: 'object', description: '向导领取身份（run，不得回退手动执行）' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'run'
      const { sessionId, paths, timeoutMs, cwd } = a
      void sessionId
      void paths
      void timeoutMs
      void cwd
      void a.message
      void a.isolateHome
      void a.expected
      const targetTool = FACADE_ACTIONS.carlos_verify[action]
      if (!targetTool) return fail('未知 action：' + action)
      const forwarded = { ...args }
      delete forwarded.action
      return callTool(targetTool, forwarded, context, runtime)
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
          enum: ['axes', 'submit', 'guard', 'verdict', 'audit'],
          description: '操作类型：axes/submit/guard/verdict/audit',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        axis: { type: 'string', enum: ['standards', 'spec'], description: '审查轴' },
        verdict: { type: 'string', enum: ['PASS', 'FAIL', 'WARN', 'DIRECTION', 'LOCAL'], description: '裁定/审查结论' },
        notes: { type: 'string', description: '审查说明' },
        findings: { type: 'array', items: { type: 'string' }, description: '问题清单（submit）' },
        evidence: { type: 'string', description: '实跑命令/输出摘要（submit）' },
        role: { type: 'string', description: '裁定角色' },
        cwd: { type: 'string', description: '工作目录' },
        type: { type: 'string', description: '审计事件类型过滤（audit）' },
        limit: { type: 'number', description: '最多返回条数（audit）' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（audit）' },
        verifyChain: { type: 'boolean', description: '是否验证审计链（audit）' },
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
      void a.findings
      void a.evidence
      void a.type
      void a.limit
      void a.date
      void a.verifyChain
      const targetTool = FACADE_ACTIONS.carlos_review[action]
      if (!targetTool) return fail('未知 action：' + action)
      const forwarded = { ...args }
      delete forwarded.action
      return callTool(targetTool, forwarded, context, runtime)
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
          enum: ['status', 'cancel', 'revert', 'stats', 'bypass', 'mode'],
          description: '操作类型：status/cancel/revert/stats/bypass/mode',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        reason: { type: 'string', description: '撤销或操作理由' },
        on: { type: 'boolean', description: '免检开关' },
        confirmed: { type: 'boolean', description: '确认授权' },
        cwd: { type: 'string', description: '工作目录' },
        mode: { type: 'string', enum: ['pro', 'guide'], description: '工作流模式（mode）' },
        includeSnapshots: { type: 'boolean', description: '包含快照信息（status）' },
        limit: { type: 'number', description: '返回条数/天数（stats）' },
        inactiveDays: { type: 'number', description: '陈旧会话阈值天数（stats）' },
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
      void a.mode
      void a.includeSnapshots
      void a.limit
      void a.inactiveDays
      const targetTool = FACADE_ACTIONS.carlos_manage[action]
      if (!targetTool) return fail('未知 action：' + action)
      const forwarded = { ...args }
      delete forwarded.action
      return callTool(targetTool, forwarded, context, runtime)
    },
  },
]
return TOOLS
}

/**
 * 门面动作路由表（阶段三）。
 *
 * 冻结口径：每个底层能力都必须能通过**恰好一个**门面动作到达，
 * 这样“外部只暴露四个门面”不等于“少了能力”。
 */
export const FACADE_ACTIONS = Object.freeze({
  carlos_task: Object.freeze({
    submit: 'flow_submit_requirement',
    start: 'flow_submit_requirement',
    claim: 'flow_claim',
    dispatch: 'flow_dispatch',
    protocol: 'flow_protocol',
    add_user_msg: 'flow_add_user_msg',
    save_result: 'flow_save_result',
  }),
  carlos_verify: Object.freeze({
    run: 'flow_run_verify',
    falsify: 'flow_falsify',
    check_scope: 'flow_check_scope',
    trigger_check: 'flow_trigger_check',
    diff_hunks: 'flow_diff_hunks',
  }),
  carlos_review: Object.freeze({
    axes: 'flow_audit_axes',
    submit: 'flow_audit_submit',
    guard: 'flow_audit_guard',
    verdict: 'flow_verdict',
    audit: 'flow_audit',
  }),
  carlos_manage: Object.freeze({
    status: 'flow_status',
    cancel: 'flow_cancel',
    revert: 'flow_revert_plan',
    stats: 'flow_stats',
    bypass: 'flow_bypass',
    mode: 'flow_mode',
  }),
})
