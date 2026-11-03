// Carlos 工作流 · 完整端到端测试（12 工具 + 审计链验证）
import { spawn } from "node:child_process";
import fs from "node:fs";

const CLIENT = process.env.CARLOS_FLOW_MCP_ROOT + "/carlos.js";
const SID = "e2e-" + Date.now();
const FLOW_HOME = process.env.CARLOS_FLOW_HOME || "D:/opencode-backups";

let pass = 0, fail = 0;
const results = [];

function call(tool, args) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLIENT, tool, JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARLOS_FLOW_HOME: FLOW_HOME },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: "timeout" }); }, 60000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().slice(0, 300) });
      try { resolve({ ok: true, data: JSON.parse(out) }); } catch (e) { resolve({ ok: false, error: "parse: " + e.message + " | " + out.slice(0, 200) }); }
    });
  });
}

function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
}

const QUOTE = "帮我把 carlos-flow 的端到端测试跑通，确认 12 个工具都能正常工作";

async function main() {
  console.log("════════ Carlos 工作流 · 端到端测试 ════════");
  console.log(`sessionId: ${SID}`);
  console.log(`FLOW_HOME: ${FLOW_HOME}\n`);

  // 1. flow_protocol
  let r = await call("flow_protocol", {});
  check("1. flow_protocol", r.ok && r.data?.protocol?.ROUTE_TABLE?.includes("T2"), r.ok ? "" : r.error);

  // 2. flow_add_user_msg
  r = await call("flow_add_user_msg", { sessionId: SID, text: QUOTE });
  check("2. flow_add_user_msg", r.ok && r.data?.ok === true, r.ok ? `text_len=${r.data.text_len}` : r.error);

  // 3. flow_submit_requirement
  r = await call("flow_submit_requirement", {
    sessionId: SID, goal: "跑通 Carlos 端到端测试",
    quote: QUOTE, scope: [process.env.CARLOS_FLOW_MCP_ROOT + "/README.md"],
    acceptance: ["12 个工具全部可用"], confirmed: true,
  });
  check("3. flow_submit_requirement", r.ok && r.data?.ok === true, r.ok ? `tier=${r.data.tier}` : r.error);

  // 3b. 锚点否决（错误 quote 必须被拒）
  r = await call("flow_submit_requirement", {
    sessionId: SID, goal: "x", quote: "这句话不在用户原话里",
    scope: [process.env.CARLOS_FLOW_MCP_ROOT + "/README.md"], acceptance: ["a"], confirmed: true,
  });
  check("3b. 锚点否决生效", r.ok && r.data?.ok === false && /锚点/.test(r.data.reason || ""), r.ok ? "已拒绝" : r.error);

  // 3c. 敏感路径未确认必须被拒
  r = await call("flow_submit_requirement", {
    sessionId: SID, goal: "x", quote: QUOTE,
    scope: [process.env.REA_MCP_ROOT + "/package.json"], acceptance: ["a"], confirmed: false,
  });
  check("3c. 敏感路径拦截", r.ok && r.data?.ok === false, r.ok ? "已拒绝" : r.error);

  // 4. flow_status
  r = await call("flow_status", { sessionId: SID });
  check("4. flow_status", r.ok && r.data?.has_card === true && r.data?.dispatch_count === 0, r.ok ? `unreviewed=${r.data.unreviewed}` : r.error);

  // 5. flow_claim
  r = await call("flow_claim", { sessionId: SID, role: "executor" });
  check("5. flow_claim", r.ok && r.data?.ok === true && /objective:/.test(r.data.prompt || ""), r.ok ? `dispatch=${r.data.dispatch_count}` : r.error);

  // 6. flow_dispatch
  r = await call("flow_dispatch", { sessionId: SID, role: "executor", message: "只读检查", run: false });
  const snapOk = r.ok && r.data?.snapshot?.length === 1 && r.data?.snapshot[0].backup;
  check("6. flow_dispatch", r.ok && r.data?.ok === true && snapOk, r.ok ? (snapOk ? "快照已建" : "快照缺失") : r.error);

  // 7. flow_save_result
  r = await call("flow_save_result", { sessionId: SID, role: "executor", stdout: "结论：全部通过", stderr: "", code: 0 });
  check("7. flow_save_result", r.ok && r.data?.ok === true && !!r.data?.file, r.ok ? "" : r.error);

  // 8. flow_verdict
  r = await call("flow_verdict", { sessionId: SID, verdict: "PASS", notes: "端测通过" });
  check("8. flow_verdict", r.ok && r.data?.verdict === "PASS" && r.data?.completed_ok === true, r.ok ? "" : r.error);

  // 9. flow_audit
  r = await call("flow_audit", { sessionId: SID, limit: 50 });
  const kinds = r.ok ? (r.data?.by_kind || {}) : {};
  const hasHash = r.ok && (r.data?.events || []).some((e) => typeof e.hash === "string");
  check("9. flow_audit", r.ok && r.data?.total >= 6 && hasHash, r.ok ? `total=${r.data.total} kinds=${Object.keys(kinds).join(",")}` : r.error);

  // 10. flow_diff_hunks
  r = await call("flow_diff_hunks", { cwd: process.env.CARLOS_FLOW_MCP_ROOT, paths: ["README.md"] });
  check("10. flow_diff_hunks", r.ok && r.data?.ok === true, r.ok ? `files=${r.data.files?.length}` : r.error);

  // 11. flow_bypass
  r = await call("flow_bypass", { sessionId: SID, on: true, reason: "端测" });
  const byOn = r.ok && r.data?.bypass === true;
  r = await call("flow_bypass", { sessionId: SID, on: false, reason: "端测结束" });
  check("11. flow_bypass 开关", byOn && r.ok && r.data?.bypass === false, r.ok ? "开→关正常" : r.error);

  // 12. flow_revert_plan
  r = await call("flow_revert_plan", { sessionId: SID });
  check("12. flow_revert_plan", r.ok && r.data?.count === 1 && r.data?.plan?.[0]?.action === "restore", r.ok ? "" : r.error);

  // 13. 最终状态
  r = await call("flow_status", { sessionId: SID });
  check("13. 终态 completed_ok", r.ok && r.data?.completed_ok === true && r.data?.verified === true, r.ok ? "" : r.error);

  // 14. 状态目录落点
  r = await call("flow_status", { sessionId: SID });
  const runDir = `${process.env.CARLOS_FLOW_HOME || "D:/opencode-backups"}/gate-state/runs/${SID}`;
  const landed = fs.existsSync(runDir + "/state.json");
  check("14. 状态落盘到 FLOW_HOME", landed, runDir);

  console.log(results.join("\n"));
  console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
  console.log(`sessionId=${SID}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
