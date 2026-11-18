// 长耗时验证的并发安全 + 「证据必须属于当前卡」—— 回归测试
//
// 背景（二次评估实测）：
//   flow_run_verify 的读-改-写窗口横跨整个命令执行期（最长 120s）。
//   · 若把整段包进 withStateLock：持锁超过 staleMs(30s) 会被判陈旧并回收，
//     另一个进程随即拿到同一把锁 → 同时写入，比不加锁更难复现；
//   · 若不加锁裸写 saveState：用「命令执行前」的旧快照覆盖磁盘，
//     期间别人提交的新卡 / 写的字段被静默回滚。
// 正确做法：命令在锁外跑 → 短锁内重新读最新状态 → 只合并自己的结果。
//
// 本测试用两个真实进程制造交叠，断言「两边的改动都活下来了」。
//
// 跑法：node test/verify-cas.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startMcpClient } from "./_mcp-client.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const ROOT = path.resolve(HERE, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-cas-home-"));
const SERVER = path.join(ROOT, "src", "index.js");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const newClient = () => startMcpClient({ entry: SERVER, cwd: ROOT, env: { CARLOS_FLOW_HOME: HOME } });

/** 起一个「慢验证」子进程：命令跑 2 秒，期间主进程去写别的字段 */
function slowVerify(sessionId) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CARLOS_FLOW_HOME: HOME },
    windowsHide: true,
  });
  let buf = "";
  const pending = new Map();
  let id = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* ignore */ }
    }
  });
  const req = (method, params) => new Promise((resolve) => {
    const rid = id++;
    pending.set(rid, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await req("tools/call", { name, arguments: args });
    const t = String(r.result?.content?.[0]?.text || "");
    try { return JSON.parse(t); } catch { return { raw: t }; }
  };
  const done = (async () => {
    await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slow", version: "1" } });
    const r = await call("flow_run_verify", { sessionId });
    child.stdin.end();
    return r;
  })();
  return { done, kill: () => { try { child.kill("SIGKILL"); } catch { /* ignore */ } } };
}

let client = null;
try {
  const c = newClient();
  client = c;
  await c.initialize();
  const tool = async (name, args) => {
    const r = await c.request("tools/call", { name, arguments: args }, 60000);
    const t = String(r.result?.content?.[0]?.text || "");
    try { return JSON.parse(t); } catch { return { raw: t }; }
  };

  // ---- 1. 慢验证期间别人写的字段不得被回滚 ----
  {
    const sid = "cas-merge-" + Date.now();
    await tool("flow_add_user_msg", { sessionId: sid, text: "慢验证并发用例" });
    const slowCmd = 'node -e "setTimeout(()=>{},2000)"';
    await tool("flow_submit_requirement", {
      sessionId: sid, goal: "慢验证并发", quote: "慢验证并发用例",
      scope: ["README.md"], acceptance: ["验证通过"],
      verify: { cmd: slowCmd }, cwd: ROOT, confirmed: true,
    });

    const sv = slowVerify(sid);
    // 命令跑着的时候，用另一个进程改状态（免检开关，短写）
    await new Promise((r) => setTimeout(r, 600));
    // 开启免检需要显式 confirmed（门禁要求），这里就是「另一个进程在慢验证期间写状态」
    const bypass = await tool("flow_bypass", { sessionId: sid, on: true, confirmed: true, reason: "cas 并发测试" });
    const verifyResult = await sv.done;

    check("1a. 慢验证正常返回", verifyResult && verifyResult.exitCode === 0,
      `exit=${verifyResult && verifyResult.exitCode}`);
    const st = await tool("flow_status", { sessionId: sid });
    check("1b. 验证期间写入的 bypass 没有被回滚（合并而不是覆盖）", st.bypass === true,
      `bypass=${st.bypass}（提交侧返回 ok=${bypass.ok}）`);
    const full = JSON.parse(fs.readFileSync(path.join(HOME, "gate-state", "runs", sid, "state.json"), "utf8"));
    check("1c. last_verify 已落盘且带 card_ts（证据绑定当前卡）",
      !!full.last_verify && Number(full.last_verify.card_ts) === Number(full.card_ts),
      full.last_verify ? `card_ts=${full.last_verify.card_ts}` : "缺失");
    check("1d. 卡片本身没有被旧快照覆盖（还是那张卡）", full.card && full.card.goal === "慢验证并发",
      full.card ? full.card.goal : "卡片丢失");
  }

  // ---- 2. 旧卡的验证结果不得给新卡用（card_ts 不一致 → 拒绝 PASS）----
  {
    const sid = "cas-stale-" + Date.now();
    await tool("flow_add_user_msg", { sessionId: sid, text: "旧卡证据不得复用" });
    const cmd = 'node -e "process.exit(0)"';
    await tool("flow_submit_requirement", {
      sessionId: sid, goal: "第一张卡", quote: "旧卡证据不得复用",
      scope: ["README.md"], acceptance: ["验证通过"], verify: { cmd }, cwd: ROOT, confirmed: true,
    });
    await tool("flow_claim", { sessionId: sid, role: "executor" });
    await tool("flow_dispatch", { sessionId: sid, role: "executor", run: false, cwd: ROOT });
    await tool("flow_run_verify", { sessionId: sid });

    // 提交一张新卡（同一台机器、同一条 verify 命令 → 旧实现会认为「命令一致」就放行）
    await new Promise((r) => setTimeout(r, 10));
    await tool("flow_submit_requirement", {
      sessionId: sid, goal: "第二张卡", quote: "旧卡证据不得复用",
      scope: ["README.md"], acceptance: ["验证通过"], verify: { cmd }, cwd: ROOT, confirmed: true,
    });
    await tool("flow_claim", { sessionId: sid, role: "executor" });
    await tool("flow_dispatch", { sessionId: sid, role: "executor", run: false, cwd: ROOT });
    await tool("flow_claim", { sessionId: sid, role: "auditor" });
    const v = await tool("flow_verdict", { sessionId: sid, verdict: "PASS", notes: "复用旧证据", cwd: ROOT });
    const text = JSON.stringify(v);
    check("2a. 用上一张卡的验证结果记 PASS 被拒", v.ok === false || /上一张任务卡|card_ts/.test(text),
      String(v.error || v.raw || "").slice(0, 80));
  }
} finally {
  // 必须关掉客户端：MCP 子进程活着会把事件循环吊住，测试「跑完了却不退出」。
  try { await client.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("VERIFY_CAS_OK");