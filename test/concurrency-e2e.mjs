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

import { AssertionError } from "node:assert";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// 分类发布后的管道错误不再写证据或输出原始异常，避免反向改判。
process.stdout.on("error", () => process.exit(1));
let DIAGNOSTICS;
try {
  DIAGNOSTICS = mkdtempSync(join(tmpdir(), "carlos-flow-concurrency-evidence-"));
  mkdirSync(HOME, { recursive: true });
} catch (e) {
  // 初始化失败也不向分类通道透传路径或堆栈。
  process.stdout.write("FATAL UNKNOWN 初始化失败\n");
  process.exit(1);
}

const log = (s) => { activeAttempt?.logs.push(s); };

const children = [];
const diagnostics = [];
const rawErrors = [];
const rawEvidenceErrors = [];
const attempts = [];
let activeAttempt;
let processSequence = 0;
let unresolved = false;
function errorRecord(e) {
  if (!e || typeof e !== "object") return String(e);
  return { name: e.name, message: e.message, stack: e.stack, code: e.code,
    cause: e.cause ? errorRecord(e.cause) : undefined,
    errors: e.errors ? Array.from(e.errors, errorRecord) : undefined };
}
function saveEvidence(file, data) {
  try { writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
  catch (e) {
    rawEvidenceErrors.push({ file, attempt: activeAttempt?.number, error: errorRecord(e) });
    return false;
  }
}
function persist(finalResult) {
  return saveEvidence(join(DIAGNOSTICS, "diagnostics.json"), {
    repo: REPO_ROOT, home: HOME, diagnosticsDirectory: DIAGNOSTICS,
    unresolved, records: [...diagnostics, ...children.map(p => p.record)],
    errors: rawErrors, rawEvidenceErrors, attempts, finalResult,
  });
}

// close 才表示输出流已收敛；记录原始命令、路径及全部数据，不进入分类通道。
function track(cp, label, timeout = 0) {
  const record = { label, pid: cp.pid, command: cp.spawnargs, executable: cp.spawnfile, cwd: REPO_ROOT, home: HOME, stdout: "", stderr: "", code: null, signal: null, error: null, timedOut: false, closed: false, messages: [] };
  record.attempt = activeAttempt.number;
  const streamId = processSequence++;
  record.stdoutFile = join(DIAGNOSTICS, `${streamId}-stdout.bin`);
  record.stderrFile = join(DIAGNOSTICS, `${streamId}-stderr.bin`);
  for (const stream of ["stdout", "stderr"]) {
    cp[stream]?.on("error", e => {
      rawEvidenceErrors.push({ file: record[`${stream}File`], attempt: record.attempt, pid: record.pid, stream, error: errorRecord(e) });
    });
    cp[stream]?.on("data", d => {
      record[stream] += d.toString();
      try { appendFileSync(record[`${stream}File`], d); }
      catch (e) {
        rawEvidenceErrors.push({ file: record[`${stream}File`], attempt: record.attempt, pid: record.pid, stream, error: errorRecord(e) });
      }
    });
  }
  cp.on("message", m => { record.messages.push(m); });
  cp.on("error", e => { record.error = e.stack || String(e); });
  const item = { cp, record, closed: false };
  item.done = new Promise(resolve => cp.on("close", (code, signal) => {
    clearTimeout(item.timer); item.closed = true;
    Object.assign(record, { code, signal, closed: true }); resolve(record);
  }));
  if (timeout) item.timer = setTimeout(() => {
    record.timedOut = true;
    item.termination = terminate(item).catch(e => { record.terminationError = errorRecord(e); });
  }, timeout);
  children.push(item);
  return item;
}
async function bounded(promise, ms, label, records) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(unknown(label, records)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const waitClose = (item, ms = 24000) => bounded(item.done, ms, "进程完成超时", [item.record]);
async function terminate(item) {
  if (item.closed) return;
  if (item.stopPromise) return item.stopPromise;
  item.record.terminationRequested = true;
  item.stopPromise = (async () => {
    // PID 只取本测试真实 spawn 返回值，禁止进程名扫描或外部 PID 注入。
    if (!Number.isSafeInteger(item.cp.pid) || item.cp.pid <= 0 || item.cp.pid !== item.record.pid) {
      throw unknown("无法确认自建进程PID", [item.record]);
    }
    if (process.platform === "win32") {
      const killer = track(spawn("taskkill", ["/pid", String(item.cp.pid), "/T", "/F"], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      }), "taskkill");
      try {
        const result = await waitClose(killer, 3000);
        if (bad(result)) throw unknown("终止辅助进程拒绝", [result, item.record]);
      } catch (e) {
        // helper 超时只终止本次 helper；仍有界等待，不递归启动 taskkill。
        if (!killer.closed) {
          killer.record.timedOut = true;
          try { killer.cp.kill(); } catch (cause) { killer.record.killError = errorRecord(cause); }
          try { await waitClose(killer, 1000); } catch (cause) { killer.record.waitError = errorRecord(cause); }
        }
        throw e;
      }
    } else {
      try { process.kill(-item.cp.pid, "SIGKILL"); }
      catch (e) { if (e.code !== "ESRCH") throw unknown("终止拒绝", [errorRecord(e), item.record]); }
    }
    await waitClose(item, 3000);
  })();
  return item.stopPromise;
}
const bad = r => r.code !== 0 || r.signal || r.error || r.timedOut;
function unknown(label, records) {
  // 原始内容只进入旁证；Error 自身也不携带路径或记录文本。
  rawErrors.push({ label, records });
  return new Error("UNKNOWN 运行未确认");
}
async function waitMessage(item, type) {
  const until = Date.now() + 10000;
  while (!item.record.messages.some(m => m.type === type)) {
    if (item.closed || Date.now() >= until) throw unknown(`barrier ${type}`, [item.record]);
    await new Promise(r => setTimeout(r, 5));
  }
}

function assertRunning(token = activeAttempt) {
  if (!token || token.stopped) throw unknown("attempt已停止，禁止继续业务", []);
}

class Mcp {
  constructor(sp, env) { this.sp = sp; this.env = env; this.pending = new Map(); this.id = 1; this.buf = ""; this.stderr = ""; this.dead = false; }
  start() {
    assertRunning();
    this.proc = spawn(process.execPath, [this.sp], {
      cwd: REPO_ROOT, env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    this.child = track(this.proc, "MCP");
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.proc.on("error", () => { this.dead = true; });
    this.proc.stdin.on("error", (e) => {
      this.child.record.error = e.stack || String(e);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); }
      this.pending.clear();
    });
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
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw unknown("状态读取未确认", [errorRecord(e)]);
  }
}

const sleepMs = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
};

