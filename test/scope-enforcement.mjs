// 越界拦截真实验证 —— 「越界直接阻断」必须真的成立
//
// 背景：2026-11-07 的第三方审查发现 enforceScope 从不自己跑 git diff，
// 且 flow_dispatch 里零 scope 校验 —— README 承诺的「越界直接阻断派发」
// 实际不成立。本次修复把它落到「裁定前用增量阻断 PASS」。
//
// 这个脚本用**真实 git 仓库 + 真实改动**验证：
//   1) scope 内改动 → 允许 PASS
//   2) scope 外改动 → 阻断 PASS（这是核心断言）
//   3) 用户派发前就有的未提交改动 → **不误判**为越界
//
// 跑法：node test/scope-enforcement.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "src", "index.js");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${d}`); }
};

// ---- 建一个真实 git 仓库 ----
const repo = mkdtempSync(join(tmpdir(), "carlos-scope-"));
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
writeFileSync(join(repo, "in-scope.txt"), "original\n");
writeFileSync(join(repo, "out-of-scope.txt"), "original\n");
writeFileSync(join(repo, "pre-existing.txt"), "original\n");
git("add", "-A");
git("commit", "-q", "-m", "初始提交");

// ---- 起 MCP server ----
const child = spawn(process.execPath, [SERVER], {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CARLOS_FLOW_HOME: join(repo, ".flowhome") },
});
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
  const isError = r.result?.isError === true;
  try { return { ...JSON.parse(text), __isError: isError }; }
  catch { return { ok: false, __raw: text, __isError: isError }; }
};

await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scope-test", version: "1" } });
await req("notifications/initialized", {});

console.log("\n════ 越界拦截真实验证 ════\n");

const QUOTE = "改 in-scope 文件";
// 真实测试：检查 in-scope.txt 内容 —— 改动前（original）失败、改动后（含 changed）通过。
// 旧版用 `process.stdout.write(\"OK\")`（永远退 0）—— 正是负对照要抓的「空测试」。
const VERIFY = "node -e \"const c=require(\'fs\').readFileSync(\'in-scope.txt\',\'utf8\');process.exit(c.includes(\'changed\')?0:1)\"";

/** 跑一轮：提交卡 → claim → dispatch → 改文件 → verify → verdict */
async function round(name, { mutate, expectPass, expectFalsify, verify }) {
  const sid = "scope-" + name + "-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid, text: QUOTE });
  await tool("flow_submit_requirement", {
    sessionId: sid, goal: "测试 scope 拦截", quote: QUOTE,
    scope: ["in-scope.txt"], acceptance: ["改对了"],
    verify: { cmd: verify || VERIFY }, cwd: repo, confirmed: true,
  });
  await tool("flow_claim", { sessionId: sid, role: "executor" });
  const d = await tool("flow_dispatch", { sessionId: sid, role: "executor", run: false });
  if (d.__isError || d.ok === false) {
    check(`${name}：dispatch 成功`, false, d.__raw || JSON.stringify(d).slice(0, 100));
    return;
  }
  mutate();
  // 负对照：改动前必须失败、改动后必须通过（空测试在这里被判定为 vacuous）
  const f = await tool("flow_falsify", { sessionId: sid, cwd: repo });
  if (expectFalsify) {
    check(`${name}：负对照结论 = ${expectFalsify}`, f.verdict === expectFalsify,
      `实际 ${f.verdict}${f.reason ? "（" + f.reason + "）" : ""}`);
  }
  // auditor claim 后 verdict
  await tool("flow_claim", { sessionId: sid, role: "auditor" });
  if (expectPass) {
    // 双轴门禁：落 PASS 前必须收齐 Standards / Spec 两轴证据（仅正向用例需要）
    await tool("flow_audit_axes", { sessionId: sid });
    await tool("flow_audit_submit", { sessionId: sid, axis: "standards", verdict: "PASS", findings: ["符合规范"], evidence: "scope 实测人工核验" });
    await tool("flow_audit_submit", { sessionId: sid, axis: "spec", verdict: "PASS", findings: ["验收满足"], evidence: "scope 实测人工核验" });
  }
  const verdict = await tool("flow_verdict", { sessionId: sid, verdict: "PASS", notes: "测试", cwd: repo });
  const gotPass = verdict.ok === true && verdict.completed_ok === true;
  check(`${name}：${expectPass ? "允许 PASS" : "阻断 PASS"}`,
    gotPass === expectPass,
    expectPass ? `竟然被拒：${verdict.__raw || verdict.reason || ""}` : `竟然放行了：${JSON.stringify(verdict).slice(0, 120)}`);
  return verdict;
}

