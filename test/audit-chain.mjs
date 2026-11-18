// 审计链篡改检测验证 —— 「防篡改」承诺必须真的成立
//
// 背景：2026-11-07 的第三方审查发现审计链是**裸 SHA-256**（无密钥），
// 攻击者能读文件就能重算整条链 → 篡改无法被发现。
// 本次修复：设置 CARLOS_FLOW_AUDIT_KEY 时用 HMAC-SHA256（带密钥），
// 未设置时降级为 plain 模式并在 verify 结果里**显式标注 mode**。
//
// 这个脚本用**真实篡改**验证：
//   1) hmac 模式下，篡改一条记录 → 必须被检测出来
//   2) plain 模式下，篡改一条记录 → 会被重算掩盖（这是 plain 模式的**已知局限**，
//      脚本要如实记录这个事实，而不是假装 plain 也能防篡改）
//   3) legacy 记录（无 hash）不应让后续记录全部误报 broken
//   4) 未篡改的链必须 ok:true
//
// 跑法：node test/audit-chain.mjs
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// 审计文件按**本地日期**分文件（state.js 的 localDate）。
// 这里必须用本地日期而不是 toISOString()（UTC）—— 在 UTC+8 的 00:00–08:00，
// UTC 日期比本地日期慢一天，用 UTC 会读到/写到**另一天**的文件。
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let pass = 0,
  fail = 0
const check = (n, ok, d = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${n}`)
  } else {
    fail++
    console.log(`  ✗ ${n}  ${d}`)
    if (existsSync(join(home, 'gate-audit'))) cpSync(join(home, 'gate-audit'), join(home, `failed-audit-${fail}`), { recursive: true })
  }
}

console.log('\n════ 审计链篡改检测验证 ════\n')

// ---- 准备一个隔离的 FLOW_HOME ----
const home = mkdtempSync(join(tmpdir(), 'carlos-audit-'))
const KEY = 'test-audit-key-0123456789'

/** 在指定模式下导入 state.js（模块级缓存 → 用不同 query 参数强制重载） */
async function loadStateModule(mode) {
  const env = {
    ...process.env,
    CARLOS_FLOW_HOME: home,
    HOME: home,
    USERPROFILE: home,
  }
  if (mode === 'hmac') env.CARLOS_FLOW_AUDIT_KEY = KEY
  else delete env.CARLOS_FLOW_AUDIT_KEY
  // 通过子进程跑，避免 ESM 模块缓存导致 AUDIT_KEY 常量固定
  return env
}

/** 在子进程里写审计记录并校验 */
function runInChild(mode, script) {
  const env = {
    ...process.env,
    CARLOS_FLOW_HOME: home,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(home, 'npm-cache'),
  }
  if (mode === 'hmac') env.CARLOS_FLOW_AUDIT_KEY = KEY
  else delete env.CARLOS_FLOW_AUDIT_KEY
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    cwd: ROOT,
  })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

const WRITE_SCRIPT = `
import { audit } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
audit("run", "sess-tamper", { kind: "record", n: 1 });
audit("run", "sess-tamper", { kind: "record", n: 2 });
audit("run", "sess-tamper", { kind: "record", n: 3 });
console.log("written");
`

const VERIFY_SCRIPT = `
import { verifyAuditChain, auditHashMode } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
const r = verifyAuditChain({});
console.log(JSON.stringify({ ok: r.ok, broken: r.broken, total: r.total, mode: r.mode }));
`

const VERIFY_SCRIPT_KEYED = `
import { verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
const r = verifyAuditChain({});
console.log(JSON.stringify({ ok: r.ok, broken: r.broken, total: r.total, mode: r.mode }));
`

// 确定性回收声明共享冲突，审计不得吞掉永久发布/撤销失败再报成功。
const reaperSharing = runInChild(
  'plain',
  `
  import fs from 'node:fs'; import path from 'node:path';
  import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';
  import * as s from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
  fs.mkdirSync(s.AUDIT_DIR,{recursive:true});
  const dead=spawnSync(process.execPath,['-e','']).pid;
  const lock=path.join(s.AUDIT_DIR,'.append-lock'), dir=lock+'.reapers';
  fs.mkdirSync(dir,{recursive:true});
  const foreign=path.join(dir,'foreign.json'), foreignText=JSON.stringify({pid:dead,ticket:1,choosing:false});
  fs.writeFileSync(foreign,foreignText);
  for(const phase of ['first','second','unlink','temp','write-first','write-second']) {
    for(const permanent of [false,true]) {
      fs.mkdirSync(lock,{recursive:true});fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:dead}));
      const rename=fs.renameSync,unlink=fs.unlinkSync,write=fs.writeFileSync;
      let hits=0,choosingVisible=false;
      const ownSlot=f=>path.dirname(String(f))===dir&&String(f)!==foreign&&String(f).endsWith('.json');
      const ownTemp=f=>path.dirname(String(f))===dir&&String(f).endsWith('.json.tmp');
      const fail=()=>{hits++;const e=new Error('确定性审计共享冲突');e.code='EPERM';throw e};
      const shouldFail=()=>permanent||hits<3;
      fs.renameSync=(a,b,...args)=>{
        if(ownSlot(b)) {
          const value=JSON.parse(fs.readFileSync(a,'utf8'));
          if((phase==='first'?value.choosing:phase==='second'&&!value.choosing)&&shouldFail()) {
            if(!value.choosing)choosingVisible=JSON.parse(fs.readFileSync(b,'utf8')).choosing===true;
            fail();
          }
        }
        return rename(a,b,...args);
      };
      fs.unlinkSync=(f,...args)=>{if(((phase==='unlink'&&ownSlot(f))||(phase==='temp'&&ownTemp(f)))&&shouldFail())fail();return unlink(f,...args)};
      fs.writeFileSync=(f,data,...args)=>{
        if(ownTemp(f)) {
          const value=JSON.parse(data);
          if((phase==='write-first'&&value.choosing)||(phase==='write-second'&&!value.choosing)) {write(f,data,...args);fail()}
        }
        return write(f,data,...args);
      };
      const before=s.verifyAuditChain().total,started=Date.now();let receipt;
      try {receipt=s.audit('run','reaper-sharing',{phase,permanent})}
      finally {fs.renameSync=rename;fs.unlinkSync=unlink;fs.writeFileSync=write}
      assert.equal(receipt.persisted,!permanent&&!phase.startsWith('write-'));
      assert.ok(hits>0);assert.ok(Date.now()-started<2500);
      if(phase==='second')assert.equal(choosingVisible,true);
      assert.equal(s.verifyAuditChain().total,before+(receipt.persisted?1:0));
      assert.equal(fs.readFileSync(foreign,'utf8'),foreignText);
      assert.equal(fs.readdirSync(dir).some(n=>n.endsWith('.tmp')),false);
      if(phase!=='unlink'||!permanent)assert.deepEqual(fs.readdirSync(dir),['foreign.json']);
      for(const name of fs.readdirSync(dir))if(name!=='foreign.json')fs.unlinkSync(path.join(dir,name));
      fs.rmSync(lock,{recursive:true,force:true});
    }
  }
  assert.equal(s.verifyAuditChain().ok,true);
