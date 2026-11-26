// main.js —— Carlos 工作流（chip 沙箱入口）
//
// 为什么是「两段式目录」（Cindy 插件手册 §3.5）：
// 本插件底层有 22 个操作 + 4 个门面，而宿主对 tools 声明有**硬上限 16 项**；
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
// 类目 members 同时列出底层操作与门面。运行时按 tools/list 的真实可见面过滤：
// legacy 面看到 26 个底层操作，external 面只看到四个门面——两种面都不报漂移，
// 只有“整个类目一个可用操作都没有”才判为版本不一致。
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
    members: [
      'flow_audit_axes', 'flow_audit_submit', 'flow_audit_guard', 'flow_audit',
      'flow_advisory_axes', 'flow_advisory_submit', 'flow_advisory_guard',
      'carlos_review',
    ],
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
var LONG_RUNNING_TOOLS = {
  flow_run_verify: true, flow_falsify: true, flow_dispatch: true,
  carlos_verify: true, carlos_task: true, carlos_review: true,
};
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

function visibleMembers(cat, catalog) {
  return cat.members.filter(function (name) { return !!catalog.byName[name]; });
}

async function overview() {
  var catalog = await loadTools();
  var cats = CATEGORIES.map(function (c) {
    return { cat: c, members: visibleMembers(c, catalog) };
  }).filter(function (x) { return x.members.length > 0; });
  return {
    ok: true,
    total: cats.reduce(function (n, x) { return n + x.members.length; }, 0),
    categories: cats.map(function (x) {
      return { name: x.cat.name, label: x.cat.label, count: x.members.length, summary: x.cat.summary };
    }),
    hint: '传 category 取该类目的工具明细与 RULES，再用 call_tool 执行；不传 category 只看概览。',
  };
}