async function main(token) {
  assertRunning(token);
  log("🧪 Carlos Flow 跨进程并发 · 激活闸门回归测试");
  log("=".repeat(60));
  log("  已启用唯一隔离状态目录及独立诊断目录");
  log(`  轮次: ${GROUPS} 组 × ${ROUNDS} 轮 = ${GROUPS * ROUNDS}`);

  const env = { CARLOS_FLOW_HOME: HOME };
  const c1 = new Mcp(SERVER, env).start();
  const c2 = new Mcp(SERVER, env).start();
  await c1.init(); assertRunning(token);
  await c2.init(); assertRunning(token);
  log("✅ 两个 MCP server 进程已启动（共享同一 CARLOS_FLOW_HOME）");

  let rounds = 0, leaked = 0, exploited = 0;
  const evidences = [];
  const submissions = [];
  const submissionErrors = [];
  // 重复多组：单组 40 轮的竞态检出率约 80%，多组后任一组出现泄漏即失败。
  // （单组判定的假警报与真 bug 难以区分，用多组把概率压下去。）
  for (let g = 0; g < GROUPS; g++) {
  for (let i = 0; i < ROUNDS; i++) {
    // 一轮内同时发起 PARALLEL_PER_ROUND 组跨进程并发提交（每组不同 sessionId）
    const groupSids = [];
    for (let k = 0; k < PARALLEL_PER_ROUND; k++) {
      assertRunning(token);
      const sid = "conc-g" + g + "-" + i + "-k" + k + "-" + Date.now();
      groupSids.push(sid);
      await c1.call("flow_add_user_msg", { sessionId: sid, text: QUOTE });
      assertRunning(token);
      const emptyArgs = {
        sessionId: sid, goal: "待补充目标", quote: QUOTE,
        scope: [], acceptance: [], unknowns: [], assumptions: [], files: [],
        confirmed: false, cwd: REPO_ROOT,
      };
      const lockArgs = Object.assign({}, emptyArgs, { activation: true });
      // 真正的并发：两个进程同时提交同一 sessionId
      submissions.push(Promise.allSettled([
        c1.call("flow_submit_requirement", lockArgs),
        c2.call("flow_submit_requirement", emptyArgs),
      ]).then(rs => { for (const r of rs) if (r.status === "rejected") submissionErrors.push(String(r.reason)); }));
    }
    // 等待本轮所有并发提交落盘
    await new Promise((r) => setTimeout(r, 60));
    assertRunning(token);

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
      assertRunning(token);
      const vd = await c1.call("flow_verdict", { sessionId: sid, verdict: "PASS", notes: "exploit", role: "auditor" });
      if (!isErr(cl) && !isErr(vd)) exploited++;
      if (evidences.length < 3) {
        evidences.push(`  组${g}第${i}轮 sid=${sid}：pending=[] 但卡片 scope=${JSON.stringify(s2)} acceptance=${JSON.stringify(a2)} verify=${JSON.stringify(v2 && v2.cmd)} activation_activated=${st2 && st2.activation_activated} → claim=${isErr(cl) ? "拒" : "放行"} verdict=${isErr(vd) ? "拒" : "放行"}`);
      }
    }
  }
  }
  }

  await Promise.all(submissions);
  assertRunning(token);
  if (submissionErrors.length || c1.dead || c2.dead) throw unknown("MCP submissions", [submissionErrors, c1.child.record, c2.child.record]);
  await Promise.all([terminate(c1.child), terminate(c2.child)]);
  await Promise.all([waitClose(c1.child), waitClose(c2.child)]);

  // ---- 用例 4：保留 2 × 100 压力计数，先加确定性真实跨进程屏障 ----
  // 只有回调在 A 的释放授权前确实进入才是互斥反例；release/IO 错误不是断言。
  let lockLost = -1;
  let enteredEarly = false;
  const probeRecords = [];
  const releaseFile = join(HOME, "barrier-release");
  const stateURL = pathToFileURL(join(REPO_ROOT, "src", "state.js")).href;
  const runProbe = (label, code, ipc = false) => {
    assertRunning(token);
    const item = track(spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: REPO_ROOT, env: { ...process.env, CARLOS_FLOW_HOME: HOME },
      stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      windowsHide: true, detached: process.platform !== "win32",
    }), label, 20000);
    probeRecords.push(item);
    return item;
  };
  const prelude = `
import fs from "node:fs";
import { withStateLock } from ${JSON.stringify(stateURL)};
const releaseFile = ${JSON.stringify(releaseFile)};
`;
  let barrierError;
  const a = runProbe("barrier-A", prelude + `
const released = new Promise(resolve => process.on("message", m => { if (m === "release") resolve(); }));
await withStateLock("barrier-probe", async () => {
  process.send({type:"held"});
  await released;
});
process.disconnect();
`, true);
  try {
    await waitMessage(a, "held");
    assertRunning(token);
    const b = runProbe("barrier-B", prelude + `
// 观测真实业务锁 open 返回或抛错后的结果，不修改原操作。
const originalOpen = fs.openSync;
let attempted = false;
fs.openSync = function(file, flag, ...args) {
  const target = String(file).endsWith(".state.lock") && (flag === "wx" || flag === "a");
  let outcome;
  try {
    const fd = originalOpen.call(this, file, flag, ...args);
    outcome = { success: true };
    return fd;
  } catch (e) {
    outcome = { success: false, errorCode: e.code, errorStack: e.stack };
    throw e;
  } finally {
    if (target && !attempted) { attempted = true; process.send({type:"attempted", outcome}); }
  }
};
await withStateLock("barrier-probe", () => {
  let early = false;
  try {
    if (fs.readFileSync(releaseFile, "utf8") !== "authorized") throw new Error("UNKNOWN release marker content");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // A 的回调在释放 IPC 前不能返回；标记缺失时还须确认 A 存活。
    // 崩溃或终止后的标记缺失不能作为互斥反例。
    process.kill(${a.cp.pid}, 0);
    early = true;
  }
  process.send({type:"entered", early});
});
process.disconnect();
`, true);
    await waitMessage(b, "attempted");
    assertRunning(token);
    // 父进程收到实际尝试完成通知后等待300ms，并非内核精确计时区间。
    // 回调直接检查授权标记，不以消息到达先后伪造提前进入。
    await new Promise(r => setTimeout(r, 300));
  } catch (e) { barrierError = e; } finally {
    try {
      writeFileSync(releaseFile, "authorized");
      if (!a.closed && a.cp.connected) a.cp.send("release", e => { if (e) a.record.error = String(e); });
    } catch (e) {
      barrierError = e;
      // 未能写入授权标记则不释放 A，避免缺失标记失去观测语义。
      await Promise.all(probeRecords.filter(p => !p.closed).map(p => terminate(p)));
    }
    const completions = await Promise.allSettled(probeRecords.map(p => waitClose(p)));
    for (const r of completions) if (r.status === "rejected") barrierError ||= r.reason;
    enteredEarly = probeRecords.some(p => p.record.messages.some(m => m.type === "entered" && m.early === true));
    const bRecord = probeRecords.find(p => p.record.label === "barrier-B")?.record;
    if (!bRecord?.messages.some(m => m.type === "entered" && typeof m.early === "boolean")) {
      barrierError ||= unknown("B callback observation missing", [bRecord]);
    }
  }

  const cntFile = join(HOME, "lock-count.json");
  const lockProbe = prelude + `
const cnt = ${JSON.stringify(cntFile)};
for (let i = 0; i < 100; i++) {
  await withStateLock("lock-probe", () => {
    let v = 0;
    try { v = JSON.parse(fs.readFileSync(cnt, "utf8")).v || 0; }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    fs.writeFileSync(cnt, JSON.stringify({ v: v + 1 }));
  });
}
console.log("done");
`;
  const pressure = [runProbe("pressure-1", lockProbe), runProbe("pressure-2", lockProbe)];
  const pressureWaits = await Promise.allSettled(pressure.map(p => waitClose(p)));
  let countError;
  for (const r of pressureWaits) if (r.status === "rejected") countError ||= r.reason;
  if (pressure.every(p => !bad(p.record))) {
    try { lockLost = 200 - JSON.parse(readFileSync(cntFile, "utf8")).v; }
    catch (e) { countError = e; }
  }
  const faults = probeRecords.filter(p => bad(p.record)).map(p => p.record);
  rawErrors.push({ label: "探针汇总", enteredEarly, barrierError: errorRecord(barrierError), countError: errorRecord(countError), records: probeRecords.map(p => p.record) });
  if (barrierError || countError || faults.length) {
    if (!enteredEarly) throw unknown("lock probes", [String(barrierError || countError || ""), ...faults]);
    log("CLASSIFICATION MUTEX_VIOLATION_WITH_SECONDARY_UNKNOWN (early callback is primary; subsequent probe faults retained)");
  } else log("CLASSIFICATION " + (enteredEarly ? "MUTEX_VIOLATION" : "PROBES_COMPLETE"));

  return { enteredEarly, cases: [
    { name: "并发提交后闸门不得被清空（零泄漏）", ok: leaked === 0, detail: `泄漏=${leaked}/${rounds}` },
    { name: "并发后字段不全的卡不得被放行派发（零利用）", ok: exploited === 0, detail: `利用=${exploited}` },
    { name: "并发用例确实执行了（轮次 > 0）", ok: rounds > 0, detail: `轮次=${rounds}` },
    { name: "锁排他性：跨进程读-改-写零丢更新（M12 盲区）", ok: lockLost === 0 && !enteredEarly, detail: `丢更新=${lockLost} B提前进入=${enteredEarly}` },
  ], evidences };
}

