// main.js —— Carlos 工作流（chip 沙箱入口）
//
// 为什么是「两段式目录」（Cindy 插件手册 §3.5）：
// 本插件有 21 个 flow_* 操作，而宿主对 tools 声明有**硬上限 16 项**；
// 21 个端点级操作塞进去必然被拒装。手册给的解法是只声明两个元工具
// `list_tools` / `call_tool`，把目录与分发表放在 main.js 里自己维护。
//
// 分工（重要，别把职责搞混）：
//   · 每个操作的**权威说明与参数 schema**不在这里抄一份 —— 一律向随包 MCP 服务端
//     取 `tools/list`（单一真源 src/index.js），避免文档与实现漂移；
//   · 这里只维护「操作 → 类目」映射与「该类目调用前必须知道的 RULES」。
//   · scripts/full-audit.mjs 会校验：类目表覆盖服务端全部工具、不多不少。
//
// 沙箱约束：本文件跑在无文件、无 Node 的沙箱页里，只有一个全局 `cindy`。
// 所有真实工作都由 `cindy.node.request` 转给随包 MCP 服务端（node.protocol = mcp-stdio）。

// ---- 类目与规则 -----------------------------------------------------------
//
// rules 会被**随结果一起下发**（手册要求：只给工具名与说明、把规则留到调用失败
// 后才说，是不合格的目录）。所以每条都写成「调用前必须知道的一句话」。
var CATEGORIES = [
  {
    name: 'gate',
    label: '门禁主链',
    summary: '留痕 → 领名额 → 派发 → 裁定',
    rules: [
      '改代码 / 配置 / 文档（T2）之前必须先 flow_submit_requirement 留痕；没卡不许派发、不许裁定。',
      'PASS 只能由已领取 auditor 角色的会话落下（executor 自批会被拒）。',
      'scope 为空的卡按 fail-closed 处理：任何文件改动都算越界。',
      '激活占位卡（activation_pending 非空）必须先补齐 scope / acceptance / verify.cmd，否则 claim / dispatch / verdict 全被拒。',
    ],
    members: ['flow_submit_requirement', 'flow_claim', 'flow_dispatch', 'flow_verdict', 'carlos_task'],
  },
  {
    name: 'verify',
    label: '验证与负对照',
    summary: '跑验证命令 + 证明测试有判别力',
    rules: [
      '验证命令由任务卡的 verify.cmd 指定，executor 不得自选测试项。',
      'flow_run_verify 通过后代码再改动即失效（STALE），必须重跑。',
      '记 PASS 前必须 flow_falsify：改动前跑必须失败、改动后跑必须通过，否则视为空测试。',
      '负对照会临时把文件改回旧内容；返回值里的 restore.ok=false 表示工作区还原没通过核对，要立刻人工确认。',
    ],
    members: ['flow_run_verify', 'flow_falsify', 'carlos_verify'],
  },
  {
    name: 'audit',
    label: '双轴审查与流水',
    summary: 'Standards / Spec 两轴取证 + 审计流水查询',
    rules: [
      'PASS 前两轴（standards、spec）都必须有结论，且 card_ts 与当前卡一致（旧卡结论不算数）。',
      '任一轴 FAIL 硬拦；WARN 不硬拦，但会随裁定一起返回（warn_findings），汇报时不能吞。',
      'flow_audit 只读审计流水，可验证哈希链完整性；它不产生裁定。',
    ],
    members: ['flow_audit_axes', 'flow_audit_submit', 'flow_audit_guard', 'flow_audit', 'carlos_review'],
  },
  {
    name: 'infra',
    label: '状态·协议·还原',
    summary: '看进度、读协议、免检、还原计划、越界自查',
    rules: [
      'flow_status 是唯一的进度真源；汇报「做到哪一步」前先读它，别凭记忆答。',
      '清理/归档磁盘前先看 flow_stats（只读）：它会给出各会话占用、备份去重率、审计按日增长与陈旧会话清单；没有它就只能凭感觉删目录。',
      'flow_bypass 只能在用户明确说「直接干 / 免检 / 别管流程」时开启，且每次开关都进审计流水。',
      'flow_revert_plan 只出还原计划，绝不自动执行；真正回滚要人工确认。',
      'flow_check_scope 不传 paths 时会自己跑 git diff 取当前改动，用来在裁定前自查越界。',
    ],
    members: [
      'flow_status', 'flow_stats', 'flow_protocol', 'flow_mode', 'flow_bypass', 'flow_cancel', 'flow_add_user_msg',
      'flow_save_result', 'flow_revert_plan', 'flow_check_scope', 'flow_diff_hunks', 'carlos_manage',
    ],
  },
  {
    name: 'trigger',
    label: '智能触发',
    summary: '判断这条用户消息是否该启动工作流',
    rules: [
      '由宿主在收到用户消息时调用；达标时会实际激活（写用户原话 + 开占位卡），而不只是打分。',
      '未达阈值只如实返回评分与决策，不做任何写入 —— 不要把它当「无条件开卡」用。',
    ],
    members: ['flow_trigger_check'],
  },
];

