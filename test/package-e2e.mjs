// 包级端到端实测 —— 「装完就能用」的真实路径
//
// 为什么要有这个：
// 前面所有测试都跑在**源码目录**里，绕过了一整条真实链路：
//   npm pack → tarball → npm install → node_modules 布局 → 全局 bin → 真实 MCP 握手
// 2026-11-07 的两次事故（T-69 插件找不到单包、T-70 ghost.json 缺工具）
// 都是**只有走真实安装路径才会暴露**的问题。
//
// 所以这个测试**故意**：
//   1) 先 npm pack 打出真实 tarball
//   2) 再装到临时目录（模拟干净环境）
//   3) 从 node_modules 里拉起 MCP server，走真实 JSON-RPC
//   4) 校验包内关键文件齐备、ghost.json 工具清单与服务端一致
//   5) 跑完整门禁流程 + 负例 + 智能触发
//
// 跑法：node test/package-e2e.mjs
// 依赖：网络（从 registry 装依赖）。离线环境可用 --local 跳过安装步骤。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const LOCAL_ONLY = process.argv.includes("--local");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${d}`); }
};

const run = (cmd, args, opts = {}) => {
  const isWin = process.platform === "win32";
  return execFileSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin && /^(npm|npx|node|git)$/i.test(cmd),
  });
};

console.log("\n════ 包级端到端实测 ════\n");

const tmp = mkdtempSync(join(tmpdir(), "carlos-pkg-e2e-"));
let pkgRoot = ROOT;   // --local 模式下直接用源码目录

