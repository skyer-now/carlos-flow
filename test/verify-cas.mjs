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
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from 'node:child_process'
import { startMcpClient } from "./_mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

// 持久化阶段故障：真实文件 + 局部 fs 注入，不向生产代码增加后门。
const durableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-durable-'))
process.env.CARLOS_FLOW_HOME = durableHome
const stateModule = await import('../src/state.js')
const { saveState, loadState, defaultState, withStateLock, RUNS_DIR } = stateModule
for (const stage of ['write', 'file-fsync', 'close', 'rename', 'rename-after', 'directory-sync']) {
  if (stage === 'directory-sync' && process.platform === 'win32') continue
  const sid = `fault-${stage}`
  saveState(sid, { ...defaultState(), task_id: 'before' })
  const real = { writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync }
  let injected = false
  const fault = () => { injected = true; throw Object.assign(new Error('持久化注入'), { code: 'EIO' }) }
  let syncCount = 0
  if (stage === 'write') fs.writeFileSync = (...args) => { if (!injected && typeof args[0] === 'number') fault(); return real.writeFileSync(...args) }
  if (stage === 'file-fsync' || stage === 'directory-sync') fs.fsyncSync = (...args) => {
    syncCount++
    if (!injected && syncCount === (stage === 'file-fsync' ? 1 : 2)) fault()
    return real.fsyncSync(...args)
  }
  if (stage === 'close') fs.closeSync = (...args) => { if (!injected) { real.closeSync(...args); fault() } return real.closeSync(...args) }
  if (stage.startsWith('rename')) fs.renameSync = (...args) => {
    if (!injected) { if (stage === 'rename-after') real.renameSync(...args); fault() }
    return real.renameSync(...args)
  }
  let error
  let spawned = false
  try { saveState(sid, { ...defaultState(), task_id: 'after' }); spawned = true } catch (cause) { error = cause } finally { Object.assign(fs, real) }
  const expectedPhase = stage === 'rename-after' ? 'rename' : stage
  const expectedStatus = ['rename', 'rename-after', 'directory-sync'].includes(stage) ? 'unknown' : 'not-committed'
  const expectedTask = ['rename-after', 'directory-sync'].includes(stage) ? 'after' : 'before'
  check(`P8 ${stage} 故障绝不返回成功/进入执行`, injected && error?.phase === expectedPhase && !spawned)
  const current = loadState(sid)
  check(`P8 ${stage} target 不回滚且 JSON 完整`, ['before', 'after'].includes(current.task_id) &&
    (stage !== 'rename-after' || (current.task_id === 'after' && error.commitStatus === 'unknown')))
  check(`R2 ${stage} 提交状态及目标内容精确对应`, error?.commitStatus === expectedStatus && current.task_id === expectedTask)
}
// 非 EEXIST 的锁 IO 必须有界传播，不能误执行 fn。
{
  const realOpen = fs.openSync
  let entered = false
  let error
  fs.openSync = (...args) => {
    if (String(args[0]).endsWith('.state.lock')) throw Object.assign(new Error('锁永久 IO'), { code: 'EIO' })
    return realOpen(...args)
  }
  try { await withStateLock('fault-lock', () => { entered = true }, { timeoutMs: 80 }) } catch (cause) { error = cause } finally { fs.openSync = realOpen }
  check('P6 永久锁 IO 明确传播且不执行', !entered && /锁永久 IO/.test(error?.message || ''))
}
// gate 未知槽阻塞，不按年龄删除。
{
  const dir = path.join(RUNS_DIR, 'unknown-gate')
  const { createHash } = await import('node:crypto')
  fs.mkdirSync(dir, { recursive: true })
  const physicalRuns = fs.realpathSync.native(RUNS_DIR)
  const physicalDir = fs.realpathSync.native(dir)
  const canonicalRuns = physicalRuns
  const canonicalDir = process.platform === 'win32' ? physicalDir.toLowerCase() : physicalDir
  const gate = path.join(path.dirname(canonicalRuns), 'state-transitions', createHash('sha256').update(path.join(canonicalDir, '.state.lock')).digest('hex'))
  fs.mkdirSync(gate, { recursive: true })
  fs.writeFileSync(path.join(gate, 'unknown.json'), '{}')
  let entered = false
  try { await withStateLock('unknown-gate', () => { entered = true }, { timeoutMs: 80 }) } catch {}
  check('P6 未知 gate 槽保留且 fail-closed', !entered && fs.existsSync(path.join(gate, 'unknown.json')))
}