var CATEGORY_BY_TOOL = {};
CATEGORIES.forEach(function (c) {
  c.members.forEach(function (name) { CATEGORY_BY_TOOL[name] = c; });
});

// 长任务：verify / falsify 可能各跑上百秒，期间按 45s 发心跳续命，
// 免得主机把这次 tool-call 判成超时（窗口默认 330s）。
var LONG_RUNNING_TOOLS = { flow_run_verify: true, flow_falsify: true, flow_dispatch: true };
var HEARTBEAT_MS = 45000;
// 单次 Node 请求：沉默窗口 120s（宿主上限），总时长放宽到 15 分钟。
// 负对照要跑两次命令，120s 的沉默窗口对「两次各 60s」仍然够用。
var NODE_TIMEOUT_MS = 120000;
var NODE_MAX_TOTAL_MS = 900000;

var toolsCache = null;

async function loadTools() {
  if (toolsCache) return toolsCache;
  var res = await cindy.node.request({
    method: 'tools/list',
    params: {},
    timeoutMs: NODE_TIMEOUT_MS,
    maxTotalMs: NODE_MAX_TOTAL_MS,
  });
  if (!res || !res.ok) {
    throw new Error('取工具目录失败：' + (res && res.message ? res.message : '未知原因'));
  }
  var list = (res.result && res.result.tools) || [];
  var byName = {};
  list.forEach(function (t) { byName[t.name] = t; });
  toolsCache = { list: list, byName: byName };
  return toolsCache;
}

function fail(msg, errorCode, message, extra) {
  var out = { type: 'tool-result', callId: msg.callId, ok: false, errorCode: errorCode, message: message };
  if (extra) out.result = extra;
  return out;
}

function overview() {
  return {
    ok: true,
    total: CATEGORIES.reduce(function (n, c) { return n + c.members.length; }, 0),
    categories: CATEGORIES.map(function (c) {
      return { name: c.name, label: c.label, count: c.members.length, summary: c.summary };
    }),
    hint: '传 category 取该类目的工具明细与 RULES，再用 call_tool 执行；不传 category 只看概览。',
  };
}

async function listTools(msg) {
  var args = msg.args || {};
  var category = args.category;

  if (category === undefined || category === null || category === '') {
    return { type: 'tool-result', callId: msg.callId, ok: true, result: overview() };
  }

  var cat = null;
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].name === String(category).trim()) { cat = CATEGORIES[i]; break; }
  }
  if (!cat) {
    return fail(msg, 'UNKNOWN_CATEGORY',
      '没有这个类目：' + category + '。可用类目：' + CATEGORIES.map(function (c) { return c.name; }).join(' / ') +
      '（不传 category 可看概览）',
      { categories: CATEGORIES.map(function (c) { return c.name; }) });
  }

  var catalog = await loadTools();
  var tools = [];
  var missing = [];
  cat.members.forEach(function (name) {
    var t = catalog.byName[name];
    if (!t) { missing.push(name); return; }
    tools.push({ name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } });
  });
  if (missing.length) {
    return fail(msg, 'CATALOG_DRIFT',
      '服务端缺少类目 ' + cat.name + ' 声明的操作：' + missing.join('、') +
      '。这属于版本不一致（插件清单比服务端新/旧），请重新安装插件或升级 carlos-flow 后再试。',
      { missing: missing });
  }

  return {
    type: 'tool-result',
    callId: msg.callId,
    ok: true,
    result: { ok: true, category: cat.name, label: cat.label, tool_count: tools.length, rules: cat.rules, tools: tools },
  };
}

