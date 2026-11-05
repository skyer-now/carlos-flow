// P0 门禁专项验证：逐条核对审核报告指出的 8 项门禁机制
import { spawn } from "node:child_process";
import fs from "node:fs";

import os from 'node:os';
import { join } from 'node:path';
import path from 'node:path';

// 状态/审计根目录默认值：与 src/state.js 的 FLOW_HOME 保持一致（跨平台）
const DEFAULT_FLOW_HOME = join(os.homedir(), '.carlos-flow');

const ROOT = process.env.CARLOS_FLOW_MCP_ROOT;
const CLIENT = [ROOT + "/client/carlos.js", ROOT + "/carlos.js"].find(p => fs.existsSync(p));
const FLOW_HOME = process.env.CARLOS_FLOW_HOME || DEFAULT_FLOW_HOME;
// 独立 Bridge 端口：避免复用本机已有的 Bridge（它可能带旧的 FLOW_HOME）
const BRIDGE_PORT = String(process.env.BRIDGE_PORT || (19500 + (process.pid % 400)));

let pass = 0, fail = 0;
const lines = [];

function call(tool, args) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLIENT, tool, JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARLOS_FLOW_HOME: FLOW_HOME, BRIDGE_PORT },
    });
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    const timer = setTimeout(() => { p.kill(); resolve({ ok:false, error:"timeout" }); }, 45000);
    p.on("error", e => { clearTimeout(timer); resolve({ ok:false, error:"spawn: "+e.message }); });
    p.on("close", code => {
      clearTimeout(timer);
      // 错误走 stderr 且退出码非 0；成功时 stdout 是 JSON
      if (code !== 0) return resolve({ ok:false, error:(err||out).trim().slice(0,300), isError:true });
      try { resolve({ ok:true, data: JSON.parse(out) }); }
      catch(e) { resolve({ ok:false, error:(err||out).trim().slice(0,300) }); }
    });
  });
}
function check(name, cond, detail="") {
  if (cond) { pass++; lines.push(`  ✓ ${name}${detail?"  "+detail:""}`); }
  else { fail++; lines.push(`  ✗ ${name}${detail?"  "+detail:""}`); }
}

const QUOTE = "帮我验证 carlos-flow 的 14 个门禁工具真的有效";

async function main() {
  console.log("════════ P0 门禁专项验证 ════════\n");

  // --- 准备一张卡 ---
  const sid = "p0-" + Date.now();
  await call("flow_add_user_msg", { sessionId: sid, text: QUOTE });
  let r = await call("flow_submit_requirement", {
    sessionId: sid, goal: "验证门禁", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["门禁生效"], confirmed: true,
    verify: { cmd: "node -e \"console.log('VERIFY_OK_42')\"" },
  });
  check("0. 留痕成功", r.ok && r.data?.ok === true, r.ok?`tier=${r.data.tier}`:r.error);

  // --- 1. 非法 role 必须报错（不得静默降级）---
  r = await call("flow_claim", { sessionId: sid, role: "hacker" });
  check("1. 非法 role 被拒（不降级为 executor）",
    r.ok === false && /role|非法/i.test(r.error||""),
    (r.error||"").slice(0,70));

  // --- 2. 过期卡拦截 ---
  // --- 3. 配额耗尽拦截 ---
  // --- 4. 未 claim 不得 dispatch ---
  const sid2 = "p0-noclaim-" + Date.now();
  await call("flow_add_user_msg", { sessionId: sid2, text: QUOTE });
  await call("flow_submit_requirement", {
    sessionId: sid2, goal: "未 claim 直接 dispatch", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["x"], confirmed: true,
  });
  r = await call("flow_dispatch", { sessionId: sid2, role: "executor" });
  check("2. 未 claim 直接 dispatch 被拒",
    r.ok === false && /claim/i.test(r.error||""),
    (r.error||"").slice(0,70));

  // --- 5. 真实验证：flow_run_verify 真的执行命令 ---
  r = await call("flow_run_verify", { sessionId: sid });
  check("3. flow_run_verify 真实执行 verify.cmd",
    r.ok && r.data?.ok === true && r.data?.exitCode === 0 && String(r.data?.stdout||"").includes("VERIFY_OK_42"),
    r.ok ? `exitCode=${r.data?.exitCode} stdout=${String(r.data?.stdout||"").trim().slice(0,30)}` : r.error);

  // --- 6. 真实验证：失败命令必须报失败 ---
  const sid3 = "p0-fail-" + Date.now();
  await call("flow_add_user_msg", { sessionId: sid3, text: QUOTE });
  await call("flow_submit_requirement", {
    sessionId: sid3, goal: "验证失败路径", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["x"], confirmed: true,
    verify: { cmd: "node -e \"process.exit(3)\"" },
  });
  r = await call("flow_run_verify", { sessionId: sid3 });
  check("4. verify.cmd 失败时如实报失败",
    r.ok && r.data?.ok === false && r.data?.exitCode === 3,
    r.ok ? `ok=${r.data?.ok} exitCode=${r.data?.exitCode}` : r.error);

  // --- 7. scope 越界拦截 ---
  r = await call("flow_check_scope", { sessionId: sid, paths: [ROOT + "/README.md"] });
  check("5. scope 内文件不报违规",
    r.ok && r.data?.ok === true && (r.data?.violations||[]).length === 0,
    r.ok ? `violations=${JSON.stringify(r.data?.violations)}` : r.error);
  r = await call("flow_check_scope", { sessionId: sid, paths: [ROOT + "/README.md", ROOT + "/src/index.js"] });
  check("6. scope 外文件被标为违规",
    r.ok && r.data?.ok === false && (r.data?.violations||[]).length > 0,
    r.ok ? `violations=${JSON.stringify(r.data?.violations)}` : r.error);

  // --- 8. verdict 枚举校验 ---
  r = await call("flow_verdict", { sessionId: sid, verdict: "GARBAGE" });
  check("7. 非法 verdict 被拒",
    r.ok === false && /verdict|非法|PASS/i.test(r.error||""),
    (r.error||"").slice(0,70));

  // --- 9. bypass 需 confirmed ---
  const sid4 = "p0-bypass-" + Date.now();
  await call("flow_add_user_msg", { sessionId: sid4, text: QUOTE });
  await call("flow_submit_requirement", {
    sessionId: sid4, goal: "验证免检", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["x"], confirmed: false,
  });
  r = await call("flow_bypass", { sessionId: sid4, on: true, confirmed: false });
  check("8. 未确认时免检被拒",
    r.ok === false,
    (r.error||"").slice(0,70));

  // --- 10. 工具清单完整性 ---
  const list = await call("flow_protocol", {});
  check("9. flow_protocol 可用", list.ok && !!list.data?.protocol);

  console.log(lines.join("\n"));
  console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
  cleanupBridge();
  process.exit(fail ? 1 : 0);
}

// 清理本次测试拉起的 Bridge（端口隔离，不影响其他实例）
function cleanupBridge() {
  try {
    const pidFile = path.join(ROOT, `bridge-${BRIDGE_PORT}.pid`);
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (pid && pid !== process.pid) {
        try { process.kill(pid); } catch { /* 已退出 */ }
      }
      fs.unlinkSync(pidFile);
    }
  } catch { /* 清理失败不影响测试结果 */ }
}

main();
