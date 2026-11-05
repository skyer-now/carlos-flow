// Carlos 工作流 · 完整端到端测试（12 工具 + 审计链验证）
import { spawn } from "node:child_process";
import fs from "node:fs";

import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 状态/审计根目录默认值：与 src/state.js 的 FLOW_HOME 保持一致（跨平台）
const DEFAULT_FLOW_HOME = join(os.homedir(), '.carlos-flow');

// 仓库根目录：优先环境变量，缺失时回退到本脚本所在目录的上一级（= 仓库根）
// 这样本地 `npm run test:e2e` 无需额外配置环境变量也能跑
const REPO_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const ROOT = process.env.CARLOS_FLOW_MCP_ROOT || REPO_ROOT;
// 客户端路径：优先 client/carlos.js（发布版布局），回退到根目录 carlos.js（扁平布局）
const CLIENT = [
  ROOT + "/client/carlos.js",
  ROOT + "/carlos.js",
].find((p) => fs.existsSync(p)) || ROOT + "/client/carlos.js";
const SID = "e2e-" + Date.now();
const FLOW_HOME = process.env.CARLOS_FLOW_HOME || DEFAULT_FLOW_HOME;
// 独立 Bridge 端口：避免复用本机已有的 Bridge（它可能带旧的 FLOW_HOME），
// 确保本次测试的状态真正落到 FLOW_HOME
const BRIDGE_PORT = String(process.env.BRIDGE_PORT || (19100 + (process.pid % 400)));

let pass = 0, fail = 0;
const results = [];

function call(tool, args) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLIENT, tool, JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARLOS_FLOW_HOME: FLOW_HOME, BRIDGE_PORT },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: "timeout" }); }, 60000);
    // spawn 失败（如客户端路径不存在）必须 resolve，否则 Promise 永远挂起
    p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: "spawn: " + e.message }); });
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

/**
 * 直接跑客户端进程并捕获 stderr（不走 MCP 直调）。
 *
 * 用途：验证**客户端激活路径**真的执行了动作，而不只是打印日志。
 * 如果 checkTrigger 里的 callMCP 被改成空实现，本函数返回的 stderr
 * 依然会说「已执行激活步骤」，但随后的 flow_status 查不到 has_card=true，
 * 因此第 17 组用例会失败——这正是用来卡住「只打印日志」退化的断言。
 */
