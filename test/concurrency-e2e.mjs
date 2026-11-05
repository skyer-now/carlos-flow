#!/usr/bin/env node
// concurrency-e2e.mjs — 跨进程并发提交下的激活闸门回归测试
//
// 背景（红队实测绕过）：两个 MCP server 进程共享同一 CARLOS_FLOW_HOME 时，
// flow_submit_requirement 的「读状态 → 算 pending → 写状态」读-改-写非原子。
// 进程A 写（占位卡, pending=[三项]）与进程B 写（普通空卡, pending=[]）交错时，
// 后写入者可能用**过期的 prevState** 算出 pending=[]，而它写入的卡片字段仍为空
// ⇒ 闸门被绕过，claim/dispatch/verdict(PASS) 全部放行。
// 红队 40 轮复现 4 次。
//
// 修复：src/state.js 的 withStateLock（文件锁）把读-改-写包成临界区 +
//       pending 改为「由当前卡片内容幂等派生」，落盘状态自洽。
//
// 本测试固化该防护：起**两个真实 MCP server 进程**共享同一 CARLOS_FLOW_HOME，
// 并发提交同一 sessionId，断言 40 轮内零泄漏、零放行。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SERVER = join(REPO_ROOT, "src", "index.js");
const QUOTE = "并发回归 请把激活闸门跑通";
const ROUNDS = Number(process.env.CONCURRENCY_ROUNDS) || 40;

// 隔离状态目录：绝不污染用户的 ~/.carlos-flow
const HOME = join(tmpdir(), "carlos-flow-concurrency-home");
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(HOME, { recursive: true });

const results = { pass: [], fail: [], total: 0 };
const log = (s) => process.stdout.write(s + "\n");

class Mcp {
  constructor(sp, env) { this.sp = sp; this.env = env; this.pending = new Map(); this.id = 1; this.buf = ""; this.stderr = ""; this.dead = false; }
  start() {
    this.proc = spawn(process.execPath, [this.sp], {
      cwd: REPO_ROOT, env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.proc.on("exit", () => {
      this.dead = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("SERVER_EXIT")); }
      this.pending.clear();
    });
    return this;
  }
  _onData(d) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      const t = line.trim(); if (!t) continue;
      let m; try { m = JSON.parse(t); } catch { continue; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m);
      }
    }
  }
  req(method, params, t = 20000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      if (this.dead) return rej(new Error("SERVER_DEAD"));
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error("TIMEOUT " + method)); }, t);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  init() { return this.req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "concurrency-e2e", version: "1" } }); }
  call(name, args) { return this.req("tools/call", { name, arguments: args }); }
  stop() { try { this.proc.kill(); } catch { /* ignore */ } }
}

const isErr = (res) => !!(res.error || (res.result && res.result.isError) || res.isError);

function readState(sid) {
  try {
    return JSON.parse(readFileSync(join(HOME, "gate-state", "runs", sid, "state.json"), "utf8"));
  } catch { return null; }
}

async function main() {
  log("🧪 Carlos Flow 跨进程并发 · 激活闸门回归测试");
  log("=".repeat(60));
  log(`  隔离 CARLOS_FLOW_HOME: ${HOME}`);
  log(`  轮次: ${ROUNDS}`);

  const env = { CARLOS_FLOW_HOME: HOME };
  const c1 = new Mcp(SERVER, env).start();
  const c2 = new Mcp(SERVER, env).start();
  await c1.init(); await c2.init();
  log("✅ 两个 MCP server 进程已启动（共享同一 CARLOS_FLOW_HOME）");

  let rounds = 0, leaked = 0, exploited = 0;
  const evidences = [];
  for (let i = 0; i < ROUNDS; i++) {
    const sid = "conc-" + i + "-" + Date.now();
    await c1.call("flow_add_user_msg", { sessionId: sid, text: QUOTE });
    const emptyArgs = {
      sessionId: sid, goal: "待补充目标", quote: QUOTE,
      scope: [], acceptance: [], unknowns: [], assumptions: [], files: [],
      confirmed: false, cwd: REPO_ROOT,
    };
    const lockArgs = Object.assign({}, emptyArgs, { activation: true });
    // 真正的并发：两个进程同时提交同一 sessionId
    await Promise.all([
      c1.call("flow_submit_requirement", lockArgs),
      c2.call("flow_submit_requirement", emptyArgs),
    ]);

    const st = readState(sid);
    if (!st) continue;
    rounds++;
    const pending = Array.isArray(st.activation_pending) ? st.activation_pending : [];
    const scope = (st.card && st.card.scope) || [];
    const acc = (st.card && st.card.acceptance) || [];
    const ver = st.card && st.card.verify;
    const incomplete = scope.length === 0 || acc.length === 0 || !(ver && ver.cmd);
    if (pending.length === 0 && incomplete) {
      leaked++;
      const cl = await c1.call("flow_claim", { sessionId: sid, role: "executor", cwd: REPO_ROOT });
      const vd = await c1.call("flow_verdict", { sessionId: sid, verdict: "PASS", notes: "exploit", role: "auditor" });
      if (!isErr(cl) && !isErr(vd)) exploited++;
      if (evidences.length < 3) {
        evidences.push(`  第${i}轮：pending=[] 但卡片 scope=${JSON.stringify(scope)} acceptance=${JSON.stringify(acc)} verify=${JSON.stringify(ver && ver.cmd)} → claim=${isErr(cl) ? "拒" : "放行"} verdict=${isErr(vd) ? "拒" : "放行"}`);
      }
    }
  }

  c1.stop(); c2.stop();

  results.total = 3;
  const okNoLeak = leaked === 0;
  const okNoExploit = exploited === 0;
  const okStateConsistent = rounds > 0;

  const cases = [
    ["并发提交后闸门不得被清空（零泄漏）", okNoLeak, `泄漏=${leaked}/${rounds}`],
    ["并发后字段不全的卡不得被放行派发（零利用）", okNoExploit, `利用=${exploited}`],
    ["并发用例确实执行了（轮次 > 0）", okStateConsistent, `轮次=${rounds}`],
  ];
  for (const [name, ok, detail] of cases) {
    if (ok) { results.pass.push(name); log(`✅ ${name}  ${detail}`); }
    else { results.fail.push(name); log(`❌ ${name}  ${detail}`); }
  }
  if (evidences.length) {
    log("");
    log("泄漏证据：");
    for (const e of evidences) log(e);
  }

  log("");
  log("=".repeat(60));
  log(`总测试数: ${results.total}`);
  log(`✅ 通过: ${results.pass.length}`);
  log(`❌ 失败: ${results.fail.length}`);
  log(`📈 通过率: ${((results.pass.length / results.total) * 100).toFixed(1)}%`);
  try {
    writeFileSync(join(tmpdir(), "carlos-flow-concurrency-results.json"), JSON.stringify(results, null, 2), "utf8");
  } catch { /* ignore */ }
  process.exit(results.fail.length === 0 ? 0 : 1);
}

main().catch((e) => { log("FATAL " + (e && e.stack ? e.stack : e)); process.exit(1); });