// 所有生命周期/介质/结果异常在这里收口，任何 attempt 都不直接输出失败标记。
async function cleanup(token, mainTask) {
  token.stopped = true;
  const errors = [];
  const targets = children.filter(p => !p.closed && p.record.label !== "taskkill");
  const stops = await Promise.allSettled(targets.map(p => terminate(p)));
  errors.push(...stops.filter(r => r.status === "rejected").map(r => errorRecord(r.reason)));
  const waits = await Promise.allSettled(children.map(p => waitClose(p, 1000)));
  errors.push(...waits.filter(r => r.status === "rejected").map(r => errorRecord(r.reason)));
  // 等待已启动的超时终止操作收敛，防止快照后才出现 helper/持久化故障。
  const endings = await Promise.allSettled(children.map(p => p.termination));
  errors.push(...endings.filter(r => r.status === "rejected").map(r => errorRecord(r.reason)));
  unresolved = children.some(p => !p.closed);
  if (mainTask) {
    try { await bounded(mainTask.then(() => {}, () => {}), 1000, "旧main未收敛", []); }
    catch (e) { unresolved = true; errors.push(errorRecord(e)); }
  }
  token.mainSettled = token.settled;
  for (const item of children.filter(p => !p.closed)) {
    clearTimeout(item.timer);
    try {
      item.cp.unref();
      item.cp.stdout?.destroy(); item.cp.stderr?.destroy(); item.cp.stdin?.destroy();
      if (item.cp.connected) item.cp.disconnect();
    } catch (e) { errors.push(errorRecord(e)); }
  }
  // 检查所有创建进程的启动/管道错误；主动终止 MCP 的退出码不构成坏执行。
  errors.push(...children.filter(p => p.record.error || p.record.terminationError).map(p => p.record));
  if (!unresolved) {
    try { rmSync(HOME, { recursive: true, force: true }); token.homeRemoved = true; }
    catch (e) { errors.push(errorRecord(e)); }
  }
  diagnostics.push(...children.map(p => p.record));
  children.length = 0;
  return errors;
}