async function callToolRequest(msg) {
  var args = msg.args || {};
  var name = args.name;
  var callArgs = args.args;

  if (typeof name !== 'string' || name.trim() === '') {
    return fail(msg, 'MISSING_NAME',
      'call_tool 需要 name（操作名）。先调 list_tools 看有哪些操作，再把它返回的 name 原样传进来。',
      { categories: CATEGORIES.map(function (c) { return c.name; }) });
  }
  name = name.trim();

  var catalog = await loadTools();
  var tool = catalog.byName[name];
  if (!tool) {
    var names = catalog.list.map(function (t) { return t.name; });
    return fail(msg, 'UNKNOWN_TOOL',
      '没有这个操作：' + name + '。可用操作共 ' + names.length + ' 个：' + names.join('、') +
      '。先调 list_tools(category) 取明细（含参数说明与 RULES）再重试。',
      { available_tools: names });
  }

  if (callArgs !== undefined && callArgs !== null && (typeof callArgs !== 'object' || Array.isArray(callArgs))) {
    return fail(msg, 'INVALID_ARGS',
      'args 必须是 JSON 对象（键值对）。' + name + ' 的参数 schema 见 result.schema。',
      { schema: tool.inputSchema || { type: 'object', properties: {} }, rules: rulesOf(name) });
  }
  var payload = {}
  Object.keys(callArgs || {}).forEach(function (key) {
    if (!/^__/.test(key) && ['session_context', 'carlosContext', 'cindy', 'hostContext'].indexOf(key) < 0) payload[key] = callArgs[key]
  })
  var suppliedContext = args.session_context
  var context = suppliedContext && typeof suppliedContext.session_id === 'string' ? {
    session_id: suppliedContext.session_id,
    workdir: suppliedContext.workdir,
    workdir_is_local: suppliedContext.workdir_is_local === true,
    workdir_is_read_only: suppliedContext.workdir_is_read_only !== false,
  } : undefined

  // 参数形状自查：只提示，不改写（真正的校验在服务端 validateToolArgs）。
  var lacks = [];
  var required = (tool.inputSchema && tool.inputSchema.required) || [];
  required.forEach(function (k) {
    if (payload[k] === undefined || payload[k] === null || payload[k] === '') lacks.push(k);
  });
  if (lacks.length) {
    return fail(msg, 'MISSING_FIELDS',
      name + ' 缺少必填参数：' + lacks.join('、') + '。参数 schema 与 RULES 见 result，按它补齐后重试。',
      { schema: tool.inputSchema || {}, rules: rulesOf(name), missing: lacks });
  }

  var heartbeat = null;
  if (LONG_RUNNING_TOOLS[name]) {
    heartbeat = setInterval(function () {
      try { cindy.send({ type: 'tool-progress', callId: msg.callId }); } catch (e) { /* 续命失败不影响主流程 */ }
    }, HEARTBEAT_MS);
  }

  try {
    var res = await cindy.node.request({
      method: 'tools/call',
      params: { name: name, arguments: payload, carlosContext: context },
      callId: msg.callId,
      cancelWithCall: true,
      timeoutMs: NODE_TIMEOUT_MS,
      maxTotalMs: NODE_MAX_TOTAL_MS,
    });
    if (!res || !res.ok) {
      return fail(msg, 'NODE_REQUEST_FAILED',
        payload.expected !== undefined ? '验证请求结果未知；请查看原任务，不自动重试或回退执行。' :
        '执行 ' + name + ' 时随包 Node 服务没有正常回包：' + (res && res.message ? res.message : '未知原因') +
        '。可重试一次；仍失败请检查插件是否被停用或 Node 进程被系统拦截。');
    }
    var stale = res.result && res.result.structuredContent
    if (name === 'flow_verdict' && payload.verdict === 'PASS' && res.result.isError === true &&
        stale && stale.code === 'VERIFY_STALE' && stale.expected && /^[a-f0-9]{64}$/.test(stale.expected.caseKey) &&
        context && context.session_id === payload.sessionId) {
      await rememberStale(msg.callId, context.session_id, stale)
      drawStale(msg.callId, '检测时发现验证之后有变化；不是实时检测。')
    }
    // 原样透传 MCP 结果：工具自身失败用 isError 表达，宿主会按错误内容展示，
    // 这保证了「直接声明工具」与「经 call_tool 转发」两条路径的语义一致。
    return { type: 'tool-result', callId: msg.callId, ok: true, result: { mcpResult: res.result } };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

// 完整向导：缓存只是展示与拒绝重放提示，不能形成后端证据或授予 Node 权限。
var wizardCurrent = Object.create(null)
var wizardIssued = Object.create(null)
var wizardDrafts = Object.create(null)
var WIZARD_INTENTS = { clarify: '读取草稿并澄清目标', 'confirm-scope': '讨论并确认范围与验收意图', execute: '协调已确认范围内的下一项执行', check: '协调真实检查、负对照与还原核对', review: '协调独立审查', finish: '复核真实结果或处理问题' }
var wizardObserved = Object.create(null)
var wizardConsumed = Object.create(null)
var wizardChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('carlos-task-wizard') : null
var WIZARD_LABELS = { start: '启动', goal: '说明目标', scope: '范围与验收', execution: '执行', checks: '检查与负对照', review: '独立审查', complete: '完成', problem: '处理问题' }
function writableWizardContext(ctx) {
  return !!(ctx && typeof ctx.session_id === 'string' && ctx.session_id.length > 0 && ctx.session_id.length <= 200 &&
    typeof ctx.workdir === 'string' && ctx.workdir.trim() && ctx.workdir_is_local === true && ctx.workdir_is_read_only === false)
}
function trustedWizardContext(msg) {
  var ctx = msg.args && msg.args.session_context
  return ctx ? { session_id: ctx.session_id, workdir: ctx.workdir, workdir_is_local: ctx.workdir_is_local === true, workdir_is_read_only: ctx.workdir_is_read_only !== false } : null
}
function safeWizard(w) {
  if (!w || !Object.prototype.hasOwnProperty.call(WIZARD_LABELS, w.stage)) throw new Error('向导状态不可用')
  var status = ['waiting', 'blocked', 'unknown', 'complete'].indexOf(w.status) >= 0 ? w.status : 'unknown'
  var reasons = { start: '请在原对话说明希望解决的问题。', goal: '请在原对话明确目标。', scope: '请确认修改范围和验收依据；确认前不执行。', execution: '执行状态待确认，派发记录不代表完成。', checks: '需要真实检查、有效负对照与还原核对；未知或失败不能继续。', review: '需要当前任务的独立审查和合法最终裁定。', complete: '后端当前检查与独立裁定已确认。', problem: '存在阻断或未知结果，请先在原对话处理问题，不自动重试。' }
  return { stage: w.stage, stage_label: WIZARD_LABELS[w.stage], status: status,
    completed_ok: w.completed_ok === true && w.stage === 'complete' && status === 'complete',
    goal: w.goal === '已记录目标' ? '已记录目标' : '尚未记录目标',
    scope_count: Number.isInteger(w.scope_count) && w.scope_count >= 0 ? w.scope_count : 0,
    reason: reasons[w.stage], next_responsible: ['start', 'goal', 'scope'].indexOf(w.stage) >= 0 ? '用户与原任务助手' : '原任务助手与独立审查者',
    sampled_at: Number.isFinite(w.sampled_at) ? w.sampled_at : null,
    warning_count: Number.isInteger(w.warning_count) && w.warning_count >= 0 ? w.warning_count : 0 }
}
function readStatus(result) {
  if (!result || result.isError) throw new Error('状态未确认')
  var content = (result.content || []).find(function (item) { return item.type === 'text' })
  var status = content ? JSON.parse(content.text) : null
  if (!status || !status.wizard) throw new Error('向导真源不可用')
  return status
}
async function wizardGeneration(status, ctx) {
  var encoded = unescape(encodeURIComponent(JSON.stringify({ card: status.card, card_ts: status.card_ts, sid: ctx.session_id, workdir: ctx.workdir })))
  var data = Uint8Array.from(encoded, function (c) { return c.charCodeAt(0) })
  var digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0') }).join('')
}
async function wizardCache() {
  var response = await fetch('/kv')
  if (!response.ok) throw new Error('缓存不可用')
  var cfg = await response.json()
  var rows = []
  ;(Array.isArray(cfg.fullWizard) ? cfg.fullWizard : []).slice(-8).forEach(function (r) {
    try {
      if (!r || typeof r.sid !== 'string' || r.sid.length > 200 || typeof r.callId !== 'string' || r.callId.length > 200 || !/^[a-f0-9]{64}$/.test(r.generation) || !/^[a-f0-9]{32}$/.test(r.nonce) || !Object.prototype.hasOwnProperty.call(WIZARD_INTENTS, r.intent)) return
      rows.push({ sid: r.sid, callId: r.callId, generation: r.generation, nonce: r.nonce, intent: r.intent, expiresAt: Number(r.expiresAt) || 0, requested: r.requested === true, resumed: r.resumed === true, wizard: safeWizard(r.wizard) })
    } catch (e) { /* 单条展示损坏隔离；绝不重建执行资格 */ }
  })
  return { cfg: cfg, rows: rows }
}
async function saveWizard(cache) {
  cache.cfg.fullWizard = cache.rows.slice(-8)
  var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(cache.cfg) })
  if (!response.ok) throw new Error('展示缓存保存未确认')
}
function wizardConfirmation(row, cached) {
  if (cached) return 'unknown'
  var issued = row && wizardIssued[row.nonce]
  if (!row || !issued || wizardCurrent[row.sid] !== row.nonce || issued.sid !== row.sid || issued.callId !== row.callId || issued.generation !== row.generation || issued.intent !== row.intent) return 'unknown'
  if (issued.expiresAt <= Date.now() || row.expiresAt <= Date.now()) return 'expired'
  if (issued.unavailable) return 'unavailable'
  if (issued.resumed) return 'consumed'
  if (issued.requested) return 'requested'
  return issued.offerReady === true ? 'pending' : 'unknown'
}
function displayWizard(row, confirmation, cached) {
  if (wizardChannel && row) wizardChannel.postMessage({ type: 'wizard-display', sid: row.sid, wizard: row.wizard, cached: cached === true, intent: row.intent, confirmation: confirmation })
}
function drawWizard(callId, text, hide, nonce) {
  cindy.send({ type: 'card-update', callId: callId, v: 2, state: 'done', height: 150,
    html: '<div style="padding:12px;color:var(--text-primary,#222)"><p>' + text + '</p>' +
      (hide ? '' : '<button data-ghost-action="wizard-continue:' + nonce + '" data-ghost-primary>确认并继续</button>') + '</div>' })
}
function escapeWizard(text) { return String(text).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
function wizardDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (key) { return ['goal', 'scope', 'acceptance'].indexOf(key) < 0 })) return null
  var draft = {}
  for (var key of ['goal', 'scope', 'acceptance']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1000)) return null
    draft[key] = value[key] || ''
  }
  return draft
}
async function publishWizard(msg, ctx, status, intent) {
  if (status.sessionId !== ctx.session_id) throw new Error('状态任务不匹配')
  var generation = await wizardGeneration(status, ctx)
  var summary = safeWizard(status.wizard)
  wizardObserved[ctx.session_id] = generation
  var cache
  try { cache = await wizardCache() } catch (e) { cache = null }
  var warning = null
  var nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (b) { return b.toString(16).padStart(2, '0') }).join('')
  var row = { sid: ctx.session_id, callId: msg.callId, generation: generation, nonce: nonce, intent: intent, expiresAt: Date.now() + 120000, requested: false, resumed: false, wizard: summary }
  try {
    if (!cache) throw new Error('展示缓存不可用')
    cache.rows = cache.rows.filter(function (r) { return r.sid !== ctx.session_id }); cache.rows.push(row)
    await saveWizard(cache)
    wizardIssued[nonce] = { sid: row.sid, callId: row.callId, generation: generation, intent: intent, expiresAt: row.expiresAt, requested: false, resumed: false, offerReady: true, workdir: ctx.workdir, draft: wizardDrafts[row.sid] || null }
    wizardCurrent[row.sid] = nonce
    var draft = wizardDrafts[row.sid]
    drawWizard(msg.callId, WIZARD_INTENTS[intent] + '。' + (draft ? '待讨论草稿（不是任务事实或扩大范围授权）：' + escapeWizard(JSON.stringify(draft)) : '先在任务页填写草稿，再点击此原生卡读取草稿并开始协调。') + '文件与命令仍需原权限审批。', false, nonce)
  } catch (e) {
    warning = '展示或确认记录保存未确认；没有执行资格，请在原对话继续讨论。'
    drawWizard(msg.callId, warning, true)
  }
  if (wizardChannel) wizardChannel.postMessage({ type: 'wizard-display', sid: ctx.session_id, wizard: summary, cached: false, intent: intent, confirmation: warning ? 'unavailable' : wizardConfirmation(row, false), draft_received: !!wizardDrafts[ctx.session_id] })
  return { wizard: summary, warning: warning }
}
async function wizardStatusRequest(msg, ctx) {
  var result = await cindy.node.request({ method: 'tools/call', params: { name: 'flow_status', arguments: { sessionId: ctx.session_id }, carlosContext: ctx },
    callId: msg.callId, cancelWithCall: true, timeoutMs: NODE_TIMEOUT_MS, maxTotalMs: NODE_MAX_TOTAL_MS })
  if (!result || !result.ok) throw new Error('只读状态请求未确认')
  return readStatus(result.result)
}
function nextWizardIntent(stage) { return { start: 'clarify', goal: 'clarify', scope: 'confirm-scope', execution: 'execute', checks: 'check', review: 'review', complete: 'finish', problem: 'finish' }[stage] }
async function startWizard(msg) {
  var args = msg.args || {}, ctx = trustedWizardContext(msg)
  if (!writableWizardContext(ctx)) return fail(msg, 'WIZARD_CONTEXT_REQUIRED', '仅支持当前本机可写任务；未受理启动，请检查任务权限与位置。')
  if (args.sessionId !== undefined && args.sessionId !== ctx.session_id) return fail(msg, 'WIZARD_TASK_MISMATCH', '任务不匹配，未受理启动。')
  var action = args.action === undefined ? 'open' : args.action
  if (['open', 'prepare', 'resume'].indexOf(action) < 0 || Object.keys(args).some(function (key) { return ['session_context', 'sessionId', 'action', 'intent', 'expected'].indexOf(key) < 0 }) ||
      (args.intent !== undefined && !Object.prototype.hasOwnProperty.call(WIZARD_INTENTS, args.intent)) || (action !== 'resume' && args.expected !== undefined)) return fail(msg, 'WIZARD_INVALID_INTENT', '只接受明确向导意图，不接受工具名、目录或执行指令。')
  var row, issued, cache
  if (action === 'resume') {
    var exp = args.expected
    if (!exp || typeof exp !== 'object' || Array.isArray(exp) || Object.keys(exp).sort().join(',') !== 'callId,generation,intent,nonce' || !/^[a-f0-9]{32}$/.test(exp.nonce) || !/^[a-f0-9]{64}$/.test(exp.generation)) return fail(msg, 'WIZARD_EXPECTED_INVALID', '确认记录无效，不回退普通执行。')
    cache = await wizardCache()
    row = cache.rows.find(function (r) { return r.sid === ctx.session_id && r.callId === exp.callId && r.nonce === exp.nonce && r.generation === exp.generation && r.intent === exp.intent })
    issued = wizardIssued[exp.nonce]
    if (issued && issued.workdir !== ctx.workdir) return fail(msg, 'WIZARD_WORKDIR_MISMATCH', '当前任务目录已变化，旧意图不能继续。')
    if (!row || !issued || wizardCurrent[ctx.session_id] !== exp.nonce || issued.unavailable || issued.sid !== ctx.session_id || issued.callId !== exp.callId || issued.generation !== exp.generation || issued.intent !== exp.intent || !issued.requested || issued.resumed || issued.expiresAt <= Date.now() || !row.requested || row.resumed || row.expiresAt <= Date.now()) return fail(msg, 'WIZARD_EXPECTED_INVALID', '单次意图已过期、变化或消费；不重放，也不影响普通工具调用。')
  }
  var status = await wizardStatusRequest(msg, ctx)
  if (status.sessionId !== ctx.session_id) return fail(msg, 'WIZARD_TASK_MISMATCH', '状态与当前任务不一致，未打开页面。')
  if (row) {
    var sampledGeneration = await wizardGeneration(status, ctx)
    // 最后一个 await 之后同步复核并领取；并发另一请求不能穿过已消费的内存门。
    if (sampledGeneration !== exp.generation) return fail(msg, 'WIZARD_GENERATION_CHANGED', '任务或目录已变化，旧意图不能继续。')
    if (nextWizardIntent(status.wizard.stage) !== issued.intent) return fail(msg, 'WIZARD_INTENT_STAGE_MISMATCH', '本次采样阶段已变化，旧意图不能继续；不是实时监控。')
    if (wizardIssued[exp.nonce] !== issued || wizardCurrent[ctx.session_id] !== exp.nonce || issued.unavailable || issued.resumed || !issued.requested ||
        issued.sid !== ctx.session_id || issued.workdir !== ctx.workdir || issued.callId !== exp.callId || issued.generation !== exp.generation || issued.intent !== exp.intent ||
        row.nonce !== exp.nonce || row.callId !== exp.callId || row.generation !== exp.generation || row.intent !== exp.intent || !row.requested || row.resumed ||
        issued.expiresAt <= Date.now() || row.expiresAt <= Date.now()) {
      displayWizard(row, wizardConfirmation(row, false), false)
      return fail(msg, 'WIZARD_EXPECTED_INVALID', '单次意图在采样等待后过期、变化或已消费，不重放。')
    }
    // 同一同步段立即消费，不锁普通工具；保存未知仍保留消费，不回滚。
    issued.resumed = true; row.resumed = true
    displayWizard(row, 'consumed', false)
    try { await saveWizard(cache) } catch (e) {
      issued.unavailable = true
      displayWizard(row, 'unavailable', false)
      return fail(msg, 'WIZARD_PERSIST_UNKNOWN', '消费记录保存未确认；意图仍已消费，不自动重放。')
    }
    return { type: 'tool-result', callId: msg.callId, ok: true, result: { intent: row.intent, wizard: safeWizard(status.wizard),
      proposal: issued.draft, proposal_is_untrusted: true,
      next: '只协调本意图；草稿不等于用户原话、任务事实或扩大范围授权。正常业务工具沿原权限另发新调用。完成一个协调动作或提问后，必须在本活跃回合用 start_wizard prepare 采样并供下一确认卡；无需用户催动技术命令。未知结果先查证，不自动PASS或重放。' } }
  }
  var opened = await cindy.taskView({ sessionId: ctx.session_id })
  if (!opened || !opened.ok || opened.sessionId !== ctx.session_id) return fail(msg, 'WIZARD_OPEN_DENIED', '任务页未受理或落点不一致；请检查插件批准与原任务，不自动重试。')
  var intent = args.intent || nextWizardIntent(status.wizard.stage)
  if (!intent || intent !== nextWizardIntent(status.wizard.stage)) return fail(msg, 'WIZARD_INTENT_STAGE_MISMATCH', '意图与真实当前阶段不一致，不执行或跳步。')
  var published = await publishWizard(msg, ctx, status, intent)
  return { type: 'tool-result', callId: msg.callId, ok: true, result: { opened: true, wizard: published.wizard, warning: published.warning,
    intent: intent, hint: '先自然询问当前目标或范围，让用户在页填草稿并点击当前原生意图卡。每次resume之后本回合自动prepare下一卡，不让用户填写技术参数或催prepare。草稿只是提案，页面不能执行。' } }
}
async function wizardAction(msg) {
  var nonce = msg.actionId.slice('wizard-continue:'.length)
  if (!/^[a-f0-9]{32}$/.test(nonce) || wizardConsumed[nonce]) return
  var issued = wizardIssued[nonce]
  // 先绑定本实例当前nonce/callId/SID；无效跨任务事件不能消费或取消真卡。
  if (!issued || wizardCurrent[issued.sid] !== nonce || issued.callId !== msg.callId || issued.sid !== msg.sessionId) return
  wizardConsumed[nonce] = true
  var cache
  try { cache = await wizardCache() } catch (e) {
    // GET网络/非ok/解析未知：仅仍绑定当前签发对象时撤销展示资格；消费不回滚。
    if (wizardIssued[nonce] === issued && wizardCurrent[issued.sid] === nonce && issued.callId === msg.callId && issued.sid === msg.sessionId) {
      issued.unavailable = true
      if (wizardChannel) wizardChannel.postMessage({ type: 'wizard-confirmation', sid: issued.sid, confirmation: 'unavailable' })
      drawWizard(msg.callId, '确认记录读取未确认；资格不可用，不请求助手或重放。', true)
    }
    return
  }
  var row = cache.rows.find(function (r) { return r.callId === msg.callId && r.sid === msg.sessionId && r.nonce === nonce })
  if (!row || !issued || issued.callId !== row.callId || issued.sid !== row.sid || issued.generation !== row.generation || issued.intent !== row.intent || issued.expiresAt <= Date.now() || wizardCurrent[row.sid] !== nonce || issued.unavailable || row.requested || row.expiresAt <= Date.now() || wizardObserved[row.sid] !== row.generation || !msg.userActionToken) {
    drawWizard(msg.callId, '确认已过期、任务观察已变化或记录不可用；请在原对话重新确认，不会自动执行。', true)
    return
  }
  row.requested = true; issued.requested = true
  // bootstrap卡只批准读取并讨论草稿；页面草稿永不变成业务授权。
  issued.draft = wizardDrafts[row.sid] || issued.draft
  try { await saveWizard(cache) } catch (e) {
    issued.unavailable = true
    displayWizard(row, 'unavailable', false)
    drawWizard(msg.callId, '确认记录保存未确认；不会请求助手或重放。', true)
    return
  }
  displayWizard(row, 'requested', false)
  var expected = { callId: row.callId, generation: row.generation, nonce: row.nonce, intent: row.intent }
  var result
  try { result = await cindy.agent.run({ mode: 'continue', userActionToken: msg.userActionToken,
    promptTemplate: '用户选择：{{user_message}}\n立即在新的活跃调用中使用 start_wizard(action=resume, expected=事件中的expected)。它只返回一个协调意图和未可信草稿，绝不将草稿作为quote/范围授权。按当前阶段自然提问或协调一个动作；正常业务工具另发新调用沿原权限。随后本回合必须调用 start_wizard(action=prepare) 采样并生成下一适用意图卡，说明下一输入项，不让用户主动催prepare或填写JSON。没有用户确认不扩范围；不免检、自动PASS、重放未知结果；resume失败不能回退执行。\n{{event_json}}',
    userMessage: WIZARD_INTENTS[row.intent], event: { expected: expected } })
  } catch (e) {
    issued.unavailable = true
    displayWizard(row, 'unknown', false)
    drawWizard(msg.callId, '助手续接结果未知；不自动重放，请查看原对话。', true)
    return
  }
  if (!result || !result.ok) { issued.unavailable = true; displayWizard(row, 'unavailable', false) }
  drawWizard(msg.callId, result && result.ok ? '原助手已受理本意图；正在协调下一步，不代表执行或检查完成。' : '继续未受理或结果未知，请查看原对话；不自动重试。', true)
}
if (wizardChannel) wizardChannel.onmessage = async function (event) {
  var data = event.data
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.sid !== 'string' || data.sid.length > 200) return
  if (data.type === 'wizard-draft-proposal') {
    if (!wizardObserved[data.sid] || Object.keys(data).some(function (key) { return ['type', 'sid', 'draft'].indexOf(key) < 0 })) return
    var draft = wizardDraft(data.draft)
    if (draft) { wizardDrafts[data.sid] = draft; wizardChannel.postMessage({ type: 'wizard-draft-received', sid: data.sid, untrusted: true }) }
    return
  }
  if (data.type !== 'wizard-display-request') return
  try {
    var cache = await wizardCache()
    var row = cache.rows.find(function (r) { return r.sid === data.sid })
    if (row) displayWizard(row, 'unknown', true)
  } catch (e) {
    if (wizardChannel) wizardChannel.postMessage({ type: 'wizard-confirmation', sid: data.sid, confirmation: 'unavailable' })
  }
}

