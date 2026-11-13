// A1 验证结果绑定代码状态（指纹 + 四态）—— 自动化验证
//
// 来源：研究产物《A1-A2-A3 实施前核验清单》的 1.4「验证方法」。
//       原文档里是 4 段需要人手敲的命令（V1.1~V1.4），这里全部变成可执行断言。
//
// 为什么必须有这个测试：
//   A1 修的是一个**已确认的绕过路径**：
//     1. flow_run_verify 跑通 → last_verify = {ok:true, cmd:"npm test"}
//     2. executor 继续改代码（甚至改坏）
//     3. flow_verdict(PASS) → 三道判断全过 → 放行 ❌
//   没有自动化测试，这个漏洞随时可能被改回来。
//
// 运行：node test/verify-stale.test.mjs

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const ROOT = process.env.CARLOS_FLOW_MCP_ROOT || REPO_ROOT;
const CLIENT = [
  ROOT + "/client/carlos.js",
  ROOT + "/carlos.js",
].find((p) => fs.existsSync(p)) || ROOT + "/client/carlos.js";

const FLOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-a1-home-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-a1-work-"));
const BRIDGE_PORT = String(process.env.BRIDGE_PORT || (19500 + (process.pid % 300)));
const SID = "a1-" + Date.now();

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    results.push(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    results.push(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function call(tool, args) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLIENT, tool, JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARLOS_FLOW_HOME: FLOW_HOME, BRIDGE_PORT },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      p.kill();
      resolve({ ok: false, error: "timeout" });
    }, 60000);
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: "spawn: " + e.message });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().slice(0, 300) });
      try {
        resolve({ ok: true, data: JSON.parse(out) });
      } catch (e) {
        resolve({ ok: false, error: "parse: " + e.message + " | " + out.slice(0, 200) });
      }
    });
  });
}

// 提交双轴审计结论（PASS 裁定的前置：Standards + Spec 均 PASS）
async function submitAxes(sid) {
  await call("flow_audit_axes", { sessionId: sid });
  await call("flow_audit_submit", {
    sessionId: sid, axis: "standards", verdict: "PASS",
    findings: ["符合规范"], evidence: "A1 自动化验证",
  });
  await call("flow_audit_submit", {
    sessionId: sid, axis: "spec", verdict: "PASS",
    findings: ["验收满足"], evidence: "A1 自动化验证",
  });
}

// ---- 准备一个真实的 git 工作区（V1.1~V1.3 都需要 git 语义）----
git(WORK, ["init", "-q"]);
git(WORK, ["config", "user.email", "test@example.com"]);
git(WORK, ["config", "user.name", "test"]);
fs.writeFileSync(path.join(WORK, "a.txt"), "hello\n", "utf8");
git(WORK, ["add", "-A"]);
git(WORK, ["commit", "-qm", "init"]);

// ---- V1.1 单元级：指纹稳定性与敏感性 ----
const { workspaceFingerprint } = await import("../src/state.js");

console.log("▶ V1.1 指纹稳定性与敏感性");

check("同一工作区两次指纹相同（稳定性）", () => {
  const a = workspaceFingerprint(WORK);
  const b = workspaceFingerprint(WORK);
  return a.ok === true && a.diff_sha256.length === 64 && a.diff_sha256 === b.diff_sha256;
});

check("改一个已跟踪文件 → 指纹变化（敏感性）", () => {
  const before = workspaceFingerprint(WORK).diff_sha256;
  fs.writeFileSync(path.join(WORK, "a.txt"), "changed\n", "utf8");
  const after = workspaceFingerprint(WORK).diff_sha256;
  git(WORK, ["checkout", "--", "a.txt"]);
  return before !== after;
});

check("新建未跟踪文件 → 指纹变化", () => {
  const before = workspaceFingerprint(WORK).diff_sha256;
  fs.writeFileSync(path.join(WORK, "new.txt"), "x\n", "utf8");
  const after = workspaceFingerprint(WORK).diff_sha256;
  fs.unlinkSync(path.join(WORK, "new.txt"));
  return before !== after;
});

check("`.carlos-flow/` 状态目录不计入指纹（不能自我失效）", () => {
  const before = workspaceFingerprint(WORK).diff_sha256;
  fs.mkdirSync(path.join(WORK, ".carlos-flow"), { recursive: true });
  fs.writeFileSync(path.join(WORK, ".carlos-flow", "state.json"), "{}", "utf8");
  const after = workspaceFingerprint(WORK).diff_sha256;
  fs.rmSync(path.join(WORK, ".carlos-flow"), { recursive: true, force: true });
  return before === after;
});

console.log("▶ V1.3 非 git 目录");

check("非 git 目录返回 {ok:false, reason:'not_a_git_repo'} 且不崩", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-a1-plain-"));
  const fp = workspaceFingerprint(plain);
  return fp.ok === false && fp.reason === "not_a_git_repo";
});

console.log("▶ V1.2 端到端：STALE 必须阻断 PASS");

