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
import { createHash } from 'node:crypto'
import { parseTools } from '../scripts/check-no-dead-handler.mjs'
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
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
    env: { ...process.env, ...isolatedEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin && /^(npm|npx|node|git)$/i.test(cmd),
  });
};

console.log("\n════ 包级端到端实测 ════\n");

const tmp = mkdtempSync(join(tmpdir(), "carlos-pkg-e2e-"));
let pkgRoot
let server
// 包级契约测试覆盖 26 个底层操作；v3 对外默认面由 facade-surface 用例覆盖。
const isolatedEnv = { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'), CARLOS_FLOW_TOOL_SURFACE: 'legacy' }
for (const [key, sub] of Object.entries({ HOME: 'home', USERPROFILE: 'profile', CARLOS_FLOW_HOME: 'flow', npm_config_cache: 'npm-cache' })) {
  isolatedEnv[key] = join(tmp, sub)
  mkdirSync(isolatedEnv[key], { recursive: true })
}
// 保存全部已跟踪文件内容和工作区状态，验收结束必须逐项保持不变。
const sourceSnapshot = () => {
  const files = run('git', ['ls-files', '-z']).split('\0').filter(Boolean)
  return {
    status: run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    readme: createHash('sha256').update(readFileSync(join(ROOT, 'README.md'))).digest('hex'),
    tracked: files.map((file) => [file, existsSync(join(ROOT, file)) ? createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex') : null]),
  }
}
const sourceBefore = sourceSnapshot()

try {
  // ---- 1. 打出真实 tarball ----
  console.log("▶ ① 打出真实 tarball");
  const tgz = run("npm", ["pack", "--pack-destination", tmp]).trim().split("\n").pop();
  const tarball = join(tmp, tgz.replace(/^.*\//, ""));
  check(`tarball 产出：${path2(tarball)}`, existsSync(tarball), tarball);
  console.log('TARBALL_SHA256 ' + createHash('sha256').update(readFileSync(tarball)).digest('hex'));
  let evidence;
  if (process.env.CARLOS_PACKAGE_EVIDENCE_DIR) {
    evidence = resolve(process.env.CARLOS_PACKAGE_EVIDENCE_DIR);
    if (evidence.startsWith(ROOT)) throw new Error('包级证据目录必须在源码副本之外');
    mkdirSync(evidence, { recursive: true });
    copyFileSync(tarball, join(evidence, 'runtime-package.tgz'));
    writeFileSync(join(evidence, 'tar-sha256.txt'), createHash('sha256').update(readFileSync(tarball)).digest('hex'));
  }
  // GNU tar 将 Windows 盘符当远程主机；在归档目录用相对名，跨平台一致。
  const tarEntries = new Set(run('tar', ['-tzf', tarball.slice(tmp.length + 1)], { cwd: tmp }).split(/\r?\n/).filter(Boolean));
  if (evidence) writeFileSync(join(evidence, 'tar-entries.json'), JSON.stringify([...tarEntries].sort(), null, 2));
  for (const resource of ['ui/narrator.js', 'settings.html', 'settings.js']) {
    check(`真实 tarball 含运行资源 ${resource}`, tarEntries.has('package/' + resource));
  }

  // ---- 2. 装到临时目录（干净环境） ----
  if (!LOCAL_ONLY) {
    console.log("▶ ② 安装到干净临时目录");
    const proj = join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "pkg-e2e", version: "1.0.0", private: true }, null, 2));
    run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: proj });
    pkgRoot = join(proj, "node_modules", "carlos-flow");
  } else {
    console.log('▶ ② 跳过安装，将真实包解压到临时副本')
    const unpacked = join(tmp, 'unpacked')
    mkdirSync(unpacked)
    run('tar', ['-xzf', tarball.slice(tmp.length + 1), '-C', 'unpacked'], { cwd: tmp })
    pkgRoot = join(unpacked, 'package')
  }

  // 负对照必须从干净基线开始；发现旧标记立即失败，不能悄悄沿用污染数据。
  if (readFileSync(join(pkgRoot, 'README.md'), 'utf8').includes('PKG-E2E-CHANGED')) {
    throw new Error('包内 README 已含测试标记，拒绝运行负对照')
  }
  run('git', ['init'], { cwd: pkgRoot })
  run('git', ['add', '--all'], { cwd: pkgRoot })
  run('git', ['-c', 'user.name=包级测试', '-c', 'user.email=package-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', '包级测试临时基线'], { cwd: pkgRoot })

  // ---- 3. 包内文件齐备 ----
  console.log("▶ ③ 包内关键文件");
  const MUST = [
    "client/carlos.js", "src/index.js", "src/trigger.js", "src/state.js", "src/protocol.js",
    "bridge/mcp-bridge.js", "plugins/carlos-flow-trigger.js", "ghost.json", "opencode.json",
    "opencode.json.template", ".mcprc.template", "trigger-config.usable.json",
    "templates/cursor/mcp.json", "templates/cline/mcp.json", "templates/vscode/mcp.json",
    "templates/claude/claude_desktop_config.json",
    "README.md", "README.zh.md", "README.en.md", "TRIGGER_GUIDE.md", "MIGRATION.md",
    "CHANGELOG.md", "LICENSE", "ui/narrator.js", "settings.html", "settings.js",
  ];
  for (const f of MUST) {
    if (!existsSync(join(pkgRoot, f))) check(`包内含 ${f}`, false);
  }
  check(`包内 ${MUST.length} 个关键文件齐备`, MUST.every((f) => existsSync(join(pkgRoot, f))));
  for (const resource of ['ui/narrator.js', 'settings.html', 'settings.js']) {
    check(`安装资源与源码逐字节一致 ${resource}`, existsSync(join(pkgRoot, resource)) &&
      createHash('sha256').update(readFileSync(join(pkgRoot, resource))).digest('hex') === createHash('sha256').update(readFileSync(join(ROOT, resource))).digest('hex'));
  }
  const packagedGhost = JSON.parse(readFileSync(join(pkgRoot, 'ghost.json'), 'utf8'));
  check('运行包明确声明固定哈希子入口权限', packagedGhost.node?.childSpawn === true && JSON.stringify(packagedGhost.node.entries) === JSON.stringify(['src/state.js']))
  const hashOutput = execFileSync(process.execPath, [join(pkgRoot, 'src/state.js'), '--hash-child'], {
    env: { ...process.env, ...isolatedEnv }, cwd: pkgRoot, windowsHide: true, timeout: 10000, maxBuffer: 65536,
    input: JSON.stringify({ diff: '包内固定入口', files: [], gitRoot: pkgRoot, flowHomeAbs: isolatedEnv.CARLOS_FLOW_HOME }), encoding: 'utf8',
  })
  check('真实包内固定入口正常退出且复用内容算法', JSON.parse(hashOutput).diff_sha256 === createHash('sha256').update('包内固定入口').digest('hex'))
  let pageClosure = true;
  for (const html of [packagedGhost.settingsHtml].filter(Boolean)) {
    if (!existsSync(join(pkgRoot, html))) { pageClosure = false; continue; }
    for (const ref of readFileSync(join(pkgRoot, html), 'utf8').matchAll(/<script\s+src=["']([^"']+)["']/g)) {
      const target = ref[1].replace(/^\//, '');
      if (target.includes('..') || !existsSync(join(pkgRoot, target)) || !tarEntries.has('package/' + target)) pageClosure = false;
    }
  }
  check('真实运行包内 settings 页面脚本引用完整', pageClosure);
  const visited = new Set(); let moduleClosure = true;
  function verifyRuntimeClosure(file) {
    if (visited.has(file)) return;
    visited.add(file);
    if (!existsSync(join(pkgRoot, file)) || !tarEntries.has('package/' + file)) { moduleClosure = false; return; }
    for (const ref of readFileSync(join(pkgRoot, file), 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(join(pkgRoot, file)), ref[1]);
      if (!target.startsWith(resolve(pkgRoot) + pathSeparator)) { moduleClosure = false; continue; }
      verifyRuntimeClosure(target.slice(resolve(pkgRoot).length + 1).replace(/\\/g, '/'));
    }
  }
  const pathSeparator = process.platform === 'win32' ? '\\' : '/';
  for (const entry of ['src/index.js', 'client/carlos.js', 'bridge/mcp-bridge.js', 'plugins/carlos-flow-trigger.js', 'settings.js', 'ui/narrator.js']) verifyRuntimeClosure(entry);
  check(`真实运行包本地依赖 closure 完整（${visited.size} 文件）`, moduleClosure);

  // ---- 4. bin 入口有 shebang（否则全局命令不可用） ----
  console.log("▶ ④ bin 入口");
  const binSrc = readFileSync(join(pkgRoot, "client", "carlos.js"), "utf8");
  check("client/carlos.js 有 node shebang", binSrc.startsWith("#!") && /node/.test(binSrc.split("\n")[0]));

  // ---- 5. ghost.json 工具清单 == 服务端实际工具 ----
  console.log("▶ ⑤ 工具清单一致性");
  const ghost = JSON.parse(readFileSync(join(pkgRoot, "ghost.json"), "utf8"));
  const idxSrc = readFileSync(join(pkgRoot, "src", "index.js"), "utf8");
  const serverTools = parseTools(idxSrc).map((tool) => tool.name)
  const ghostTools = (ghost.tools || []).map((t) => t.name);
  // 两种合法形态（详见 docs/TOOL_CONTRACTS.md §1.3）：
  //   A. 直接声明：ghost.json 逐条列出全部 flow_*（宿主上限 16 项）
  //   B. 两元工具（list_tools / call_tool）；后端类目仍恰好覆盖全部操作。
  const twoLevel = ghostTools.length === 2 &&
    new Set(ghostTools).size === 2 && ghostTools.includes('list_tools') && ghostTools.includes('call_tool') &&
    ghostTools.every((name) => ['list_tools', 'call_tool'].includes(name));
  if (twoLevel) {
    const mainSrc = readFileSync(join(pkgRoot, "main.js"), "utf8");
    const members = [...mainSrc.matchAll(/members:\s*\[([^\]]*)\]/gs)]
      .flatMap((m) => [...m[1].matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2]));
    const uniq = [...new Set(members)];
    check(`两段式目录：main.js 类目表覆盖 ${serverTools.length} 个操作`, uniq.length === serverTools.length,
      `main=${uniq.length} server=${serverTools.length}`);
    for (const t of serverTools) if (!uniq.includes(t)) check(`main.js 类目表含 ${t}`, false);
    check("两段式清单 kind=chip 且 entry=main.js", ghost.kind === "chip" && ghost.entry === "main.js");
    check("两段式清单 node.protocol=mcp-stdio", ghost.node && ghost.node.protocol === "mcp-stdio");
    check("包内确实带上 main.js 与 src/mcp-stdio.mjs",
      existsSync(join(pkgRoot, "main.js")) && existsSync(join(pkgRoot, "src", "mcp-stdio.mjs")));
  } else {
    check(`ghost.json 声明 ${serverTools.length} 个工具，与服务端一致`, ghostTools.length === serverTools.length,
      `ghost=${ghostTools.length} server=${serverTools.length}`);
    for (const t of serverTools) if (!ghostTools.includes(t)) check(`ghost.json 含 ${t}`, false);
    check("直接声明的工具数不超过宿主上限 16", ghostTools.length <= 16, `ghost=${ghostTools.length}`);
  }

  // ---- 6. 插件能定位到**单包**的 MCP server ----
  console.log("▶ ⑥ OpenCode 插件的包名兼容");
  const pluginSrc = readFileSync(join(pkgRoot, "plugins", "carlos-flow-trigger.js"), "utf8");
  check("插件候选含单包名 carlos-flow", /["']carlos-flow["']/.test(pluginSrc));

  // ---- 7. 真实 MCP 握手 + 完整门禁流程 ----
  console.log("▶ ⑦ 真实 MCP 调用（完整门禁流程）");
  const serverPath = join(pkgRoot, "src", "index.js");
  const child = server = spawn(process.execPath, [serverPath], {
    cwd: pkgRoot,
    env: { ...process.env, ...isolatedEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ""; const pending = new Map(); let id = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  // 服务端 stderr 必须转发出来：子进程崩了却只看到「卡住」，是这类测试最容易骗人的地方。
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d.toString()));
  // 子进程退出 → 把在途请求判失败，绝不静默挂死（旧版没这道，崩了会挂到超时）
  child.on("exit", (code) => {
    for (const [, r] of pending) r({ error: "MCP server 退出（code=" + code + "）" });
    pending.clear();
  });
  const req = (method, params) => new Promise((r) => {
    const rid = id++;
    const timer = setTimeout(() => {
      if (pending.has(rid)) { pending.delete(rid); r({ error: "TIMEOUT " + method }); }
    }, 30000);
    pending.set(rid, (msg) => { clearTimeout(timer); r(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const r = await req('tools/call', { name, arguments: { ...args, cwd: pkgRoot } })
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

  // 真实改动只写临时副本；默认安装和离线解包均不得引用源码目录。
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
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise((done) => { server.once('exit', done); server.kill() })
  }
  rmSync(tmp, { recursive: true, force: true })
  const sourceAfter = sourceSnapshot()
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) throw new Error('包级测试污染了源仓库文件或工作区状态')
  console.log(`源仓库无副作用核验通过：README、${sourceBefore.tracked.length} 个已跟踪文件及工作区状态均不变`)
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail === 0 ? 0 : 1);

function path2(p) { return p.replace(/\\/g, "/"); }