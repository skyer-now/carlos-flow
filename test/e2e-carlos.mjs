// Carlos 工作流 · 完整端到端测试（12 工具 + 审计链验证）
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

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

/**
 * 执行一个 node 脚本并捕获 stdout（用于断言发布脚本的结构化输出，如推送顺序）。
 * 与 runClient 分开：这个不经过 MCP/bridge，是直接跑仓库里的脚本。
 */
function runNodeScript(scriptPath, argsArr = []) {
  return new Promise((resolve) => {
    const p = spawn("node", [scriptPath, ...argsArr], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: ROOT,
      env: { ...process.env, CARLOS_FLOW_HOME: FLOW_HOME },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, stdout: out, stderr: err, error: "timeout" }); }, 30000);
    p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, stdout: out, stderr: err, error: "spawn: " + e.message }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); });
  });
}

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
    acceptance: ["12 个工具全部可用"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
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

  // 7b. flow_run_verify —— 记 PASS 的前置证据（真实验证必须跑通）
  r = await call("flow_run_verify", { sessionId: SID });
  check("7b. flow_run_verify 真实执行 verify.cmd", r.ok && r.data?.ok === true && r.data?.exitCode === 0,
    r.ok ? `ok=${r.data?.ok} exitCode=${r.data?.exitCode}` : r.error);

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

  // 19d-2. 闸门解除后**再提交一张普通卡**，不得重新上闸。
  //
  // 这一条专门盯住「普通卡分支的 activationPending」那几行：
  // 正确实现是 `activationPending = currentMissing`（按**当前卡片内容**派生），
  // 而变异体 M9 把它退回 `prevPendingBefore`（传递上一轮的 pending）。
  // 两者在「激活 → 补齐 → 再提交普通卡」这个序列下才会分岔：
  //   正确 → 当前卡齐备 → pending=[] → 放行
  //   M9   → 沿用上一轮 pending → 又被锁住 → 用户永远解不开闸
  // 缺了这一条，M9 就会一直 NOT CAUGHT（历史守护缺口）。
  const AFTER_SID = SID + "-after-clear";
  await call("flow_add_user_msg", { sessionId: AFTER_SID, text: QUOTE });
  // 先开一张占位卡（激活过 → 标记 activation_activated）
  await call("flow_submit_requirement", {
    sessionId: AFTER_SID, goal: "占位", quote: QUOTE,
    scope: [], acceptance: [], confirmed: true, activation: true,
  });
  // 再提交一张字段齐全的普通卡
  r = await call("flow_submit_requirement", {
    sessionId: AFTER_SID, goal: "齐全的普通卡", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["验收标准"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  r = await call("flow_status", { sessionId: AFTER_SID });
  const afterClearPending = r.ok && Array.isArray(r.data?.activation_pending) ? r.data.activation_pending : [];
  check("19d-2. 激活过之后提交齐全的普通卡，不得重新上闸（M9 守护）",
    r.ok && afterClearPending.length === 0,
    r.ok ? `pending=${afterClearPending.join(",")}` : r.error);

  // 19d-3. 状态文件出现**不一致组合**（pending 非空但 activation_activated=false）时，
  //         提交普通卡必须能**自愈**（清空 pending），而不是把用户永久锁死。
  //
  // 这一条专门盯住「普通卡分支」的 activationPending 赋值：
  //   正确实现 → activationPending = []      （普通卡不上闸）
  //   变异体 M9 → activationPending = prevPendingBefore （沿用上一轮的 pending）
  // 在正常流程下两者等价（未激活过的会话本就没有 pending），
  // 只有在「状态文件被写成不一致组合」时才会分岔 —— 而那正是用户被锁死、
  // 门禁变成死锁的场景。所以直接构造这个状态来验证。
  const INCONSIST_SID = SID + "-inconsistent";
  const stateDir = join(FLOW_HOME, "gate-state", "runs", INCONSIST_SID);
  mkdirSync(stateDir, { recursive: true });
  // state.json 可能还不存在（新会话）—— 用 defaultState 的字段集打底
  const statePath = join(stateDir, "state.json");
  const prevState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8") || "{}") : {};
  writeFileSync(statePath, JSON.stringify({
    ...prevState,
    activation_pending: ["scope", "acceptance", "verify.cmd"],
    activation_activated: false,
    card: null,
  }, null, 2), "utf8");
  await call("flow_add_user_msg", { sessionId: INCONSIST_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: INCONSIST_SID, goal: "自愈用的普通卡", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["验收标准"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  r = await call("flow_status", { sessionId: INCONSIST_SID });
  const inconsistPending = r.ok && Array.isArray(r.data?.activation_pending) ? r.data.activation_pending : [];
  check("19d-3. 不一致状态下提交普通卡能自愈，不被旧 pending 锁死（M9 守护）",
    r.ok && inconsistPending.length === 0,
    r.ok ? `pending=${inconsistPending.join(",")}` : r.error);

  // 19e. 占位卡的待补项必须由**服务端从卡片内容派生**，而不是硬编码三项。
  // 这一条专门盯住「activationPending = currentMissing」这一行：
  // 若它被退回硬编码 ["scope","acceptance","verify.cmd"]，本用例会变红。
  // （否则派生逻辑与硬编码在现有用例下不可区分 —— 变异体 M11 逃逸的根因。）
  const PARTIAL_SID = SID + "-partial";
  await call("flow_add_user_msg", { sessionId: PARTIAL_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: PARTIAL_SID, goal: "占位（已带 scope）", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: [], confirmed: true, activation: true,
  });
  r = await call("flow_status", { sessionId: PARTIAL_SID });
  const derivedPending = r.ok && Array.isArray(r.data?.activation_pending) &&
    r.data.activation_pending.length === 2 &&
    !r.data.activation_pending.includes("scope") &&
    r.data.activation_pending.includes("acceptance") &&
    r.data.activation_pending.includes("verify.cmd");
  check("19e. 占位卡待补项由服务端从卡片内容派生（非硬编码三项）", derivedPending,
    r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  // 19f. 规则③正向断言：普通卡（未标 activation、此前也未被锁）**不上闸门**。
  // 即：字段完整性只由 validateCard 按风险档强制（read_only 只要 goal+quote），
  // 激活闸门不重复拦截普通卡 —— 否则会误伤 T1 只读调研。
  // 变异体 M10（把普通卡也上闸）会让本用例变红。
  const PLAIN_SID = SID + "-plain";
  await call("flow_add_user_msg", { sessionId: PLAIN_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: PLAIN_SID, goal: "普通卡（字段不齐）", quote: QUOTE,
    scope: [], acceptance: [], confirmed: false,
  });
  r = await call("flow_status", { sessionId: PLAIN_SID });
  const plainNoGate = r.ok && Array.isArray(r.data?.activation_pending) &&
    r.data.activation_pending.length === 0;
  check("19f. 普通卡不上激活闸门（不误伤只读调研）", plainNoGate,
    r.ok ? `pending=${(r.data?.activation_pending || []).join(",")}` : r.error);

  // 19g. 同上，但普通卡字段齐全 —— 必须能正常 claim（证明不是「一律锁死」）
  const PLAIN_FULL_SID = SID + "-plainfull";
  await call("flow_add_user_msg", { sessionId: PLAIN_FULL_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: PLAIN_FULL_SID, goal: "普通卡（字段齐全）", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["验收项"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  r = await call("flow_claim", { sessionId: PLAIN_FULL_SID, role: "executor" });
  const plainFullClaim = r.ok && r.data?.ok === true;
  check("19g. 普通卡（字段齐全）可正常 claim", plainFullClaim, r.ok ? "" : r.error);

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

  // 23. 真实验证闸门（防假闭环之三）：记 PASS 必须有**验证通过**的证据
  //     ——验证失败时 PASS 必须被拒；DIRECTION / LOCAL 不受影响（返工意见不误伤）。
  const VF_SID = SID + "-verifyfail";
  await call("flow_add_user_msg", { sessionId: VF_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: VF_SID, goal: "验证失败不许记 PASS", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["验证失败时 PASS 必须被拒"],
    verify: { cmd: "node -e \"process.exit(3)\"" }, confirmed: true,
  });
  const vfSubmitted = r.ok && r.data?.ok === true;
  await call("flow_claim", { sessionId: VF_SID, role: "executor" });
  await call("flow_dispatch", { sessionId: VF_SID, role: "executor", message: "只读检查", run: false });
  r = await call("flow_run_verify", { sessionId: VF_SID });
  const vfRan = r.ok && r.data?.ok === false && r.data?.exitCode === 3;
  check("23a. verify.cmd 失败时 run_verify 如实报失败", vfSubmitted && vfRan,
    r.ok ? `ok=${r.data?.ok} exitCode=${r.data?.exitCode}` : r.error);

  r = await call("flow_verdict", { sessionId: VF_SID, verdict: "PASS", notes: "验证没过就想通过" });
  const vfPassBlocked = r.ok === false && /验证/.test(r.error || "");
  check("23b. 验证失败时记 PASS 被拒（不认执行者自述）", vfPassBlocked,
    r.ok ? "未被拒绝（异常）" : "已拒绝");

  r = await call("flow_verdict", { sessionId: VF_SID, verdict: "DIRECTION", notes: "方向要调整" });
  check("23c. 验证失败时 DIRECTION 仍可记录（不误伤）", r.ok && r.data?.verdict === "DIRECTION",
    r.ok ? "" : r.error);

  // 23d. run_verify 的工作目录优先级：显式 cwd > 卡片提交时的项目目录 > server 进程 cwd
  //      旧实现只用 process.cwd() —— MCP server 是**常驻进程**，cwd 是启动时的目录
  //      （可能是几个月前的旧仓库）→ verify.cmd 在错误目录跑，路径全错，
  //      门禁把这种失败当成「验证不通过」→ 真 PASS 被误杀。
  const VD_SID = SID + "-verifycwd";
  await call("flow_add_user_msg", { sessionId: VD_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: VD_SID, goal: "verify 工作目录回落到卡片项目目录", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["verify 在卡片项目目录执行"],
    verify: { cmd: "node -e \"process.stdout.write(process.cwd())\"" }, confirmed: true,
  });
  const vdSubmitted = r.ok && r.data?.ok === true;
  await call("flow_claim", { sessionId: VD_SID, role: "executor" });
  await call("flow_dispatch", { sessionId: VD_SID, role: "executor", message: "只读检查", run: false });
  r = await call("flow_run_verify", { sessionId: VD_SID });
  const vdCwd = String(r.data?.stdout || "").trim();
  // ROOT 可能是 `.../test/..` 形式（REPO_ROOT 推导），需 resolve 归一
  const normRoot = resolve(ROOT).replace(/\\/g, "/").toLowerCase();
  const normCwd = vdCwd.replace(/\\/g, "/").toLowerCase();
  const vdFallbackOk = vdSubmitted && r.ok && r.data?.ok === true &&
    (normCwd === normRoot || normCwd.endsWith("/" + normRoot.split("/").pop()));
  check("23d. run_verify 工作目录回落到卡片项目目录（不用 server 的陈旧 cwd）", vdFallbackOk,
    r.ok ? `cwd=${vdCwd} expected=${resolve(ROOT)}` : r.error);

  // 24. 从未跑过 flow_run_verify 就记 PASS → 必须被拒；跑通后放行
  const NV_SID = SID + "-noverify";
  await call("flow_add_user_msg", { sessionId: NV_SID, text: QUOTE });
  r = await call("flow_submit_requirement", {
    sessionId: NV_SID, goal: "没验证就想通过", quote: QUOTE,
    scope: [ROOT + "/README.md"], acceptance: ["未验证时 PASS 必须被拒"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  const nvSubmitted = r.ok && r.data?.ok === true;
  await call("flow_claim", { sessionId: NV_SID, role: "executor" });
  await call("flow_dispatch", { sessionId: NV_SID, role: "executor", message: "只读检查", run: false });
  r = await call("flow_verdict", { sessionId: NV_SID, verdict: "PASS", notes: "没跑过验证就想通过" });
  const nvPassBlocked = r.ok === false && /验证/.test(r.error || "");
  check("24a. 从未跑过 flow_run_verify 就记 PASS 被拒", nvSubmitted && nvPassBlocked,
    r.ok ? "未被拒绝（异常）" : "已拒绝");

  r = await call("flow_run_verify", { sessionId: NV_SID });
  const nvRan = r.ok && r.data?.ok === true;
  r = await call("flow_verdict", { sessionId: NV_SID, verdict: "PASS", notes: "验证已跑通" });
  const nvPassOk = r.ok && r.data?.verdict === "PASS" && r.data?.completed_ok === true;
  check("24b. 验证通过后记 PASS 放行", nvRan && nvPassOk, r.ok ? "" : r.error);

  r = await call("flow_status", { sessionId: NV_SID });
  check("24c. flow_status 暴露 verify_passed（验证是否真的通过）",
    r.ok && r.data?.verify_passed === true, r.ok ? `verify_passed=${r.data?.verify_passed}` : r.error);

  // 25. 发布推送序列守护：单包统一发布 carlos-flow
  const relOut = await runNodeScript(path.join(ROOT, "scripts", "release.mjs"), ["--print-push-sequence"]);
  let pushSeq = [];
  try {
    pushSeq = JSON.parse(String(relOut.stdout || "").trim() || "[]");
  } catch {
    /* 解析失败 → 25a 会红 */
  }
  const pushRepos = Array.isArray(pushSeq) ? pushSeq.map((x) => x && x.repo) : [];
  const cindyIdx = pushRepos.indexOf("carlos-flow");
  check("25a. release.mjs 暴露有序推送序列（--print-push-sequence）",
    relOut.ok && Array.isArray(pushSeq) && pushSeq.length >= 1 && cindyIdx >= 0,
    relOut.ok ? `order=${pushRepos.join(",")}` : String(relOut.stderr || relOut.error || "").slice(0, 160));
  check("25b. 推送序列包含 carlos-flow（单包统一发布）",
    cindyIdx >= 0, `order=${pushRepos.join(",")}`);

  // 26. MCP 路径的智能触发（历史缺陷：触发引擎只接在 CLI 客户端上，
  //     MCP server 根本不接触发引擎 —— 在 OpenCode / Cindy 里直接用 MCP 工具时，
  //     「工作流会自己认出该上场的时候」是假的）。
  // 现在 MCP server 暴露 flow_trigger_check，宿主可在消息事件里调用它。
  const TRIG_SID = SID + "-trigger";
  const TRIG_MSG = "走门禁流程，执行 dispatch 任务";
  r = await call("flow_trigger_check", { sessionId: TRIG_SID, message: TRIG_MSG });
  const trigActivated = r.ok && r.data?.activated === true && r.data?.has_card === true;
  check("26a. MCP 路径：中文流程消息能自动激活（开卡 + 写入用户原话）", trigActivated,
    r.ok ? `decision=${r.data?.decision} score=${r.data?.score} activated=${r.data?.activated}` : r.error);

  r = await call("flow_status", { sessionId: TRIG_SID });
  const trigPending = Array.isArray(r.data?.activation_pending) ? r.data.activation_pending : [];
  check("26b. 自动激活后进入门禁态（待补 scope/acceptance/verify.cmd）",
    r.ok && r.data?.has_card === true && trigPending.length === 3,
    r.ok ? `pending=${JSON.stringify(trigPending)}` : r.error);

  r = await call("flow_claim", { sessionId: TRIG_SID, role: "executor" });
  check("26c. 自动激活后补齐前不许派发（闸门拦住）", r.ok === false, r.ok ? "竟然放行了" : "已拒绝");

  const TRIG_NS = SID + "-trigger-ns";
  r = await call("flow_trigger_check", { sessionId: TRIG_NS, message: "给登录接口加一个参数校验" });
  const nsNotTriggered = r.ok && r.data?.decision === "ignore" && r.data?.activated !== true;
  check("26d. 普通中文需求不误触发（不激活、不开卡）", nsNotTriggered,
    r.ok ? `decision=${r.data?.decision} score=${r.data?.score}` : r.error);

  r = await call("flow_status", { sessionId: TRIG_NS });
  check("26e. 未触发时不开卡（has_card 保持 false）", r.ok && r.data?.has_card === false,
    r.ok ? `has_card=${r.data?.has_card}` : r.error);

  r = await call("flow_trigger_check", { sessionId: SID + "-trigger-noscore", message: TRIG_MSG, execute: false });
  check("26f. execute=false 时只评分不动作", r.ok && r.data?.execute_suppressed === true && r.data?.activated !== true,
    r.ok ? `suppressed=${r.data?.execute_suppressed} decision=${r.data?.decision}` : r.error);

  const TRIG_NS2 = SID + "-trigger-ns2";
  r = await call("flow_status", { sessionId: TRIG_NS2 });
  check("26g. execute=false 时不开卡", r.ok && r.data?.has_card === false,
    r.ok ? `has_card=${r.data?.has_card}` : r.error);

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