async function listTools(msg) {
  var args = msg.args || {};
  var category = args.category;

  if (category === undefined || category === null || category === '') {
    return { type: 'tool-result', callId: msg.callId, ok: true, result: await overview() };
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
  // 整个类目一个可用操作都没有，才是真的版本不一致；
  // 部分缺失是“当前工具面不暴露底层名”（例如 external 面只有四个门面），属正常。
  if (tools.length === 0) {
    // 整类目在当前工具面全部隐藏（例如默认四门面下没有 trigger）：
    // 这是“当前面不提供”，不是版本不一致，不能误导用户去重装。
    return {
      type: 'tool-result',
      callId: msg.callId,
      ok: true,
      result: {
        ok: true, category: cat.name, label: cat.label, tool_count: 0,
        rules: cat.rules, tools: [],
        note: '该类目的操作在当前工具面不可用（默认四门面面不暴露底层 trigger；legacy 面可用）。',
        hidden_by_surface: missing,
      },
    };
  }

  return {
    type: 'tool-result',
    callId: msg.callId,
    ok: true,
    result: {
      ok: true, category: cat.name, label: cat.label, tool_count: tools.length,
      rules: cat.rules, tools: tools,
      hidden_by_surface: missing.length ? missing : undefined,
    },
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
    var verdictLike = name === 'flow_verdict' || (name === 'carlos_review' && payload.action === 'verdict')
    if (verdictLike && payload.verdict === 'PASS' && res.result.isError === true &&
        stale && stale.code === 'VERIFY_STALE' && stale.expected && /^[a-f0-9]{64}$/.test(stale.expected.caseKey) &&
        context && context.session_id === payload.sessionId && context.workdir_is_local === true &&
        context.workdir_is_read_only === false && Number.isFinite(stale.expiresAt) && stale.expiresAt > Date.now()) {
      await rememberStale(msg.callId, context.session_id, stale)
    }
    // 原样透传 MCP 结果：工具自身失败用 isError 表达，宿主会按错误内容展示，
    // 这保证了「直接声明工具」与「经 call_tool 转发」两条路径的语义一致。
    return { type: 'tool-result', callId: msg.callId, ok: true, result: { mcpResult: res.result } };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function rulesOf(toolName) {
  var cat = CATEGORY_BY_TOOL[toolName];
  return cat ? cat.rules : [];
}

// KV 仅为有界展示缓存，LWW 不参与执行领取；绝不保存命令、路径、diff 或点击票。
var staleIssued = Object.create(null)
async function staleCache() {
  var response = await fetch('/kv')
  if (!response.ok) throw new Error('展示缓存未知')
  var cfg = await response.json()
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
  var issued = { callId: callId, sid: sid, caseKey: stale.expected.caseKey,
    expiresAt: stale.expiresAt, ready: false, requested: false, viewed: false, deferred: false }
  staleIssued[callId] = issued
  try {
    var cache = await staleCache()
    if (staleIssued[callId] !== issued || issued.expiresAt <= Date.now()) return
    cache.rows = cache.rows.filter(function (row) { return row.callId !== callId })
    cache.rows.push({ callId: callId, sid: sid, caseKey: issued.caseKey,
      detectedAt: stale.detectedAt, expiresAt: issued.expiresAt, requested: false, deferred: false })
    await saveStaleCache(cache)
    if (staleIssued[callId] !== issued || issued.expiresAt <= Date.now()) return
    issued.ready = true
    drawStale(callId, '检测时发现验证之后有变化；查看将请求原会话读取当前 Git 未暂存差异，非验证时快照。')
  } catch (error) {
    if (staleIssued[callId] === issued) {
      issued.ready = false
      drawStale(callId, '向导状态未知；不会自动重试，请查看原任务。', true)
    }
  }
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
  var issued = staleIssued[msg.callId]
  function bound() { return issued && staleIssued[msg.callId] === issued && issued.sid === msg.sessionId }
  function eligible() { return bound() && issued.ready && !issued.deferred && issued.expiresAt > Date.now() }
  // 无内存签发或跨会话事件不能改变真实卡，也不能从缓存恢复资格。
  if (!eligible()) return
  var viewing = msg.actionId === 'stale-view'
  var deferring = msg.actionId === 'stale-defer'
  if (!deferring && (!msg.userActionToken || (viewing ? issued.viewed : issued.requested))) return
  if (deferring) issued.deferred = true
  try {
    var cache = await staleCache()
    if (!bound() || !issued.ready || issued.expiresAt <= Date.now() || (!deferring && issued.deferred)) return
    var row = cache.rows.find(function (item) {
      return item.callId === issued.callId && item.sid === issued.sid && item.caseKey === issued.caseKey && item.expiresAt === issued.expiresAt
    })
    if (!row) throw new Error('展示绑定未知')
    // 最后一次读取后在同一同步段领取，保存失败也不回滚重放。
    if (deferring) row.deferred = true
    else if (viewing) { if (issued.viewed) return; issued.viewed = true }
    else { if (issued.requested) return; issued.requested = true; row.requested = true }
    await saveStaleCache(cache)
    if (!bound() || !issued.ready || issued.expiresAt <= Date.now() || (!deferring && issued.deferred)) return
    if (deferring) {
      drawStale(msg.callId, '已收起提示；不取消或撤回已经提交的请求。', true)
      return
    }
    var guidance = viewing ?
      '请在原会话的新活跃工具调用中先用 flow_status 核对当前卡与原验证；卡已变化或无法确认则停止。再用 flow_diff_hunks 读取真实 Git 差异，明确这是当前 Git 未暂存差异，非验证时快照。错误只能报告未知，不能说无变化；空结果不能推断未跟踪或已暂存无变化。仅输出数量与行区间的脱敏摘要，不输出原命令、路径或原始 diff。不执行验证、PASS 或 falsify。' :
      '请沿原会话权限调用 Carlos call_tool，name 为 flow_run_verify，args 使用以下 sessionId 与 expected；不得省略 expected 或失败后回退普通执行，不自动 PASS 或 falsify。'
    var result = await cindy.agent.run({ mode: 'continue', userActionToken: msg.userActionToken,
      promptTemplate: '用户选择：{{user_message}}\n' + guidance + '\n{{event_json}}',
      userMessage: viewing ? '查看当前变化' : '重新检查原验证',
      event: { sessionId: issued.sid, expected: { caseKey: issued.caseKey } },
    })
    if (!eligible()) return
    if (!result || result.ok !== true) throw new Error('继续请求未知')
    drawStale(msg.callId, '已请求原会话继续；不代表已读取差异、执行命令或检查通过。')
  } catch (error) {
    if (bound() && !issued.deferred) {
      issued.ready = false
      drawStale(msg.callId, '向导状态未知；请查看原任务，不自动重试。', true)
    } else if (bound() && deferring) {
      drawStale(msg.callId, '向导状态未知；已停止后续交互，不撤回已提交请求。', true)
    }
  }
}

cindy.onHostMessage(async function (msg) {
  if (msg && msg.type === 'event' && msg.name === 'card-action') {
    try {
      await staleAction(msg)
    } catch (error) {
      drawStale(msg.callId, '向导状态未知；请查看原任务，不自动重试。', true)
    }
    return
  }
  if (!msg || msg.type !== 'tool-call') return;
  try {
    var out;
    if (msg.tool === 'list_tools') out = await listTools(msg);
    else if (msg.tool === 'call_tool') out = await callToolRequest(msg);
    else {
      out = fail(msg, 'UNKNOWN_META_TOOL',
        '本插件提供 list_tools 与 call_tool 两段式门禁入口。');
    }
    cindy.send(out);
  } catch (e) {
    if (msg.args && msg.args.args && Object.prototype.hasOwnProperty.call(msg.args.args, 'expected')) {
      cindy.send(fail(msg, 'WIZARD_UNCERTAIN', '向导请求未确认；请查看原任务，不自动重试或回退执行。'))
      return
    }
    cindy.send(fail(msg, 'INTERNAL',
      '插件内部异常：' + (e && e.message ? e.message : String(e)) + '。可重试一次；持续失败请反馈。'));
  }
});