async function runWithRetry() {
  let finalResult;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    activeAttempt = { number: attempt + 1, logs: [], outcome: null, error: null, cleanupErrors: [], classification: "UNKNOWN", stopped: false, settled: false, homeRemoved: false };
    attempts.push(activeAttempt);
    const token = activeAttempt;
    let mainTask;
    try {
      mkdirSync(HOME, { recursive: true });
      mainTask = main(token);
      mainTask.then(() => { token.settled = true; }, () => { token.settled = true; });
      activeAttempt.outcome = await bounded(mainTask, 570000, "父测试总预算超时", []);
    } catch (e) {
      activeAttempt.error = errorRecord(e);
    } finally {
      try { activeAttempt.cleanupErrors = await cleanup(token, mainTask); }
      catch (e) {
        activeAttempt.cleanupErrors.push(errorRecord(e));
        unresolved = true;
      }
    }
    const outcome = activeAttempt.outcome;
    if (!activeAttempt.error && !unresolved && !activeAttempt.cleanupErrors.length) {
      activeAttempt.classification = outcome.cases.every(c => c.ok) ? "PASS" : "FAIL";
      if (outcome.enteredEarly) activeAttempt.assertion = errorRecord(new AssertionError({
        message: "跨进程锁互斥违反：A持锁且尚未授权释放时B回调已进入", actual: true, expected: false,
      }));
    }
    // 媒介损坏是独立永久状态，任何真实断言或后续重试都不能将其翻绿。
    if (rawEvidenceErrors.length) activeAttempt.classification = "UNKNOWN";
    persist();
    if (rawEvidenceErrors.length) activeAttempt.classification = "UNKNOWN";
    finalResult = { classification: activeAttempt.classification, attempt: activeAttempt.number,
      outcome: activeAttempt.classification === "UNKNOWN" ? null : outcome };
    if (finalResult.classification === "PASS" || unresolved || !token.homeRemoved || attempt >= RETRY) break;
  }
  activeAttempt = undefined;
  // 最终结果文件和最终诊断都须在任何分类输出之前保存；此后不再写证据。
  saveEvidence(join(DIAGNOSTICS, "results.json"), { attempts, finalResult });
  if (rawEvidenceErrors.length) finalResult = { classification: "UNKNOWN", attempt: finalResult.attempt, outcome: null };
  persist(finalResult);
  if (rawEvidenceErrors.length) {
    finalResult = { classification: "UNKNOWN", attempt: finalResult.attempt, outcome: null };
    // 同介质救援保存仅尽力保留写失败详情，不能撤销 UNKNOWN。
    saveEvidence(join(DIAGNOSTICS, "storage-failure.json"), { finalResult, rawEvidenceErrors, attempts, records: diagnostics });
  }
  return finalResult;
}

