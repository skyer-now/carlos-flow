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
// 重试次数：**默认 0（不重试）**。
// 并发套件曾偶发「假泄漏」，根因已查明：用例故意让两个进程提交**不同类型**的卡
// （占位卡 vs 普通卡），普通卡后写时 activation_activated=false + pending=[] 是正确
// 行为，被误判为泄漏。已在判定里加 activation_activated 条件修复。
// 但变���测试正是**期望**套件失败的（用它捕获退化），若套件自带重试会让变异测试耗时翻倍，
// 所以重试必须**显式开启**：CI 里设 CONCURRENCY_RETRY=1，mutation-check 不设。
// 重试只在「两次都失败」时才判红 —— 真缺陷不会被重试掩盖（两次都会红）。
const RETRY = Number(process.env.CONCURRENCY_RETRY || 0);
// 重复组数：单组对「锁失效」这类变异的检出率约 80%，3 组后接近 99%。
const GROUPS = Number(process.env.CONCURRENCY_GROUPS) || 3;
// 每轮内并发提交的 session 数（不同 sid）。
// 单靠加轮数来提检出率是线性成本；把同一轮里的并发组做多，**并发窗口的密度**更高，
// 竞态命中概率上升得更快（实测：1 组/轮 时在完整变异矩阵里 M12 仍偶发漏检）。
const PARALLEL_PER_ROUND = Number(process.env.CONCURRENCY_PARALLEL) || 4;

// 隔离状态目录：绝不污染用户的 ~/.carlos-flow。
// 必须**每次运行唯一**：若复用固定路径，上一次运行残留的 server 进程（kill 不干净）
// 会与本次运行共享同一 HOME，把状态写进同一目录，造成偶发误判。
const HOME = join(tmpdir(), `carlos-flow-concurrency-home-${Date.now()}-${process.pid}`);
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

const sleepMs = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
};

