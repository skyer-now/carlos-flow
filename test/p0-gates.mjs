// P0 门禁专项验证：逐条核对审核报告指出的 8 项门禁机制
import { spawn } from "node:child_process";
import fs from "node:fs";

import os from 'node:os';
import { join, dirname } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 状态/审计根目录默认值：与 src/state.js 的 FLOW_HOME 保持一致（跨平台）
const DEFAULT_FLOW_HOME = join(os.homedir(), '.carlos-flow');

// 仓库根目录：优先环境变量，缺失时回退到本脚本所在目录的上一级（= 仓库根）
const REPO_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const ROOT = process.env.CARLOS_FLOW_MCP_ROOT || REPO_ROOT;
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

  // --- 11. 激活占位卡闸门（独立 QA 审计补齐） ---
  const actSid = "p0-activation-" + Date.now();
  await call("flow_add_user_msg", { sessionId: actSid, text: "run dispatch workflow" });
  r = await call("flow_submit_requirement", {
    sessionId: actSid, goal: "占位", quote: "run dispatch workflow",
    scope: [], acceptance: [], confirmed: false, activation: true,
  });
  check("10. 激活占位卡提交成功",
    r.ok && r.data?.ok === true && (r.data?.state?.activation_pending || []).length === 3,
    r.ok ? `pending=${(r.data?.state?.activation_pending || []).join(",")}` : r.error);

  r = await call("flow_claim", { sessionId: actSid, role: "executor" });
  check("11. 占位卡未补齐时 claim 被拒",
    r.ok === false && /占位卡/.test(r.error || ""),
    (r.error||"").slice(0,70));

  r = await call("flow_verdict", { sessionId: actSid, verdict: "PASS" });
  check("12. 占位卡未补齐时 verdict 被拒（防假闭环）",
    r.ok === false && /占位卡/.test(r.error || ""),
    (r.error||"").slice(0,70));

  // --- 12. 未派发直接 PASS 必须被拒 ---
  const noDispSid = "p0-nodispatch-" + Date.now();
  await call("flow_add_user_msg", { sessionId: noDispSid, text: "quote here" });
  r = await call("flow_submit_requirement", {
    sessionId: noDispSid, goal: "只提交不派发", quote: "quote here",
    scope: [ROOT + "/README.md"], acceptance: ["x"],
    verify: { cmd: "node -e \"process.exit(0)\"" }, confirmed: true,
  });
  r = await call("flow_verdict", { sessionId: noDispSid, verdict: "PASS" });
  check("13. 未派发直接 PASS 被拒",
    r.ok === false && /尚未派发/.test(r.error || ""),
    (r.error||"").slice(0,70));

  // --- 13. 空 scope 必须 fail-closed ---
  const emptyScopeSid = "p0-emptyscope-" + Date.now();
  await call("flow_add_user_msg", { sessionId: emptyScopeSid, text: "quote here" });
  r = await call("flow_submit_requirement", {
    sessionId: emptyScopeSid, goal: "空 scope", quote: "quote here",
    scope: [], acceptance: ["x"], confirmed: true,
  });
  r = await call("flow_check_scope", { sessionId: emptyScopeSid, paths: [ROOT + "/README.md"] });
  check("14. 空 scope 对任意改动都判越界",
    r.ok && r.data?.ok === false && (r.data?.violations || []).length === 1,
    r.ok ? `ok=${r.data?.ok} violations=${JSON.stringify(r.data?.violations)}` : r.error);

  // --- 15. acceptance 伪填充必须被拒（不能解开闸门）---
  // acceptance=[""] / [null] / [0] / [{}] 这类「长度>0 但内容无效」的伪填充，
  // 若被判为「已填」，验收标准就形同虚设。
  //
  // 注意：acceptance 只在 **cross_module / sensitive** 档才是必填项
  // （single_file 档的必填项只有 goal+quote+scope），
  // 所以这里必须用**两个以上 scope 文件**触发 cross_module 档才能测到必填校验。
  //
  // 另一个坑：flow_submit_requirement 的「卡片不合规」是**正常的 MCP 响应**
  // （JSON 里 ok:false），**不是** isError —— 所以判定要看 r.data.ok，
  // 不能看 r.ok（r.ok 只表示「这次工具调用本身有没有报错」）。
  const fakeAccSid = "p0-fakeacc-" + Date.now();
  await call("flow_add_user_msg", { sessionId: fakeAccSid, text: "quote here" });
  r = await call("flow_submit_requirement", {
    sessionId: fakeAccSid, goal: "伪填充 acceptance", quote: "quote here",
    scope: [ROOT + "/README.md", ROOT + "/src/index.js"],
    files: [{ path: ROOT + "/README.md", line: 1 }, { path: ROOT + "/src/index.js", line: 1 }],
    acceptance: [""], confirmed: true,
  });
  check("15. acceptance=[\"\"] 被拒（cross_module 档 · 伪填充不算已填）",
    r.data?.ok === false && /acceptance/.test(r.data?.reason || ""),
    (r.data?.reason || r.error || "").slice(0,70));

  // 同理：[null] / [0] / [{}] / ["","  "] 都必须被拒
  const fakeVariants = [[null], [0], [{}], ["", "  "]];
  let allRejected = true;
  const details = [];
  for (const acc of fakeVariants) {
    const sid = "p0-fakeacc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    await call("flow_add_user_msg", { sessionId: sid, text: "quote here" });
    const rr = await call("flow_submit_requirement", {
      sessionId: sid, goal: "伪填充 acceptance", quote: "quote here",
      scope: [ROOT + "/README.md", ROOT + "/src/index.js"],
      files: [{ path: ROOT + "/README.md", line: 1 }, { path: ROOT + "/src/index.js", line: 1 }],
      acceptance: acc, confirmed: true,
    });
    if (rr.data?.ok !== false) { allRejected = false; details.push(`${JSON.stringify(acc)}→被接受`); }
  }
  check("16. acceptance=[null]/[0]/[{}]/[\"\",\"  \"] 全部被拒",
    allRejected, details.join("; ") || "4 种伪填充均被拒");

  // 合法的 acceptance 必须仍然通过（防止把门禁收得过紧误伤正常流程）
  const goodAccSid = "p0-goodacc-" + Date.now();
  await call("flow_add_user_msg", { sessionId: goodAccSid, text: "quote here" });
  r = await call("flow_submit_requirement", {
    sessionId: goodAccSid, goal: "合法 acceptance", quote: "quote here",
    scope: [ROOT + "/README.md", ROOT + "/src/index.js"],
    files: [{ path: ROOT + "/README.md", line: 1 }, { path: ROOT + "/src/index.js", line: 1 }],
    acceptance: ["README 首行改成中文标题"], confirmed: true,
  });
  check("18. 合法 acceptance 不被误伤（cross_module 档通过）",
    r.data?.ok === true,
    r.data?.ok ? `tier=${r.data?.tier}` : (r.data?.reason || r.error || "").slice(0, 60));

  // 激活闸门场景：伪填充不得让闸门误判为「已补齐」
  const fakeGateSid = "p0-fakegate-" + Date.now();
  await call("flow_add_user_msg", { sessionId: fakeGateSid, text: "quote here" });
  r = await call("flow_submit_requirement", {
    sessionId: fakeGateSid, goal: "伪填充开闸", quote: "quote here",
    scope: [ROOT + "/README.md"], acceptance: [""], verify: { cmd: "node -e \"process.exit(0)\"" },
    confirmed: true, activation: true,
  });
  const gatePending = r.data?.state?.activation_pending || [];
  check("17. 伪填充 acceptance 时闸门仍记为待补（不解闸）",
    r.data?.ok === false || gatePending.includes("acceptance"),
    r.data?.ok === false ? "卡片被拒（合规）" : `pending=${gatePending.join(",")}`);

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