function emitFinal(result) {
  const emit = s => process.stdout.write(s + "\n");
  if (!result || result.classification === "UNKNOWN" || !result.outcome) {
    emit("FATAL UNKNOWN 运行、清理或完整旁证保存未确认");
    process.exit(1);
  }
  // 仅最终选定 attempt 的固定名称、数值结果和已证目标断言进入原分类器。
  const cases = result.outcome.cases;
  for (const c of cases) emit(`${c.ok ? "✅" : "❌"} ${c.name}  ${c.detail}`);
  const failed = cases.filter(c => !c.ok).length;
  emit("总测试数: 4");
  emit(`✅ 通过: ${4 - failed}`);
  emit(`❌ 失败: ${failed}`);
  emit(`📈 通过率: ${((4 - failed) / 4 * 100).toFixed(1)}%`);
  if (result.classification === "FAIL") {
    emit(result.outcome.enteredEarly
      ? "FATAL AssertionError 跨进程锁互斥违反：A尚未授权释放时B回调已进入"
      : "FATAL 已证并发测试断言失败");
    process.exit(1);
  }
}
runWithRetry().then(emitFinal, e => {
  // 最后防线不输出任何原始文本；绝不复用先前 attempt 的断言标记。
  rawErrors.push({ label: "收口异常", error: errorRecord(e) });
  persist({ classification: "UNKNOWN" });
  process.stdout.write("FATAL UNKNOWN 结果收口未确认\n");
  process.exit(1);
});