// 保存顺序与唯一临时名必须实测，不仅检查最终 JSON。
{
  const events = []
  const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync }
  const temps = []
  fs.openSync = (...args) => { if (String(args[0]).includes('state.json.tmp-')) { temps.push(args[0]); events.push('open') } return real.openSync(...args) }
  for (const [name, label] of [['writeFileSync', 'write'], ['fsyncSync', 'sync'], ['closeSync', 'close'], ['renameSync', 'rename']]) {
    fs[name] = (...args) => { events.push(label); return real[name](...args) }
  }
  try { saveState('order', defaultState()); saveState('order', defaultState()) } finally { Object.assign(fs, real) }
  check('P7 唯一 temp 与 write/fsync/close/rename 顺序', temps.length === 2 && temps[0] !== temps[1] && events.slice(0, 5).join(',') === 'open,write,sync,close,rename')
}
for (const mode of ['owner-write', 'release-rename', 'release-after', 'release-cleanup', 'gate-cleanup']) {
  const sid = `fault-${mode}`
  const real = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync }
  let armed = mode === 'owner-write'
  let injected = false
  const fault = () => { injected = true; throw Object.assign(new Error(`注入-${mode}`), { code: 'EIO' }) }
  fs.writeFileSync = (...args) => { if (armed && mode === 'owner-write' && typeof args[0] === 'number') fault(); return real.writeFileSync(...args) }
  fs.renameSync = (...args) => {
    if (armed && mode.startsWith('release-') && String(args[1]).includes('.state.lock.release-') && mode !== 'release-cleanup') {
      if (mode === 'release-after') real.renameSync(...args)
      fault()
    }
    return real.renameSync(...args)
  }
  fs.unlinkSync = (...args) => {
    if (armed && ((mode === 'release-cleanup' && String(args[0]).includes('.state.lock.release-')) ||
        (mode === 'gate-cleanup' && String(args[0]).includes('state-transitions') && String(args[0]).endsWith('.json')))) fault()
    return real.unlinkSync(...args)
  }
  let error
  let entered = false
  try {
    await withStateLock(sid, () => { entered = true; armed = true; throw new Error('业务首因') }, { timeoutMs: 100 })
  } catch (cause) { error = cause } finally { Object.assign(fs, real) }
  check(`P6 ${mode} 有界传播并保留首因`, injected && !!error && (mode === 'owner-write' ? !entered : error.cause?.message === '业务首因'))
}
{
  const sid = 'eperm-owner'
  const dir = path.join(RUNS_DIR, sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.state.lock'), '123456789')
  const realKill = process.kill
  process.kill = (pid, signal) => { if (pid === 123456789) throw Object.assign(new Error('权限未知'), { code: 'EPERM' }); return realKill(pid, signal) }
  let entered = false
  try { await withStateLock(sid, () => { entered = true }, { timeoutMs: 80 }) } catch {} finally { process.kill = realKill }
  check('P4 EPERM 不推断死亡', !entered && fs.readFileSync(path.join(dir, '.state.lock'), 'utf8') === '123456789')
}

// 预审精准故障：业务 fn 前的创建/槽清理异常也必须处理 owner 生命周期。
for (const mode of ['partial-write', 'owner-close', 'owner-close-before', 'acquire-slot-EIO', 'acquire-slot-EPERM']) {
  const sid = `review-${mode}`
  const lock = path.join(RUNS_DIR, sid, '.state.lock')
  const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, closeSync: fs.closeSync, unlinkSync: fs.unlinkSync }
  let ownerFd
  let ownerWritten = false
  let injected = false
  let entered = false
  fs.openSync = (...args) => {
    const fd = real.openSync(...args)
    if (String(args[0]).endsWith('.state.lock')) ownerFd = fd
    return fd
  }
  fs.writeFileSync = (...args) => {
    if (args[0] === ownerFd && ownerFd !== undefined) {
      ownerWritten = true
      if (mode === 'partial-write') {
        real.writeFileSync(args[0], 'partial')
        injected = true
        throw Object.assign(new Error('原始部分写失败'), { code: 'EIO' })
      }
    }
    return real.writeFileSync(...args)
  }
  fs.closeSync = (...args) => {
    const owner = args[0] === ownerFd && ownerFd !== undefined
    if (owner && mode === 'owner-close-before' && !injected) {
      injected = true
      throw Object.assign(new Error('原始关闭前效失败'), { code: 'EIO' })
    }
    const result = real.closeSync(...args)
    if (owner) {
      ownerFd = undefined
      if (mode === 'owner-close') {
        injected = true
        throw Object.assign(new Error('原始关闭失败'), { code: 'EIO' })
      }
    }
    return result
  }
  fs.unlinkSync = (...args) => {
    if (ownerWritten && mode.startsWith('acquire-slot-') && String(args[0]).includes('state-transitions') && String(args[0]).endsWith('.json')) {
      injected = true
      throw Object.assign(new Error('业务前槽清理失败'), { code: mode.endsWith('EPERM') ? 'EPERM' : 'EIO' })
    }
    return real.unlinkSync(...args)
  }
  let error
  try { await withStateLock(sid, () => { entered = true }, { timeoutMs: 100 }) } catch (cause) { error = cause } finally { Object.assign(fs, real) }
  check(`R1 ${mode} 未执行业务且 owner 安全补偿`, injected && !entered && !!error && !fs.existsSync(lock))
  if (!mode.startsWith('acquire-slot-')) {
    let recovered = false
    await withStateLock(sid, () => { recovered = true })
    check(`R1 ${mode} 故障解除后可重新领取`, recovered)
  } else {
    check(`R1 ${mode} 残槽错误明确而非假称完全恢复`, /gate-cleanup/.test(error.message))
  }
}
if (process.platform !== 'win32') {
  const real = { fsyncSync: fs.fsyncSync, closeSync: fs.closeSync }
  let directoryFd
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) {
      directoryFd = fd
      throw new Error('目录同步首因')
    }
    return real.fsyncSync(fd)
  }
  fs.closeSync = fd => {
    const result = real.closeSync(fd)
    if (fd === directoryFd) throw new Error('目录关闭次因')
    return result
  }
  let error
  try { saveState('review-directory', defaultState()) } catch (cause) { error = cause } finally { Object.assign(fs, real) }
  check('R2 目录同步和关闭失败按顺序聚合且 unknown', error?.phase === 'directory-sync' && error.commitStatus === 'unknown' &&
    error.cause?.cause?.errors?.[0]?.message === '目录同步首因' && error.cause.cause.errors[1].message === '目录关闭次因')
}