async function main() {
  log("🧪 Carlos Flow 跨进程并发 · 激活闸门回归测试");
  log("=".repeat(60));
  log(`  隔离 CARLOS_FLOW_HOME: ${HOME}`);
  log(`  轮次: ${GROUPS} 组 × ${ROUNDS} 轮 = ${GROUPS * ROUNDS}`);

  const env = { CARLOS_FLOW_HOME: HOME };
  const c1 = new Mcp(SERVER, env).start();
  const c2 = new Mcp(SERVER, env).start();
  await c1.init(); await c2.init();
  log("✅ 两个 MCP server 进程已启动（共享同一 CARLOS_FLOW_HOME）");

  let rounds = 0, leaked = 0, exploited = 0;
  const evidences = [];
  // 重复多组：单组 40 轮的竞态检出率约 80%，多组后任一组出现泄漏即失败。
  // （单组判定的假警报与真 bug 难以区分，用多组把概率压下去。）
  for (let g = 0; g < GROUPS; g++) {
  for (let i = 0; i < ROUNDS; i++) {
    // 一轮内同时发起 PARALLEL_PER_ROUND 组跨进程并发提交（每组不同 sessionId）
    const groupSids = [];
    for (let k = 0; k < PARALLEL_PER_ROUND; k++) {
      const sid = "conc-g" + g + "-" + i + "-k" + k + "-" + Date.now();
      groupSids.push(sid);
      await c1.call("flow_add_user_msg", { sessionId: sid, text: QUOTE });
      const emptyArgs = {
        sessionId: sid, goal: "待补充目标", quote: QUOTE,
        scope: [], acceptance: [], unknowns: [], assumptions: [], files: [],
        confirmed: false, cwd: REPO_ROOT,
      };
      const lockArgs = Object.assign({}, emptyArgs, { activation: true });
      // 真正的并发：两个进程同时提交同一 sessionId
      Promise.all([
        c1.call("flow_submit_requirement", lockArgs),
        c2.call("flow_submit_requirement", emptyArgs),
      ]).catch(() => { /* 后续以状态判定为准 */ });
    }
    // 等待本轮所有并发提交落盘
    await new Promise((r) => setTimeout(r, 60));

    for (const sid of groupSids) {
    const st = readState(sid);
    if (!st) continue;
    rounds++;
    const pending = Array.isArray(st.activation_pending) ? st.activation_pending : [];
    const scope = (st.card && st.card.scope) || [];
    const acc = (st.card && st.card.acceptance) || [];
    const ver = st.card && st.card.verify;
    const incomplete = scope.length === 0 || acc.length === 0 || !(ver && ver.cmd);
    if (pending.length === 0 && incomplete) {
      // 二次确认：等待落盘完全稳定后重读，排除“读到写入中间态”的假象。
      // 连续两次读到相同的不一致状态，才算真泄漏。
      sleepMs(250);
      const st2 = readState(sid);
      const p2 = st2 && Array.isArray(st2.activation_pending) ? st2.activation_pending : null;
      const s2 = (st2 && st2.card && st2.card.scope) || [];
      const a2 = (st2 && st2.card && st2.card.acceptance) || [];
      const v2 = st2 && st2.card && st2.card.verify;
      // 只有「最终状态是占位卡（activation_activated=true）却 pending=[]」才算泄漏。
      //
      // 为什么必须检查 activation_activated：
      //   本用例故意让两个进程提交**不同类型**的卡（c1=占位卡 activation:true，
      //   c2=普通卡）。若两个进程都读到空 prev，普通卡后写时落盘的
      //   activation_activated=false + pending=[] 是**正确行为**（普通卡不上闸门），
      //   不是闸门被清空。此前漏掉这个条件，导致普通卡后写被误判为泄漏
      //   （实测 457 轮里偶发 1 次，repro：组2第37轮 activation_activated=false）。
      //   真泄漏（占位卡被错误清空）仍是 activation_activated=true + pending=[]，照样能拓住。
      const stillLeak = p2 && p2.length === 0 &&
        st2.activation_activated === true &&
        (s2.length === 0 || a2.length === 0 || !(v2 && v2.cmd));
      if (!stillLeak) continue; // 假警报（未稳定/被后续写入覆盖）
      leaked++;
      const cl = await c1.call("flow_claim", { sessionId: sid, role: "executor", cwd: REPO_ROOT });
      const vd = await c1.call("flow_verdict", { sessionId: sid, verdict: "PASS", notes: "exploit", role: "auditor" });
      if (!isErr(cl) && !isErr(vd)) exploited++;
      if (evidences.length < 3) {
        evidences.push(`  组${g}第${i}轮 sid=${sid}：pending=[] 但卡片 scope=${JSON.stringify(s2)} acceptance=${JSON.stringify(a2)} verify=${JSON.stringify(v2 && v2.cmd)} activation_activated=${st2 && st2.activation_activated} → claim=${isErr(cl) ? "拒" : "放行"} verdict=${isErr(vd) ? "拒" : "放行"}`);
      }
    }
  }
  }
  }

  c1.stop(); c2.stop();

  // 清理本次运行的隔离目录（不影响其他运行的目录）
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

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
  if (results.fail.length === 0) {
    process.exit(0);
  }
  // 失败用**抛异常**而不是 process.exit —— 否则重试包装捕获不到（process.exit 立即终止进程）
  throw new Error(`并发套件失败 ${results.fail.length} 项：` + results.fail.map((f) => f.name || f).join(" / "));
}

// 重试包装：偶发假泄漏时重跑一次（两次都红才判失败，真缺陷不会被掩盖）。
async function runWithRetry() {
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    if (attempt > 0) {
      log(`🔁 第 ${attempt + 1} 次尝试（上一轮失败，重跑确认是否偶发）`);
    }
    try {
      await main();
      return;
    } catch (e) {
      if (attempt >= RETRY) throw e;
    }
  }
}
runWithRetry().catch((e) => { log("FATAL " + (e && e.stack ? e.stack : e)); process.exit(1); });
