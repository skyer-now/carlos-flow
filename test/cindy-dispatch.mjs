// chip 两段式目录（main.js）—— 分发回归测试
//
// 为什么必须有这套测试：Cindy 对 tools 声明有硬上限 16 项，本插件有 20 个操作，
// 所以改成「只声明 list_tools / call_tool，目录与分发表在 main.js」。
// 这条链路一旦断了，用户在 Cindy 里**一个门禁操作都点不到**，而 src/index.js 的单测全绿
// —— 属于典型的「实现没问题、接线断了」事故。
//
// 做法：真的起随包 MCP 服务端（src/index.js），再用一个最小 `cindy` 桩在 vm 里执行
// main.js（沙箱里只有一个全局 cindy）。这样测的是**真实链路**，不是 mock 出来的假链路。
//
// 跑法：node test/cindy-dispatch.mjs
import { webcrypto } from 'node:crypto'
import { parseTools } from '../scripts/check-no-dead-handler.mjs'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpClient } from "./_mcp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-dispatch-home-"));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const server = startMcpClient({
  entry: path.join(ROOT, "src", "index.js"),
  cwd: ROOT,
  env: { CARLOS_FLOW_HOME: HOME },
});

// ---- 最小 cindy 桩：只提供 main.js 真正用到的东西 ----
let handler = null;
const sent = [];
const cindy = {
  onHostMessage(cb) { handler = cb; },
  send(msg) { sent.push(msg); },
  node: {
    async request(req) {
      if (req.method === "tools/list") {
        const res = await server.request("tools/list", req.params || {});
        return res.error ? { ok: false, message: JSON.stringify(res.error) } : { ok: true, result: res.result };
      }
      if (req.method === "tools/call") {
        const res = await server.request("tools/call", req.params || {});
        return res.error ? { ok: false, message: JSON.stringify(res.error) } : { ok: true, result: res.result };
      }
      return { ok: false, message: "桩不支持的方法：" + req.method };
    },
  },
};

const sandbox = { cindy, setInterval, clearInterval, console };
vm.createContext(sandbox);
const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
vm.runInContext(mainSrc, sandbox, { filename: "main.js" });

let callId = 0;
async function invoke(tool, args) {
  sent.length = 0;
  callId++;
  await handler({ type: "tool-call", tool, args, callId: "c" + callId });
  return sent[sent.length - 1];
}