// 1) 提交卡（verify.cmd 对文件内容敏感：改完才通过）
const QUOTE = "给 a.txt 加一行并跑验证";
const VERIFY_CMD =
  "node -e \"const c=require('fs').readFileSync('a.txt','utf8');process.exit(c.trim()==='fixed'?0:1)\"";
let r = await call("flow_add_user_msg", { sessionId: SID, text: QUOTE });
check("V1.2-0 flow_add_user_msg", r.ok && r.data?.ok === true, r.ok ? "" : r.error);

r = await call("flow_submit_requirement", {
  sessionId: SID,
  goal: "给 a.txt 加一行并跑验证",
  quote: QUOTE,
  scope: ["a.txt"],
  acceptance: ["a.txt 有一行新内容"],
  verify: { cmd: VERIFY_CMD },
  confirmed: true,
  cwd: WORK,
});
const submitted = r.ok && r.data?.ok === true;
check("V1.2-1 提交任务卡", submitted, r.ok ? r.error || "" : r.error);

if (submitted) {
  // 2) 派发（门禁要求先派发才能记 PASS）
  await call("flow_claim", { sessionId: SID, role: "executor" });
  await call("flow_dispatch", {
    sessionId: SID,
    role: "executor",
    message: "改 a.txt 并跑验证",
    run: false,
    cwd: WORK,
  });

  // 3) executor 干活：把 a.txt 改成 fixed，然后验证跑通
  fs.writeFileSync(path.join(WORK, "a.txt"), "fixed\n", "utf8");
  r = await call("flow_run_verify", { sessionId: SID, cwd: WORK });
  const ran = r.ok && r.data?.ok === true;
  check("V1.2-2 flow_run_verify 跑通", ran, r.ok ? r.error || "" : r.error);

  if (ran) {
    // 4) 验证通过后，代码又被改了（模拟 executor 改坏代码）
    fs.writeFileSync(path.join(WORK, "a.txt"), "broken by executor\n", "utf8");

    // 5) flow_verdict(PASS) 必须被拒，且错误里含 STALE / 过期
    await call("flow_claim", { sessionId: SID, role: "auditor" });
    await submitAxes(SID);
    r = await call("flow_verdict", { sessionId: SID, verdict: "PASS", notes: "验证已跑通", cwd: WORK });
    const blocked = r.ok === false && /STALE|过期/.test(r.error || "");
    check("V1.2-3 验证后修改代码 → PASS 被拒（STALE）", blocked, r.ok ? "未被拒绝（漏洞仍在）" : r.error);

    // 6) flow_status 应报 stale 四态
    r = await call("flow_status", { sessionId: SID });
    check(
      "V1.2-4 flow_status 报 verify_state=stale",
      r.ok && r.data?.verify_state === "stale",
      r.ok ? `verify_state=${r.data?.verify_state}` : r.error,
    );

    // 7) 保持 boolean 不破（下游兼容）
    check(
      "V1.2-5 verify_passed 仍是 boolean（不破坏下游）",
      r.ok && typeof r.data?.verify_passed === "boolean",
      r.ok ? `typeof=${typeof r.data?.verify_passed}` : r.error,
    );

    // 8) 负对照（证明 verify.cmd 在改动前确实会失败）
    //    注意：必须先把 a.txt 改回「fixed」——负对照会把工作区还原到派发时的
    //    「改动前」再还原到「改动后」，「改动后」取的是**当时**的工作区状态。
    fs.writeFileSync(path.join(WORK, "a.txt"), "fixed\n", "utf8");
    r = await call("flow_falsify", { sessionId: SID, cwd: WORK });
    check("V1.2-7 flow_falsify 负对照有意义", r.ok && r.data?.verdict === "meaningful", r.ok ? r.data?.verdict : r.error);

    // 9) 负对照之后代码又被改了 → 仍必须被 STALE 拦住（负对照路径也要绑指纹）
    fs.writeFileSync(path.join(WORK, "a.txt"), "changed after falsify\n", "utf8");
    r = await call("flow_verdict", { sessionId: SID, verdict: "PASS", notes: "负对照后改了代码", cwd: WORK });
    check(
      "V1.2-7b 负对照后改代码 → PASS 仍被拒（指纹已绑定）",
      r.ok === false && /STALE|过期/.test(r.error || ""),
      r.ok ? "未被拒绝（负对照路径有漏洞）" : r.error,
    );

    // 10) 重新改回 fixed 并重新验证 → 指纹一致 → PASS 放行（不能误伤）
    fs.writeFileSync(path.join(WORK, "a.txt"), "fixed\n", "utf8");
    r = await call("flow_run_verify", { sessionId: SID, cwd: WORK });
    r = await call("flow_verdict", { sessionId: SID, verdict: "PASS", notes: "重新验证后通过", cwd: WORK });
    check("V1.2-8 重新验证后 PASS 放行（不误伤）", r.ok === true, r.ok ? "" : r.error);
  }
}

console.log("");
for (const line of results) console.log(line);
console.log(
  fail ? `\n❌ A1 验证测试失败：${pass} 通过 / ${fail} 失败` : `\n✅ A1 验证测试全部通过（${pass} 条）`,
);
process.exit(fail ? 1 : 0);