`,
)
check(
  '审计首/二发布、choosing可见、瞬时/永久EPERM与清理故障均诚实回执',
  reaperSharing.status === 0,
  reaperSharing.stderr,
)

// 确定性释放屏障下的真实文件系统发布；不伪造成功 rename。
async function retirementChecks(source) {
  const { default: fs } = await import('node:fs')
  const { default: path } = await import('node:path')
  const { default: assert } = await import('node:assert/strict')
  const { spawn, spawnSync } = await import('node:child_process')
  const { pathToFileURL } = await import('node:url')
  const s = await import(pathToFileURL(source).href)
  const lock = path.join(s.AUDIT_DIR, '.append-lock')
  const wait = (file) => {
    const end = Date.now() + 10000
    while (!fs.existsSync(file)) {
      if (Date.now() > end) throw new Error('屏障等待超时: ' + file)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  const isolatedModule = async (name, expose = false) => {
    const priorHome = process.env.CARLOS_FLOW_HOME
    const caseHome = path.join(priorHome, name)
    fs.mkdirSync(caseHome, { recursive: true })
    const file = path.join(caseHome, 'state.mjs')
    let text = fs.readFileSync(source, 'utf8')
    if (expose) text += '\nexport { withAuditLock }\n'
    fs.writeFileSync(file, text)
    process.env.CARLOS_FLOW_HOME = caseHome
    try {
      return await import(pathToFileURL(file).href)
    } finally {
      process.env.CARLOS_FLOW_HOME = priorHome
    }
  }
  async function successor({ source, lock, ready, go }) {
    const { default: fs } = await import('node:fs')
    const { pathToFileURL } = await import('node:url')
    const rename = fs.renameSync
    fs.renameSync = (a, b, ...args) => {
      const result = rename(a, b, ...args)
      if (String(b) === lock) {
        fs.writeFileSync(ready, String(process.pid))
        const end = Date.now() + 10000
        while (!fs.existsSync(go)) {
          if (Date.now() > end) throw new Error('后继屏障超时')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
      }
      return result
    }
    const s = await import(pathToFileURL(source).href)
    const receipt = s.audit('run', 'successor')
    console.log(JSON.stringify({
      persisted: receipt.persisted,
      error: receipt.error,
      receipt,
    }))
    if (!receipt.persisted) process.exitCode = 2
  }
  const controls = process.platform === 'win32' ? [false] : [true, false]
  // 负控仅替换释放块，候选目录仍通过真实 rename 发布。
  const cases = controls.map((old) => ({ old, mode: 'normal' }))
  cases.push(
    { old: false, mode: 'exception' },
    { old: false, mode: 'barrier-failure' },
    { old: false, mode: 'cleanup-retry' },
    { old: false, mode: 'go-failure' },
  )
  for (const { old, mode } of cases) {
    const copy = path.join(process.env.CARLOS_FLOW_HOME, `control-${old}-${mode}.mjs`)
    let text = fs.readFileSync(source, 'utf8')
    if (old) {
      const start = text.indexOf('      // 仅在完整唯一 owner')
      const end = text.indexOf('\n    }\n  } catch (e)', start)
      assert.ok(start > 0 && end > start)
      text = text.slice(0, start) +
        '      fs.unlinkSync(owner)\n      fs.rmdirSync(lock)' + text.slice(end)
    }
    fs.writeFileSync(copy, text)
    const m = await import(pathToFileURL(copy).href)
    const ready = path.join(process.env.CARLOS_FLOW_HOME, `ready-${old}-${mode}`)
    const go = ready + '.go'
    let peer
    let closed
    let diag = ''
    let observed = false
    let closedObserved = false
    let spawnCount = 0
    let cleanupHits = 0
    let receipt
    let failure
    let signalError
    let code = -1
    const rename = fs.renameSync
    const unlink = fs.unlinkSync
    const remove = fs.rmSync
    const write = fs.writeFileSync
    const terminateOwnTree = () => {
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill', ['/PID', String(peer.pid), '/T', '/F'], {
          encoding: 'utf8',
        })
        diag += killed.stderr || ''
        if (killed.status !== 0) throw new Error('自有 peer 整树终止失败: ' + diag)
      } else {
        try {
          process.kill(-peer.pid, 'SIGKILL')
        } catch (e) {
          if (e.code !== 'ESRCH') throw e
        }
      }
    }
    const barrier = () => {
      // 私有 cleanup 重试不得再派生第二个等待中的后继。
      if (peer) return
      const script = `(${successor.toString()})(${JSON.stringify({ source, lock, ready, go })})`
      peer = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      spawnCount++
      closed = new Promise((resolve) => {
        peer.on('error', (e) => { diag += e.message })
        peer.on('close', (value) => {
          closedObserved = true
          resolve(value)
        })
      })
      peer.stdout.on('data', (b) => { diag += b })
      peer.stderr.on('data', (b) => { diag += b })
      wait(ready)
      observed = true
    }
    fs.unlinkSync = (file, ...args) => {
      const result = unlink(file, ...args)
      if (old && String(file) === path.join(lock, 'owner.json')) barrier()
      return result
    }
    fs.rmSync = (file, ...args) => {
      if (!old && String(file).includes('.retired-')) {
        barrier()
        if (mode === 'barrier-failure') throw new Error('注入屏障清理异常')
        const owner = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')
        assert.equal(JSON.parse(owner).pid, Number(fs.readFileSync(ready, 'utf8')))
        if (mode === 'cleanup-retry' && cleanupHits++ === 0) {
          const e = new Error('注入私有清理瞬时冲突')
          e.code = 'EPERM'
          throw e
        }
        const result = remove(file, ...args)
        assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner)
        return result
      }
      return remove(file, ...args)
    }
    fs.writeFileSync = (file, ...args) => {
      if (mode === 'go-failure' && file === go) throw new Error('注入 go 写入失败')
      return write(file, ...args)
    }
    try {
      receipt = m.audit('run', 'predecessor')
      if (mode === 'exception') throw new Error('注入屏障主体异常')
    } catch (e) {
      failure = e
    } finally {
      fs.renameSync = rename
      fs.unlinkSync = unlink
      fs.rmSync = remove
      try {
        if (peer) fs.writeFileSync(go, 'go')
      } catch (e) {
        signalError = e
        try {
          terminateOwnTree()
        } catch (killError) {
          signalError = new AggregateError([e, killError], e.message, { cause: e })
        }
      } finally {
        fs.writeFileSync = write
        if (peer) code = await closed
      }
    }
    assert.equal(observed, true)
    assert.equal(closedObserved, true, '断言前必须收到全部后继 close')
    assert.equal(spawnCount, 1, '清理重试不能遗留额外 peer')
    if (mode === 'go-failure') {
      assert.match(signalError.message, /go 写入失败/)
      assert.notEqual(code, 0, diag)
      // 自有 worker 已整树 close，才清理其崩溃遗留隔离锁。
      fs.rmSync(lock, { recursive: true, force: true })
    } else {
      assert.equal(code, 0, diag)
      assert.equal(signalError, undefined)
    }
    if (mode === 'exception') assert.match(failure.message, /屏障主体异常/)
    else assert.equal(failure, undefined)
    assert.equal(receipt.persisted, !old && mode !== 'barrier-failure', JSON.stringify(receipt))
    if (mode === 'barrier-failure') assert.match(receipt.error, /屏障清理异常/)
    if (old) assert.match(receipt.error, /ENOTEMPTY|EEXIST/)
    assert.equal(s.verifyAuditChain().ok, true)
    fs.unlinkSync(copy)
    console.log(JSON.stringify({
      control: old ? 'old-negative' : 'new-positive',
      mode,
      persisted: receipt.persisted,
      error: receipt.error,
      close: code,
      closedObserved,
      spawnCount,
      signalError: signalError?.message,
      peer: diag,
    }))
  }
  const matrix = []
  for (const phase of ['retire', 'cleanup']) {
    for (const permanent of [false, true]) {
      for (const after of [false, true]) {
        for (const errno of ['EPERM', 'EACCES', 'EBUSY']) {
          matrix.push({ phase, permanent, after, errno })
        }
      }
    }
  }
  for (const { phase, permanent, after, errno } of matrix) {
    const f = await isolatedModule(`fault-${phase}-${permanent}-${after}-${errno}`)
    const caseLock = path.join(f.AUDIT_DIR, '.append-lock')
    const rename = fs.renameSync
    const remove = fs.rmSync
    let hits = 0
    const fault = () => {
      hits++
      const e = new Error('注入 ' + phase)
      e.code = errno
      throw e
    }
    fs.renameSync = (a, b, ...args) => {
      if (phase === 'retire' && String(b).includes('.retired-') && (permanent || hits === 0)) {
        if (after) rename(a, b, ...args)
        fault()
      }
      return rename(a, b, ...args)
    }
    fs.rmSync = (file, ...args) => {
      if (phase === 'cleanup' && String(file).includes('.retired-') && (permanent || hits === 0)) {
        if (after) remove(file, ...args)
        fault()
      }
      return remove(file, ...args)
    }
    const before = f.verifyAuditChain().total
    let receipt
    try {
      receipt = f.audit('run', 'fault', { phase, permanent, after })
    } finally {
      fs.renameSync = rename
      fs.rmSync = remove
    }
    const expected = !permanent && (phase === 'cleanup' || !after)
    assert.equal(receipt.persisted, expected, JSON.stringify(receipt))
    if (phase === 'retire' && after) assert.equal(hits, 1, '模糊成功不得重试')
    else if (permanent) assert.ok(hits > 1 && hits <= 51, '自有操作重试有界')
    else assert.equal(hits, 1)
    if (!expected) {
      assert.ok(receipt.error.includes(errno) && receipt.error.includes(
        phase === 'retire' ? 'retire 失败' : 'cleanup 失败',
      ), receipt.error)
      assert.match(receipt.error, /追加可能已完成/)
    }
    assert.equal(f.verifyAuditChain().total, before + 1)
    console.log(JSON.stringify({
      phase,
      permanent,
      after,
      errno,
      hits,
      persisted: receipt.persisted,
      error: receipt.error,
      receipt,
    }))
    // 全部 worker close 后才重置隔离 fixture；绝不截断审计历史。
    fs.rmSync(caseLock, { recursive: true, force: true })
    for (const name of fs.readdirSync(f.AUDIT_DIR).filter((n) => n.includes('.retired-'))) {
      fs.rmSync(path.join(f.AUDIT_DIR, name), { recursive: true })
    }
  }
  // 业务首因、释放和候选清理异常必须全部保留，回执可直接看见首因。
  for (const phase of ['retire', 'cleanup']) {
    const f = await isolatedModule('compound-' + phase, true)
    const primary = new Error('PRIMARY-WRITE-FAILURE')
    const secondary = new Error('SECONDARY-' + phase)
    secondary.code = 'EIO'
    const candidateError = new Error('CANDIDATE-CLEANUP-FAILURE')
    candidateError.code = 'EIO'
    const rename = fs.renameSync
    const remove = fs.rmSync
    const open = fs.openSync
    fs.renameSync = (a, b, ...args) => {
      if (phase === 'retire' && String(b).includes('.retired-')) throw secondary
      return rename(a, b, ...args)
    }
    fs.rmSync = (file, ...args) => {
      if (String(file).includes('.candidate-')) throw candidateError
      if (phase === 'cleanup' && String(file).includes('.retired-')) throw secondary
      return remove(file, ...args)
    }
    let thrown
    let receipt
    try {
      try {
        f.withAuditLock(() => { throw primary })
      } catch (e) {
        thrown = e
      }
      assert.ok(thrown instanceof AggregateError)
      assert.equal(thrown.cause, primary)
      assert.equal(thrown.errors[0], primary)
      assert.equal(thrown.errors[1].cause, secondary)
      assert.equal(thrown.errors[2].cause, candidateError)
      // 上次调用已完成，且没有其他 worker，才复位本用例的锁。
      remove(path.join(f.AUDIT_DIR, '.append-lock'), { recursive: true, force: true })
      fs.openSync = (file, ...args) => {
        if (String(file).endsWith('.jsonl')) throw primary
        return open(file, ...args)
      }
      receipt = f.audit('run', 'compound')
    } finally {
      fs.renameSync = rename
      fs.rmSync = remove
      fs.openSync = open
    }
    assert.equal(receipt.persisted, false)
    assert.match(receipt.error, /PRIMARY-WRITE-FAILURE/)
    assert.match(receipt.error, /SECONDARY-/)
    assert.match(receipt.error, /CANDIDATE-CLEANUP-FAILURE/)
    console.log(JSON.stringify({ compound: phase, error: receipt.error, causes: thrown.errors.length }))
  }
  const initialization = await isolatedModule('candidate-initialization', true)
  const initPrimary = new Error('OWNER-WRITE-PRIMARY')
  const initCleanup = new Error('OWNER-CANDIDATE-CLEANUP')
  const originalWrite = fs.writeFileSync
  const originalRemove = fs.rmSync
  fs.writeFileSync = (file, ...args) => {
    if (String(file).includes('.candidate-')) throw initPrimary
    return originalWrite(file, ...args)
  }
  fs.rmSync = (file, ...args) => {
    if (String(file).includes('.candidate-')) throw initCleanup
    return originalRemove(file, ...args)
  }
  try {
    assert.throws(() => initialization.withAuditLock(() => assert.fail('未发布不得执行')), (e) => {
      assert.ok(e instanceof AggregateError)
      assert.equal(e.cause, initPrimary)
      assert.equal(e.errors[0], initPrimary)
      assert.equal(e.errors[1].cause, initCleanup)
      console.log(JSON.stringify({ initialization: e.message, causes: e.errors.length }))
      return true
    })
  } finally {
    fs.writeFileSync = originalWrite
    fs.rmSync = originalRemove
  }
  // 死主锁的实际私有清理和共享移动 IO 故障不得被当未知 owner 吞掉。
  for (const phase of ['rename', 'cleanup']) {
    const f = await isolatedModule('dead-' + phase)
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    const caseLock = path.join(f.AUDIT_DIR, '.append-lock')
    fs.mkdirSync(caseLock, { recursive: true })
    const ownerText = JSON.stringify({ pid: dead })
    fs.writeFileSync(path.join(caseLock, 'owner.json'), ownerText)
    const rename = fs.renameSync
    const remove = fs.rmSync
    let hits = 0
    const fault = () => {
      hits++
      const e = new Error('DEAD-' + phase + '-EIO')
      e.code = 'EIO'
      throw e
    }
    fs.renameSync = (a, b, ...args) => {
      if (phase === 'rename' && String(b).includes('.dead-')) fault()
      return rename(a, b, ...args)
    }
    fs.rmSync = (file, ...args) => {
      if (phase === 'cleanup' && String(file).includes('.dead-')) fault()
      return remove(file, ...args)
    }
    let receipt
    const before = f.verifyAuditChain().total
    try {
      receipt = f.audit('run', 'dead-fault')
    } finally {
      fs.renameSync = rename
      fs.rmSync = remove
    }
    assert.equal(receipt.persisted, false)
    assert.equal(hits, 1, '死锁共享移动及私有清理不得盲重试')
    assert.match(receipt.error, /DEAD-.*-EIO/)
    assert.match(receipt.error, /审计回收锁 dead/)
    assert.equal(f.verifyAuditChain().total, before)
    if (phase === 'rename') {
      assert.equal(fs.readFileSync(path.join(caseLock, 'owner.json'), 'utf8'), ownerText)
    } else {
      assert.equal(fs.existsSync(caseLock), false)
      assert.equal(fs.readdirSync(f.AUDIT_DIR).filter((n) => n.includes('.dead-')).length, 1)
    }
    console.log(JSON.stringify({ dead: phase, hits, persisted: receipt.persisted, error: receipt.error }))
  }
  async function crashWorker({ source, after }) {
    const { default: fs } = await import('node:fs')
    const { pathToFileURL } = await import('node:url')
    const rename = fs.renameSync
    fs.renameSync = (a, b, ...args) => {
      if (String(b).includes('.retired-')) {
        if (after) rename(a, b, ...args)
        process.exit(74)
      }
      return rename(a, b, ...args)
    }
    const s = await import(pathToFileURL(source).href)
    s.audit('run', 'release-crash')
  }
  for (const after of [false, true]) {
    const script = `(${crashWorker.toString()})(${JSON.stringify({ source, after })})`
    const crash = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: process.env,
      encoding: 'utf8',
    })
    assert.equal(crash.status, 74, crash.stderr)
    assert.equal(s.audit('run', 'after-crash').persisted, true)
    assert.equal(s.verifyAuditChain().ok, true)
    console.log(JSON.stringify({ crash: after ? 'after-retire' : 'before-retire', status: crash.status }))
  }
}
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
const retirement = runInChild(
  'plain',
  `(${retirementChecks.toString()})(${JSON.stringify(join(ROOT, 'src', 'state.js'))})`,
)
check('真实屏障、异常全部 close、24 项矩阵、复合首因及死锁 IO 回执', retirement.status === 0, retirement.stderr)
console.log(retirement.stdout)

// ---- 大尾行回归：反向跨块读取，不以固定窗口截断记录 ----
for (const mode of ['plain', 'hmac']) {
  rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
  const result = runInChild(
    mode,
    `
    import fs from "node:fs";
    import path from "node:path";
    import assert from "node:assert/strict";
    import { audit, AUDIT_DIR, verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
    audit("run", "tail", { kind: "种子" });
    for (const size of [20000, 1000000]) {
      const tail = audit("run", "tail", { payload: "中文😀".repeat(size) });
      const file = path.join(AUDIT_DIR, fs.readdirSync(AUDIT_DIR).find(n => n.endsWith(".jsonl")));
      if (size === 1000000) {
        // 去掉换行并移为前一天分片，后继写入新文件，不制造粘行。
        fs.truncateSync(file, fs.statSync(file).size - 1);
        fs.renameSync(file, path.join(AUDIT_DIR, "2000-01-01.jsonl"));
      }
      const next = audit("run", "tail", { kind: "长尾之后" });
      assert.equal(next.prevHash, tail.hash, "多字节大行跨任意多块仍须接上");
      assert.equal(verifyAuditChain().ok, true, "完整大行链可校验");
    }
  `,
  )
  check(
    `${mode} 多字节超多块大尾行准确接续`,
    result.status === 0,
    result.stderr,
  )
}

// 无 hash 与坏尾行沿用跳过策略：容忍旧格式不等于保证这些行的完整性。
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
const tailResult = runInChild(
  'plain',
  `
  import fs from "node:fs";
  import path from "node:path";
  import assert from "node:assert/strict";
  import { audit, AUDIT_DIR, verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
  const seed = audit("run", "tail", { kind: "种子" });
  const file = path.join(AUDIT_DIR, fs.readdirSync(AUDIT_DIR)[0]);
  fs.appendFileSync(file, JSON.stringify({ payload: "旧格式😀".repeat(10000) }) + "\\n" + "坏尾行".repeat(10000) + "\\n  \\n");
  const next = audit("run", "tail", { kind: "兼容跳过" });
  assert.equal(next.prevHash, seed.hash, "跳过大旧格式及坏行仍找到最近哈希");
  const v = verifyAuditChain();
  assert.equal(v.ok, false, "坏行不可报告完整成功");
  assert.equal(v.complete, false);
  assert.equal(v.invalidLines, 1);
  assert.equal(v.broken, 0, "已有哈希记录链关系仍兼容");
  assert.equal(v.legacy, 1, "无哈希记录明确计入旧格式");
`,
)
check(
  '旧格式及坏尾行兼容不代表完整性保证',
  tailResult.status === 0,
  tailResult.stderr,
)

// ---- 并发、故障回执与读取覆盖 ----
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
const reliable = runInChild(
  'hmac',
  `
  import fs from 'node:fs';
  import path from 'node:path';
  import assert from 'node:assert/strict';
  import { spawn, spawnSync } from 'node:child_process';
  import * as s from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
  assert.equal(s.audit('run','reliable').persisted,true);
  async function workerMain() {
    const { audit } = await import('./src/state.js')
    for (let i = 0; i < 40; i++) {
      const receipt = audit('run', 'worker', { i })
      if (!receipt.persisted) {
        console.error(JSON.stringify({
          pid: process.pid,
          i,
          persisted: receipt.persisted,
          error: receipt.error,
        }))
        process.exitCode = 2
        break
      }
    }
  }
  const worker = '(' + workerMain.toString() + ')()'
  const workers = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', worker], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let error = ''
    p.stderr.on('data', (b) => { stderr += b })
    p.stdout.resume()
    p.on('error', (e) => { error = e.message })
    p.on('close', (code) => resolve({ code, stderr, error }))
  })))
  assert.ok(workers.every((w) => w.code === 0 && !w.error), JSON.stringify(workers))
  assert.equal(s.verifyAuditChain().total,161);
  assert.equal(s.verifyAuditChain().ok,true);
  assert.deepEqual(s.readAudit({limit:0}),[]);
  assert.equal(s.readAudit({limit:3}).length,3);
  const lock=path.join(s.AUDIT_DIR,'.append-lock');
  const dead=spawnSync(process.execPath,['-e','']).pid;
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:dead}));
  assert.equal(s.audit('run','dead-recovery').persisted,true);
  fs.mkdirSync(lock)
  const badOwner = JSON.stringify({ pid: dead, token: 'invalid' })
  fs.writeFileSync(path.join(lock, 'owner.json'), badOwner)
  const bad = s.audit('run', 'bad-token')
  assert.equal(bad.persisted, false)
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), badOwner)
  fs.rmSync(lock, { recursive: true })
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
  fs.utimesSync(lock,0,0);
  assert.equal(s.audit('run','live-lock').persisted,false);
  assert.ok(fs.existsSync(lock)); fs.rmSync(lock,{recursive:true});
  const wr=fs.writeSync;
  const before=s.verifyAuditChain().total;
  try {
    fs.writeSync=(fd,data,offset,length,position)=>{
      if (typeof position !== 'number') return wr(fd,data,offset,length,position);
      wr(fd,data,offset,Math.min(17,length),position);
      throw new Error('injected partial append');
    };
    assert.equal(s.audit('run','partial-write').persisted,false);
  } finally { fs.writeSync=wr; }
  assert.equal(s.verifyAuditChain().total,before);
  assert.equal(s.audit('run','retry-after-partial').persisted,true);
  assert.equal(s.verifyAuditChain().ok,true);
  const dirty=path.join(s.AUDIT_DIR,fs.readdirSync(s.AUDIT_DIR).find(n=>n.endsWith('.jsonl')));
  fs.appendFileSync(dirty,'{"partial":');
  assert.equal(s.audit('run','dirty-tail').persisted,false);
  assert.equal(s.verifyAuditChain().complete,false);
  // 只在隔离测试内撤销本测试注入的脏尾。
  fs.truncateSync(dirty,fs.statSync(dirty).size-11);
  const sync=fs.fsyncSync;
  try { fs.fsyncSync=()=>{throw new Error('injected fsync')}; assert.equal(s.audit('run','fsync-fail').persisted,false); }
  finally { fs.fsyncSync=sync; }
  const open=fs.openSync;
  try { fs.openSync=(p,...a)=>{if(String(p).endsWith('.jsonl'))throw new Error('injected open');return open(p,...a)};
    assert.equal(s.audit('run','write-fail').persisted,false);
    assert.equal(s.verifyAuditChain().complete,false);
    assert.ok(s.verifyAuditChain().readErrors.length);
    assert.equal(s.readAuditDetailed({}).complete,false);
  } finally { fs.openSync=open; }
  const rd=fs.readdirSync;
  try { fs.readdirSync=()=>{throw new Error('injected readdir')};
    assert.equal(s.verifyAuditChain().ok,false);
    assert.equal(s.readAuditDetailed({}).complete,false);
    assert.equal(s.audit('run','enumeration-fail').persisted,false);
  } finally { fs.readdirSync=rd; }
  const {startMcpClient}=await import('./test/_mcp-client.mjs');
  const sid='audit-pass-failure';
  s.saveState(sid,{...s.defaultState(),card:{goal:'isolated failure'},completed_ok:true,verdict:'PASS',dispatch_count:0});
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
  const client=startMcpClient({entry:path.resolve('src/index.js'),cwd:process.cwd(),env:{...process.env}});
  try {
    await client.initialize();
    const response=await client.request('tools/call',{name:'flow_verdict',arguments:{sessionId:sid,verdict:'PASS',role:'auditor'}},20000);
    assert.ok(JSON.stringify(response).includes('审计未确认持久化'));
    const failed=s.loadState(sid);
    assert.equal(failed.completed_ok,false);
    assert.ok(failed.audit_pending);
  } finally { await client.close(); fs.rmSync(lock,{recursive:true}); }
  // 真子进程在持有 reaper 槽位且即将移动死主锁时退出。
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:dead}));
  const reapCrash=spawnSync(process.execPath,['--input-type=module','-e',
    "import fs from 'node:fs';const rn=fs.renameSync;fs.renameSync=(a,b,...c)=>{if(String(b).includes('.dead-'))process.exit(73);return rn(a,b,...c)};const s=await import('./src/state.js');s.audit('run','crash-in-reap');"
  ],{env:process.env,encoding:'utf8'});
  assert.equal(reapCrash.status,73);
  assert.equal(s.audit('run','retry-after-reaper-death').persisted,true);
  // 活回收者和未知回收者均不得抢占。
  const reapDir=lock+'.reapers';
  const activeSlot=path.join(reapDir,'active-test.json');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:dead}));
  fs.writeFileSync(activeSlot,JSON.stringify({pid:process.pid,ticket:0,choosing:true}));
  assert.equal(s.audit('run','live-reaper').persisted,false);
  assert.ok(fs.existsSync(activeSlot));
  fs.unlinkSync(activeSlot);
  fs.writeFileSync(activeSlot,'{}');
  const unknown=s.audit('run','unknown-reaper');
  assert.equal(unknown.persisted,false); assert.match(unknown.error,/所有者未知/);
  fs.unlinkSync(activeSlot);
  assert.equal(s.audit('run','retry-after-reaper-unblock').persisted,true);
  const finalSid='audit-final-pass-failure';
  const ts=Date.now();
  const cmd='node -e "process.exit(0)"';
  s.saveState(finalSid,{...s.defaultState(),card:{goal:'final pass failure',scope:[],verify:{cmd}},card_ts:ts,
    dispatch_count:1,claimed_role:'auditor',completed_ok:true,verdict:'PASS',
    last_verify:{ok:true,cmd,card_ts:ts,ts:ts+1,cwd:process.env.CARLOS_FLOW_HOME},
    last_falsify:{verdict:'meaningful'},
    audit_axes:{standards:{verdict:'PASS',card_ts:ts},spec:{verdict:'PASS',card_ts:ts}}});
  const fault=path.join(process.env.CARLOS_FLOW_HOME,'inject-final');
  const hit=path.join(process.env.CARLOS_FLOW_HOME,'hit-final');
  fs.writeFileSync(fault,'1');
  const entry=path.join(process.env.CARLOS_FLOW_HOME,'fault-server.mjs');
  fs.writeFileSync(entry,[
    "import fs from 'node:fs';",
    'const fault='+JSON.stringify(fault)+'; const hit='+JSON.stringify(hit)+';',
    'const original=fs.writeSync;',
    'fs.writeSync=function(fd,b,...a){if(Buffer.isBuffer(b)&&b.toString().includes(\\\'"type":"resolution"\\\')&&b.toString().includes(\\\'"kind":"verdict"\\\')&&fs.existsSync(fault)){fs.writeFileSync(hit,"final-stage");throw new Error("injected final resolution append");}return original.call(this,fd,b,...a)};',
    'await import('+JSON.stringify(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'index.js')).href)})+');'
  ].join('\\n'));
  const finalClient=startMcpClient({entry,cwd:process.env.CARLOS_FLOW_HOME,env:{...process.env}});
  try {
    await finalClient.initialize();
    const args={sessionId:finalSid,verdict:'PASS',role:'auditor',cwd:process.env.CARLOS_FLOW_HOME};
    const failed=await finalClient.request('tools/call',{name:'flow_verdict',arguments:args},20000);
    assert.ok(fs.existsSync(hit),'必须实际抵达最终 resolution 追加，不能以前置拒绝冒充');
    assert.ok(JSON.stringify(failed).includes('injected final resolution append'));
    assert.equal(s.loadState(finalSid).completed_ok,false);
    assert.ok(s.loadState(finalSid).audit_pending);
    fs.unlinkSync(fault);
    const retried=await finalClient.request('tools/call',{name:'flow_verdict',arguments:args},20000);
    const data=JSON.parse(retried.result.content[0].text);
    assert.equal(data.ok,true,JSON.stringify(data));
    assert.equal(data.completed_ok,true);
    assert.equal(s.loadState(finalSid).completed_ok,true);
    assert.equal(s.loadState(finalSid).audit_pending,undefined);
  } finally { await finalClient.close(); }
  // 真实双进程竞争：对手先持状态锁，再提交验证字段或替换任务卡。
  for (const replace of [false,true]) {
    const raceSid='audit-compensation-'+replace;
    s.saveState(raceSid,{...s.defaultState(),card:{goal:'original'},card_ts:100,completed_ok:true});
    const ready=path.join(process.env.CARLOS_FLOW_HOME,'race-ready-'+replace);
    const done=path.join(process.env.CARLOS_FLOW_HOME,'race-done-'+replace);
    const peerScript=[
      "import fs from 'node:fs'; import {withStateLock,loadState,saveState} from "+JSON.stringify(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)})+";",
      'await withStateLock('+JSON.stringify(raceSid)+',async()=>{const latest=loadState('+JSON.stringify(raceSid)+');',
      'fs.writeFileSync('+JSON.stringify(ready)+',"ready"); await new Promise(r=>setTimeout(r,500));',
      'latest.last_verify={ok:true,marker:"concurrent"};latest.claimed_role="executor";',
      replace?'latest.card={goal:"replacement"};latest.card_ts=200;latest.completed_ok=true;':'',
      'saveState('+JSON.stringify(raceSid)+',latest);});fs.writeFileSync('+JSON.stringify(done)+',"done");'
    ].join('\\n');
    const raceEntry=path.join(process.env.CARLOS_FLOW_HOME,'race-server-'+replace+'.mjs');
    fs.writeFileSync(raceEntry,[
      "import fs from 'node:fs';import {spawn} from 'node:child_process';",
      'const wr=fs.writeSync;let injected=false;',
      'fs.writeSync=(fd,b,...args)=>{if(!injected&&Buffer.isBuffer(b)&&b.toString().includes("verdict_denied")){injected=true;',
      'spawn(process.execPath,["--input-type=module","-e",'+JSON.stringify(peerScript)+'],{env:process.env,stdio:"ignore"});',
      'const deadline=Date.now()+10000;while(!fs.existsSync('+JSON.stringify(ready)+')){if(Date.now()>deadline)throw new Error("peer not ready");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}',
      'throw new Error("injected competing audit failure");}return wr(fd,b,...args)};',
      'await import('+JSON.stringify(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'index.js')).href)})+');'
    ].join('\\n'));
    const raceClient=startMcpClient({entry:raceEntry,cwd:process.cwd(),env:{...process.env}});
    try {
      await raceClient.initialize();
      const response=await raceClient.request('tools/call',{name:'flow_verdict',arguments:{sessionId:raceSid,verdict:'PASS',role:'auditor'}},20000);
      assert.ok(JSON.stringify(response).includes('injected competing audit failure'));
      assert.ok(fs.existsSync(done),'回执必须等待状态锁内对手提交');
      const latest=s.loadState(raceSid);
      assert.equal(latest.last_verify.marker,'concurrent');
      assert.equal(latest.claimed_role,'executor');
      assert.equal(latest.completed_ok,replace);
      assert.equal(Boolean(latest.audit_pending),!replace);
      assert.equal(latest.card.goal,replace?'replacement':'original');
    } finally { await raceClient.close(); }
  }
  const file=path.join(s.AUDIT_DIR,fs.readdirSync(s.AUDIT_DIR).find(n=>n.endsWith('.jsonl')));
  fs.appendFileSync(file,'bad JSON\\n');
  assert.equal(s.verifyAuditChain().invalidLines,1);
  assert.equal(s.verifyAuditChain().complete,false);
  assert.equal(s.readAuditDetailed({}).invalidLines,1);