try {
  // ---- 1. 打出真实 tarball ----
  console.log("▶ ① 打出真实 tarball");
  const tgz = run("npm", ["pack", "--pack-destination", tmp]).trim().split("\n").pop();
  const tarball = join(tmp, tgz.replace(/^.*\//, ""));
  check(`tarball 产出：${path2(tarball)}`, existsSync(tarball), tarball);

  // ---- 2. 装到临时目录（干净环境） ----
  if (!LOCAL_ONLY) {
    console.log("▶ ② 安装到干净临时目录");
    const proj = join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "pkg-e2e", version: "1.0.0", private: true }, null, 2));
    run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: proj });
    pkgRoot = join(proj, "node_modules", "carlos-flow");
  } else {
    console.log("▶ ② 跳过安装（--local，用源码目录）");
  }

  // ---- 3. 包内文件齐备 ----
  console.log("▶ ③ 包内关键文件");
  const MUST = [
    "client/carlos.js", "src/index.js", "src/trigger.js", "src/state.js", "src/protocol.js",
    "bridge/mcp-bridge.js", "plugins/carlos-flow-trigger.js", "ghost.json", "opencode.json",
    "opencode.json.template", ".mcprc.template", "trigger-config.usable.json",
    "templates/cursor/mcp.json", "templates/cline/mcp.json", "templates/vscode/mcp.json",
    "templates/claude/claude_desktop_config.json",
    "README.md", "README.zh.md", "README.en.md", "TRIGGER_GUIDE.md", "MIGRATION.md",
    "CHANGELOG.md", "LICENSE",
  ];
  for (const f of MUST) {
    if (!existsSync(join(pkgRoot, f))) check(`包内含 ${f}`, false);
  }
  check(`包内 ${MUST.length} 个关键文件齐备`, MUST.every((f) => existsSync(join(pkgRoot, f))));

  // ---- 4. bin 入口有 shebang（否则全局命令不可用） ----
  console.log("▶ ④ bin 入口");
  const binSrc = readFileSync(join(pkgRoot, "client", "carlos.js"), "utf8");
  check("client/carlos.js 有 node shebang", binSrc.startsWith("#!") && /node/.test(binSrc.split("\n")[0]));

  // ---- 5. ghost.json 工具清单 == 服务端实际工具 ----
  console.log("▶ ⑤ 工具清单一致性");
  const ghost = JSON.parse(readFileSync(join(pkgRoot, "ghost.json"), "utf8"));
  const idxSrc = readFileSync(join(pkgRoot, "src", "index.js"), "utf8");
  const serverTools = [...new Set([...idxSrc.matchAll(/name:\s*"(flow_[a-z_]+)"/g)].map((m) => m[1]))];
  const ghostTools = (ghost.tools || []).map((t) => t.name);
  check(`ghost.json 声明 ${serverTools.length} 个工具，与服务端一致`, ghostTools.length === serverTools.length,
    `ghost=${ghostTools.length} server=${serverTools.length}`);
  for (const t of serverTools) if (!ghostTools.includes(t)) check(`ghost.json 含 ${t}`, false);

  // ---- 6. 插件能定位到**单包**的 MCP server ----
  console.log("▶ ⑥ OpenCode 插件的包名兼容");
  const pluginSrc = readFileSync(join(pkgRoot, "plugins", "carlos-flow-trigger.js"), "utf8");
  check("插件候选含单包名 carlos-flow", /["']carlos-flow["']/.test(pluginSrc));

  // ---- 7. 真实 MCP 握手 + 完整门禁流程 ----
  console.log("▶ ⑦ 真实 MCP 调用（完整门禁流程）");
  const serverPath = join(pkgRoot, "src", "index.js");
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pending = new Map(); let id = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  const req = (method, params) => new Promise((r) => {
    const rid = id++; pending.set(rid, r);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const r = await req("tools/call", { name, arguments: args });
    const text = String(r.result?.content?.[0]?.text || "");
    try { return { ...JSON.parse(text), __isError: r.result?.isError === true }; }
    catch { return { ok: false, __raw: text, __isError: r.result?.isError === true }; }
  };

  // 双轴门禁：落 PASS 前必须收齐 Standards / Spec 两轴证据
  const submitAxes = async (sid) => {
    await tool("flow_audit_axes", { sessionId: sid });
    await tool("flow_audit_submit", { sessionId: sid, axis: "standards", verdict: "PASS", findings: ["符合规范"], evidence: "包级实测人工核验" });
    await tool("flow_audit_submit", { sessionId: sid, axis: "spec", verdict: "PASS", findings: ["验收满足"], evidence: "包级实测人工核验" });
  };

  await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pkg-e2e", version: "1" } });
  await req("notifications/initialized", {});

  const list = await req("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check(`tools/list 返回 ${serverTools.length} 个工具`, names.length === serverTools.length, `实际 ${names.length}`);

  const SID = "pkg-e2e-" + Date.now();
  const TEXT = "给登录接口加参数校验并跑测试";

  let r = await tool("flow_add_user_msg", { sessionId: SID, text: TEXT });
  check("flow_add_user_msg 留痕", r.ok === true);

  r = await tool("flow_submit_requirement", {
    sessionId: SID, goal: "加参数校验", quote: TEXT, scope: ["README.md"],
    acceptance: ["参数校验生效"],
    // 真实测试：检查 README.md 是否含改动标记 —— 改动前失败、改动后通过。
    verify: { cmd: "node -e \"const c=require(\'fs\').readFileSync(\'README.md\',\'utf8\');process.exit(c.includes(\'PKG-E2E-CHANGED\')?0:1)\"" },
    cwd: pkgRoot, confirmed: true,
  });
  check("flow_submit_requirement 提交卡片", r.ok === true);
  check("风险档判定正确（scope 1 个文件 → single_file）", r.tier === "single_file", `tier=${r.tier}`);

  r = await tool("flow_claim", { sessionId: SID, role: "executor" });
  check("flow_claim 领取名额", r.ok === true);

  r = await tool("flow_dispatch", { sessionId: SID, role: "executor", message: "只读检查", run: false, cwd: pkgRoot });
  check("flow_dispatch 派发并快照", r.ok === true && Array.isArray(r.snapshot));

  // 真实改动：给 README.md 打标记（pkgRoot 是临时安装目录，改了不污染源码）
  writeFileSync(join(pkgRoot, "README.md"),
    readFileSync(join(pkgRoot, "README.md"), "utf8") + "\n" + "PKG-E2E-CHANGED" + "\n");

  r = await tool("flow_falsify", { sessionId: SID });
  check("flow_falsify 负对照通过（改动前失败 + 改动后通过）",
    r.ok === true && r.verdict === "meaningful", r.ok ? `verdict=${r.verdict}` : (r.__raw || ""));

  r = await tool("flow_claim", { sessionId: SID, role: "auditor" });
  await submitAxes(SID);
  r = await tool("flow_verdict", { sessionId: SID, verdict: "PASS", notes: "验证通过", cwd: pkgRoot });
  check("flow_verdict 记 PASS（有验证证据才放行）", r.ok === true && r.completed_ok === true);

  r = await tool("flow_audit", { sessionId: SID });
  check("flow_audit 返回 ok 字段（结构统一）", r.ok === true, `ok=${r.ok}`);
  check("flow_audit 审计流水可读", typeof r.total === "number" && r.total > 0, `total=${r.total}`);

  console.log("\n▶ ⑧ 门禁负例（必须被拒）");
  const SID2 = SID + "-neg";
  await tool("flow_add_user_msg", { sessionId: SID2, text: TEXT });
  r = await tool("flow_verdict", { sessionId: SID2, verdict: "PASS", notes: "没派发就想通过" });
  check("未派发记 PASS 被拒", r.ok === false || r.__isError === true);
  r = await tool("flow_submit_requirement", {
    sessionId: SID2, goal: "x", quote: TEXT, scope: [123], confirmed: true, cwd: pkgRoot,
  });
  check("scope 含非字符串元素被拒", r.ok === false || r.__isError === true);

  console.log("\n▶ ⑨ 智能触发");
  r = await tool("flow_trigger_check", { sessionId: SID + "-trig", message: "走门禁流程，执行 dispatch 任务" });
  check("中文流程消息自动激活", r.decision === "trigger" && r.activated === true, `decision=${r.decision} score=${r.score}`);
  r = await tool("flow_trigger_check", { sessionId: SID + "-ns", message: "给登录接口加一个参数校验" });
  check("普通中文需求不误触发", r.decision === "ignore", `decision=${r.decision}`);

  child.kill();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail === 0 ? 0 : 1);

function path2(p) { return p.replace(/\\/g, "/"); }