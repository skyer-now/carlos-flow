// 跨进程状态锁 —— 退避 / 陈旧回收 —— 回归测试
//
// 背景：`withStateLock` 是门禁状态「读-改-写」的临界区保护。它一旦退化成
// 「谁都能进」或「进不去就死等」，都会出真实事故：
//   · 排他性失效 → 激活闸门被并发绕过（历史上红队 40 轮复现 4 次）；
//   · 死等不回收 → 持有者崩溃后同一会话永久卡死（用户只看到「请稍后重试」）。
//
// 本测试钉死四条行为：
//   1. 正常路径：拿到锁 → 执行 → 释放（锁文件不残留）；
//   2. 锁被活进程持有时：fail-closed，超时报错（绝不无锁写状态）；
//   3. 持有者 pid 已死：立即回收，不用干等满 staleMs；
//   4. 老式空锁无法证明 owner 死亡，即使超龄也必须拒绝。
//
// 跑法：node test/state-lock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-lock-home-"));
process.env.CARLOS_FLOW_HOME = HOME;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
};

const { withStateLock, RUNS_DIR, sanitizeId } = await import("../src/state.js");

const sid = "lock-test-" + Date.now();
const dir = path.join(RUNS_DIR, sanitizeId(sid));
const lockFile = path.join(dir, ".state.lock");
fs.mkdirSync(dir, { recursive: true });

// 1. 正常路径
let ran = 0;
await withStateLock(sid, () => { ran++; });
check("1a. 正常加锁后临界区执行", ran === 1);
check("1b. 退出后不残留锁文件", !fs.existsSync(lockFile));

// 1c. 锁文件里写的是持有者 pid（诊断用）
let sawPid = 0;
await withStateLock(sid, () => {
  try { sawPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10); } catch { sawPid = 0; }
});
check("1c. 锁文件记录持有者 pid", sawPid === process.pid, `pid=${sawPid}`);

// 2. 被活进程持有 → 超时报错（fail-closed）
fs.writeFileSync(lockFile, String(process.pid), "utf8");
let blocked = false;
let occupiedEntered = false
let blockedMsg = "";
const t2 = Date.now();
try {
  await withStateLock(sid, () => { occupiedEntered = true }, { timeoutMs: 250 });
} catch (e) {
  blocked = true;
  blockedMsg = String(e && e.message ? e.message : e);
}
const wait2 = Date.now() - t2;
check("2a. 锁被占用时不放行（fail-closed）", blocked === true);
check('P0. 真实占用时业务回调从未进入（不以释放异常冒充互斥）', !occupiedEntered)
check("2b. 超时错误里点明持有者", /获取状态锁超时/.test(blockedMsg) && blockedMsg.includes("pid="), blockedMsg.slice(0, 80));
check("2c. 按 timeoutMs 及时退出（没有死等）", wait2 < 3000, `${wait2}ms`);
fs.rmSync(lockFile, { force: true });

// 3. 持有者 pid 已死 → 立即回收（不必等满 staleMs）
const dead = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
const deadPid = dead.pid;
fs.writeFileSync(lockFile, String(deadPid), "utf8");
const t3 = Date.now();
let reclaimed = false;
try {
  await withStateLock(sid, () => { reclaimed = true; }, { timeoutMs: 3000, staleMs: 60000 });
} catch { reclaimed = false; }
const wait3 = Date.now() - t3;
check("3a. 死锁号（pid 已不存在）被即时回收", reclaimed === true, `deadPid=${deadPid}`);
check("3b. 回收是即时的（远小于 staleMs=60s）", wait3 < 1500, `${wait3}ms`);

// 4. 安全契约修订：未知空锁不得凭年龄推断 owner 已死
fs.writeFileSync(lockFile, "", "utf8");
const old = new Date(Date.now() - 120000);
try { fs.utimesSync(lockFile, old, old); } catch { /* 某些文件系统不支持，跳过 */ }
let reclaimedOld = false;
try {
  await withStateLock(sid, () => { reclaimedOld = true; }, { timeoutMs: 3000, staleMs: 30000 });
} catch { reclaimedOld = false; }
check("4a. 无 pid 的陈旧锁拒绝自动回收", reclaimedOld === false);
check("4b. 未知锁原样保留供人工核验", fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === '');
fs.unlinkSync(lockFile)