function rulesOf(toolName) {
  var cat = CATEGORY_BY_TOOL[toolName];
  return cat ? cat.rules : [];
}

// KV 仅为有界展示缓存，LWW 不参与执行领取；绝不保存命令、路径、diff 或点击票。
async function staleCache() {
  var cfg = await (await fetch('/kv')).json()
  var rows = Array.isArray(cfg.staleWizard) ? cfg.staleWizard : []
  rows = rows.filter(function (row) {
    return row && typeof row.callId === 'string' && row.callId.length <= 200 &&
      typeof row.sid === 'string' && row.sid.length <= 200 && /^[a-f0-9]{64}$/.test(row.caseKey)
  }).slice(-24).map(function (row) {
    return {
      callId: row.callId, sid: row.sid, caseKey: row.caseKey,
      detectedAt: Number(row.detectedAt) || 0, expiresAt: Number(row.expiresAt) || 0,
      requested: row.requested === true, deferred: row.deferred === true,
    }
  })
  return { cfg: cfg, rows: rows }
}

async function saveStaleCache(cache) {
  cache.cfg.staleWizard = cache.rows.slice(-24)
  var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(cache.cfg) })
  if (!response.ok) throw new Error('向导展示状态未保存；请使用普通验证入口')
}

async function rememberStale(callId, sid, stale) {
  var cache = await staleCache()
  cache.rows = cache.rows.filter(function (row) { return row.callId !== callId })
  cache.rows.push({
    callId: callId, sid: sid, caseKey: stale.expected.caseKey,
    detectedAt: stale.detectedAt, expiresAt: stale.expiresAt, requested: false, deferred: false,
  })
  await saveStaleCache(cache)
}

