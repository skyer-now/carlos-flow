// 端到端验收脚本（跨平台）：验证本轮全部修复的真实行为
// 覆盖：P0-1 acceptance 伪填充 / P0-2 config 深合并 / T-30 中文词表 / T-29 MCP 触发 / 插件
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const HOME = mkdtempSync(join(tmpdir(), "carlos-e2e-"));

let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; results.push(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

console.log(`端到端验收 · ${REPO}`);
console.log(`临时 CARLOS_FLOW_HOME: ${HOME}\n`);

// 关键：把 CARLOS_FLOW_HOME 写回**当前进程**环境 ——
// 插件（chat.message 钩子）会 spawn 自己的 MCP server 进程，
// 它继承的是当前进程的环境；不设的话插件会写到用户真实的 ~/.carlos-flow。
process.env.CARLOS_FLOW_HOME = HOME;

// ---- 启动 MCP server ----
const child = spawn(process.execPath, [join(REPO, "src", "index.js")], {
  env: { ...process.env, CARLOS_FLOW_HOME: HOME },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "", stderr = "";
const pending = new Map();
let id = 1;
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
child.stderr.on("data", (d) => { stderr += d.toString(); });
const req = (method, params) => new Promise((r) => {
  const rid = id++; pending.set(rid, r);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); r({ error: "TIMEOUT " + method }); } }, 20000);
});
const call = async (name, args) => {
  const r = await req("tools/call", { name, arguments: args });
  const t = r?.result?.content?.[0]?.text || "{}";
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
check("MCP server 启动", stderr.includes("connected"), stderr.slice(-60).trim());

// ---- 1. 工具数 ----
const list = await req("tools/list", {});
check("15 个工具（含 flow_trigger_check）", (list.result?.tools || []).length === 15,
  `实际 ${(list.result?.tools || []).length}`);

// ---- 2. T-29: MCP 路径自动触发（中文）----
const sidZh = "e2e-zh-" + Date.now();
let r = await call("flow_trigger_check", { sessionId: sidZh, message: "走门禁流程，执行 dispatch 任务" });
check("T-29 中文流程消息自动激活", r.activated === true && r.has_card === true,
  `decision=${r.decision} score=${r.score}`);
r = await call("flow_status", { sessionId: sidZh });
check("T-29 激活后进入门禁态（待补三项）",
  (r.activation_pending || []).length === 3, JSON.stringify(r.activation_pending));
const claimRes = await req("tools/call", { name: "flow_claim", arguments: { sessionId: sidZh, role: "executor" } });
check("T-29 补齐前 claim 被闸门拦住", !!claimRes.result?.isError,
  (claimRes.result?.content?.[0]?.text || "").slice(0, 50));

// ---- 3. T-30: 普通中文需求不误触发 ----
const sidNs = "e2e-ns-" + Date.now();
r = await call("flow_trigger_check", { sessionId: sidNs, message: "给登录接口加一个参数校验" });
check("T-30 普通中文需求不触发", r.decision === "ignore" && r.activated !== true,
  `decision=${r.decision} score=${r.score}`);
r = await call("flow_status", { sessionId: sidNs });
check("T-30 未触发时不开卡", r.has_card === false);

// ---- 4. T-30: 英文仍能触发 ----
const sidEn = "e2e-en-" + Date.now();
r = await call("flow_trigger_check", { sessionId: sidEn, message: "run dispatch workflow" });
check("T-30 英文流程消息仍能触发", r.activated === true, `score=${r.score}`);

// ---- 5. P0-1: acceptance 伪填充被拒（cross_module 档）----
const fakeCases = [[""], [null], [0], [{}], ["", "  "]];
let allRejected = true;
const det = [];
for (const acc of fakeCases) {
  const sid = "e2e-fake-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  await call("flow_add_user_msg", { sessionId: sid, text: "quote here" });
  const rr = await call("flow_submit_requirement", {
    sessionId: sid, goal: "伪填充", quote: "quote here",
    scope: [join(REPO, "README.md"), join(REPO, "src", "index.js")],
    files: [{ path: join(REPO, "README.md"), line: 1 }, { path: join(REPO, "src", "index.js"), line: 1 }],
    acceptance: acc, confirmed: true,
  });
  if (rr.ok !== false) { allRejected = false; det.push(JSON.stringify(acc) + "→接受"); }
}
check("P0-1 acceptance 五种伪填充全部被拒", allRejected, det.join("; ") || "5/5 拒绝");

// 合法 acceptance 不被误伤
const sidGood = "e2e-good-" + Date.now();
await call("flow_add_user_msg", { sessionId: sidGood, text: "quote here" });
r = await call("flow_submit_requirement", {
  sessionId: sidGood, goal: "合法", quote: "quote here",
  scope: [join(REPO, "README.md"), join(REPO, "src", "index.js")],
  files: [{ path: join(REPO, "README.md"), line: 1 }, { path: join(REPO, "src", "index.js"), line: 1 }],
  acceptance: ["README 首行改成中文标题"], confirmed: true,
});
check("P0-1 合法 acceptance 不被误伤", r.ok === true, `tier=${r.tier}`);

// ---- 6. P0-2: config 深合并（独立进程）----
const cfgHome = mkdtempSync(join(tmpdir(), "carlos-cfg-"));
mkdirSync(cfgHome, { recursive: true });
writeFileSync(join(cfgHome, "trigger-config.json"), JSON.stringify({
  keywordWeights: { "评审": 3 },
  readOnlyIntentWords: ["讲一下"],
  mutatingActionWords: ["改造一下"],
}), "utf8");
const probe = `
  const { TriggerEngine } = await import(${JSON.stringify(pathToFileURL(join(REPO, "src", "trigger.js")).href)});
  const c = TriggerEngine.getConfig();
  console.log(JSON.stringify({
    zh: c.keywordWeights['门禁'] !== undefined,
    en: c.keywordWeights['work'] !== undefined,
    user: c.keywordWeights['评审'] === 3,
    ro: c.readOnlyIntentWords.includes('explain') && c.readOnlyIntentWords.includes('讲一下'),
    mut: c.mutatingActionWords.includes('修复') && c.mutatingActionWords.includes('改造一下'),
  }));
`;
const pr = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
  env: { ...process.env, CARLOS_FLOW_HOME: cfgHome }, encoding: "utf8",
});
try { rmSync(cfgHome, { recursive: true, force: true }); } catch {}
let cfgOk = false, cfgDetail = "";
try {
  const c = JSON.parse((pr.stdout || "").trim().split("\n").pop());
  cfgOk = c.zh && c.en && c.user && c.ro && c.mut;
  cfgDetail = JSON.stringify(c);
} catch { cfgDetail = (pr.stderr || "").slice(0, 120); }
check("P0-2 trigger-config 词表是追加不是替换", cfgOk, cfgDetail);

// ---- 7. 插件（仅 opencode 仓有此文件）----
const pluginPath = join(REPO, "plugins", "carlos-flow-trigger.js");
if (existsSync(pluginPath)) {
  const mod = await import(pathToFileURL(pluginPath).href);
  const plugin = await mod.CarlosFlowTriggerPlugin({ client: {}, $: () => {}, worktree: REPO, directory: REPO });
  check("插件导出 chat.message 钩子", typeof plugin["chat.message"] === "function",
    Object.keys(plugin).join(","));
  const psid = "plug-" + Date.now();
  await plugin["chat.message"]({ sessionID: psid },
    { message: { id: "m", sessionID: psid, role: "user" }, parts: [{ id: "p", type: "text", text: "走门禁流程" }] });
  r = await call("flow_status", { sessionId: psid });
  check("插件触发后真的开卡", r.has_card === true, `has_card=${r.has_card}`);
} else {
  check("插件文件存在（cindy 版无此插件，跳过）", true, "skipped");
}

child.kill();
try { rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(results.join("\n"));
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail === 0 ? 0 : 1);