`,
)
check(
  '多进程161条无分叉、死锁恢复/活锁保护、fsync/open/枚举失败及读取覆盖',
  reliable.status === 0,
  reliable.stderr,
)

// ---- 1. hmac 模式：篡改必须被发现 ----
console.log('▶ ① hmac 模式（带密钥）')
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
let r = runInChild('hmac', WRITE_SCRIPT)
check('写入 3 条审计记录', r.stdout.includes('written'), r.stderr.slice(0, 200))

r = runInChild('hmac', VERIFY_SCRIPT_KEYED)
let v = JSON.parse(r.stdout.trim().split('\n').pop())
check('mode 标注为 hmac', v.mode === 'hmac', `mode=${v.mode}`)
check('未篡改的链校验通过', v.ok === true && v.broken === 0, JSON.stringify(v))

// 篡改第 2 条的 kind
const auditDir = join(home, 'gate-audit')
// 审计文件按**本地日期**分文件（state.js 的 localDate），
// 不能用 toISOString()（UTC）—— 两者在时区边界会差一天。
const localDate = localDateStr()
const file = join(auditDir, `${localDate}.jsonl`)
check('审计文件存在', existsSync(file), file)
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const rec2 = JSON.parse(lines[1])
rec2.kind = 'TAMPERED_BY_ATTACKER'
lines[1] = JSON.stringify(rec2)
writeFileSync(file, lines.join('\n') + '\n', 'utf8')

r = runInChild('hmac', VERIFY_SCRIPT_KEYED)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check(
  '⚠️  hmac 模式：篡改被检测出来（ok=false, broken>0）',
  v.ok === false && v.broken > 0,
  JSON.stringify(v),
)

// ---- 2. plain 模式：如实记录其局限 ----
console.log('\n▶ ② plain 模式（无密钥）')
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
r = runInChild('plain', WRITE_SCRIPT)
check('写入 3 条审计记录', r.stdout.includes('written'), r.stderr.slice(0, 200))

r = runInChild('plain', VERIFY_SCRIPT)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check('mode 标注为 plain（诚实降级）', v.mode === 'plain', `mode=${v.mode}`)
check(
  'plain 模式下未篡改的链也校验通过',
  v.ok === true && v.broken === 0,
  JSON.stringify(v),
)

// ---- 3. legacy 记录不应让后续记录误报 ----
console.log('\n▶ ③ legacy 兼容（无 hash 的旧记录）')
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
r = runInChild('plain', WRITE_SCRIPT)
const l2 = readFileSync(file, 'utf8').split('\n').filter(Boolean)
// 在中间插入一条 legacy 记录（无 hash 字段）
const legacy = JSON.stringify({
  ts: new Date().toISOString(),
  type: 'run',
  sessionID: 'sess-tamper',
  kind: 'legacy_old_record',
})
l2.splice(1, 0, legacy)
writeFileSync(file, l2.join('\n') + '\n', 'utf8')

r = runInChild('plain', VERIFY_SCRIPT)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check(
  'legacy 记录被计入 legacy 计数',
  typeof v.total === 'number',
  JSON.stringify(v),
)
check(
  '⚠️  legacy 记录不会让后续记录全部误报 broken（v2.5 升级用户不误报）',
  v.broken === 0,
  JSON.stringify(v),
)

// ---- 4. date 参数必须真的生效 ----
console.log('\n▶ ④ date 参数')
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
r = runInChild('plain', WRITE_SCRIPT)
const DATE_SCRIPT = `
import { readAudit, verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
const r = readAudit({ date: "2020-01-01" });
console.log(JSON.stringify({ total: r.length, chainBroken: verifyAuditChain({ date: "2020-01-01" }).broken }));
`
r = runInChild('plain', DATE_SCRIPT)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check(
  'date=2020-01-01 读到 0 条（不再误读今天的数据）',
  v.total === 0,
  JSON.stringify(v),
)
check(
  'date=2020-01-01 校验的是那一天的文件（broken=0）',
  v.chainBroken === 0,
  JSON.stringify(v),
)

// ---- 4b. 单日校验也必须能发现篡改（堵 M15 盲区）----
// 背景：M15 变异体把单日分支的返回改成恒 ok:true，而旧用例只测全链（无 date），
// 单日分支恒真时测试仍全绿 —— 守护静默失效。这里直接对单日分支做真实篡改。
console.log('\n> 4b. 单日校验篡改检测')
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
r = runInChild('plain', WRITE_SCRIPT)
const todayStr = localDateStr()
const dayFile = join(home, 'gate-audit', todayStr + '.jsonl')
check('单日审计文件已写入', existsSync(dayFile), dayFile)
const dayLines = readFileSync(dayFile, 'utf8').split('\n').filter(Boolean)
const dayRec = JSON.parse(dayLines[1])
dayRec.kind = 'TAMPERED_BY_ATTACKER'
dayLines[1] = JSON.stringify(dayRec)
writeFileSync(dayFile, dayLines.join('\n') + '\n', 'utf8')
const DAY_TAMPER_SCRIPT = `
import { verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
const r = verifyAuditChain({ date: ${JSON.stringify(todayStr)} });
console.log(JSON.stringify({ ok: r.ok, broken: r.broken, total: r.total, file: r.file }));
`
r = runInChild('plain', DAY_TAMPER_SCRIPT)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check(
  '⚠️  单日校验：篡改被检测出来（ok=false, broken>0）',
  v.ok === false && v.broken > 0,
  JSON.stringify(v),
)

// ---- 5. 跨天断链回连：今天第一条记录的 prevHash 必须来自昨天的 tail ----
console.log('\n> 5. 跨天链')
const YESTERDAY = (n) => localDateStr(new Date(Date.now() - n * 86400000))
rmSync(join(home, 'gate-audit'), { recursive: true, force: true })
// 写种子：一条昨天的记录（格式与 audit() 完全一致）
const YESTERDAY_SCRIPT = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
mkdirSync(join(${JSON.stringify(home)}, "gate-audit"), { recursive: true });
// 手动写一条昨天的记录：格式与 audit() 一致
function payload(rec) {
  const SKIP = new Set(["ts", "type", "sessionID", "prevHash", "hash"]);
  return JSON.stringify(Object.fromEntries(Object.entries(rec).filter(([k]) => !SKIP.has(k))));
}
function compute(rec, prev) { return createHash("sha256").update(rec.ts + rec.type + rec.sessionID + payload(rec) + prev).digest("hex"); }
const y = ${JSON.stringify(YESTERDAY(1))};
const rec = { ts: y + "T23:59:59Z", type: "run", sessionID: "sess-yest", kind: "record" };
rec.prevHash = "0".repeat(64);
rec.hash = compute(rec, rec.prevHash);
writeFileSync(join(${JSON.stringify(home)}, "gate-audit", y + ".jsonl"), JSON.stringify(rec) + "\\n");
console.log("yesterday written, date =", y);
`
r = runInChild('plain', YESTERDAY_SCRIPT)
check(
  '手动种子：昨天写入一条记录',
  r.stdout.includes('yesterday written'),
  r.stderr.slice(0, 300),
)

const TODAY_SCRIPT = `
import { verifyAuditChain, audit } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
const v = verifyAuditChain({ date: ${JSON.stringify(YESTERDAY(1))}, fullChain: false });
audit("run", "sess-crossday", { kind: "record" });
audit("run", "sess-crossday2", { kind: "record" });
const vT = verifyAuditChain({ date: ${JSON.stringify(localDateStr())}, fullChain: false });
const vF = verifyAuditChain({ fullChain: true });
console.log(JSON.stringify({ y: ${JSON.stringify(YESTERDAY(1))}, t: ${JSON.stringify(localDateStr())}, v: v.ok, vT: vT.ok, vTbroken: vT.broken, vF: vF.ok, vFbroken: vF.broken }));
`
r = runInChild('plain', TODAY_SCRIPT)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check(
  'crossDay audit() 今天 prevHash 来自昨天的 tail（不是 ZERO）',
  v.vTbroken === 0,
  JSON.stringify(v),
)
check('昨天种子记录可验证（backward link）', v.v === true, JSON.stringify(v))
check('全链验证通过（逐天串联，无断裂）', v.vF === true, JSON.stringify(v))

// 用来确认 fullChain 能把所有天串在一起
const CHAIN_VERIFY_SCRIPT = `
import { verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
const v = verifyAuditChain({ fullChain: true });
console.log(JSON.stringify({ total: v.total, broken: v.broken, byDay: v.byDay.map((d) => d.date + ":" + d.dayBroken) }));
`
r = runInChild('plain', CHAIN_VERIFY_SCRIPT)
v = JSON.parse(r.stdout.trim().split('\n').pop())
check('fullChain 按天串联且只有 0 个断裂', v.broken === 0, JSON.stringify(v))

// ---- 6. 敏感信息脱敏：密钥不能明文落盘 ----
console.log('\n> 6. 敏感脱敏')
const hasSecret = 'sk_live_abc123456789'
const SECRETS_SCRIPT = `
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audit, saveState } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'state.js')).href)};
mkdirSync(${JSON.stringify(home)}, { recursive: true });
saveState("sess-secret", { card: { goal: "leak-me", verify: { cmd: "echo " + ${JSON.stringify(hasSecret)} }, password: "123456", token: "tok_1234567890abcdef01234567890" } });
audit("run", "sess-secret", { cmd: "curl -H 'Bearer " + ${JSON.stringify(hasSecret)} + "' https://api.example.com", token: "tok_1234567890abcdef01234567890" });
console.log("wrote");
`
r = runInChild('plain', SECRETS_SCRIPT)
r = runInChild('plain', SECRETS_SCRIPT)
check('audit/write 完成', r.stdout.includes('wrote'), r.stderr.slice(0, 200))

const stateFile = readFileSync(
  join(home, 'gate-state', 'runs', 'sess-secret', 'state.json'),
  'utf8',
)
const state = JSON.parse(stateFile)
check(
  'card.verify.cmd 脱敏',
  state.card.verify.cmd !== hasSecret &&
    !state.card.verify.cmd.includes(hasSecret),
  JSON.stringify(state.card),
)
check(
  'card.password 脱敏',
  state.card.password === '[脱敏]',
  JSON.stringify(state.card),
)
check(
  'card.token 脱敏',
  typeof state.card.token === 'string' &&
    !state.card.token.includes('1234567890abcdef'),
  JSON.stringify(state.card),
)
const AUDIT_DIR = join(home, 'gate-audit')
const today = readFileSync(
  join(AUDIT_DIR, localDateStr() + '.jsonl'),
  'utf8',
).trim()
const last = JSON.parse(today.split('\n').filter(Boolean).pop())
check(
  'audit 字段脱敏（不含 sk_live 等密钥）',
  !today.includes(hasSecret),
  JSON.stringify(last),
)
check(
  'audit 仍然拥有合法 hash（脱敏后参与链计算）',
  last.hash && last.hash.length === 64,
  JSON.stringify(last),
)

if (fail === 0) try {
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
} catch {}
else console.error(`失败证据保留: ${home}`)

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`)
console.log(
  '\n说明：plain 模式（未设 CARLOS_FLOW_AUDIT_KEY）**不能**防有意篡改 ——',
)
console.log(
  '这是哈希链的固有局限，现在通过 mode 字段诚实告知，而不是继续对外宣称「防篡改」。',
)
process.exit(fail === 0 ? 0 : 1)