try {
  await server.initialize();

  check("1. main.js 注册了 tool-call 处理器", typeof handler === "function");

  // 2. 概览
  const overview = await invoke("list_tools", {});
  const ov = overview && overview.result;
  const names = (ov && ov.categories ? ov.categories.map((c) => c.name) : []).join(",");
  check("2a. list_tools 不传 category 返回概览", !!(ov && ov.categories));
  check("2b. 类目为 gate/verify/audit/infra/trigger",
    names === "gate,verify,audit,infra,trigger", names);
  const expectedNames = parseTools(fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')).map((tool) => tool.name)
  const expectedTotal = expectedNames.length
  const listed = await server.request('tools/list', {})
  check('源码与协议工具名单一致', JSON.stringify((listed.result?.tools || []).map((tool) => tool.name).sort()) === JSON.stringify(expectedNames.slice().sort()))
  check(`2c. 概览里的操作总数与源码一致（${expectedTotal}）`, ov && ov.total === expectedTotal, String(ov && ov.total));
  check("2d. 概览给出下一步提示", !!(ov && ov.hint));

  // 3. 类目下钻：必须同时给工具明细与 RULES
  const gate = await invoke("list_tools", { category: "gate" });
  const g = gate && gate.result;
  check("3a. 下钻返回该类目工具明细", !!(g && Array.isArray(g.tools) && g.tools.length >= 4),
    g ? `${g.tool_count} 个` : "");
  check("3b. 明细里带参数 schema（可直接照着填）",
    !!(g && g.tools.every((t) => t.parameters && t.parameters.type === "object")));
  check("3c. 同一份结果里下发 RULES（手册硬要求）",
    !!(g && Array.isArray(g.rules) && g.rules.length >= 2), g ? `${g.rules.length} 条` : "");
  check("3d. RULES 讲的是门禁关键约束（留痕/auditor/scope）",
    !!(g && g.rules.join(" ").includes("留痕") && g.rules.join(" ").includes("auditor")));

  // 4. 未知类目 → 可操作的错误
  const badCat = await invoke("list_tools", { category: "nope" });
  check("4a. 未知类目返回 ok:false", badCat && badCat.ok === false);
  check("4b. 错误里列出可用类目", /gate/.test(String(badCat && badCat.message)));

  // 5. call_tool 正常转发
  const proto = await invoke("call_tool", { name: "flow_protocol", args: {} });
  const protoText = proto && proto.result && proto.result.mcpResult
    && proto.result.mcpResult.content && proto.result.mcpResult.content[0]
    && proto.result.mcpResult.content[0].text;
  check("5a. call_tool 原样透传 MCP 结果（mcpResult）",
    proto && proto.ok === true && !!protoText, protoText ? `${String(protoText).length} 字符` : "");
  check("5b. 透传结果能解析出协议内容（真的跑到了服务端）",
    /ROUTE_TABLE/.test(String(protoText)));

  // 6. 未知操作名 → 附全部可用操作名 + 回查提示
  const unknown = await invoke("call_tool", { name: "flow_不存在" });
  check("6a. 未知操作返回 ok:false", unknown && unknown.ok === false);
  check(`6b. 未知操作附全部可用操作名（${expectedTotal} 个）`,
    unknown && unknown.result && Array.isArray(unknown.result.available_tools)
      && unknown.result.available_tools.length === expectedTotal,
    unknown && unknown.result ? `${unknown.result.available_tools.length} 个` : "");
  check("6c. 提示先 list_tools 回查", /list_tools/.test(String(unknown && unknown.message)));

  // 7. 缺必填参数 → 附 schema + 规则（自纠所需）
  const missing = await invoke("call_tool", { name: "flow_mode", args: {} });
  check("7a. 缺必填参数返回 ok:false", missing && missing.ok === false);
  check("7b. 错误指出缺哪个字段", /mode/.test(String(missing && missing.message)));
  check("7c. 附该操作的参数 schema", !!(missing && missing.result && missing.result.schema
    && missing.result.schema.properties && missing.result.schema.properties.mode));
  check("7d. 附所属类目 RULES", !!(missing && missing.result && Array.isArray(missing.result.rules)
    && missing.result.rules.length > 0));

  // 8. args 类型不合法
  const badArgs = await invoke("call_tool", { name: "flow_status", args: "不是对象" });
  check("8a. args 非对象时返回 ok:false 且附 schema", badArgs && badArgs.ok === false
    && !!(badArgs.result && badArgs.result.schema));

  // 9. 服务端返回的工具级失败仍被如实透传（isError 不被吞）
  const toolErr = await invoke("call_tool", { name: "flow_claim", args: { role: "executor" } });
  const mcpErr = toolErr && toolErr.ok === true && toolErr.result && toolErr.result.mcpResult;
  check("9a. 工具级错误（未留痕）如实透传 isError",
    !!(mcpErr && mcpErr.isError === true),
    mcpErr ? String((mcpErr.content || [])[0] && (mcpErr.content[0].text || "")).slice(0, 40) : "无结果");

  // 10. 非本插件的元工具调用要有明确指引
  const wrongTool = await invoke("something_else", {});
  check("10. 未知元工具返回指引（指向 call_tool）",
    wrongTool && wrongTool.ok === false && /call_tool/.test(String(wrongTool.message)));
  // VM 仅模拟 Host；按钮必须继续原 Agent，而非回调里复用旧 RPC。
  let uiHandler
  let kv = {}
  const uiSent = []
  const requests = []
  const agents = []
  let structured = { code: 'VERIFY_STALE', expected: { caseKey: 'a'.repeat(64) }, detectedAt: 1, expiresAt: Date.now() + 600000 }
  const ui = {
    cindy: {
      onHostMessage: fn => { uiHandler = fn }, send: msg => { uiSent.push(msg) },
      agent: {
        run: async args => {
          agents.push(args)
          return { ok: true }
        },
      },
      node: {
        request: async args => {
          requests.push(args)
          return {
            ok: true,
            result: args.method === 'tools/list' ? listed.result :
              { isError: true, content: [{ type: 'text', text: 'STALE 只是兼容文字' }], structuredContent: structured },
          }
        },
      },
    },
    fetch: async (url, options) => {
      if (url !== '/kv') throw new Error('非 KV 请求')
      if (options) kv = JSON.parse(options.body)
      return { ok: true, json: async () => structuredClone(kv) }
    }, setInterval, clearInterval, console,
  }
  vm.runInNewContext(mainSrc, ui)
  const issue = async id => uiHandler({
    type: 'tool-call', tool: 'call_tool', callId: id,
    args: {
      name: 'flow_verdict', args: { verdict: 'PASS', sessionId: 'ui', __ctx: { forged: true }, carlosContext: { forged: true } },
      session_context: { session_id: 'ui', workdir: '冻结目录', workdir_is_local: true, workdir_is_read_only: false },
    },
  })
  await issue('wizard')
  const card = uiSent.find(msg => msg.type === 'card-update')
  check('W8 真结构化 STALE 才供原卡且恰三按钮', card?.callId === 'wizard' && (card.html.match(/data-ghost-action=/g) || []).length === 3)
  const forwarded = requests.at(-1)
  check('W9 剥 Agent 内部字段，重铸四字段关联非授权', !forwarded.params.arguments.__ctx && !forwarded.params.arguments.carlosContext && Object.keys(forwarded.params.carlosContext).length === 4)
  structured = { ...structured, expected: { caseKey: 'b'.repeat(64) } }
  await issue('wizard-second')
  check('W15 多 case 展示不挤掉原卡归属', kv.staleWizard.length === 2 && kv.staleWizard.some(row => row.callId === 'wizard' && row.caseKey === 'a'.repeat(64)))
  const before = requests.length
  await uiHandler({ type: 'event', name: 'card-action', callId: 'wizard', sessionId: 'ui', actionId: 'stale-view' })
  await uiHandler({ type: 'event', name: 'card-action', callId: 'wizard', sessionId: 'ui', actionId: 'stale-defer' })
  check('W10 无票查看与收起均零 Node/Agent，收起终止交互', requests.length === before && agents.length === 0)
  await uiHandler({ type: 'event', name: 'card-action', callId: 'wizard', sessionId: 'other', actionId: 'stale-retry', userActionToken: '票' })
  check('W11 跨会话 callback 不续接', agents.length === 0)
  await uiHandler({ type: 'event', name: 'card-action', callId: 'wizard-second', sessionId: 'ui', actionId: 'stale-retry', userActionToken: '真实点击票' })
  await uiHandler({ type: 'event', name: 'card-action', callId: 'wizard-second', sessionId: 'ui', actionId: 'stale-defer' })
  check('W12 真票 continue 且收起不撤回，不复用 RPC', agents.length === 1 && agents[0].mode === 'continue' && requests.length === before)
  check('W13 缓存白名单无路径/点击票/命令', !JSON.stringify(kv).includes('冻结目录') && !JSON.stringify(kv).includes('真实点击票'))
  structured = undefined
  const cardsBefore = uiSent.filter(msg => msg.type === 'card-update').length
  await issue('keyword-only')
  check('W14 STALE 关键词不能误供卡', uiSent.filter(msg => msg.type === 'card-update').length === cardsBefore)

  // 设置页加载与保存测试
  const settingsSource = fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8')
  async function page() {
    const nodes = new Map(); const fetches = []
    const get = key => { if (!nodes.has(key)) nodes.set(key, { hidden: true, value: '', style: {}, dataset: {}, setAttribute() {} }); return nodes.get(key) }
    vm.runInNewContext(settingsSource, {
      location: { search: '' }, URLSearchParams, console,
      document: { querySelector: get, querySelectorAll: () => [] },
      fetch: async (url, options) => { fetches.push({ url, options }); return { ok: true, json: async () => ({}) } },
    })
    await new Promise(resolve => setImmediate(resolve))
    return { nodes, fetches }
  }
  const settingsPage = await page()
  await settingsPage.nodes.get('#save').onclick()
  check('F18 原设置加载保存回归', settingsPage.fetches[0].url === '/config' && settingsPage.fetches.at(-1).options.method === 'PUT' && settingsPage.nodes.get('#settings-shell').hidden === false)

  // P5 新文件授权（new_files）门禁层用例：
  //    「派发时尚不存在的新文件」必须走**独立字段**精确授权，
  //    缺确认 / 缺授权说明 / 路径非法 / 越界 / 已存在 / 父目录不存在 → 一律拒绝且不落卡。
  const nfRepo = path.join(HOME, 'newfile-project');
  fs.mkdirSync(nfRepo, { recursive: true });
  fs.writeFileSync(path.join(nfRepo, 'existing.txt'), 'original\n');
  // 存在但**不在 scope** 里的文件：用于「已存在文件请放入 scope」的用例
  fs.writeFileSync(path.join(nfRepo, 'other-existing.txt'), 'original\n');
  fs.mkdirSync(path.join(nfRepo, 'sub'), { recursive: true });
  const nfCall = async (name, args) => {
    const res = await server.request('tools/call', { name, arguments: args });
    const text = String(res.result?.content?.[0]?.text || '');
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    return { isError: res.result?.isError === true, payload, text };
  };
  const NF_QUOTE = '新建一个测试文件';
  const nfBase = (sid, extra = {}) => ({
    sessionId: sid,
    goal: '新建测试文件',
    quote: NF_QUOTE,
    scope: ['existing.txt'],
    cwd: nfRepo,
    ...extra,
  });
  const nfCases = [
    ['缺确认', { confirmed: false, newFiles: ['new-a.txt'], newFilesReason: '用户同意新建' }, /确认/],
    ['缺授权说明', { confirmed: true, newFiles: ['new-a.txt'] }, /授权说明/],
    ['路径非法', { confirmed: true, newFiles: [123], newFilesReason: '用户同意新建' }, /类型错误|无效路径/],
    ['路径越界', { confirmed: true, newFiles: ['../escape.txt'], newFilesReason: '用户同意新建' }, /仓库/],
    ['绝对路径越界', { confirmed: true, newFiles: ['C:/Windows/win.ini'], newFilesReason: '用户同意新建' }, /相对路径|仓库/],
    ['已存在文件', { confirmed: true, newFiles: ['other-existing.txt'], newFilesReason: '用户同意新建' }, /已存在/],
    ['已存在目录', { confirmed: true, newFiles: ['sub'], newFilesReason: '用户同意新建' }, /目录/],
    ['父目录不存在', { confirmed: true, newFiles: ['missing-dir/new-b.txt'], newFilesReason: '用户同意新建' }, /父目录/],
  ];
  for (const [label, extra, matcher] of nfCases) {
    const sid = 'nf-' + Date.now() + '-' + label;
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    const res = await nfCall('flow_submit_requirement', nfBase(sid, extra));
    const reason = String(res.payload?.reason || res.text || '');
    // 拒绝有两种形态：MCP 层参数校验报错（isError）或业务层返回 ok:false。
    const rejected = res.isError === true || res.payload?.ok === false;
    check(`P5 ${label}：拒绝新文件授权`, rejected && matcher.test(reason), reason.slice(0, 90));
    const st = await nfCall('flow_status', { sessionId: sid });
    check(`P5 ${label}：拒绝后不落卡`, st.payload?.has_card === false, JSON.stringify(st.payload?.has_card));
  }
  // 与 scope 重复的路径同样拒绝
  {
    const sid = 'nf-dup-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    const res = await nfCall('flow_submit_requirement', nfBase(sid, { confirmed: true, newFiles: ['existing.txt'], newFilesReason: '用户同意新建' }));
    check('P5 与 scope 重复：拒绝新文件授权', res.payload?.ok === false && /重复|已存在/.test(String(res.payload?.reason || '')), String(res.payload?.reason || '').slice(0, 90));
    const st = await nfCall('flow_status', { sessionId: sid });
    check('P5 与 scope 重复：拒绝后不落卡', st.payload?.has_card === false);
  }
  // 合法登记：可落卡，且派发快照按「派发时不存在」记录（created:true）
  {
    const sid = 'nf-ok-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    // 授权说明必须能在**用户原话**中定位（与 quote 同级锚定）：
    // 自述 confirmed 不算数 —— 说明得真的出现在用户说过的话里。
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 new-ok.txt' });
    const res = await nfCall('flow_submit_requirement', nfBase(sid, { confirmed: true, newFiles: ['new-ok.txt'], newFilesReason: '用户原话：允许新建 new-ok.txt' }));
    check('P5 合法新文件授权：可落卡且写入 new_files',
      res.payload?.ok === true && Array.isArray(res.payload?.card?.new_files) && res.payload.card.new_files.includes('new-ok.txt'),
      JSON.stringify(res.payload?.card?.new_files || res.payload?.reason || ''));
    await nfCall('flow_claim', { sessionId: sid, role: 'executor' });
    const d = await nfCall('flow_dispatch', { sessionId: sid, role: 'executor', run: false, cwd: nfRepo });
    const snap = d.payload?.snapshot || [];
    const entry = snap.find((e) => String(e.orig || '').replace(/\\/g, '/').endsWith('new-ok.txt'));
    check('P5 合法新文件授权：快照按「派发时不存在」记录',
      d.payload?.ok === true && !!entry && entry.created === true && !entry.backup,
      JSON.stringify(entry || d.payload?.reason || ''));
    // 派发合同 prompt 的「任务边界」必须列出获授权的新文件：
    // 执行者只看得到 prompt，看不到卡片字段 —— 不列出来就等于没授权。
    const promptText = String(d.payload?.prompt || '');
    check('P5 派发合同 prompt 的任务边界列出获授权的新文件',
      /获授权新建文件/.test(promptText) && /new-ok\.txt/.test(promptText),
      promptText.split('\n').filter((l) => l.includes('boundaries')).join(' | ').slice(0, 160));
  }

  // 授权说明无法在用户原话中定位 → 拒绝（不能只靠自述 confirmed）
  {
    const sid = 'nf-noanchor-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    const res = await nfCall('flow_submit_requirement', nfBase(sid, {
      confirmed: true,
      newFiles: ['new-noanchor.txt'],
      newFilesReason: '用户同意新建 new-noanchor.txt',
    }));
    check('P5 授权说明无法在用户原话中定位：拒绝落卡',
      res.payload?.ok === false && /原话|锚定/.test(String(res.payload?.reason || '')),
      String(res.payload?.reason || '').slice(0, 120));
    const st = await nfCall('flow_status', { sessionId: sid });
    check('P5 授权说明无法在用户原话中定位：拒绝后不落卡', st.payload?.has_card === false);
  }

  // 卡片层校验不依赖可选参数：缺仓库根上下文时按保守口径拒绝
  {
    const { validateCard } = await import('../src/card.js');
    const noRoot = validateCard({
      goal: '新建文件', quote: '新建一个测试文件', scope: ['existing.txt'],
      new_files: ['card-layer-new.txt'], new_files_reason: '用户原话：允许新建',
    }, { userMessages: ['新建一个测试文件'] });
    check('P5 卡片层缺仓库根上下文：按保守口径拒绝',
      noRoot.ok === false && /仓库根/.test(String(noRoot.reason || '')),
      String(noRoot.reason || '').slice(0, 120));
    const withRoot = validateCard({
      goal: '新建文件', quote: '新建一个测试文件', scope: ['existing.txt'],
      new_files: ['card-layer-new.txt'], new_files_reason: '用户原话：允许新建',
    }, { userMessages: ['新建一个测试文件'], repoRoot: nfRepo });
    check('P5 卡片层有仓库根上下文：结构合法即通过', withRoot.ok === true, String(withRoot.reason || ''));
  }

  // appendScope 分支：同样可追加新文件授权（确认 + 授权说明缺一不可）
  {
    const sid = 'nf-append-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    // 追加的授权说明同样必须能在用户原话中定位
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 appended-new.txt' });
    await nfCall('flow_submit_requirement', nfBase(sid));
    await nfCall('flow_claim', { sessionId: sid, role: 'executor' });
    await nfCall('flow_dispatch', { sessionId: sid, role: 'executor', run: false, cwd: nfRepo });
    const before = await nfCall('flow_status', { sessionId: sid });
    // 缺新文件授权说明 → 拒绝（带上了 appendScope 的 reason，只缺 newFilesReason）
    const noReason = await nfCall('flow_submit_requirement', {
      sessionId: sid, cwd: nfRepo, confirmed: true, appendScope: ['existing.txt'],
      reason: '用户原话：追加范围',
      newFiles: ['appended-new.txt'],
    });
    check('P5 追加新文件：缺授权说明被拒',
      (noReason.isError === true || noReason.payload?.ok === false)
        && /newFilesReason|授权说明/.test(String(noReason.payload?.reason || noReason.text || '')),
      String(noReason.payload?.reason || noReason.text || '').slice(0, 90));
    // 缺确认 → 拒绝
    const noConfirm = await nfCall('flow_submit_requirement', {
      sessionId: sid, cwd: nfRepo, appendScope: ['existing.txt'],
      reason: '用户原话：追加范围',
      newFiles: ['appended-new.txt'], newFilesReason: '用户同意新建',
    });
    check('P5 追加新文件：缺确认被拒',
      noConfirm.isError === true || noConfirm.payload?.ok === false,
      String(noConfirm.payload?.reason || noConfirm.text || '').slice(0, 90));
    // 合法追加 → 卡片带上新文件授权，且既有派发次数不变
    const appended = await nfCall('flow_submit_requirement', {
      sessionId: sid, cwd: nfRepo, confirmed: true, appendScope: ['existing.txt'],
      newFiles: ['appended-new.txt'], newFilesReason: '用户原话：允许新建 appended-new.txt',
      reason: '用户原话：追加范围',
    });
    check('P5 追加新文件：合法追加成功',
      appended.payload?.ok === true && Array.isArray(appended.payload?.added_new_files)
        && appended.payload.added_new_files.includes('appended-new.txt'),
      JSON.stringify(appended.payload?.added_new_files || appended.payload?.reason || appended.text || '').slice(0, 140));
    const after = await nfCall('flow_status', { sessionId: sid });
    check('P5 追加新文件：既有派发次数保持不变',
      after.payload?.dispatch_count === before.payload?.dispatch_count,
      `before=${before.payload?.dispatch_count} after=${after.payload?.dispatch_count}`);
    const st = await nfCall('flow_status', { sessionId: sid });
    check('P5 追加新文件：卡片 new_files 含追加项',
      Array.isArray(st.payload?.card?.new_files) && st.payload.card.new_files.includes('appended-new.txt'),
      JSON.stringify(st.payload?.card?.new_files || []));
    // 追加的新文件必须**补记快照**（created:true）：
    // 否则负对照的「改动前态」删不掉它 → 负对照变成 vacuous（空测试）。
    const manifestPath = path.join(HOME, 'gate-state', 'runs', sid, 'backup', 'manifest.jsonl');
    let appendedEntry = null;
    try {
      const lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      appendedEntry = lines.find((e) => String(e.orig || '').replace(/\\/g, '/').endsWith('appended-new.txt'));
    } catch (e) { /* 没读到就不算通过 */ }
    check('P5 追加新文件：补记快照（created:true）',
      !!appendedEntry && appendedEntry.created === true,
      JSON.stringify(appendedEntry || 'manifest 无该条目'));
  }

  // 负对照失败必须**作废**既有 last_falsify（不得沿用旧结论放行 PASS）
  {
    const sid = 'nf-falsify-' + Date.now();
    const verifyCmd = 'node -e "const c=require(\'fs\').readFileSync(\'existing.txt\',\'utf8\');process.exit(c.includes(\'changed\')?0:1)"';
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_submit_requirement', nfBase(sid, { verify: { cmd: verifyCmd } }));
    await nfCall('flow_claim', { sessionId: sid, role: 'executor' });
    await nfCall('flow_dispatch', { sessionId: sid, role: 'executor', run: false, cwd: nfRepo });
    fs.writeFileSync(path.join(nfRepo, 'existing.txt'), 'changed by agent\n', 'utf8');
    const f1 = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    check('P5 负对照失败作废：先拿到一次 meaningful 结论', f1.payload?.verdict === 'meaningful',
      String(f1.payload?.verdict || f1.payload?.reason || '').slice(0, 90));
    // 把快照的备份路径指向不存在的文件 → 下一次负对照必然还原失败
    const manifestPath = path.join(HOME, 'gate-state', 'runs', sid, 'backup', 'manifest.jsonl');
    try {
      const lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      for (const e of lines) if (e.backup) e.backup = path.join(nfRepo, 'no-such-backup.bin');
      fs.writeFileSync(manifestPath, lines.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch { /* 改不动就跳过后面的断言 */ }
    const f2 = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    check('P5 负对照失败作废：本次负对照如实失败', f2.payload?.ok === false || f2.isError === true,
      String(f2.payload?.reason || f2.text || '').slice(0, 90));
    let stateJson = null;
    try {
      stateJson = JSON.parse(fs.readFileSync(path.join(HOME, 'gate-state', 'runs', sid, 'state.json'), 'utf8'));
    } catch { /* 读不到就不算通过 */ }
    check('P5 负对照失败作废：既有 last_falsify 被清空（不得沿用旧结论）',
      !!stateJson && stateJson.last_falsify === null,
      stateJson ? JSON.stringify(stateJson.last_falsify || null).slice(0, 90) : '读不到 state.json');
    fs.writeFileSync(path.join(nfRepo, 'existing.txt'), 'original\n', 'utf8');
  }

  // 负对照**抛异常**的路径同样必须作废既有 last_falsify。
  // 旧实现只在「负对照返回失败」时作废；抛异常时直接 fail()，旧的 meaningful 结论仍在。
  {
    const sid = 'nf-falsify-throw-' + Date.now();
    const verifyCmd = 'node -e "const c=require(\'fs\').readFileSync(\'existing.txt\',\'utf8\');process.exit(c.includes(\'changed\')?0:1)"';
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_submit_requirement', nfBase(sid, { verify: { cmd: verifyCmd } }));
    await nfCall('flow_claim', { sessionId: sid, role: 'executor' });
    await nfCall('flow_dispatch', { sessionId: sid, role: 'executor', run: false, cwd: nfRepo });
    fs.writeFileSync(path.join(nfRepo, 'existing.txt'), 'changed by agent\n', 'utf8');
    const f1 = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    check('P6 负对照异常作废：先拿到一次 meaningful 结论', f1.payload?.verdict === 'meaningful',
      String(f1.payload?.verdict || f1.payload?.reason || '').slice(0, 90));
    // 把卡片登记的项目目录指向不存在的路径 → 负对照内部抛异常
    const statePath = path.join(HOME, 'gate-state', 'runs', sid, 'state.json');
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      st.card.env = { ...(st.card.env || {}), project: path.join(nfRepo, 'no-such-dir-xyz') };
      fs.writeFileSync(statePath, JSON.stringify(st), 'utf8');
    } catch { /* 改不动就跳过后面的断言 */ }
    const f2 = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    check('P6 负对照异常作废：本次负对照如实失败', f2.payload?.ok === false || f2.isError === true,
      String(f2.payload?.reason || f2.text || '').slice(0, 90));
    let stateJson = null;
    try {
      stateJson = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch { /* 读不到就不算通过 */ }
    check('P6 负对照异常作废：既有 last_falsify 被清空（不得沿用旧结论）',
      !!stateJson && stateJson.last_falsify === null,
      stateJson ? JSON.stringify(stateJson.last_falsify || null).slice(0, 90) : '读不到 state.json');
    fs.writeFileSync(path.join(nfRepo, 'existing.txt'), 'original\n', 'utf8');
  }

  // 卡片层：父目录是 junction / 符号链接且指向仓库外 → 必须拒绝授权
  {
    const { validateNewFiles } = await import('../src/card.js');
    const junctionRepo = path.join(HOME, 'junction-repo');
    const outsideDir = path.join(HOME, 'junction-outside');
    fs.mkdirSync(junctionRepo, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(junctionRepo, 'keep.txt'), 'x\n');
    let linked = false;
    try {
      fs.symlinkSync(outsideDir, path.join(junctionRepo, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch { linked = false; }
    if (!linked) {
      console.log('  · 跳过 junction 逃逸用例（本机不允许创建目录链接）');
    } else {
      const escaped = validateNewFiles(
        ['escape/new.txt'],
        ['keep.txt'],
        junctionRepo,
        { confirmed: true, reason: '用户原话：允许新建', anchor: false },
      );
      check('P6 junction 逃逸：父目录指向仓库外时拒绝授权',
        escaped.ok === false && /仓库之外|真实路径|符号链接|junction/.test(String(escaped.reason || '')),
        String(escaped.reason || '').slice(0, 120));
      // 对照：根内的普通路径仍然可以授权
      const inside = validateNewFiles(
        ['new-ok.txt'],
        ['keep.txt'],
        junctionRepo,
        { confirmed: true, reason: '用户原话：允许新建', anchor: false },
      );
      check('P6 junction 逃逸：根内普通路径仍可授权',
        inside.ok === true,
        String(inside.reason || '').slice(0, 120));
    }
  }

  // 授权列表**内部**出现重复路径 → 必须拒绝。
  // 同一份授权里出现同一条路径（写法不同也算同一条）会让「授权了几条」与
  // 「快照覆盖了哪些文件」两处口径对不上，事后无法回答「这条文件被哪条授权覆盖」。
  {
    const dupCases = [
      ['同路径不同写法', ['dup-inner-a.txt', './dup-inner-a.txt']],
      ['分隔符写法不同', ['sub/dup-inner-b.txt', 'sub\\dup-inner-b.txt']],
    ];
    for (const [label, files] of dupCases) {
      const sid = 'nf-dupinner-' + Date.now() + '-' + label;
      const reasonText = '用户原话：允许新建 ' + files.join('、');
      await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
      await nfCall('flow_add_user_msg', { sessionId: sid, text: reasonText });
      const res = await nfCall('flow_submit_requirement', nfBase(sid, {
        confirmed: true, newFiles: files, newFilesReason: reasonText,
      }));
      const reason = String(res.payload?.reason || res.text || '');
      check(`P6 授权列表内重复路径（${label}）：拒绝`,
        res.payload?.ok === false && /重复/.test(reason), reason.slice(0, 100));
      const st = await nfCall('flow_status', { sessionId: sid });
      check(`P6 授权列表内重复路径（${label}）：拒绝后不落卡`,
        st.payload?.has_card === false, JSON.stringify(st.payload?.has_card));
    }
  }

  // 大小写语义按**当前平台**取期望值（不得写死 win32）：
  //   · win32 大小写不敏感 → 'case-x.txt' 与 'CASE-X.TXT' 是同一条授权 → 必须拒绝；
  //   · POSIX 大小写敏感 → 两个不同文件 → 不算重复（放过它们不是放宽，是正确口径）。
  {
    const sid = 'nf-case-' + Date.now();
    const reasonText = '用户原话：允许新建 case-x.txt、CASE-X.TXT';
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_add_user_msg', { sessionId: sid, text: reasonText });
    const res = await nfCall('flow_submit_requirement', nfBase(sid, {
      confirmed: true, newFiles: ['case-x.txt', 'CASE-X.TXT'], newFilesReason: reasonText,
    }));
    const reason = String(res.payload?.reason || res.text || '');
    if (process.platform === 'win32') {
      check('P6 大小写语义（win32）：大小写不同的同一路径按重复拒绝',
        res.payload?.ok === false && /重复/.test(reason), reason.slice(0, 100));
    } else {
      check('P6 大小写语义（POSIX）：大小写不同的两个文件不算重复',
        res.payload?.ok === true, reason.slice(0, 100));
    }
  }

  // 负对照「作废旧结论」这一步失败时，必须**失败关闭**。
  // 旧实现：作废写不进去 → 异常冒泡 → 旧 meaningful 结论仍在状态里 → 仍能支撑 PASS。
  // 现在：作废失败会落一个持久标记（不依赖状态锁），裁定闸看到标记一律拒 PASS。
  {
    const sid = 'nf-falsify-invalidate-fail-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_submit_requirement', nfBase(sid, {
      verify: { cmd: 'node -e "process.exit(0)"' },
    }));
    const sessionDir = path.join(HOME, 'gate-state', 'runs', sid);
    const lockFile = path.join(sessionDir, '.state.lock');
    const markerFile = path.join(sessionDir, 'falsify_invalidation_failed.json');
    // 模拟「状态锁被占住」：锁文件持有者是本进程（存活）→ 服务端拿不到锁 → 写状态失败。
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid) + '\nheld-by-test\n', 'utf8');
    const f = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    const freason = String(f.payload?.reason || f.text || '');
    check('P6 作废失败：负对照如实失败并说明旧结论未能作废',
      (f.isError === true || f.payload?.ok === false) && /未能作废/.test(freason),
      freason.slice(0, 140));
    check('P6 作废失败：落下「不可 PASS」的持久标记',
      fs.existsSync(markerFile),
      fs.existsSync(markerFile) ? '标记已落盘' : '标记缺失');
    // 锁放开后再做一次负对照：这次作废成功 → 标记必须撤销。
    try { fs.unlinkSync(lockFile); } catch {}
    await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    check('P6 作废失败：作废成功后标记被撤销',
      !fs.existsSync(markerFile),
      fs.existsSync(markerFile) ? '标记仍在' : '标记已撤销');
  }

  // 负对照「作废旧结论」失败，且**「不可 PASS」标记也写不进去**时：
  // 必须失败关闭 —— 既不得放行旧结论支撑 PASS，也不得谎称「已标记不可 PASS」。
  //
  // 制造方式：① 占住状态锁 → 写状态失败（作废写不进去）；
  //           ② 在标记路径上放一个**目录** → 标记文件写不进去。
  {
    const sid = 'nf-falsify-marker-fail-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_submit_requirement', nfBase(sid, {
      verify: { cmd: 'node -e "process.exit(1)"' },
    }));
    const sessionDir = path.join(HOME, 'gate-state', 'runs', sid);
    const lockFile = path.join(sessionDir, '.state.lock');
    const markerFile = path.join(sessionDir, 'falsify_invalidation_failed.json');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid) + '\nheld-by-test\n', 'utf8');
    // 标记路径被一个目录占住 → 标记文件写不进去
    fs.mkdirSync(markerFile, { recursive: true });
    const f = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    const freason = String(f.payload?.reason || f.text || '');
    check('P6 标记写不进去：负对照如实失败（不得谎称已作废）',
      (f.isError === true || f.payload?.ok === false) && /未能作废/.test(freason),
      freason.slice(0, 180));
    check('P6 标记写不进去：如实报告标记写不进去（不得声称已标记不可 PASS）',
      /写不进去|写入失败/.test(freason) && !/已被标记为不可 PASS/.test(freason),
      freason.slice(0, 180));
    // 旧结论不得支撑 PASS：裁定必须因「作废失败」被拒（而不是被别的闸门碰巧拦住）。
    const v = await nfCall('flow_verdict', { sessionId: sid, verdict: 'PASS', notes: '旧结论还想支撑 PASS' });
    const vreason = String(v.payload?.reason || v.text || '');
    check('P6 标记写不进去：旧结论不得支撑 PASS（裁定被拒且理由指向作废失败）',
      (v.isError === true || v.payload?.ok === false) && /未能作废/.test(vreason),
      vreason.slice(0, 180));
    try { fs.unlinkSync(lockFile); } catch {}
    try { fs.rmSync(markerFile, { recursive: true, force: true }); } catch {}
  }

  // 负对照成功、但旧的「不可 PASS」标记**清不掉**时：必须如实报告，不得静默吞掉。
  // 静默吞掉的后果：标记会一直挡着 PASS，而用户重跑负对照也清不掉（像门禁坏了）。
  {
    const sid = 'nf-falsify-marker-clear-fail-' + Date.now();
    const target = 'falsify-clear-' + Date.now() + '.txt';
    fs.writeFileSync(path.join(nfRepo, target), 'before\n');
    const verifyCmd = `node -e "process.exit(require('fs').readFileSync('${target}','utf8').includes('after')?0:1)"`;
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_submit_requirement', nfBase(sid, {
      scope: [target], verify: { cmd: verifyCmd },
    }));
    const sessionDir = path.join(HOME, 'gate-state', 'runs', sid);
    const markerFile = path.join(sessionDir, 'falsify_invalidation_failed.json');
    fs.mkdirSync(sessionDir, { recursive: true });
    // 标记路径被一个目录占住 → unlink 失败（标记清不掉）
    fs.mkdirSync(markerFile, { recursive: true });
    await nfCall('flow_claim', { sessionId: sid, role: 'executor' });
    await nfCall('flow_dispatch', { sessionId: sid, role: 'executor', run: false, cwd: nfRepo });
    fs.writeFileSync(path.join(nfRepo, target), 'after\n');
    const f = await nfCall('flow_falsify', { sessionId: sid, cwd: nfRepo });
    const note = String(f.payload?.note || '');
    check('P6 标记清不掉：负对照跑完但如实报告清除失败',
      f.payload?.ok === true && /标记清除失败/.test(note),
      `verdict=${f.payload?.verdict} note=${note.slice(0, 140)}`);
    check('P6 标记清不掉：标记仍在（未假装已撤销）',
      fs.existsSync(markerFile),
      fs.existsSync(markerFile) ? '标记仍在' : '标记不见了');
    try { fs.rmSync(markerFile, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(nfRepo, target), { force: true }); } catch {}
  }

  // appendScope 追加授权：旧文件的授权说明不得被新说明覆盖（逐文件保留）
  {
    const sid = 'nf-append-reason-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 reason-a.txt' });
    await nfCall('flow_submit_requirement', nfBase(sid, {
      confirmed: true,
      newFiles: ['reason-a.txt'],
      newFilesReason: '用户原话：允许新建 reason-a.txt',
    }));
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 reason-b.txt' });
    const appended = await nfCall('flow_submit_requirement', {
      sessionId: sid, cwd: nfRepo, confirmed: true, appendScope: ['existing.txt'],
      reason: '用户原话：追加范围',
      newFiles: ['reason-b.txt'], newFilesReason: '用户原话：允许新建 reason-b.txt',
    });
    check('P6 追加授权：成功追加新文件',
      appended.payload?.ok === true && (appended.payload?.added_new_files || []).includes('reason-b.txt'),
      JSON.stringify(appended.payload?.added_new_files || appended.payload?.reason || '').slice(0, 120));
    const st = await nfCall('flow_status', { sessionId: sid });
    const card = st.payload?.card || {};
    const reasons = card.new_files_reasons || {};
    check('P6 追加授权：旧文件的授权说明未被覆盖',
      reasons['reason-a.txt'] === '用户原话：允许新建 reason-a.txt',
      JSON.stringify(reasons).slice(0, 140));
    check('P6 追加授权：新文件的授权说明被记录',
      reasons['reason-b.txt'] === '用户原话：允许新建 reason-b.txt',
      JSON.stringify(reasons).slice(0, 140));
  }

  // cardText 里的 new_files 与参数 newFiles 同时给 → 必须显式拒绝（不得静默丢弃其中一份）
  {
    const sid = 'nf-conflict-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    // 两份说明都在用户原话里：旧实现会**静默取参数那份**并落卡，
    // 新实现必须显式报冲突（不得丢一份授权依据）。
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 from-cardtext.txt' });
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 from-param.txt' });
    const cardText = 'FLOW_CARD:' + JSON.stringify({
      goal: '新建测试文件',
      quote: NF_QUOTE,
      scope: ['existing.txt'],
      new_files: ['from-cardtext.txt'],
      new_files_reason: '用户原话：允许新建 from-cardtext.txt',
      acceptance: ['x'],
      verify: { cmd: 'node -e \"process.exit(0)\"' },
    });
    const res = await nfCall('flow_submit_requirement', {
      sessionId: sid, cwd: nfRepo, confirmed: true,
      cardText,
      newFiles: ['from-param.txt'],
      newFilesReason: '用户原话：允许新建 from-param.txt',
    });
    const rejected = res.isError === true || res.payload?.ok === false;
    check('P6 冲突拒绝：cardText 的 new_files 与参数 newFiles 同时给时显式拒绝',
      rejected && /冲突/.test(String(res.payload?.reason || res.text || '')),
      String(res.payload?.reason || res.text || '').slice(0, 120));
    const st = await nfCall('flow_status', { sessionId: sid });
    check('P6 冲突拒绝：拒绝后不落卡', st.payload?.has_card === false,
      JSON.stringify(st.payload?.has_card));
  }

  // cardText 的 new_files_reason 与参数 newFilesReason 同时给（内容不同）→ 同样显式拒绝
  {
    const sid = 'nf-conflict-reason-' + Date.now();
    await nfCall('flow_add_user_msg', { sessionId: sid, text: NF_QUOTE });
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 conflict-r.txt' });
    await nfCall('flow_add_user_msg', { sessionId: sid, text: '用户原话：允许新建 conflict-r2.txt' });
    const cardText = 'FLOW_CARD:' + JSON.stringify({
      goal: '新建测试文件',
      quote: NF_QUOTE,
      scope: ['existing.txt'],
      new_files: ['conflict-r.txt'],
      new_files_reason: '用户原话：允许新建 conflict-r.txt',
      acceptance: ['x'],
      verify: { cmd: 'node -e \"process.exit(0)\"' },
    });
    const res = await nfCall('flow_submit_requirement', {
      sessionId: sid, cwd: nfRepo, confirmed: true,
      cardText,
      newFilesReason: '用户原话：允许新建 conflict-r2.txt',
    });
    const rejected = res.isError === true || res.payload?.ok === false;
    check('P6 冲突拒绝：cardText 的 new_files_reason 与参数 newFilesReason 同时给时显式拒绝',
      rejected && /冲突/.test(String(res.payload?.reason || res.text || '')),
      String(res.payload?.reason || res.text || '').slice(0, 120));
  }

} finally {
  await server.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("CINDY_DISPATCH_OK");