// receipt 永久领取矩阵：真实文件，不以 KV 或 state 投影充当权威。
{
  const { issueStaleOffer, claimStaleOffer, staleCaseIdentity } = stateModule
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-cwd-'))
  const fixture = () => ({ ...defaultState(), card_ts: Date.now(), card: { verify: { cmd: 'node -e "process.exit(0)"' }, env: { project: cwd } }, last_verify: { ts: '原验证', output_hash: '原输出', fingerprint: { ok: true, diff_sha256: '原指纹' } } })
  for (const mode of ['write', 'fsync', 'close']) {
    const sid = `receipt-${mode}`
    const original = fixture()
    saveState(sid, original)
    const offer = await issueStaleOffer(sid, original, cwd)
    const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync }
    const fds = new Set()
    let injected = false
    let error
    fs.openSync = (...args) => {
      const fd = real.openSync(...args)
      if (String(args[0]).endsWith('.claim')) fds.add(fd)
      return fd
    }
    const fault = () => {
      injected = true
      throw new Error('真实 receipt 故障')
    }
    fs.writeFileSync = (...args) => {
      if (mode === 'write' && fds.has(args[0])) fault()
      return real.writeFileSync(...args)
    }
    fs.fsyncSync = (...args) => {
      if (mode === 'fsync' && fds.has(args[0])) fault()
      return real.fsyncSync(...args)
    }
    fs.closeSync = fd => {
      const target = fds.has(fd)
      const result = real.closeSync(fd)
      fds.delete(fd)
      if (mode === 'close' && target) fault()
      return result
    }
    try { await claimStaleOffer(sid, { caseKey: offer.caseKey }) } catch (cause) { error = cause } finally { Object.assign(fs, real) }
    check(`W1 ${mode} 真实故障传播`, injected && !!error)
    let blocked = false
    try { await claimStaleOffer(sid, { caseKey: offer.caseKey }) } catch { blocked = true }
    check(`W2 ${mode} 永久 claim 不修复重开`, blocked)
  }
  const sid = 'receipt-identity'
  const original = fixture()
  saveState(sid, original)
  const offer = await issueStaleOffer(sid, original, cwd)
  const same = await issueStaleOffer(sid, original, cwd)
  check('W3 同代永久 offer 不换键不延期', offer.caseKey === same.caseKey && offer.expiresAt === same.expiresAt)
  const changed = structuredClone(original)
  changed.card.verify.cmd += ' '
  saveState(sid, changed)
  let blocked = false
  try { await claimStaleOffer(sid, { caseKey: offer.caseKey }) } catch { blocked = true }
  check('W4 卡执行属性变化拒绝旧领取', blocked && staleCaseIdentity(sid, original) !== staleCaseIdentity(sid, changed))
  const quotaSid = 'receipt-quota'
  for (let i = 0; i < 128; i++) {
    const item = fixture()
    item.last_verify.ts = String(i)
    saveState(quotaSid, item)
    await issueStaleOffer(quotaSid, item, cwd)
  }
  const item = fixture()
  item.last_verify.ts = '第129代'
  saveState(quotaSid, item)
  let full = false
  try { await issueStaleOffer(quotaSid, item, cwd) } catch { full = true }
  check('W5 128代预留claim后满额拒绝，不淘汰历史', full)

  // 真业务 marker 后换卡/更新旧验证：旧命令允许完成，但结果不得覆盖新证据。
  const receiptServer = startMcpClient({ entry: SERVER, cwd: ROOT, env: { CARLOS_FLOW_HOME: durableHome } })
  try {
    await receiptServer.initialize()
    for (const change of ['card', 'verify', 'ordinary-verify']) {
      const casSid = `receipt-cas-${change}`
      const started = path.join(cwd, `${change}.started`)
      const script = path.join(cwd, `${change}.mjs`)
      fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(started)}, 'entered')\nawait new Promise(resolve => setTimeout(resolve, 500))\n`)
      const initial = fixture()
      initial.card.verify.cmd = `node "${script}"`
      saveState(casSid, initial)
      const offered = await issueStaleOffer(casSid, initial, cwd)
      const running = receiptServer.request('tools/call', { name: 'flow_run_verify', arguments: { sessionId: casSid, ...(change === 'ordinary-verify' ? {} : { expected: { caseKey: offered.caseKey } }) },
        carlosContext: { session_id: casSid, workdir: cwd, workdir_is_local: true, workdir_is_read_only: false },
      })
      const deadline = Date.now() + 4000
      while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      check(`W16 ${change} 真业务已在锁外启动`, fs.existsSync(started))
      await stateModule.commitState(casSid, latest => {
        if (change === 'card') latest.card.goal = '后来新卡'
        else latest.last_verify.output_hash = '后来验证'
      })
      const response = await running
      const current = loadState(casSid)
      check(`W17 ${change} 完成CAS拒绝旧结果`, response.result?.isError === true &&
        (change === 'card' ? current.card.goal === '后来新卡' && current.last_verify.output_hash === '原输出' : current.last_verify.output_hash === '后来验证'))
    }
    const peer = startMcpClient({ entry: SERVER, cwd: ROOT, env: { CARLOS_FLOW_HOME: durableHome } })
    try {
      await peer.initialize()
      const physicalMarker = path.join(cwd, 'physical.marker')
      const physicalScript = path.join(cwd, 'physical.mjs')
      fs.writeFileSync(physicalScript, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(physicalMarker)}, 'spawn\\n')\nawait new Promise(resolve => setTimeout(resolve, 500))\n`)
      const physicalFixture = fixture()
      physicalFixture.card.verify.cmd = `node "${physicalScript}"`
      const runReceipt = (server, receiptSid, entry) => server.request('tools/call', {
        name: 'flow_run_verify', arguments: { sessionId: receiptSid, expected: { caseKey: entry.caseKey } },
        carlosContext: { session_id: receiptSid, workdir: cwd, workdir_is_local: true, workdir_is_read_only: false },
      })
      const markerCount = () => fs.existsSync(physicalMarker) ? fs.readFileSync(physicalMarker, 'utf8').trim().split('\n').filter(Boolean).length : 0
      const realSid = 'receipt-physical-real'
      const aliasSid = 'receipt-physical-alias'
      saveState(realSid, physicalFixture)
      const alias = path.join(RUNS_DIR, aliasSid)
      fs.symlinkSync(path.join(RUNS_DIR, realSid), alias, process.platform === 'win32' ? 'junction' : 'dir')
      try {
        const entry = await issueStaleOffer(realSid, physicalFixture, cwd)
        let aliasDenied = false
        let aliasEntry
        try { aliasEntry = await issueStaleOffer(aliasSid, physicalFixture, cwd) } catch (error) { aliasDenied = /session-layout/.test(error.message) }
        const responses = await Promise.all([runReceipt(receiptServer, realSid, entry), runReceipt(peer, aliasSid, aliasEntry || entry)])
        check('W18 真session链接在offer转换前拒绝', aliasDenied)
        check('W19 真别名双进程同物理同代最多spawn1', markerCount() === 1 && responses[1].result?.isError === true)
        let ordinaryEntered = false
        await withStateLock(aliasSid, () => { ordinaryEntered = true })
        check('W20 普通锁允许既有session别名的行为不变', ordinaryEntered)
      } finally { fs.unlinkSync(alias) }

      let caseSensitive = process.platform !== 'win32'
      if (process.platform === 'win32') {
        const enabled = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', RUNS_DIR, 'enable'], { encoding: 'utf8', windowsHide: true })
        caseSensitive = enabled.status === 0
        if (!caseSensitive) console.log(`  WARN Windows自有目录case-sensitive设置被拒，未提权；该分支未实测: ${enabled.status} ${(enabled.stdout || enabled.stderr).trim()}`)
      }
      if (caseSensitive) {
        const upperSid = 'ReceiptCase'
        const lowerSid = 'receiptcase'
        saveState(upperSid, physicalFixture)
        saveState(lowerSid, physicalFixture)
        const upperIno = fs.statSync(path.join(RUNS_DIR, upperSid), { bigint: true }).ino
        const lowerIno = fs.statSync(path.join(RUNS_DIR, lowerSid), { bigint: true }).ino
        const upperOffer = await issueStaleOffer(upperSid, physicalFixture, cwd)
        const lowerOffer = await issueStaleOffer(lowerSid, physicalFixture, cwd)
        const before = markerCount()
        await Promise.all([runReceipt(receiptServer, upperSid, upperOffer), runReceipt(peer, lowerSid, lowerOffer)])
        const distinct = upperIno !== lowerIno
        check('W21 真文件系统大小写语义按inode去重或隔离', distinct
          ? upperOffer.caseKey !== lowerOffer.caseKey && markerCount() === before + 2
          : upperOffer.caseKey === lowerOffer.caseKey && markerCount() === before + 1)
      }
      const zeroSid = 'receipt-zero-ino'
      saveState(zeroSid, physicalFixture)
      const realStat = fs.statSync
      fs.statSync = (...args) => {
        const stat = realStat(...args)
        return args[1]?.bigint ? Object.assign(Object.create(stat), { ino: 0n }) : stat
      }
      let zeroDenied = false
      try { await issueStaleOffer(zeroSid, physicalFixture, cwd) } catch { zeroDenied = true } finally { fs.statSync = realStat }
      check('W22 无法确认非零物理inode时fail-closed', zeroDenied)
    } finally { await peer.close() }
  } finally { await receiptServer.close() }
}