// 5. 退避不放大总耗时（多次竞争后仍能在 timeoutMs 内拿到锁）
let ok5 = 0;
for (let i = 0; i < 20; i++) {
  try { await withStateLock(sid, () => { ok5++; }, { timeoutMs: 2000 }); } catch { /* 计入失败 */ }
}
check("5a. 连续 20 次加锁全部成功（退避不会造成假超时）", ok5 === 20, `${ok5}/20`);

// 前置真实多进程测试：IPC marker 屏障，不以长 sleep 猜测持锁时刻。
const { spawn } = await import('node:child_process')
const stateUrl = new URL('../src/state.js', import.meta.url).href
const workerSource = `
  const { withStateLock } = await import(process.env.STATE_TEST_URL)
  process.send({ phase: 'ready' })
  process.once('message', async () => {
    try {
      await withStateLock(process.env.STATE_TEST_SID, async () => {
        process.send({ phase: 'entered' })
        await new Promise(resolve => process.once('message', resolve))
      }, { timeoutMs: 1500 })
      process.send({ phase: 'done' })
    } catch (error) { process.send({ phase: 'error', message: error.message }) }
    process.disconnect()
  })
`
function worker(id, home = HOME) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, CARLOS_FLOW_HOME: home, STATE_TEST_URL: stateUrl, STATE_TEST_SID: id },
  })
  const queue = []
  const waits = []
  child.on('message', message => waits.length ? waits.shift()(message) : queue.push(message))
  return {
    child,
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('marker 等待超时')), 8000)
      waits.push(message => { clearTimeout(timer); resolve(message) })
    }),
  }
}
const ownedChildren = []
try {
  const activeSid = `${sid}-aged`
  const owner = worker(activeSid)
  ownedChildren.push(owner.child)
  await owner.next()
  owner.child.send('start')
  check('P1a. 真实 owner 已进入', (await owner.next()).phase === 'entered')
  const activeLock = path.join(RUNS_DIR, activeSid, '.state.lock')
  const oldTime = new Date(Date.now() - 120000)
  fs.utimesSync(activeLock, oldTime, oldTime)
  let overlap = false
  try { await withStateLock(activeSid, () => { overlap = true }, { timeoutMs: 120 }) } catch {}
  check('P1b. 活 owner 老化不被抢占（旧 age 负控）', !overlap)
  owner.child.send('release')
  check('P1c. 原 owner 安全释放', (await owner.next()).phase === 'done')

  const raceSid = `${sid}-reapers`
  const raceDir = path.join(RUNS_DIR, raceSid)
  fs.mkdirSync(raceDir, { recursive: true })
  fs.writeFileSync(path.join(raceDir, '.state.lock'), String(deadPid))
  const a = worker(raceSid)
  const b = worker(raceSid)
  ownedChildren.push(a.child, b.child)
  await Promise.all([a.next(), b.next()])
  a.child.send('start')
  b.child.send('start')
  const winner = await Promise.race([a.next().then(message => ({ worker: a, message })), b.next().then(message => ({ worker: b, message }))])
  check('P3a. 双 reaper 有且仅有先入 owner', winner.message.phase === 'entered')
  // 第二个 next 已在等待；用单独消息监听观察它，不取消竞争中的 Promise。
  const loser = winner.worker === a ? b : a
  const loserEntered = new Promise(resolve => loser.child.once('message', resolve))
  winner.worker.child.send('release')
  const next = await loserEntered
  check('P3b. 后继 owner 未被旧 reaper 删除', next.phase === 'entered')
  loser.child.send('release')

  let ticks = 0
  const ticker = setInterval(() => { ticks++ }, 5)
  await withStateLock(`${sid}-async`, async () => {
    let blocked = false
    try { await withStateLock(`${sid}-async`, () => {}, { timeoutMs: 80 }) } catch { blocked = true }
    check('P2. 异步等待/重入有界拒绝', blocked && ticks > 0)
  })
  clearInterval(ticker)

  const identitySid = `${sid}-identity`
  const identityLock = path.join(RUNS_DIR, identitySid, '.state.lock')
  let identityError
  try {
    await withStateLock(identitySid, () => {
      fs.writeFileSync(identityLock, `${process.pid}\n${'b'.repeat(24)}`)
      throw new Error('业务首因')
    })
  } catch (error) { identityError = error }
  check('P5. 释放核 nonce、保留业务首因与释放错误',
    identityError?.cause?.message === '业务首因' && identityError.errors.length === 2 &&
    fs.readFileSync(identityLock, 'utf8').endsWith('b'.repeat(24)))
  fs.unlinkSync(identityLock)

  // 真实 junction/符号链接及 Windows 大小写必须命中同一 gate，不能只验证 wx。
  const alias = `${HOME}-alias`
  fs.symlinkSync(HOME, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const { createHash } = await import('node:crypto')
    const aliasSid = `${sid}-alias`
    const sessionDir = path.join(RUNS_DIR, aliasSid)
    fs.mkdirSync(sessionDir, { recursive: true })
    const normalize = file => process.platform === 'win32' ? file.toLowerCase() : file
    const physicalRuns = fs.realpathSync.native(RUNS_DIR)
    const physicalSession = normalize(fs.realpathSync.native(sessionDir))
    const gate = path.join(path.dirname(physicalRuns), 'state-transitions', createHash('sha256').update(path.join(physicalSession, '.state.lock')).digest('hex'))
    fs.mkdirSync(gate, { recursive: true })
    fs.writeFileSync(path.join(gate, 'unknown.json'), '{}')
    for (const home of process.platform === 'win32' ? [alias, HOME.toUpperCase()] : [alias]) {
      const probe = worker(aliasSid, home)
      ownedChildren.push(probe.child)
      await probe.next()
      probe.child.send('start')
      const result = await probe.next()
      check('P9. 物理根别名命中同一未知 gate 并拒绝', result.phase === 'error' && /gate-read/.test(result.message))
    }
  } finally {
    // 仅解除本次创建的链接，不递归操作目标。
    fs.unlinkSync(alias)
  }

  // 两个不同 RUNS 根链接同一外部 session：必须在 gate/create/reap 之前拒绝。
  const rootA = path.join(HOME, 'escape-home-A')
  const rootB = path.join(HOME, 'escape-home-B')
  const runsA = path.join(rootA, 'gate-state', 'runs')
  const runsB = path.join(rootB, 'gate-state', 'runs')
  // 与 runs 前缀相似也不能误判为子目录。
  const shared = path.join(rootA, 'gate-state', 'runs-similar', 'shared')
  fs.mkdirSync(shared, { recursive: true })
  const sharedLock = path.join(shared, '.state.lock')
  const deadText = String(deadPid)
  fs.writeFileSync(sharedLock, deadText)
  for (const runs of [runsA, runsB]) {
    fs.mkdirSync(runs, { recursive: true })
    fs.symlinkSync(shared, path.join(runs, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const escaped = [worker('shared', rootA), worker('shared', rootB)]
  ownedChildren.push(...escaped.map(probe => probe.child))
  await Promise.all(escaped.map(probe => probe.next()))
  for (const probe of escaped) probe.child.send('start')
  const escapedResults = await Promise.all(escaped.map(probe => probe.next()))
  check('R2. 不同 RUNS 根指向同一外部 session 均在转换前拒绝', escapedResults.every(result => result.phase === 'error' && /session-layout/.test(result.message)))
  check('R2. 拒绝逃逸布局不回收死锁、不生成 gate、不改目标', fs.readFileSync(sharedLock, 'utf8') === deadText &&
    fs.readdirSync(shared).join(',') === '.state.lock' &&
    [runsA, runsB].every(runs => !fs.existsSync(path.join(path.dirname(runs), 'state-transitions'))))
  for (const runs of [runsA, runsB]) fs.unlinkSync(path.join(runs, 'shared'))
  for (const invalid of ['.', '..']) {
    let entered = false
    try { await withStateLock(invalid, () => { entered = true }) } catch {}
    check(`R2. 非直接子目录 ${invalid} 不进入业务`, !entered)
  }

  // 实际 IO 路径保留 realpath 拼写，不能因 gate key 归一而 lower IO。
  const mixedSid = 'MiXeD-IO-Identity'
  const mixedDir = path.join(RUNS_DIR, mixedSid)
  fs.mkdirSync(mixedDir, { recursive: true })
  const expectedLock = path.join(fs.realpathSync.native(mixedDir), '.state.lock')
  const realOpen = fs.openSync
  let seenLock
  fs.openSync = (...args) => {
    if (String(args[0]).endsWith('.state.lock')) seenLock = args[0]
    return realOpen(...args)
  }
  try { await withStateLock(mixedSid, () => {}) } finally { fs.openSync = realOpen }
  check('R2. gate key 与实际 IO 大小写分离', seenLock === expectedLock)
} finally {
  for (const child of ownedChildren) {
    if (child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else { try { child.kill('SIGKILL') } catch {} }
    }
  }
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("STATE_LOCK_OK");
