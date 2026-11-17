// main.js —— Carlos 工作流（chip 沙箱入口）
//
// 为什么是「两段式目录」（Cindy 插件手册 §3.5）：
// 本插件有 20 个 flow_* 操作，而宿主对 tools 声明有**硬上限 16 项**；
// 20 个端点级操作塞进去必然被拒装。手册给的解法是只声明两个元工具
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
    members: ['flow_submit_requirement', 'flow_claim', 'flow_dispatch', 'flow_verdict'],
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
    members: ['flow_run_verify', 'flow_falsify'],
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
    members: ['flow_audit_axes', 'flow_audit_submit', 'flow_audit_guard', 'flow_audit'],
  },
  {
    name: 'infra',
    label: '状态·协议·还原',
    summary: '看进度、读协议、免检、还原计划、越界自查',
    rules: [
      'flow_status 是唯一的进度真源；汇报「做到哪一步」前先读它，别凭记忆答。',
      'flow_bypass 只能在用户明确说「直接干 / 免检 / 别管流程」时开启，且每次开关都进审计流水。',
      'flow_revert_plan 只出还原计划，绝不自动执行；真正回滚要人工确认。',
      'flow_check_scope 不传 paths 时会自己跑 git diff 取当前改动，用来在裁定前自查越界。',
    ],
    members: [
      'flow_status', 'flow_protocol', 'flow_mode', 'flow_bypass', 'flow_add_user_msg',
      'flow_save_result', 'flow_revert_plan', 'flow_check_scope', 'flow_diff_hunks',
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
  var payload = callArgs || {};

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
      params: { name: name, arguments: payload },
      callId: msg.callId,
      cancelWithCall: true,
      timeoutMs: NODE_TIMEOUT_MS,
      maxTotalMs: NODE_MAX_TOTAL_MS,
    });
    if (!res || !res.ok) {
      return fail(msg, 'NODE_REQUEST_FAILED',
        '执行 ' + name + ' 时随包 Node 服务没有正常回包：' + (res && res.message ? res.message : '未知原因') +
        '。可重试一次；仍失败请检查插件是否被停用或 Node 进程被系统拦截。');
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

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  try {
    var out;
    if (msg.tool === 'list_tools') out = await listTools(msg);
    else if (msg.tool === 'call_tool') out = await callToolRequest(msg);
    else {
      out = fail(msg, 'UNKNOWN_META_TOOL',
        '本插件只提供 list_tools 与 call_tool 两个入口；具体门禁操作请走 call_tool（先用 list_tools 取操作名）。');
    }
    cindy.send(out);
  } catch (e) {
    cindy.send(fail(msg, 'INTERNAL',
      '插件内部异常：' + (e && e.message ? e.message : String(e)) + '。可重试一次；持续失败请反馈。'));
  }
});