// 真实 Git 对象损坏 + 真实 MCP 工具链：不能将 Git 失败当非 Git 或 STALE。
{
  const faultHome = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-fingerprint-home-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-fingerprint-work-'))
  const c = startMcpClient({ entry: SERVER, cwd: ROOT, env: { CARLOS_FLOW_HOME: faultHome } })
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true })
    if (r.error || r.status !== 0) throw new Error(`Git fixture失败: ${r.stderr || r.error}`)
    return r.stdout.trim()
  }
  const tool = async (name, args) => {
    const r = await c.request('tools/call', { name, arguments: args }, 60000)
    const text = String(r.result?.content?.[0]?.text || '')
    let data
    try { data = JSON.parse(text) } catch { data = { ok: false, error: text } }
    return { ...data, isError: r.result?.isError === true, structuredContent: r.result?.structuredContent }
  }
  const setup = async (name, args) => {
    const r = await tool(name, args)
    if (r.ok !== true) throw new Error(`真实工具前置失败 ${name}: ${JSON.stringify(r)}`)
    return r
  }
  let objectPath, objectBytes
  try {
    git(['init', '-q'])
    git(['config', 'user.name', 'Owned fingerprint test'])
    git(['config', 'user.email', 'owned@example.invalid'])
    fs.writeFileSync(path.join(work, 'a.txt'), 'before\n')
    git(['add', 'a.txt'])
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
    const head = git(['rev-parse', 'HEAD'])
    objectPath = path.join(work, '.git', 'objects', head.slice(0, 2), head.slice(2))
    objectBytes = fs.readFileSync(objectPath)
    await c.initialize()
    const sessionId = 'cas-fingerprint-failure'
    const quote = '真实Git故障不得放行'
    const cmd = 'node -e "process.exit(require(\'fs\').readFileSync(\'a.txt\',\'utf8\').trim()===\'fixed\'?0:1)"'
    await setup('flow_add_user_msg', { sessionId, text: quote })
    await setup('flow_submit_requirement', {
      sessionId, goal: quote, quote, scope: ['a.txt'], acceptance: ['a.txt fixed'],
      verify: { cmd }, cwd: work, confirmed: true,
    })
    await setup('flow_claim', { sessionId, role: 'executor' })
    await setup('flow_dispatch', { sessionId, role: 'executor', run: false, cwd: work })
    fs.writeFileSync(path.join(work, 'a.txt'), 'fixed\n')
    await setup('flow_run_verify', { sessionId, cwd: work })
    const negative = await tool('flow_falsify', { sessionId, cwd: work })
    if (negative.verdict !== 'meaningful') throw new Error('真实负对照前置失败')
    await setup('flow_audit_axes', { sessionId })
    for (const axis of ['standards', 'spec']) await setup('flow_audit_submit', {
      sessionId, axis, verdict: 'PASS', findings: ['真实工具检查'], evidence: 'Git对象故障回归',
    })
    await setup('flow_claim', { sessionId, role: 'auditor' })
    check('F1 健康Git真实验证状态pass', (await tool('flow_status', { sessionId })).verify_state === 'pass')
    fs.unlinkSync(objectPath)
    const denied = await tool('flow_verdict', { sessionId, verdict: 'PASS', cwd: work })
    check('F2 当前Git损坏拒PASS且不是STALE向导', denied.isError && denied.structuredContent?.code !== 'VERIFY_STALE')
    check('F3 未知指纹状态不报pass', (await tool('flow_status', { sessionId })).verify_state === 'fail')
    const ran = await tool('flow_run_verify', { sessionId, cwd: work })
    check('F4 真命令成功但Git失败仍拒验证', ran.isError)
    const falsified = await tool('flow_falsify', { sessionId, cwd: work })
    check('F5 真负对照成功但Git失败仍拒有效证据', falsified.isError)
    const stored = JSON.parse(fs.readFileSync(path.join(faultHome, 'gate-state', 'runs', sessionId, 'state.json'), 'utf8'))
    check('F6 保存显式失败而非错误hash', stored.last_verify.ok === false &&
      stored.last_verify.fingerprint.reason === 'git_command_failed' && !stored.last_verify.fingerprint.diff_sha256)
    fs.writeFileSync(objectPath, objectBytes)
    const staleStored = await tool('flow_verdict', { sessionId, verdict: 'PASS', cwd: work })
    check('F7 Git恢复也不能复用失败证据', staleStored.isError && staleStored.structuredContent?.code !== 'VERIFY_STALE')
    await setup('flow_run_verify', { sessionId, cwd: work })
    check('F8 重新真实验证后健康PASS', (await tool('flow_verdict', { sessionId, verdict: 'PASS', cwd: work })).ok === true)
    const goodState = fs.readFileSync(path.join(faultHome, 'gate-state', 'runs', sessionId, 'state.json'), 'utf8')
    for (const field of ['head', 'diff_sha256']) {
      const damaged = JSON.parse(goodState)
      delete damaged.last_verify.fingerprint[field]
      const statePath = path.join(faultHome, 'gate-state', 'runs', sessionId, 'state.json')
      fs.writeFileSync(statePath, JSON.stringify(damaged))
      const result = await tool('flow_verdict', { sessionId, verdict: 'PASS', cwd: work })
      check(`F10 旧指纹缺${field}拒绝且不发STALE`, result.isError && result.structuredContent?.code !== 'VERIFY_STALE')
      check(`F11 旧指纹缺${field}状态fail`, (await tool('flow_status', { sessionId })).verify_state === 'fail')
      fs.writeFileSync(statePath, goodState)
    }
    git(['add', 'a.txt'])
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'verified fixed'])
    await setup('flow_run_verify', { sessionId, cwd: work })
    fs.writeFileSync(path.join(work, 'a.txt'), 'new bad commit\n')
    git(['add', 'a.txt'])
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'changed HEAD'])
    const headChanged = await tool('flow_verdict', { sessionId, verdict: 'PASS', cwd: work })
    check('F12 干净工作区换HEAD仍拒STALE', headChanged.isError && headChanged.structuredContent?.code === 'VERIFY_STALE')
    check('F13 HEAD变化状态stale', (await tool('flow_status', { sessionId })).verify_state === 'stale')
    for (const file of [' leading.txt', '中文 file.txt', 'large-untracked.txt']) {
      const target = path.join(work, file)
      const size = file.startsWith('large') ? 1100000 : 5
      fs.writeFileSync(target, 'A'.repeat(size))
      const before = stateModule.workspaceFingerprint(work)
      fs.writeFileSync(target, 'B'.repeat(size))
      const after = stateModule.workspaceFingerprint(work)
      check(`F14 未跟踪路径无损且同尺寸内容变化 ${file}`, before.ok && after.ok && before.diff_sha256 !== after.diff_sha256)
      fs.unlinkSync(target)
    }
    const unread = path.join(work, 'unread.txt')
    fs.writeFileSync(unread, '真实自有内容')
    const originalOpen = fs.openSync
    fs.openSync = (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(unread))
        throw Object.assign(new Error('自有未跟踪读取故障'), { code: 'EIO' })
      return originalOpen(...args)
    }
    const preload = path.join(faultHome, 'owned-read-fault.cjs')
    fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');const original=fs.openSync;fs.openSync=(...args)=>{if(path.resolve(String(args[0]))===${JSON.stringify(path.resolve(unread))})throw Object.assign(new Error('owned read EIO'),{code:'EIO'});return original(...args)};`)
    const oldNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = `${oldNodeOptions || ''} --require=${preload.replace(/\\/g, '/')}`.trim()
    try {
      const failed = stateModule.workspaceFingerprint(work)
      check('F15 真实文件局部读取故障不生成hash', failed.ok === false && failed.reason === 'untracked_read_failed' && !failed.diff_sha256)
    } finally {
      fs.openSync = originalOpen
      if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = oldNodeOptions
      fs.unlinkSync(unread)
    }
    const malformed = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-malformed-git-'))
    try {
      fs.mkdirSync(path.join(malformed, '.git'))
      const child = path.join(malformed, 'child')
      fs.mkdirSync(child)
      for (const dir of [malformed, child]) {
        const fp = stateModule.workspaceFingerprint(dir)
        check('F16 损坏祖先Git元数据不能冒充非Git', fp.ok === false && fp.reason !== 'not_a_git_repo' && !fp.diff_sha256)
      }
    } finally { fs.rmSync(malformed, { recursive: true, force: true }) }
    const slowFile = path.join(work, 'slow-close.txt')
    const childMarker = path.join(faultHome, 'child-close-marker.json')
    const closePreload = path.join(faultHome, 'owned-close-block.cjs')
    fs.writeFileSync(slowFile, '真实子进程读取')
    fs.writeFileSync(closePreload, `const fs=require('node:fs'),path=require('node:path');const originalOpen=fs.openSync,originalClose=fs.closeSync;const fds=new Set();fs.openSync=(...a)=>{const fd=originalOpen(...a);if(path.resolve(String(a[0]))===${JSON.stringify(path.resolve(slowFile))})fds.add(fd);return fd};fs.closeSync=fd=>{if(fds.has(fd)){fs.writeFileSync(${JSON.stringify(childMarker)},JSON.stringify({pid:process.pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);fs.appendFileSync(${JSON.stringify(childMarker)},'LATE')}return originalClose(fd)};`)
    const priorOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = `${priorOptions || ''} --require=${closePreload.replace(/\\/g, '/')}`.trim()
    try {
      const started = Date.now()
      const blocked = stateModule.workspaceFingerprint(work)
      const elapsed = Date.now() - started
      const marker = fs.readFileSync(childMarker, 'utf8')
      const pid = JSON.parse(marker).pid
      let reaped = false
      try { process.kill(pid, 0) } catch (e) { reaped = e.code === 'ESRCH' }
      await new Promise((resolve) => setTimeout(resolve, 250))
      check('F18 真实close阻塞子进程超时后已终止无后续写', blocked.ok === false && blocked.errorCode === 'ETIMEDOUT' &&
        !blocked.diff_sha256 && reaped && fs.readFileSync(childMarker, 'utf8') === marker && elapsed < 6500)
    } finally {
      if (priorOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = priorOptions
      fs.unlinkSync(slowFile)
    }
    const rootRecord = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: work, encoding: null, windowsHide: true,
    })
    check('F19 Git目录协议实测LF记录而非盲剥CR', rootRecord.status === 0 &&
      rootRecord.stdout[rootRecord.stdout.length - 1] === 10 &&
      (process.platform !== 'win32' || rootRecord.stdout[rootRecord.stdout.length - 2] !== 13),
    rootRecord.stdout.subarray(-2).toString('hex'))
    const nested = path.join(work, 'nested')
    fs.mkdirSync(nested)
    const parentDependency = path.join(work, 'parent-dependency.txt')
    fs.writeFileSync(parentDependency, 'A')
    const parentBefore = stateModule.workspaceFingerprint(nested)
    fs.writeFileSync(parentDependency, 'B')
    const parentAfter = stateModule.workspaceFingerprint(nested)
    check('F17 子目录调用仍绑定父目录未跟踪依赖', parentBefore.ok && parentAfter.ok && parentBefore.diff_sha256 !== parentAfter.diff_sha256)
    fs.unlinkSync(parentDependency)
    // 独立非仓库必须在Git工作区之外。
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-fingerprint-plain-'))
    try {
      const fp = stateModule.workspaceFingerprint(nonGit)
      check('F9 确认非Git仍兼容不可用', fp.ok === false && fp.reason === 'not_a_git_repo')
    } finally { fs.rmSync(nonGit, { recursive: true, force: true }) }
  } finally {
    if (objectPath && objectBytes && !fs.existsSync(objectPath)) fs.writeFileSync(objectPath, objectBytes)
    await c.close()
    fs.rmSync(faultHome, { recursive: true, force: true })
    fs.rmSync(work, { recursive: true, force: true })
  }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("VERIFY_CAS_OK");