function drawStale(callId, text, hide) {
  var buttons = hide ? '' : '<div style="display:flex;gap:8px;flex-wrap:wrap"><button data-ghost-action="stale-view">查看变化</button><button data-ghost-action="stale-retry" data-ghost-primary>重新检查</button><button data-ghost-action="stale-defer">暂不继续</button></div>'
  cindy.send({
    type: 'card-update', callId: callId, v: 2, state: 'done', height: 150,
    html: '<div style="padding:12px;color:var(--text-primary,#222)"><p>' + text + '</p>' + buttons + '</div>',
  })
}

async function staleAction(msg) {
  if (['stale-view', 'stale-retry', 'stale-defer'].indexOf(msg.actionId) < 0) return
  var cache = await staleCache()
  var row = cache.rows.find(function (item) { return item.callId === msg.callId && item.sid === msg.sessionId })
  if (!row) {
    drawStale(msg.callId, '展示记录不可用；不会重建执行资格，请手动验证。', true)
    return
  }
  if (msg.actionId === 'stale-view') {
    drawStale(msg.callId, '检测时发现代码与原验证不同；此处不是实时检测，不展示命令、路径或完整差异。')
    return
  }
  if (msg.actionId === 'stale-defer') {
    row.deferred = true
    await saveStaleCache(cache)
    drawStale(msg.callId, '已收起提示；不取消验证，也不撤回已经提交的重新检查。', true)
    return
  }
  if (!msg.userActionToken || row.requested) {
    drawStale(msg.callId, '重新检查未再次提交；请查看原任务执行状态。', true)
    return
  }
  row.requested = true
  await saveStaleCache(cache)
  var result = await cindy.agent.run({ mode: 'continue', userActionToken: msg.userActionToken,
    promptTemplate: '用户选择：{{user_message}}\n请沿原会话权限调用 Carlos call_tool，name 为 flow_run_verify，args 使用以下 sessionId 与 expected；不得省略 expected 或失败后回退普通执行，不自动 PASS 或 falsify。\n{{event_json}}',
    userMessage: '重新检查原验证', event: { sessionId: row.sid, expected: { caseKey: row.caseKey } },
  })
  drawStale(msg.callId, result.ok ? '已请求原任务继续；不代表命令已执行或检查通过。' : '继续请求未确认；请查看原任务，不自动重新提交。', true)
}