function runClient(tool, argsObj) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLIENT, tool, JSON.stringify(argsObj)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARLOS_FLOW_HOME: FLOW_HOME, BRIDGE_PORT },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: "timeout", stderr: err, stdout: out }); }, 60000);
    p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: "spawn: " + e.message, stderr: err, stdout: out }); });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, error: code !== 0 ? (err || out).trim().slice(0, 300) : "", stderr: err, stdout: out });
    });
  });
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
    quote: QUOTE, scope: [ROOT + "/README.md"],
    acceptance: ["12 个工具全部可用"], confirmed: true,
  });
  check("3. flow_submit_requirement", r.ok && r.data?.ok === true, r.ok ? `tier=${r.data.tier}` : r.error);

  // 3b. 锚点否决（错误 quote 必须被拒）
  r = await call("flow_submit_requirement", {
    sessionId: SID, goal: "x", quote: "这句话不在用户原话里",
    scope: [ROOT + "/README.md"], acceptance: ["a"], confirmed: true,
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
  r = await call("flow_diff_hunks", { cwd: ROOT, paths: ["README.md"] });
  check("10. flow_diff_hunks", r.ok && r.data?.ok === true, r.ok ? `files=${r.data.files?.length}` : r.error);

  // 11. flow_bypass（开启必须显式 confirmed=true）
  r = await call("flow_bypass", { sessionId: SID, on: true, confirmed: false, reason: "未确认应被拒" });
  const denied = r.ok === false;
  r = await call("flow_bypass", { sessionId: SID, on: true, confirmed: true, reason: "端测" });
  const byOn = r.ok && r.data?.bypass === true;
  r = await call("flow_bypass", { sessionId: SID, on: false, reason: "端测结束" });
  check("11. flow_bypass 开关", denied && byOn && r.ok && r.data?.bypass === false,
    r.ok ? (denied ? "未确认被拒，开→关正常" : "未确认未被拒") : r.error);

  // 12. flow_revert_plan
  r = await call("flow_revert_plan", { sessionId: SID });
  check("12. flow_revert_plan", r.ok && r.data?.count === 1 && r.data?.plan?.[0]?.action === "restore", r.ok ? "" : r.error);

  // 13. 最终状态
  r = await call("flow_status", { sessionId: SID });
  check("13. 终态 completed_ok", r.ok && r.data?.completed_ok === true && r.data?.verified === true, r.ok ? "" : r.error);

  // 14. 状态目录落点
  r = await call("flow_status", { sessionId: SID });
  const runDir = path.join(process.env.CARLOS_FLOW_HOME || DEFAULT_FLOW_HOME, "gate-state", "runs", SID);
  const landed = fs.existsSync(path.join(runDir, "state.json"));
  check("14. 状态落盘到 FLOW_HOME", landed, runDir);

  // 15. 激活占位卡闸门：占位卡未补齐时 claim / dispatch 必须被拒
  const ACT_SID = SID + "-act";
  r = await call("flow_add_user_msg", { sessionId: ACT_SID, text: "run dispatch workflow" });
  r = await call("flow_submit_requirement", {
    sessionId: ACT_SID,
    goal: "执行 Carlos 工作流任务（占位）",
    quote: "run dispatch workflow",
    scope: [],
    acceptance: [],
    confirmed: false,
    activation: true,
  });
  const actCardOk = r.ok && r.data?.ok === true;
  const actPending = r.ok ? (r.data?.state?.activation_pending || []) : [];
  check("15a. 激活占位卡提交成功", actCardOk, actCardOk ? `pending=${actPending.join(",")}` : r.error);

  r = await call("flow_status", { sessionId: ACT_SID });
  const pendingShown = r.ok && Array.isArray(r.data?.activation_pending) && r.data.activation_pending.length === 3;
  check("15b. flow_status 暴露 activation_pending", pendingShown, r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  r = await call("flow_claim", { sessionId: ACT_SID, role: "executor" });
  const claimBlocked = r.ok === false && /占位卡/.test(r.error || "");
  check("15c. 占位卡未补齐时 claim 被拒", claimBlocked, r.ok ? "未被拒绝（异常）" : "已拒绝");

  r = await call("flow_dispatch", { sessionId: ACT_SID, role: "executor" });
  const dispatchBlocked = r.ok === false && /占位卡/.test(r.error || "");
  check("15d. 占位卡未补齐时 dispatch 被拒", dispatchBlocked, r.ok ? "未被拒绝（异常）" : "已拒绝");

  // 15e. 防假闭环：占位卡未补齐时不能记 PASS 裁定
  r = await call("flow_verdict", { sessionId: ACT_SID, verdict: "PASS", notes: "占位卡直接通过" });
  const verdictBlocked = r.ok === false && /占位卡/.test(r.error || "");
  check("15e. 占位卡未补齐时 verdict 被拒（防假闭环）", verdictBlocked, r.ok ? "未被拒绝（异常）" : "已拒绝");

  r = await call("flow_status", { sessionId: ACT_SID });
  const notClosed = r.ok && r.data?.completed_ok !== true;
  check("15f. 占位卡状态未标记为完成", notClosed, r.ok ? `completed_ok=${r.data?.completed_ok}` : r.error);

  // 16. 补齐后重新提交完整卡 → 闸门解除
  r = await call("flow_submit_requirement", {
    sessionId: ACT_SID,
    goal: "给 README 补一段说明",
    quote: "run dispatch workflow",
    scope: ["README.md"],
    acceptance: ["README 含新增段落"],
    verify: { cmd: "node -e \"process.exit(0)\"" },
    confirmed: true,
  });
  const refillOk = r.ok && r.data?.ok === true && r.data?.tier === "single_file";
  check("16a. 补齐后重新提交完整卡", refillOk, r.ok ? `tier=${r.data?.tier}` : r.error);

  r = await call("flow_status", { sessionId: ACT_SID });
  const cleared = r.ok && Array.isArray(r.data?.activation_pending) && r.data.activation_pending.length === 0;
  check("16b. 补齐后 activation_pending 清空", cleared, r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  r = await call("flow_claim", { sessionId: ACT_SID, role: "executor" });
  check("16c. 补齐后 claim 放行", r.ok && r.data?.ok === true, r.ok ? "" : r.error);

  // 16d. 防绕过：不能靠「空 scope 的普通卡」清掉激活闸门
  const BYPASS_SID = SID + "-bypass";
  await call("flow_add_user_msg", { sessionId: BYPASS_SID, text: "run dispatch workflow" });
  await call("flow_submit_requirement", {
    sessionId: BYPASS_SID, goal: "占位", quote: "run dispatch workflow",
    scope: [], acceptance: [], confirmed: false, activation: true,
  });
  // 尝试提交一张 scope 为空的普通卡（不带 activation）
  r = await call("flow_submit_requirement", {
    sessionId: BYPASS_SID, goal: "试图绕过", quote: "run dispatch workflow",
    scope: [], acceptance: [], confirmed: false,
  });
  r = await call("flow_status", { sessionId: BYPASS_SID });
  const gateHeld = r.ok && Array.isArray(r.data?.activation_pending) && r.data.activation_pending.length === 3;
  check("16d. 空 scope 提交无法解除激活闸门", gateHeld,
    r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  r = await call("flow_claim", { sessionId: BYPASS_SID, role: "executor" });
  const bypassBlocked = r.ok === false && /占位卡/.test(r.error || "");
  check("16e. 绕过尝试后 claim 仍被拒", bypassBlocked, r.ok ? "未被拒绝（异常）" : "已拒绝");

  // 17. 客户端激活路径（防退化）：必须真的执行了动作，而不只是打印日志
  // 这一组跑的是真实客户端进程，断言的是**服务端状态真的变了**，
  // 而不是 stderr 里那句「已执行激活步骤」——只要把 checkTrigger 里的
  // callMCP 换成空实现，这里就会失败。
  const CLI_SID = SID + "-cli";
  const cli = await runClient("flow_status", {
    sessionId: CLI_SID,
    triggerMessage: "run dispatch workflow",
  });
  const loggedAdd = /已执行激活步骤：flow_add_user_msg/.test(cli.stderr || "");
  const loggedCard = /已执行激活步骤：flow_submit_requirement/.test(cli.stderr || "");
  check("17a. 客户端输出激活日志", loggedAdd && loggedCard,
    `add=${loggedAdd} card=${loggedCard}${cli.ok ? "" : " | " + cli.error}`);

  // 关键断言：服务端状态必须真的改变（has_card + activation_pending）
  r = await call("flow_status", { sessionId: CLI_SID });
  const reallyActivated = r.ok && r.data?.has_card === true &&
    Array.isArray(r.data?.activation_pending) && r.data.activation_pending.length === 3;
  check("17b. 激活真实改变了服务端状态（非仅打印日志）", reallyActivated,
    r.ok ? `has_card=${r.data?.has_card} pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  // 17c. 客户端激活后，闸门对该会话同样生效
  r = await call("flow_claim", { sessionId: CLI_SID, role: "executor" });
  const cliGate = r.ok === false && /占位卡/.test(r.error || "");
  check("17c. 客户端激活后闸门生效", cliGate, r.ok ? "未被拒绝（异常）" : "已拒绝");

  // 18. 不传 triggerMessage → 不启用自动触发（防自伤）
  // 早先的兜底项是「工具名 + 参数 JSON」，参数里含触发词时会自己给自己开占位卡，
  // 导致同一次调用的 flow_dispatch 反被闸门拒绝（自伤）。
  const NO_TRIG_SID = SID + "-notrig";
  const noTrig = await runClient("flow_status", {
    sessionId: NO_TRIG_SID,
    message: "run the dispatch workflow",   // 参数里故意含触发词
  });
  const noTrigLogged = /已执行激活步骤/.test(noTrig.stderr || "");
  check("18a. 未传 triggerMessage 时不自动激活", !noTrigLogged,
    noTrigLogged ? "意外激活了（自伤）" : "未激活");

  r = await call("flow_status", { sessionId: NO_TRIG_SID });
  const noTrigCard = r.ok && r.data?.has_card !== true;
  check("18b. 未传 triggerMessage 时服务端无任务卡", noTrigCard,
    r.ok ? `has_card=${r.data?.has_card}` : r.error);

  // 18c. 该会话仍可正常走完整流程（没有被自伤污染）
  r = await call("flow_add_user_msg", { sessionId: NO_TRIG_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: NO_TRIG_SID, goal: "正常流程不受影响",
    quote: QUOTE, scope: [ROOT + "/README.md"],
    acceptance: ["能正常提交"], confirmed: true,
  });
  check("18c. 同一会话仍可正常提交完整卡", r.ok && r.data?.ok === true, r.ok ? "" : r.error);

  // 19. 半补齐不算补齐（独立 QA 审计发现的绕过路径）
  // activation_pending 宣称待补 scope/acceptance/verify.cmd，
  // 但早期释放判据只看 scope 非空 → 只补 scope 就能解闸 → PASS → completed_ok=true。
  const HALF_SID = SID + "-half";
  await call("flow_add_user_msg", { sessionId: HALF_SID, text: "run dispatch workflow" });
  await call("flow_submit_requirement", {
    sessionId: HALF_SID, goal: "占位", quote: "run dispatch workflow",
    scope: [], acceptance: [], confirmed: false, activation: true,
  });
  // 只补 scope，acceptance 与 verify.cmd 仍缺
  r = await call("flow_submit_requirement", {
    sessionId: HALF_SID, goal: "只补了 scope", quote: "run dispatch workflow",
    scope: [ROOT + "/README.md"], acceptance: [], confirmed: true,
  });
  r = await call("flow_status", { sessionId: HALF_SID });
  const halfPending = r.ok && Array.isArray(r.data?.activation_pending) &&
    r.data.activation_pending.length > 0 && !r.data.activation_pending.includes("scope");
  check("19a. 只补 scope 不足以解除闸门", halfPending,
    r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  r = await call("flow_claim", { sessionId: HALF_SID, role: "executor" });
  check("19b. 半补齐后 claim 仍被拒", r.ok === false && /占位卡/.test(r.error || ""),
    r.ok ? "未被拒绝（异常）" : "已拒绝");

  r = await call("flow_verdict", { sessionId: HALF_SID, verdict: "PASS" });
  check("19c. 半补齐后 verdict 仍被拒", r.ok === false, r.ok ? "未被拒绝（异常）" : "已拒绝");

  // 19d. 三项补齐后才真正解闸
  r = await call("flow_submit_requirement", {
    sessionId: HALF_SID, goal: "三项齐全", quote: "run dispatch workflow",
    scope: [ROOT + "/README.md"], acceptance: ["补齐验收标准"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  r = await call("flow_status", { sessionId: HALF_SID });
  const fullyCleared = r.ok && Array.isArray(r.data?.activation_pending) && r.data.activation_pending.length === 0;
  check("19d. 三项补齐后闸门解除", fullyCleared,
    r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  // 20. 未派发就记 PASS 裁定 → 必须被拒（防假闭环之二）
  const NO_DISPATCH_SID = SID + "-nodispatch";
  await call("flow_add_user_msg", { sessionId: NO_DISPATCH_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: NO_DISPATCH_SID, goal: "只提交不派发", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["x"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  r = await call("flow_verdict", { sessionId: NO_DISPATCH_SID, verdict: "PASS", notes: "没派发就想通过" });
  const noDispatchBlocked = r.ok === false && /尚未派发/.test(r.error || "");
  check("20a. 未派发直接 PASS 被拒", noDispatchBlocked, r.ok ? "未被拒绝（异常）" : "已拒绝");

  // 20b. 未派发时 DIRECTION / LOCAL 仍可记录（返工意见不要求已完成派发）
  r = await call("flow_verdict", { sessionId: NO_DISPATCH_SID, verdict: "DIRECTION", notes: "方向需要调整" });
  check("20b. 未派发时 DIRECTION 可记录（不误伤）", r.ok && r.data?.verdict === "DIRECTION", r.ok ? "" : r.error);

  r = await call("flow_status", { sessionId: NO_DISPATCH_SID });
  check("20b. 未派发时 completed_ok 保持 false", r.ok && r.data?.completed_ok !== true,
    r.ok ? `completed_ok=${r.data?.completed_ok}` : r.error);

  // 21. 空 scope 的卡：任何改动都算越界（fail-closed）
  const EMPTY_SCOPE_SID = SID + "-emptyscope";
  await call("flow_add_user_msg", { sessionId: EMPTY_SCOPE_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: EMPTY_SCOPE_SID, goal: "空 scope", quote: QUOTE,
    scope: [], acceptance: ["x"], confirmed: true,
  });
  r = await call("flow_check_scope", { sessionId: EMPTY_SCOPE_SID, paths: [ROOT + "/README.md", ROOT + "/src/index.js"] });
  const emptyScopeClosed = r.ok && r.data?.ok === false && (r.data?.violations || []).length === 2;
  check("21. 空 scope 对任意改动都判越界（fail-closed）", emptyScopeClosed,
    r.ok ? `ok=${r.data?.ok} violations=${JSON.stringify(r.data?.violations)}` : r.error);

  // 22. 审计链可追溯：激活建立 / 闸门解除都有专属事件
  r = await call("flow_audit", { sessionId: HALF_SID, limit: 100 });
  const actKinds = r.ok ? (r.data?.by_kind || {}) : {};
  const traceable = actKinds.activation >= 1 && actKinds.activation_released >= 1 && actKinds.activation_gate_held >= 1;
  check("22. 审计链含 activation / activation_released / activation_gate_held", traceable,
    r.ok ? `kinds=${Object.keys(actKinds).join(",")}` : r.error);

  console.log(results.join("\n"));
  console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
  console.log(`sessionId=${SID}`);
  cleanupBridge();
  process.exit(fail > 0 ? 1 : 0);
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

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