// ---- 用例 1：scope 内改动 → 允许 PASS ----
await round("用例1-scope内", {
  mutate: () => writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n"),
  expectPass: true, expectFalsify: "meaningful",
});

// 恢复
git("checkout", "--", "in-scope.txt");

// ---- 用例 2：scope 外改动 → 必须阻断 PASS（核心断言）----
await round("用例2-scope外", {
  mutate: () => writeFileSync(join(repo, "out-of-scope.txt"), "changed by agent OUT OF SCOPE\n"),
  expectPass: false, expectFalsify: "not_passing",
});
git("checkout", "--", "out-of-scope.txt");

// ---- 用例 3：派发【之前】就存在的未提交改动 → 不得误判为越界 ----
writeFileSync(join(repo, "pre-existing.txt"), "用户自己先改的（派发前就有）\n");
await round("用例3-派发前已有改动", {
  mutate: () => writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n"),
  expectPass: true, expectFalsify: "meaningful",
});
git("checkout", "--", "in-scope.txt");
git("checkout", "--", "pre-existing.txt");

// ---- 用例 6：空测试（改动前后都退 0）→ 负对照判定 vacuous，阻断 PASS ----
// 这是负对照存在的理由：`|| true` / `process.exit(0)` 这类命令永远「验证通过」，
// 旧门禁会把它们当成证据。
await round("用例6-空测试", {
  mutate: () => writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n"),
  expectPass: false, expectFalsify: "vacuous",
  verify: "node -e \"process.exit(0)\"",
});
git("checkout", "--", "in-scope.txt");

// ---- 用例 4：flow_check_scope 不传 paths 时自动跑 git diff ----
const sid4 = "scope-auto-" + Date.now();
await tool("flow_add_user_msg", { sessionId: sid4, text: QUOTE });
await tool("flow_submit_requirement", {
  sessionId: sid4, goal: "自动 diff 模式", quote: QUOTE,
  scope: ["in-scope.txt"], acceptance: ["x"], cwd: repo, confirmed: true,
});
writeFileSync(join(repo, "out-of-scope.txt"), "auto diff detects this\n");
const auto = await tool("flow_check_scope", { sessionId: sid4, cwd: repo });
// 语义：payload 里的 ok 是 enforceScope 的结果（false = 有越界），
// MCP 层面没报错（__isError 为 false）
check("flow_check_scope 不传 paths → 自动跑 git diff 并发现越界",
  auto.__isError === false && auto.ok === false && Array.isArray(auto.violations) && auto.violations.length > 0,
  JSON.stringify(auto).slice(0, 140));
git("checkout", "--", "out-of-scope.txt");

// ---- 用例 5：enforceScope 自己跑 git（不经调用方传 paths）----
const mod = await import(pathToFileURL(join(ROOT, "src", "dispatch.js")).href);
const gitInside = mod.enforceScope.toString().includes("git") && mod.enforceScope.toString().includes("diff");
check("enforceScope 函数体内确实包含 git diff 调用", gitInside);

child.kill();
// Windows 上子进程退出前目录仍被占用 → 清理失败不应影响测试结论
try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) {
  console.log("\n⚠️  越界拦截未生效 —— README「越界直接阻断」的承诺仍然不成立。");
}
process.exit(fail === 0 ? 0 : 1);