cindy.onHostMessage(async function (msg) {
  if (msg && msg.type === 'event' && msg.name === 'card-action') {
    try {
      if (msg.actionId && msg.actionId.indexOf('wizard-continue:') === 0) await wizardAction(msg)
      else await staleAction(msg)
    } catch (error) {
      if (msg.actionId && msg.actionId.indexOf('wizard-continue:') === 0) drawWizard(msg.callId, '继续请求未确认，请查看原对话；不会自动重试。', true)
      else drawStale(msg.callId, '向导状态未知；请查看原任务，不自动重试。', true)
    }
    return
  }
  if (!msg || msg.type !== 'tool-call') return;
  try {
    var out;
    if (msg.tool === 'list_tools') out = await listTools(msg);
    else if (msg.tool === 'start_wizard') out = await startWizard(msg);
    else if (msg.tool === 'call_tool') out = await callToolRequest(msg);
    else {
      out = fail(msg, 'UNKNOWN_META_TOOL',
        '本插件提供 start_wizard 启动向导，以及 list_tools 与 call_tool 两段式门禁入口。');
    }
    cindy.send(out);
  } catch (e) {
    if (msg.tool === 'start_wizard') {
      cindy.send(fail(msg, 'WIZARD_UNCERTAIN', '启动请求未确认；请查看原任务，不自动重试或执行。'))
      return
    }
    if (msg.args && msg.args.args && Object.prototype.hasOwnProperty.call(msg.args.args, 'expected')) {
      cindy.send(fail(msg, 'WIZARD_UNCERTAIN', '向导请求未确认；请查看原任务，不自动重试或回退执行。'))
      return
    }
    cindy.send(fail(msg, 'INTERNAL',
      '插件内部异常：' + (e && e.message ? e.message : String(e)) + '。可重试一次；持续失败请反馈。'));
  }
});