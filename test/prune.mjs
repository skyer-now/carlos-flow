// 存储清理（归档 + 备份去重）—— 回归测试
//
// 这套清理逻辑最危险的三种错法，逐条钉死：
//   1. 把「还在跑」的会话当陈旧清掉（没有 verdict 的会话一律不准动）；
//   2. 「清理」变成真删除（必须是归档：移出 FLOW_HOME，能搬回来）；
//   3. 动了审计目录（哈希链，删一天就断，追溯能力永久丢失）。
// 另外还要验证：迁移后的备份仍能还原（manifest 指针正确、内容可读）。
//
// 跑法：node test/prune.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-prune-home-'))
process.env.CARLOS_FLOW_HOME = HOME
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.npm_config_cache = path.join(HOME, 'npm-cache')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`)
  }
}

const state = await import('../src/state.js')
const dispatch = await import('../src/dispatch.js')
const storage = await import('../src/storage.js')

const RUNS = path.join(HOME, 'gate-state', 'runs')
const RUNS_DIR = RUNS
const AUDIT = path.join(HOME, 'gate-audit')
const day = (n) => new Date(Date.now() - n * 86400000)

/** 造一个会话目录；terminal=true 表示已落裁定（终态） */
function makeSession(
  sid,
  { terminal = true, daysAgo = 10, content = 'content-a' } = {},
) {
  const st = {
    ...state.defaultState(),
    tier: 'single_file',
    card: { goal: sid },
    card_ts: Date.now(),
    verdict: terminal ? 'PASS' : null,
    completed_ok: terminal,
  }
  state.saveState(sid, st)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-prune-work-'))
  fs.writeFileSync(path.join(work, 'a.txt'), content, 'utf8')
  // 造两次快照（内容相同 → 去重后应只剩一个 blob）
  dispatch.snapshotFiles(sid, ['a.txt'], work)
  dispatch.snapshotFiles(sid, ['a.txt'], work)
  // 再塞一个「历史时间戳命名」的旧备份 + manifest 指针，模拟老版本数据
  const bdir = path.join(RUNS, sid, 'backup')
  const legacyName = `${Date.now()}_deadbeef_legacy_${sid}.txt`
  fs.writeFileSync(path.join(bdir, legacyName), content, 'utf8')
  fs.appendFileSync(
    path.join(bdir, 'manifest.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      orig: path.join(work, 'legacy.txt'),
      backup: path.join(bdir, legacyName),
      created: false,
    }) + '\n',
    'utf8',
  )
  // 把目录时间推到 N 天前（statSync 的 mtime 用目录时间 + state.json 时间都改）
  const old = day(daysAgo)
  try {
    fs.utimesSync(path.join(RUNS, sid, 'state.json'), old, old)
    fs.utimesSync(path.join(RUNS, sid), old, old)
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(work, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  return { sid, bdir, legacyName }
}

try {
  // P2：全部真实临时目录，所有外部进程均为本测试创建的 Node writer。
  {
    const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-prune-guards-'))
    const guards = []
    const oldState = sid => {
      guards.push(sid)
      state.saveState(sid, { ...state.defaultState(), card: { goal: 'A' }, card_ts: 1, verdict: 'PASS' })
      fs.utimesSync(path.join(RUNS, sid, 'state.json'), day(20), day(20))
    }
    const onlyPlan = sid => {
      const p = storage.planPrune({ inactiveDays: 7 })
      return { ...p, archivable: p.archivable.filter(s => s.session === sid), backupConversion: [] }
    }
    const apply = p => storage.applyPrune(p, { apply: true, archiveRoot })
    const online = sid => fs.existsSync(path.join(RUNS, sid, 'state.json'))
    const waitFor = async file => {
      // 慢 runner（2 核）上子进程启动 + 模块加载可能远超 5 秒；
      // 这里只等握手文件出现，超时值不影响断言语义，放宽到 30 秒避免假红。
      const deadline = Date.now() + 30000
      while (!fs.existsSync(file)) {
        if (Date.now() >= deadline) throw new Error('测试 writer 文件握手超时')
        await new Promise(r => setTimeout(r, 10))
      }
    }
    const startWriter = code => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', b => { output += b })
      child.stderr.on('data', b => { output += b })
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', code => resolve({ code, output }))
      })
      return done
    }
    const stateURL = new URL('../src/state.js', import.meta.url).href
    try {
      for (const [sid, field, value] of [
        ['guard-active', 'audit_pending', { kind: 'events', entries: [{ id: 'a' }] }],
        ['guard-history', 'audit_history_pending', [{ id: 'h' }]],
      ]) {
        oldState(sid)
        const stale = onlyPlan(sid)
        await state.withStateLock(sid, () => {
          const s = state.loadState(sid)
          s[field] = value
          state.saveState(sid, s)
          fs.utimesSync(path.join(RUNS, sid, 'state.json'), day(20), day(20))
        })
        check(`P2. ${field} 欠账计划排除`, onlyPlan(sid).archivable.length === 0)
        const r = await apply(stale)
        check(`P2. ${field} 计划后欠账仍在线`, r.archived.length === 0 && online(sid))
      }
      oldState('guard-new-b')
      const oldPlan = onlyPlan('guard-new-b')
      await state.withStateLock('guard-new-b', () => state.saveState('guard-new-b', {
        ...state.defaultState(), card: { goal: 'B' }, card_ts: 2, verdict: null,
      }))
      check('P2. 旧计划不能搬走新 B', (await apply(oldPlan)).archived.length === 0 && state.loadState('guard-new-b').card.goal === 'B')

      for (const [name, raw] of [
        ['broken', '{'], ['null', 'null'], ['array', '[]'], ['legacy', '{"verdict":"PASS","audit_pending":{}}'],
        ['history-unknown', '{"verdict":"PASS","audit_history_pending":{}}'], ['bad-verdict', '{"verdict":true}'],
      ]) {
        const sid = `guard-${name}`
        oldState(sid)
        fs.writeFileSync(path.join(RUNS, sid, 'state.json'), raw)
        fs.utimesSync(path.join(RUNS, sid, 'state.json'), day(20), day(20))
        check(`P2. 未知状态保守保留 ${name}`, onlyPlan(sid).archivable.length === 0)
      }
      oldState('guard-mtime')
      const mtimePlan = onlyPlan('guard-mtime')
      fs.utimesSync(path.join(RUNS, 'guard-mtime', 'state.json'), day(0), day(0))
      check('P2. 仅 mtime 更新也拒绝旧计划', (await apply(mtimePlan)).archived.length === 0 && online('guard-mtime'))
      oldState('guard-same-terminal-b')
      const terminalPlan = onlyPlan('guard-same-terminal-b')
      await state.withStateLock('guard-same-terminal-b', () => {
        state.saveState('guard-same-terminal-b', { ...state.defaultState(), card: { goal: 'B' }, card_ts: 2, verdict: 'PASS' })
        fs.utimesSync(path.join(RUNS, 'guard-same-terminal-b', 'state.json'), day(20), day(20))
      })
      check('P2. 即使新 B 也是旧 mtime 终态仍拒绝旧计划', (await apply(terminalPlan)).archived.length === 0 && online('guard-same-terminal-b'))
      oldState('guard-replaced')
      const replacedPlan = onlyPlan('guard-replaced')
      fs.renameSync(path.join(RUNS, 'guard-replaced'), path.join(archiveRoot, 'replaced-original'))
      oldState('guard-replaced')
      check('P2. 同名物理目录替换拒绝旧计划', (await apply(replacedPlan)).archived.length === 0 && online('guard-replaced'))

      oldState('guard-missing')
      const missingPlan = onlyPlan('guard-missing')
      fs.rmSync(path.join(RUNS, 'guard-missing'), { recursive: true })
      await apply(missingPlan)
      check('P2. 不为锁重建已不存在的会话', !fs.existsSync(path.join(RUNS, 'guard-missing')))

      oldState('guard-live-writer')
      const racePlan = onlyPlan('guard-live-writer')
      const ready = path.join(archiveRoot, 'ready')
      const release = path.join(archiveRoot, 'release')
      const done = startWriter(`import fs from 'node:fs'; import {withStateLock,loadState,saveState} from ${JSON.stringify(stateURL)};
        await withStateLock('guard-live-writer',async()=>{
          const s=loadState('guard-live-writer'); s.audit_history_pending=[{id:'late'}]; saveState('guard-live-writer',s);
          fs.writeFileSync(${JSON.stringify(ready)},'ready'); const until=Date.now()+8000;
          while(!fs.existsSync(${JSON.stringify(release)})){ if(Date.now()>until)throw new Error('release timeout'); await new Promise(r=>setTimeout(r,10)); }
        }); console.log('writer release confirmed');`)
      let pruning
      try {
        await waitFor(ready)
        let settled = false
        pruning = apply(racePlan).finally(() => { settled = true })
        await new Promise(r => setTimeout(r, 100))
        check('P2. 真实 writer 持锁阻断归档且 owner 未移动', !settled && online('guard-live-writer') && fs.existsSync(path.join(RUNS, 'guard-live-writer', '.state.lock')))
      } finally { fs.writeFileSync(release, 'release') }
      const writer = await done
      const race = await pruning
      check('P2. writer 正常释放后重验欠账仍在线', writer.code === 0 && race.archived.length === 0 && online('guard-live-writer'), writer.output.trim())

      // 确认排队进程已用旧目录身份尝试 wx，再归档并合成同名新目录。
      oldState('guard-queued')
      const attempted = path.join(archiveRoot, 'queued-attempt')
      const queuedFile = path.join(RUNS, 'guard-queued', '.state.lock')
      let queuedDone
      const dest = path.join(archiveRoot, 'queued-archived')
      const archived = await state.archiveStateSession('guard-queued', async () => {
        queuedDone = startWriter(`import fs from 'node:fs'; import {withStateLock,saveState} from ${JSON.stringify(stateURL)};
          const real=fs.openSync; fs.openSync=function(file,flags,...rest){ if(file===${JSON.stringify(queuedFile)}&&flags==='wx')fs.writeFileSync(${JSON.stringify(attempted)},'attempt'); return real.call(this,file,flags,...rest) };
          try {await withStateLock('guard-queued',()=>{saveState('guard-queued',{card:{goal:'OVERWRITE'}}); console.log('UNSAFE ENTERED')}); process.exitCode=1}
          catch(error){console.log('queued writer rejected: '+error.message)};`)
        // 握手有两种合法结局：子进程真的用 'wx' 撞到锁（写出 attempted），
        // 或者它更早就在 session-identity 阶段被拒（目录已被移走）。
        // 慢 runner 上后一种更常见；只等 attempted 会永久挂住，因此两者等其一。
        await Promise.race([
          waitFor(attempted).catch(() => 'timeout'),
          queuedDone.then(() => 'settled'),
        ])
        return true
      }, () => {
        fs.renameSync(path.join(RUNS, 'guard-queued'), dest)
        state.saveState('guard-queued', { ...state.defaultState(), card: { goal: 'replacement' } })
        return true
      })
      const queued = await queuedDone
      check('P2. 排队 writer 不写同名替换目录', archived && queued.code === 0 && !queued.output.includes('UNSAFE ENTERED') &&
        (queued.output.includes('session-identity') || queued.output.includes('获取状态锁超时')) &&
        state.loadState('guard-queued').card.goal === 'replacement', `${queued.output.trim()}${fs.existsSync(attempted) ? '（握手：wx 撞锁）' : '（握手：早拒/等锁超时）'}`)
      check('P2. 归档正常退出不搬锁不留空壳', fs.existsSync(path.join(dest, 'state.json')) && !fs.existsSync(path.join(dest, '.state.lock')) && !fs.existsSync(queuedFile))

      // EXDEV 使用确定性 rename 错误注入，真实源/目标目录；cp/rm 不参与执行路径。
      oldState('guard-exdev')
      const exdevPlan = onlyPlan('guard-exdev')
      const rename = fs.renameSync
      let attempts = 0
      try {
        fs.renameSync = function(src, dest) {
          if (src === path.join(RUNS, 'guard-exdev')) { attempts++; throw Object.assign(new Error('synthetic EXDEV'), { code: 'EXDEV' }) }
          return rename.call(this, src, dest)
        }
        const r = await apply(exdevPlan)
        check('P2. EXDEV 单次失败保源且正常释放锁', attempts === 1 && r.archived.length === 0 && r.archiveFailed.includes('guard-exdev') && online('guard-exdev') && !fs.existsSync(path.join(RUNS, 'guard-exdev', '.state.lock')))
      } finally { fs.renameSync = rename }
      oldState('guard-release-failure')
      const releasePlan = onlyPlan('guard-release-failure')
      let directoryMoves = 0
      try {
        fs.renameSync = function(src, dest) {
          // 用后缀比对：runner 上 tmpdir 可能是 8.3 短名（RUNNER~1），
          // 锁路径在状态层可能被解析成长名，直接用字符串相等会漏注入。
          const srcKey = String(src).split(path.sep).join('/')
          if (srcKey.endsWith('guard-release-failure/.state.lock') && String(dest).includes('.release-'))
            throw Object.assign(new Error('synthetic owner release failure'), { code: 'EIO' })
          if (src === path.join(RUNS, 'guard-release-failure')) directoryMoves++
          return rename.call(this, src, dest)
        }
        const r = await apply(releasePlan)
        check('P2. owner 释放未确认绝不移动目录', directoryMoves === 0 && r.archived.length === 0 && online('guard-release-failure') && fs.existsSync(path.join(RUNS, 'guard-release-failure', '.state.lock')),
          `moves=${directoryMoves} archived=${r.archived.length} online=${online('guard-release-failure')} lock=${fs.existsSync(path.join(RUNS, 'guard-release-failure', '.state.lock'))} failed=${(r.archiveFailed || []).join(',')}`)
      } finally {
        fs.renameSync = rename
        // 仅撤销本测试注入永久故障留下的自身合成 owner，不触碰其他会话/用户锁。
        fs.rmSync(path.join(RUNS, 'guard-release-failure'), { recursive: true, force: true })
      }
      oldState('guard-inside-home')
      const rejected = await storage.applyPrune(onlyPlan('guard-inside-home'), { apply: true, archiveRoot: path.join(HOME, 'unsafe-archive') })
      check('P2. 归档根不能位于 FLOW_HOME 内', rejected.archived.length === 0 && online('guard-inside-home'))

      // CLI 真正等待异步执行与审计对比，环境明确继承本测试临时 HOME。
      oldState('guard-cli')
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/prune.mjs', import.meta.url)), '--apply', '--sessions-only', '--older-than', '7', '--archive-root', archiveRoot], { env: { ...process.env }, encoding: 'utf8', timeout: 60000 })
      check('P2. CLI await 异步归档并确认审计完整', cli.status === 0 && !online('guard-cli') && cli.stdout.includes('审计完整性'), cli.stderr.trim())
      oldState('guard-auto')
      storage.scheduleAutoPrune({ olderThanDays: 7, archiveRoot, force: true })
      const autoDeadline = Date.now() + 30000
      while (online('guard-auto') && Date.now() < autoDeadline) await new Promise(r => setTimeout(r, 10))
      check('P2. 自动调度等待异步执行且保留两类欠账', !online('guard-auto') && online('guard-active') && online('guard-history'))
    } finally {
      for (const sid of guards) fs.rmSync(path.join(RUNS, sid), { recursive: true, force: true })
      fs.rmSync(archiveRoot, { recursive: true, force: true })
    }
  }
  // 确定性共享句柄冲突：只重试本人声明，首/二发布及撤销均须有界。
  {
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    for (const phase of [
      'first',
      'second',
      'unlink',
      'temp',
      'write-first',
      'write-second',
    ]) {
      for (const permanent of [false, true]) {
        const sid = `txn-reaper-sharing-${phase}-${permanent}`
        const b = path.join(RUNS, sid, 'backup')
        fs.mkdirSync(b, { recursive: true })
        const lock = path.join(b, '.backup-lock')
        fs.writeFileSync(
          lock,
          JSON.stringify({ pid: dead, token: 'd'.repeat(32) }),
        )
        const reap = path.join(b, '.backup-reap')
        fs.mkdirSync(reap)
        const foreign = path.join(reap, `${dead}-${'e'.repeat(32)}.json`)
        const foreignText = JSON.stringify({
          pid: dead,
          token: 'e'.repeat(32),
          ticket: 1,
        })
        fs.writeFileSync(foreign, foreignText)
        const rename = fs.renameSync,
          unlink = fs.unlinkSync,
          write = fs.writeFileSync
        let hits = 0,
          entered = false,
          choosingVisible = false
        const fail = () => {
          hits++
          const e = new Error('确定性共享冲突')
          e.code = 'EPERM'
          throw e
        }
        const shouldFail = () => permanent || hits < 3
        const ownClaim = (file) =>
          path.dirname(String(file)) === reap && String(file) !== foreign
        const ownTemp = (file) =>
          path.dirname(String(file)) === b &&
          path.basename(String(file)).startsWith('.backup-reap-')
        fs.renameSync = (from, to, ...args) => {
          if (ownClaim(to)) {
            const ticket = JSON.parse(fs.readFileSync(from, 'utf8')).ticket
            const selected =
              phase === 'first'
                ? ticket === 0
                : phase === 'second' && ticket > 0
            if (selected && shouldFail()) {
              if (ticket > 0)
                choosingVisible =
                  JSON.parse(fs.readFileSync(to, 'utf8')).ticket === 0
              fail()
            }
          }
          return rename(from, to, ...args)
        }
        fs.unlinkSync = (file, ...args) => {
          if (
            ((phase === 'unlink' && ownClaim(file)) ||
              (phase === 'temp' && ownTemp(file))) &&
            shouldFail()
          )
            fail()
          return unlink(file, ...args)
        }
        fs.writeFileSync = (file, data, ...args) => {
          if (ownTemp(file)) {
            const ticket = JSON.parse(data).ticket
            if (
              (phase === 'write-first' && ticket === 0) ||
              (phase === 'write-second' && ticket > 0)
            ) {
              write(file, data, ...args)
              fail()
            }
          }
          return write(file, data, ...args)
        }
        const started = Date.now()
        try {
          const run = () =>
            dispatch.withBackupTransaction(sid, () => {
              entered = true
            })
          if (permanent || phase.startsWith('write-'))
            assert.throws(run, /共享冲突|清理失败/)
          else run()
        } finally {
          fs.renameSync = rename
          fs.unlinkSync = unlink
          fs.writeFileSync = write
        }
        assert.ok(Date.now() - started < 2500)
        assert.ok(hits > 0)
        if (phase === 'second') assert.equal(choosingVisible, true)
        if (
          phase === 'first' ||
          phase === 'second' ||
          phase.startsWith('write-')
        )
          assert.equal(entered, !permanent && !phase.startsWith('write-'))
        assert.equal(fs.readFileSync(foreign, 'utf8'), foreignText)
        assert.equal(
          fs.readdirSync(b).some((n) => n.startsWith('.backup-reap-')),
          false,
        )
        if (phase !== 'unlink' || !permanent)
          assert.deepEqual(fs.readdirSync(reap), [path.basename(foreign)])
        fs.rmSync(path.join(RUNS, sid), { recursive: true, force: true })
      }
    }
    check(
      '回收声明瞬时/永久EPERM、两次原子发布choosing可见、部分准备和自有清理',
      true,
    )
  }
  // 故障注入使用真实文件系统操作，隔离在本测试临时目录。
  const seed = (sid) => {
    const b = path.join(RUNS, sid, 'backup')
    fs.mkdirSync(b, { recursive: true })
    const old = path.join(b, 'old.txt')
    fs.writeFileSync(old, '恢复内容')
    const m = path.join(b, 'manifest.jsonl')
    const text = JSON.stringify({ orig: 'source.txt', backup: old }) + '\n'
    fs.writeFileSync(m, text)
    return { b, old, m, text }
  }
  for (const fault of ['write', 'open', 'fsync', 'link-after']) {
    const sid = `txn-publish-${fault}`,
      x = seed(sid),
      lock = path.join(x.b, '.backup-lock')
    const wr = fs.writeFileSync,
      op = fs.openSync,
      sync = fs.fsyncSync,
      link = fs.linkSync
    const temporary = (f) =>
      path.basename(String(f)).startsWith('.backup-lock-')
    const fds = new Set()
    fs.writeFileSync = function (f, ...a) {
      if (fault === 'write' && temporary(f)) {
        wr.call(this, f, '', { flag: 'wx' })
        throw new Error('身份写故障')
      }
      return wr.call(this, f, ...a)
    }
    fs.openSync = function (f, ...a) {
      if (fault === 'open' && temporary(f)) throw new Error('身份打开故障')
      const fd = op.call(this, f, ...a)
      if (temporary(f)) fds.add(fd)
      return fd
    }
    fs.fsyncSync = function (fd) {
      if (fault === 'fsync' && fds.has(fd)) throw new Error('身份同步故障')
      return sync.call(this, fd)
    }
    fs.linkSync = function (a, b) {
      link.call(this, a, b)
      if (fault === 'link-after' && b === lock)
        throw new Error('发布生效后故障')
    }
    try {
      assert.throws(() =>
        dispatch.withBackupTransaction(sid, () => assert.fail('不应进入事务')),
      )
    } finally {
      fs.writeFileSync = wr
      fs.openSync = op
      fs.fsyncSync = sync
      fs.linkSync = link
    }
    assert.ok(!fs.existsSync(lock))
    dispatch.withBackupTransaction(sid, () =>
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid),
    )
    assert.ok(!fs.existsSync(lock))
    check(`主锁 ${fault} 故障后同进程可重试`, true)
  }
  {
    const sid = 'txn-before-publish',
      x = seed(sid),
      lock = path.join(x.b, '.backup-lock')
    const module = new URL('../src/dispatch.js', import.meta.url).href
    const code = `import fs from 'node:fs';import {withBackupTransaction} from ${JSON.stringify(module)};const link=fs.linkSync;fs.linkSync=function(a,b){if(b===${JSON.stringify(lock)})process.exit(0);return link.call(this,a,b)};withBackupTransaction('${sid}',()=>{throw new Error('不应进入事务')});`
    assert.equal(
      spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: process.env,
      }).status,
      0,
    )
    assert.ok(!fs.existsSync(lock))
    const prepared = fs
      .readdirSync(x.b)
      .find((n) => n.startsWith('.backup-lock-'))
    assert.ok(
      JSON.parse(fs.readFileSync(path.join(x.b, prepared), 'utf8')).token,
    )
    dispatch.withBackupTransaction(sid, () => {})
    fs.writeFileSync(lock, '')
    assert.throws(
      () => dispatch.withBackupTransaction(sid, () => {}),
      /Unknown/,
    )
    assert.equal(fs.readFileSync(lock, 'utf8'), '')
    fs.unlinkSync(lock)
    check('真实发布前退出无主锁，未知他人身份仍阻断', true)
  }
  {
    const sid = 'txn-publication-race',
      x = seed(sid),
      lock = path.join(x.b, '.backup-lock'),
      marker = path.join(x.b, 'critical')
    const module = new URL('../src/dispatch.js', import.meta.url).href
    const code = `import fs from 'node:fs';import {withBackupTransaction} from ${JSON.stringify(module)};for(let n=0;n<8;n++){for(let i=0;;i++){try{withBackupTransaction('${sid}',()=>{if(JSON.parse(fs.readFileSync(${JSON.stringify(lock)},'utf8')).pid!==process.pid)throw new Error('身份被覆盖');fs.writeFileSync(${JSON.stringify(marker)},'',{flag:'wx'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);fs.unlinkSync(${JSON.stringify(marker)});});break;}catch(e){if(!(/busy/.test(e.message)||e.code==='EEXIST'||e.code==='ENOENT')||i>100)throw e;await new Promise(r=>setTimeout(r,5));}}}`
    await Promise.all(
      Array.from(
        { length: 3 },
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', code],
              { env: process.env },
            )
            let err = ''
            child.stderr.on('data', (d) => (err += d))
            child.on('error', reject)
            child.on('exit', (n) =>
              n === 0 ? resolve() : reject(new Error(err)),
            )
          }),
      ),
    )
    assert.ok(!fs.existsSync(lock))
    check('三进程主锁发布竞争不覆盖活跃身份', true)
  }
  for (const stage of ['prepare', 'commit', 'reclaim']) {
    const sid = `txn-${stage}`
    const x = seed(sid)
    const write = fs.writeFileSync,
      rename = fs.renameSync,
      unlink = fs.unlinkSync
    fs.writeFileSync = function (f, ...a) {
      if (stage === 'prepare' && path.basename(String(f)).startsWith('sha-'))
        throw new Error('prepare fault')
      return write.call(this, f, ...a)
    }
    fs.renameSync = function (a, b, ...c) {
      if (stage === 'commit' && b === x.m) throw new Error('commit fault')
      return rename.call(this, a, b, ...c)
    }
    fs.unlinkSync = function (f, ...a) {
      if (stage === 'reclaim' && f === x.old) throw new Error('reclaim fault')
      return unlink.call(this, f, ...a)
    }
    try {
      assert.throws(() => storage.migrateSessionBackups(sid, { dryRun: false }))
    } finally {
      fs.writeFileSync = write
      fs.renameSync = rename
      fs.unlinkSync = unlink
    }
    if (stage !== 'reclaim') {
      assert.equal(fs.readFileSync(x.m, 'utf8'), x.text)
      assert.ok(fs.existsSync(x.old))
    } else {
      const e = JSON.parse(fs.readFileSync(x.m, 'utf8'))
      assert.equal(fs.readFileSync(e.backup, 'utf8'), '恢复内容')
      assert.ok(fs.existsSync(path.join(x.b, '.backup-txn')))
    }
    storage.migrateSessionBackups(sid, { dryRun: false })
    storage.migrateSessionBackups(sid, { dryRun: false })
    const e = JSON.parse(fs.readFileSync(x.m, 'utf8'))
    assert.equal(fs.readFileSync(e.backup, 'utf8'), '恢复内容')
    assert.ok(!fs.existsSync(x.old))
    check(`事务 ${stage} 故障及幂等恢复`, true)
  }
  {
    const x = seed('txn-bad')
    fs.appendFileSync(x.m, '坏JSON\n')
    const text = fs.readFileSync(x.m, 'utf8')
    assert.throws(() =>
      storage.migrateSessionBackups('txn-bad', { dryRun: false }),
    )
    assert.equal(fs.readFileSync(x.m, 'utf8'), text)
    assert.ok(fs.existsSync(x.old))
    fs.writeFileSync(x.m, x.text)
    fs.unlinkSync(x.old)
    assert.throws(() => dispatch.pruneSnapshots('txn-bad'))
    check('坏清单和缺失引用 fail closed', true)
  }
  {
    const x = seed('txn-lock')
    const module = new URL('../src/dispatch.js', import.meta.url).href
    const killed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {withBackupTransaction} from ${JSON.stringify(module)}; withBackupTransaction('txn-lock',()=>process.exit(0));`,
      ],
      { env: process.env },
    )
    assert.equal(killed.status, 0)
    assert.ok(fs.existsSync(path.join(x.b, '.backup-lock')))
    storage.migrateSessionBackups('txn-lock', { dryRun: false })
    dispatch.withBackupTransaction('txn-lock', () =>
      assert.throws(() => dispatch.pruneSnapshots('txn-lock'), /busy/),
    )
    check('真实进程死亡锁恢复及活锁不可抢占', true)
  }
  {
    const sid = 'txn-reaper-crash',
      x = seed(sid)
    const module = new URL('../src/dispatch.js', import.meta.url).href
    const run = (code) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: process.env,
      })
    assert.equal(
      run(
        `import {withBackupTransaction} from ${JSON.stringify(module)}; withBackupTransaction('${sid}',()=>process.exit(0));`,
      ).status,
      0,
    )
    // 完整发布回收声明后、检查死亡主锁前退出，真实磁盘保留两种身份。
    assert.equal(
      run(
        `import fs from 'node:fs'; import {withBackupTransaction} from ${JSON.stringify(module)}; const rd=fs.readFileSync; fs.readFileSync=function(f,...a){if(String(f)===${JSON.stringify(path.join(x.b, '.backup-lock'))})process.exit(0);return rd.call(this,f,...a)};withBackupTransaction('${sid}',()=>{throw new Error('not reached')});`,
      ).status,
      0,
    )
    const reap = path.join(x.b, '.backup-reap')
    assert.equal(fs.readdirSync(reap).length, 1)
    const deadClaim = fs.readFileSync(
      path.join(reap, fs.readdirSync(reap)[0]),
      'utf8',
    )
    assert.ok(JSON.parse(deadClaim).ticket > 0)
    // 两个竞争回收者不得误删对方声明或新主锁；调用方重试立即失败的冲突。
    const code = `import {withBackupTransaction} from ${JSON.stringify(module)};for(let i=0;;i++){try{withBackupTransaction('${sid}',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20));break;}catch(e){if(i>100)throw e;await new Promise(r=>setTimeout(r,10));}}`
    await Promise.all(
      Array.from(
        { length: 2 },
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', code],
              { env: process.env },
            )
            let err = ''
            child.stderr.on('data', (d) => (err += d))
            child.on('error', reject)
            child.on('exit', (n) =>
              n === 0 ? resolve() : reject(new Error(err)),
            )
          }),
      ),
    )
    assert.equal(
      fs.readFileSync(path.join(reap, fs.readdirSync(reap)[0]), 'utf8'),
      deadClaim,
    )
    storage.migrateSessionBackups(sid, { dryRun: false })
    const entry = JSON.parse(fs.readFileSync(x.m, 'utf8'))
    assert.equal(fs.readFileSync(entry.backup, 'utf8'), '恢复内容')
    check('真实回收者退出后双进程恢复，无ABA删除', true)

    // 活跃的选票声明无论多旧都受保护；损坏身份明确阻断且原样保留。
    assert.equal(
      run(
        `import {withBackupTransaction} from ${JSON.stringify(module)};withBackupTransaction('${sid}',()=>process.exit(0));`,
      ).status,
      0,
    )
    const token = 'a'.repeat(32),
      live = path.join(reap, `${process.pid}-${token}.json`)
    fs.writeFileSync(
      live,
      JSON.stringify({ pid: process.pid, token, ticket: 0 }),
    )
    fs.utimesSync(live, new Date(0), new Date(0))
    assert.throws(
      () => storage.migrateSessionBackups(sid, { dryRun: false }),
      /reaper busy/,
    )
    assert.ok(fs.existsSync(live))
    fs.unlinkSync(live)
    const bad = path.join(reap, 'unknown.json')
    fs.writeFileSync(bad, '{}')
    assert.throws(
      () => storage.migrateSessionBackups(sid, { dryRun: false }),
      /Unknown backup reaper/,
    )
    assert.equal(fs.readFileSync(bad, 'utf8'), '{}')
    fs.unlinkSync(bad)
    storage.migrateSessionBackups(sid, { dryRun: false })
    check('陈旧活回收者及损坏身份明确阻断', true)
  }
  {
    const sid = 'txn-concurrent'
    const work = path.join(HOME, 'work')
    fs.mkdirSync(work)
    const file = path.join(work, 'same.txt')
    fs.writeFileSync(file, 'parallel')
    const module = new URL('../src/dispatch.js', import.meta.url).href
    const code = `import {snapshotFiles} from ${JSON.stringify(module)}; for(let i=0;i<4;i++){for(let j=0;;j++){try{snapshotFiles('${sid}',[${JSON.stringify(file)}]);break;}catch(e){if(j>100)throw e;await new Promise(r=>setTimeout(r,10));}}}`
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', code],
              { env: process.env },
            )
            let err = ''
            child.stderr.on('data', (d) => (err += d))
            child.on('error', reject)
            child.on('exit', (n) =>
              n === 0 ? resolve() : reject(new Error(err)),
            )
          }),
      ),
    )
    const entries = dispatch.backupManifestEntries(
      path.join(RUNS, sid, 'backup'),
    )
    assert.equal(entries.length, 3)
    assert.ok(
      entries.every((e) => fs.readFileSync(e.backup, 'utf8') === 'parallel'),
    )
    check('四进程快照竞争无坏清单及悬空引用', true)
  }
  for (const phase of ['before', 'after']) {
    const sid = `txn-crash-${phase}`
    const x = seed(sid)
    const module = new URL('../src/storage.js', import.meta.url).href
    const code = `import fs from 'node:fs'; import {migrateSessionBackups} from ${JSON.stringify(module)}; const rn=fs.renameSync; fs.renameSync=function(a,b,...c){if(b===${JSON.stringify(x.m)}){if('${phase}'==='before')process.exit(0);rn.call(this,a,b,...c);process.exit(0);}return rn.call(this,a,b,...c)};migrateSessionBackups('${sid}',{dryRun:false});`
    assert.equal(
      spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: process.env,
      }).status,
      0,
    )
    const entry = JSON.parse(fs.readFileSync(x.m, 'utf8'))
    assert.equal(fs.readFileSync(entry.backup, 'utf8'), '恢复内容')
    storage.migrateSessionBackups(sid, { dryRun: false })
    assert.ok(!fs.existsSync(path.join(x.b, '.backup-txn')))
    assert.ok(!fs.existsSync(x.old))
    check(`真实进程 ${phase} commit 中断恢复`, true)
  }
  {
    const sid = 'txn-prune-fault',
      file = path.join(HOME, 'prune-source.txt')
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(file, String(i))
      dispatch.snapshotFiles(sid, [file])
    }
    const b = path.join(RUNS, sid, 'backup'),
      m = path.join(b, 'manifest.jsonl'),
      before = fs.readFileSync(m, 'utf8')
    const rn = fs.renameSync
    fs.renameSync = function (a, dest, ...c) {
      if (dest === m) throw new Error('prune commit fault')
      return rn.call(this, a, dest, ...c)
    }
    try {
      assert.throws(() => dispatch.pruneSnapshots(sid, 1))
    } finally {
      fs.renameSync = rn
    }
    assert.equal(fs.readFileSync(m, 'utf8'), before)
    dispatch.backupManifestEntries(b)
    dispatch.pruneSnapshots(sid, 1)
    assert.equal(dispatch.backupManifestEntries(b).length, 1)
    const stable = fs.readFileSync(m, 'utf8')
    fs.writeFileSync(file, 'new')
    fs.renameSync = function (a, dest, ...c) {
      if (dest === m) throw new Error('snapshot commit fault')
      return rn.call(this, a, dest, ...c)
    }
    try {
      assert.throws(() => dispatch.snapshotFiles(sid, [file]))
    } finally {
      fs.renameSync = rn
    }
    assert.equal(fs.readFileSync(m, 'utf8'), stable)
    dispatch.backupManifestEntries(b)
    dispatch.snapshotFiles(sid, [file])
    assert.equal(dispatch.backupManifestEntries(b).length, 2)
    check('裁剪与快照提交失败旧指针不失效', true)
  }
  {
    const x = seed('txn-untrusted')
    const outside = path.join(HOME, 'outside.txt')
    fs.writeFileSync(outside, 'keep')
    const hash = (s) => createHash('sha256').update(s).digest('hex')
    fs.writeFileSync(
      path.join(x.b, '.backup-txn'),
      JSON.stringify({
        version: 1,
        before: hash(x.text),
        after: hash(x.text),
        temp: 'manifest-abcd.tmp',
        garbage: [outside],
      }),
    )
    assert.throws(
      () => storage.migrateSessionBackups('txn-untrusted', { dryRun: false }),
      /Unsafe/,
    )
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep')
    check('不可信恢复日志不能越界回收', true)
  }
  for (const name of fs.readdirSync(RUNS).filter((n) => n.startsWith('txn-')))
    fs.rmSync(path.join(RUNS, name), { recursive: true, force: true })
  const terminalOld = makeSession('stale-terminal', {
    terminal: true,
    daysAgo: 20,
    content: 'same-bytes',
  })
  const activeOld = makeSession('stale-open', {
    terminal: false,
    daysAgo: 20,
    content: 'same-bytes',
  })
  const fresh = makeSession('fresh-terminal', {
    terminal: true,
    daysAgo: 0,
    content: 'same-bytes',
  })

  // 审计：造一条记录，用来验证「清理不碰审计」
  state.audit('run', 'prune-probe', { kind: 'keep-me' })
  const auditBefore = fs
    .readdirSync(AUDIT)
    .map((n) => n + ':' + fs.statSync(path.join(AUDIT, n)).size)
    .sort()
    .join('|')

  // ---- 1. 计划（只读）----
  const plan = storage.planPrune({ inactiveDays: 7 })
  const names = plan.archivable.map((x) => x.session)
  check(
    '1a. 计划里只含陈旧终态会话',
    names.includes('stale-terminal') &&
      !names.includes('stale-open') &&
      !names.includes('fresh-terminal'),
    names.join(','),
  )
  check('1b. 没有结论的会话被明确保护', !names.includes('stale-open'))
  // 回归：manifest.jsonl / after_state.jsonl 不是备份指针，不能被算成「待迁移」
  {
    const bad = plan.backupConversion.filter((x) => {
      const dir = path.join(RUNS_DIR, x.session, 'backup')
      try {
        return !fs
          .readdirSync(dir)
          .some(
            (n) =>
              n.startsWith('sha-') ||
              (!n.endsWith('.jsonl') && n !== 'manifest.jsonl'),
          )
      } catch {
        return true
      }
    })
    check(
      '1c0. 计划不把 manifest/after_state 误算成待迁移备份',
      bad.length === 0,
      bad.map((x) => x.session).join(',') || '无假阳性',
    )
  }
  check(
    '1c. 计划识别出可迁移的历史备份',
    plan.backupConversion.length >= 3,
    `${plan.backupConversion.reduce((n, x) => n + x.legacy_files, 0)} 个历史文件`,
  )
  const before = fs.readdirSync(RUNS).sort().join(',')
  check(
    '1d. 计划阶段不改任何文件',
    fs.readdirSync(RUNS).sort().join(',') === before,
  )

  // ---- 2. dry-run 不执行 ----
  await storage.applyPrune(plan, { apply: false })
  check(
    '2a. dry-run 不移动会话目录',
    fs.existsSync(path.join(RUNS, 'stale-terminal')),
  )
  check(
    '2b. dry-run 不改备份文件名',
    fs.existsSync(path.join(terminalOld.bdir, terminalOld.legacyName)),
  )

  // ---- 3. 真执行 ----
  const archiveRoot = path.join(
    HOME,
    '..',
    'carlos-prune-archive-' + Date.now(),
  )
  const res = await storage.applyPrune(plan, { apply: true, archiveRoot })
  check(
    '3a. 陈旧终态会话被移出 FLOW_HOME',
    !fs.existsSync(path.join(RUNS, 'stale-terminal')),
  )
  check(
    '3b. 归档副本存在（可搬回，不是删除）',
    fs.existsSync(path.join(res.archiveDir, 'runs', 'stale-terminal')),
  )
  check(
    '3c. 没有结论的会话原封不动',
    fs.existsSync(path.join(RUNS, 'stale-open')),
  )
  check(
    '3d. 新鲜会话原封不动',
    fs.existsSync(path.join(RUNS, 'fresh-terminal')),
  )

  // ---- 4. 备份迁移：历史命名 → 内容寻址，且仍能还原 ----
  const bdir = activeOld.bdir
  const names2 = fs.readdirSync(bdir)
  check(
    '4a. 历史时间戳命名的备份已迁移',
    !names2.includes(activeOld.legacyName),
    names2.join(','),
  )
  check(
    '4b. 迁移后是内容寻址命名',
    names2.some((n) => n.startsWith('sha-')),
  )
  const lines = fs
    .readFileSync(path.join(bdir, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter((x) => x.trim())
  const legacyEntry = lines
    .map((l) => JSON.parse(l))
    .find((e) => String(e.orig).includes('legacy.txt'))
  check(
    '4c. manifest 指针已改写且带 sha',
    !!(legacyEntry && legacyEntry.sha && /sha-/.test(legacyEntry.backup)),
  )
  const content = legacyEntry ? fs.readFileSync(legacyEntry.backup, 'utf8') : ''
  check(
    '4d. 迁移后内容仍可还原（不是只改指针）',
    content === 'same-bytes',
    JSON.stringify(content),
  )
  const dupBlobs = names2.filter((n) => n.startsWith('sha-')).length
  // 三个会话写的是同一份内容（same-bytes），且这里同一会话里两个不同文件名的内容也相同
  check(
    '4e. 同内容只留一份 blob（跨文件名也去重）',
    dupBlobs === 1,
    `${dupBlobs} 个 blob`,
  )

  // ---- 5. 审计目录必须一字节不动 ----
  const auditAfter = fs
    .readdirSync(AUDIT)
    .map((n) => n + ':' + fs.statSync(path.join(AUDIT, n)).size)
    .sort()
    .join('|')
  check(
    '5a. 审计目录完全未被触碰',
    auditAfter === auditBefore && auditBefore.length > 0,
  )
  check('5b. 审计链仍然可校验', state.verifyAuditChain().ok === true)

  try {
    fs.rmSync(archiveRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
} finally {
  try {
    fs.rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`)
if (fail > 0) process.exit(1)
console.log('PRUNE_OK')
