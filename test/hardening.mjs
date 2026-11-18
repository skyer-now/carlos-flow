// 门禁加固回归：超时整树回收 / 输出截断 / 快照去重与裁剪 / 存储可观测
//
// 覆盖的四个真实故障面（都来自实测）：
//   1. verify 超时后 cmd.exe 外壳被杀、派生的 node 子进程变孤儿（残留占端口/文件）；
//   2. 命令刷出几十 MB 日志 → stdout 字符串把进程内存打爆，门禁报「插件崩了」而不是「验证没通过」；
//   3. 多轮返工时 backup/ 对同一批文件重复整文件复制 → 单会话 94% 占用都在备份；
//   4. 没有度量就只能凭感觉删目录 → 误删活跃会话，丢门禁状态。
//
// 跑法：node test/hardening.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-hardening-home-'))
process.env.CARLOS_FLOW_HOME = HOME
process.env.HOME = HOME
process.env.USERPROFILE = HOME
// 超时上限压到 800ms：这条用例要的是「超时后整树回收」，不是等 120 秒。
process.env.CARLOS_VERIFY_TIMEOUT_MS = '800'

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

const dispatch = await import('../src/dispatch.js')
const state = await import('../src/state.js')

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

try {
  {
    const parentEnv = { ...process.env }
    const script = path.join(HOME, 'home-probe.cjs')
    fs.writeFileSync(
      script,
      `console.log(JSON.stringify({HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,CARLOS_FLOW_HOME:process.env.CARLOS_FLOW_HOME,cache:process.env.npm_config_cache}));setTimeout(()=>process.exit(Number(process.argv[3]||0)),Number(process.argv[2]||0));`,
    )
    const node = `node "${script.replace(/\\/g, '/')}"`
    const roots = []
    const mkdtemp = fs.mkdtempSync
    fs.mkdtempSync = (...args) => {
      const root = mkdtemp(...args)
      roots.push(root)
      return root
    }
    const assertRootsRemoved = () => {
      assert.ok(roots.length > 0)
      for (const root of roots) assert.equal(fs.existsSync(root), false, root)
      assert.deepEqual({ ...process.env }, parentEnv)
    }
    const assertHomes = (stdout) => {
      for (const line of stdout.trim().split('\n')) {
        const env = JSON.parse(line)
        assert.equal(env.HOME, env.USERPROFILE)
        assert.equal(env.HOME, env.CARLOS_FLOW_HOME)
        assert.notEqual(env.HOME, HOME)
        assert.equal(env.cache, path.join(env.HOME, 'npm-cache'))
        assert.equal(fs.existsSync(env.HOME), false)
      }
    }
    try {
      for (const isolateHome of [null, 1, 'true', [], {}]) {
        await assert.rejects(
          dispatch.runVerifyCommand(node, HOME, { isolateHome }),
          /isolateHome/,
        )
        await assert.rejects(
          dispatch.runNegativeControl('invalid-home', node, HOME, {
            isolateHome,
          }),
          /isolateHome/,
        )
      }
      const success = await dispatch.runVerifyCommand(
        `${node} 0 && ${node} 0`,
        HOME,
        { isolateHome: true, timeoutMs: 3000 },
      )
      assert.equal(success.ok, true)
      assertHomes(success.stdout)
      const failure = await dispatch.runVerifyCommand(`${node} 0 1`, HOME, {
        isolateHome: true,
      })
      assert.equal(failure.ok, false)
      assertHomes(failure.stdout)
      const timeout = await dispatch.runVerifyCommand(`${node} 1500`, HOME, {
        isolateHome: true,
        timeoutMs: 1000,
      })
      assert.equal(timeout.ok, false)
      assertHomes(timeout.stdout)
      const controller = new AbortController()
      const pending = dispatch.runVerifyCommand(`${node} 60000`, HOME, {
        isolateHome: true,
        signal: controller.signal,
      })
      await new Promise((r) => setTimeout(r, 300))
      controller.abort()
      assert.match((await pending).stderr, /取消/)
      const aborted = new AbortController()
      aborted.abort()
      assert.equal(
        (
          await dispatch.runVerifyCommand(node, HOME, {
            isolateHome: true,
            signal: aborted.signal,
          })
        ).ok,
        false,
      )
      assert.equal(
        (
          await dispatch.runVerifyCommand(
            node,
            path.join(HOME, 'missing-home-cwd'),
            { isolateHome: true },
          )
        ).ok,
        false,
      )
      const spawn = childProcess.spawn
      try {
        childProcess.spawn = () => {
          throw new Error('isolated synchronous spawn fault')
        }
        syncBuiltinESMExports()
        await assert.rejects(
          dispatch.runVerifyCommand(node, HOME, { isolateHome: true }),
          /synchronous spawn fault/,
        )
      } finally {
        childProcess.spawn = spawn
        syncBuiltinESMExports()
      }
      assertRootsRemoved()
      const rm = fs.rmSync
      try {
        fs.rmSync = (file, ...args) => {
          if (roots.includes(file)) throw new Error('isolated cleanup fault')
          return rm(file, ...args)
        }
        await assert.rejects(
          dispatch.runVerifyCommand(node, HOME, { isolateHome: true }),
          /清理失败/,
        )
      } finally {
        fs.rmSync = rm
        for (const root of roots) rm(root, { recursive: true, force: true })
      }
      assertRootsRemoved()
      check(
        '隔离HOME覆盖整个&&宏；父环境不变、成功/失败/超时/取消/spawn异常清理、清理失败不假成功',
        true,
      )
    } finally {
      fs.mkdtempSync = mkdtemp
    }
  }
  {
    const { startMcpClient } = await import('./_mcp-client.mjs')
    const sid = 'append-scope-isolated'
    const originals = Array.from({ length: 8 }, (_, i) => `original-${i}.js`)
    for (const file of [...originals, 'added.js'])
      fs.writeFileSync(path.join(HOME, file), `// ${file}\n`)
    dispatch.snapshotFiles(sid, originals, HOME)
    const card = {
      goal: '保留原任务目标',
      quote: '允许追加这9个脚本并继续验收',
      scope: originals,
      acceptance: ['原目标不变'],
      unknowns: [],
      assumptions: [],
      files: [{ path: originals[0], line: 1 }],
      verify: { cmd: 'node -e "process.exit(0)"' },
      env: { project: HOME, git_head: 'isolated' },
    }
    state.saveState(sid, {
      ...state.defaultState(),
      card,
      card_ts: Date.now(),
      dispatch_count: 1,
      dispatch_baseline: originals,
      claimed: true,
      claimed_role: 'auditor',
      last_verify: { ok: true },
      last_falsify: { verdict: 'meaningful' },
      audit_axes: { standards: { verdict: 'PASS' }, spec: { verdict: 'PASS' } },
      audit_axes_ts: Date.now(),
      verdict: 'PASS',
      verdict_role: 'auditor',
      completed_ok: true,
    })
    const metadata = () => {
      const rows = []
      const visit = (file) => {
        const s = fs.statSync(file)
        rows.push(
          s.isDirectory() ? [file, 'directory'] : [file, s.size, s.mtimeMs],
        )
        if (s.isDirectory())
          for (const name of fs.readdirSync(file).sort())
            visit(path.join(file, name))
        else rows.push([file, fs.readFileSync(file).toString('hex')])
      }
      visit(path.join(state.RUNS_DIR, sid))
      return rows
    }
    const oldCardTs = state.loadState(sid).card_ts
    const identity = dispatch.snapshotIdentity(sid, originals)
    assert.equal(identity.ok, true)
    assert.equal(identity.entries.length, 8)
    const fault = path.join(HOME, 'append-audit-fault')
    const stateFault = path.join(HOME, 'append-state-fault')
    const entry = path.join(HOME, 'append-fault-server.mjs')
    fs.writeFileSync(
      entry,
      `import fs from 'node:fs';
const fault=${JSON.stringify(fault)};const stateFault=${JSON.stringify(stateFault)};const write=fs.writeSync;
fs.writeSync=function(fd,b,...args){if(Buffer.isBuffer(b)&&b.toString().includes('scope_append_prepared')&&fs.existsSync(fault))throw new Error('isolated append audit fault');return write.call(this,fd,b,...args)};
const writeFile=fs.writeFileSync,rename=fs.renameSync;
fs.writeFileSync=function(file,...args){if(String(file).endsWith('state.json.tmp')&&fs.existsSync(stateFault)&&fs.readFileSync(stateFault,'utf8')==='write')throw new Error('isolated state write fault');return writeFile.call(this,file,...args)};
fs.renameSync=function(from,to,...args){if(String(to).endsWith('state.json')&&fs.existsSync(stateFault)&&fs.readFileSync(stateFault,'utf8')==='rename')throw new Error('isolated state rename fault');return rename.call(this,from,to,...args)};
await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});`,
    )
    const c = startMcpClient({
      entry,
      cwd: HOME,
      env: { HOME, USERPROFILE: HOME, CARLOS_FLOW_HOME: HOME },
    })
    try {
      await c.initialize()
      const base = {
        sessionId: sid,
        cwd: HOME,
        appendScope: ['added.js'],
        confirmed: true,
        reason: card.quote,
      }
      const call = async (args) =>
        c.request('tools/call', {
          name: 'flow_submit_requirement',
          arguments: args,
        })
      for (const args of [
        { ...base, confirmed: false },
        {
          sessionId: sid,
          cwd: HOME,
          appendScope: ['added.js'],
          reason: card.quote,
        },
        { ...base, sessionId: 'missing-append-card' },
        { ...base, appendScope: [] },
        { ...base, appendScope: ['not-present.js'] },
        { ...base, appendScope: ['../outside.js'] },
        { ...base, scope: ['added.js'] },
        { ...base, goal: 'replacement' },
        { ...base, cardText: 'FLOW_CARD:{}' },
        { ...base, verify: { cmd: 'echo changed' } },
        { ...base, appendScope: ['.'] },
        { ...base, reason: '' },
      ]) {
        const before = metadata()
        const reply = await call(args)
        assert.ok(
          reply.result.isError || JSON.stringify(reply).includes('"ok":false'),
          JSON.stringify(reply),
        )
        assert.deepEqual(metadata(), before)
      }
      const beforeFault = metadata()
      fs.writeFileSync(fault, '1')
      const failed = await call(base)
      assert.ok(JSON.stringify(failed).includes('isolated append audit fault'))
      assert.deepEqual(metadata(), beforeFault)
      fs.unlinkSync(fault)
      for (const mode of ['write', 'rename']) {
        const beforeState = state.loadState(sid)
        const beforeFiles = metadata()
        fs.writeFileSync(stateFault, mode)
        const failedState = await call(base)
        assert.ok(
          JSON.stringify(failedState).includes(`isolated state ${mode} fault`),
        )
        assert.deepEqual(state.loadState(sid), beforeState)
        assert.deepEqual(dispatch.snapshotIdentity(sid, originals), identity)
        const events = state
          .readAudit({ sessionId: sid })
          .filter((row) => row.kind?.startsWith('scope_append'))
        assert.ok(events.length > 0)
        assert.ok(
          events.every(
            (row) =>
              row.type === 'run' &&
              row.kind === 'scope_append_prepared' &&
              row.phase === 'prepared',
          ),
        )
        assert.ok(events.at(-1).card_ts > oldCardTs)
        fs.unlinkSync(stateFault)
        // rename 故障留下的临时状态不是已提交卡；只清理本测试注入的临时文件。
        fs.rmSync(path.join(state.RUNS_DIR, sid, 'state.json.tmp'), {
          force: true,
        })
        assert.deepEqual(metadata(), beforeFiles)
      }
      check(
        'scope追加state写入/rename失败仅留prepared、原卡及派发/8快照不变且不报成功',
        true,
      )
      const reply = await call(base)
      const result = JSON.parse(reply.result.content[0].text)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.deepEqual(result.added, ['added.js'])
      assert.equal(result.preserved_dispatch, true)
      const latest = state.loadState(sid)
      assert.ok(latest.card_ts > oldCardTs)
      assert.equal(result.card_ts, latest.card_ts)
      assert.deepEqual(latest.card, {
        ...card,
        scope: [...originals, 'added.js'],
      })
      assert.equal(latest.dispatch_count, 1)
      assert.deepEqual(latest.dispatch_baseline, originals)
      assert.equal(latest.claimed_role, 'auditor')
      assert.equal(latest.claimed, true)
      assert.equal(latest.last_verify, null)
      assert.equal(latest.last_falsify, null)
      assert.deepEqual(latest.audit_axes, { standards: null, spec: null })
      assert.equal(latest.audit_axes_ts, 0)
      assert.equal(latest.verdict, null)
      assert.equal(latest.completed_ok, false)
      assert.deepEqual(dispatch.snapshotIdentity(sid, originals), identity)
      const beforeDuplicate = metadata()
      const duplicate = JSON.parse(
        (await call({ ...base, appendScope: ['./added.js', 'added.js'] }))
          .result.content[0].text,
      )
      assert.deepEqual(duplicate.added, [])
      assert.equal(duplicate.card_ts, latest.card_ts)
      assert.deepEqual(metadata(), beforeDuplicate)
      assert.deepEqual(c.noise, [])
      check(
        '真实 MCP 追加范围保留8快照及派发、清证据；拒绝/审计失败无副作用、重复幂等',
        true,
      )
    } finally {
      await c.close()
    }
  }
  // 显式预算、取消与所有完成路径都必须释放进度 timer。
  {
    const originalSet = globalThis.setInterval,
      originalClear = globalThis.clearInterval
    const active = new Set()
    globalThis.setInterval = (...args) => {
      const timer = originalSet(...args)
      active.add(timer)
      return timer
    }
    globalThis.clearInterval = (timer) => {
      active.delete(timer)
      return originalClear(timer)
    }
    try {
      for (const timeoutMs of [999, 600001, NaN, '1000', 1000.5]) {
        await assert.rejects(
          dispatch.runVerifyCommand('node -e "process.exit(0)"', HOME, {
            timeoutMs,
          }),
          /timeoutMs/,
        )
        await assert.rejects(
          dispatch.runNegativeControl('invalid-options', 'node', HOME, {
            timeoutMs,
          }),
          /timeoutMs/,
        )
      }
      const cmd = 'node -e "setTimeout(()=>{},1500)"'
      assert.equal(
        (await dispatch.runVerifyCommand(cmd, HOME, { timeoutMs: 1000 })).ok,
        false,
      )
      assert.equal(
        (await dispatch.runVerifyCommand(cmd, HOME, { timeoutMs: 3000 })).ok,
        true,
      )
      assert.equal(
        (
          await dispatch.runVerifyCommand('node -e "process.exit(1)"', HOME, {
            timeoutMs: 3000,
          })
        ).ok,
        false,
      )
      assert.equal(
        (
          await dispatch.runVerifyCommand(cmd, path.join(HOME, 'missing'), {
            timeoutMs: 3000,
          })
        ).ok,
        false,
      )
      const controller = new AbortController()
      const pending = dispatch.runVerifyCommand(cmd, HOME, {
        timeoutMs: 3000,
        signal: controller.signal,
      })
      controller.abort()
      assert.match((await pending).stderr, /取消/)
      assert.equal(active.size, 0)
      check('显式预算及非法参数、取消、错误均清 timer', true)
    } finally {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    }
  }
  {
    const { startMcpClient } = await import('./_mcp-client.mjs')
    const c = startMcpClient({
      entry: fileURLToPath(new URL('../src/index.js', import.meta.url)),
      cwd: HOME,
      env: { HOME, USERPROFILE: HOME, CARLOS_FLOW_HOME: HOME },
    })
    try {
      await c.initialize()
      const list = await c.request('tools/list', {})
      const parentEnv = { ...process.env }
      const homeSid = 'isolated-home-mcp'
      const probe = path.join(HOME, 'home-probe.cjs').replace(/\\/g, '/')
      const homeCmd = `node "${probe}" 0 && node "${probe}" 0`
      state.saveState(homeSid, {
        ...state.defaultState(),
        card: { goal: '隔离宏探针', verify: { cmd: homeCmd } },
        card_ts: Date.now(),
      })
      const homeCall = async (name, args = {}) => {
        const reply = await c.request('tools/call', {
          name,
          arguments: { sessionId: homeSid, cwd: HOME, ...args },
        })
        return reply
      }
      const homeResult = JSON.parse(
        (
          await homeCall('flow_run_verify', {
            isolateHome: true,
            timeoutMs: 3000,
          })
        ).result.content[0].text,
      )
      assert.equal(homeResult.ok, true)
      const childEnvs = homeResult.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(childEnvs.length, 2)
      for (const env of childEnvs) {
        assert.equal(env.HOME, env.USERPROFILE)
        assert.equal(env.HOME, env.CARLOS_FLOW_HOME)
        assert.equal(env.HOME, childEnvs[0].HOME)
        assert.equal(env.cache, path.join(env.HOME, 'npm-cache'))
        assert.notEqual(env.HOME, HOME)
        assert.equal(fs.existsSync(env.HOME), false)
      }
      const inherited = JSON.parse(
        (await homeCall('flow_run_verify')).result.content[0].text,
      )
      const inheritedEnv = JSON.parse(inherited.stdout.trim().split('\n')[0])
      assert.equal(inheritedEnv.HOME, HOME)
      assert.equal(inheritedEnv.USERPROFILE, HOME)
      assert.equal(inheritedEnv.CARLOS_FLOW_HOME, HOME)
      for (const name of ['flow_run_verify', 'flow_falsify']) {
        assert.deepEqual(
          list.result.tools.find((t) => t.name === name).inputSchema.properties
            .isolateHome,
          { type: 'boolean', default: false },
        )
        for (const isolateHome of [null, 1, 'true', []]) {
          const reply = await homeCall(name, { isolateHome })
          assert.ok(
            JSON.stringify(reply).includes('isolateHome'),
            JSON.stringify(reply),
          )
          assert.ok(reply.result.isError, JSON.stringify(reply))
        }
      }
      const value = path.join(HOME, 'negative-home-value.txt')
      fs.writeFileSync(value, 'before')
      dispatch.snapshotFiles(homeSid, [value], HOME)
      fs.writeFileSync(value, 'after')
      const falsifyScript = path.join(HOME, 'negative-home.cjs')
      fs.writeFileSync(
        falsifyScript,
        `console.log(JSON.stringify({HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,CARLOS_FLOW_HOME:process.env.CARLOS_FLOW_HOME,cache:process.env.npm_config_cache}));process.exit(require('fs').readFileSync(${JSON.stringify(value)},'utf8')==='after'?0:1);`,
      )
      const current = state.loadState(homeSid)
      current.card.verify.cmd = `node "${falsifyScript.replace(/\\/g, '/')}"`
      state.saveState(homeSid, current)
      const falsified = JSON.parse(
        (await homeCall('flow_falsify', { isolateHome: true, timeoutMs: 3000 }))
          .result.content[0].text,
      )
      assert.equal(falsified.ok, true, JSON.stringify(falsified))
      assert.equal(falsified.before.ok, false)
      assert.equal(falsified.after.ok, true)
      for (const run of [falsified.before, falsified.after]) {
        const env = JSON.parse(run.stdout)
        assert.equal(env.HOME, env.USERPROFILE)
        assert.equal(env.HOME, env.CARLOS_FLOW_HOME)
        assert.equal(env.cache, path.join(env.HOME, 'npm-cache'))
        assert.equal(fs.existsSync(env.HOME), false)
      }
      assert.equal(fs.readFileSync(value, 'utf8'), 'after')
      assert.deepEqual({ ...process.env }, parentEnv)
      check(
        '真实 MCP 隔离完整宏与负对照两次HOME/缓存、清理、父环境及非法参数',
        true,
      )
      // 新增隔离探针不占用后续既有 stats 的 top-5 名额。
      fs.rmSync(path.join(state.RUNS_DIR, homeSid), {
        recursive: true,
        force: true,
      })
      for (const name of ['flow_run_verify', 'flow_falsify']) {
        assert.deepEqual(
          list.result.tools.find((t) => t.name === name).inputSchema.properties
            .timeoutMs,
          { type: 'integer', minimum: 1000, maximum: 600000 },
        )
      }
      const sid = 'timeout-mcp-isolated'
      state.saveState(sid, {
        ...state.defaultState(),
        card: {
          goal: 'timeout probe',
          verify: { cmd: 'node -e "setTimeout(()=>{},1500)"' },
        },
        card_ts: Date.now(),
      })
      const source = path.join(HOME, 'identity.txt')
      fs.writeFileSync(source, 'identity fixture')
      dispatch.snapshotFiles(sid, [source], HOME)
      const metadata = () => {
        const rows = []
        const visit = (dir) => {
          const stat = fs.statSync(dir)
          rows.push([dir, stat.size, stat.mtimeMs])
          if (stat.isDirectory())
            for (const name of fs.readdirSync(dir).sort())
              visit(path.join(dir, name))
          else rows.push([dir, fs.readFileSync(dir).toString('hex')])
        }
        visit(state.RUNS_DIR)
        return rows
      }
      const beforeIdentity = metadata()
      const statusCall = async (includeSnapshots) => {
        const reply = await c.request('tools/call', {
          name: 'flow_status',
          arguments: { sessionId: sid, includeSnapshots },
        })
        return JSON.parse(reply.result.content[0].text)
      }
      assert.equal((await statusCall(false)).snapshot_identity, undefined)
      const identity = (await statusCall(true)).snapshot_identity
      assert.equal(identity.ok, true)
      assert.match(identity.manifest_sha256, /^[a-f0-9]{64}$/)
      assert.match(identity.dispatch_baseline_sha256, /^[a-f0-9]{64}$/)
      assert.equal(identity.entries.length, 1)
      assert.equal(identity.entries[0].sha, identity.entries[0].backup_sha256)
      assert.deepEqual(metadata(), beforeIdentity)
      const manifest = path.join(
        state.RUNS_DIR,
        sid,
        'backup',
        'manifest.jsonl',
      )
      const savedManifest = fs.readFileSync(manifest)
      const read = fs.readFileSync
      let manifestReads = 0
      try {
        fs.readFileSync = (file, ...args) => {
          const value = read(file, ...args)
          if (file === manifest && ++manifestReads === 3)
            return Buffer.from('changed during read')
          return value
        }
        assert.equal(dispatch.snapshotIdentity(sid).ok, false)
      } finally {
        fs.readFileSync = read
      }
      fs.writeFileSync(manifest, 'invalid json')
      const damaged = await statusCall(true)
      assert.equal(damaged.has_card, true)
      assert.equal(damaged.snapshot_identity.ok, false)
      fs.unlinkSync(manifest)
      assert.equal((await statusCall(true)).snapshot_identity.ok, false)
      fs.writeFileSync(manifest, savedManifest)
      check('flow_status 快照身份只读、损坏/缺失独立错误', true)
      for (const timeoutMs of [1000, 3000]) {
        const reply = await c.request('tools/call', {
          name: 'flow_run_verify',
          arguments: { sessionId: sid, cwd: HOME, timeoutMs },
        })
        const result = JSON.parse(reply.result.content[0].text)
        assert.equal(result.ok, timeoutMs === 3000, JSON.stringify(result))
        if (timeoutMs === 1000) assert.match(result.stderr, /超时/)
      }
      for (const name of ['flow_run_verify', 'flow_falsify']) {
        for (const timeoutMs of [999, 600001, '1000', 1000.5]) {
          const reply = await c.request('tools/call', {
            name,
            arguments: { sessionId: sid, timeoutMs },
          })
          assert.ok(
            JSON.stringify(reply).includes('timeoutMs'),
            JSON.stringify(reply),
          )
        }
      }
      assert.deepEqual(c.noise, [])
      check('真实 MCP 1000ms 超时、3000ms 成功及 schema 拒绝', true)
    } finally {
      await c.close()
    }
  }
  {
    const work = path.join(HOME, 'negative-budget')
    fs.mkdirSync(work)
    const file = path.join(work, 'value.txt')
    fs.writeFileSync(file, 'before')
    dispatch.snapshotFiles('negative-budget', [file], work)
    fs.writeFileSync(file, 'after')
    const cmd = `node -e "setTimeout(()=>process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1),1500)"`
    const options = { timeoutMs: 3000 }
    const result = await dispatch.runNegativeControl(
      'negative-budget',
      cmd,
      work,
      options,
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.before.ok, false, JSON.stringify(result))
    assert.equal(result.after.ok, true, JSON.stringify(result))
    assert.ok(!/超时/.test(result.before.stderr))
    assert.deepEqual(options, { timeoutMs: 3000 })
    check('负对照两次均使用同一 3000ms options（覆盖 env 800ms）', true)
    const parentEnv = { ...process.env }
    const isolatedOptions = { timeoutMs: 3000, isolateHome: true }
    const isolatedCmd = `node -e "console.log(JSON.stringify({HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,CARLOS_FLOW_HOME:process.env.CARLOS_FLOW_HOME}));setTimeout(()=>process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1),1500)"`
    const isolated = await dispatch.runNegativeControl(
      'negative-budget',
      isolatedCmd,
      work,
      isolatedOptions,
    )
    assert.equal(isolated.ok, true)
    assert.equal(isolated.before.ok, false)
    assert.equal(isolated.after.ok, true)
    for (const run of [isolated.before, isolated.after]) {
      const env = JSON.parse(run.stdout)
      assert.equal(env.HOME, env.USERPROFILE)
      assert.equal(env.HOME, env.CARLOS_FLOW_HOME)
      assert.notEqual(env.HOME, HOME)
      assert.equal(fs.existsSync(env.HOME), false)
    }
    assert.deepEqual(isolatedOptions, { timeoutMs: 3000, isolateHome: true })
    assert.deepEqual({ ...process.env }, parentEnv)
    check('library负对照两次隔离策略一致、目录清理及父环境不变', true)
  }
  // ---- 1. 超时必须整树回收（Windows: taskkill /T /F；POSIX: 进程组）----
  {
    const pidFile = path.join(HOME, 'grandchild.pid')
    // 命令自己写 pid 再挂住：它是 cmd.exe 的**子进程**，只杀外壳会留下它
    const cmd = `node -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},60000)" "${pidFile.replace(/\\/g, '/')}"`
    const r = await dispatch.runVerifyCommand(cmd, HOME)
    check(
      '1a. 超时后判定为失败',
      r.ok === false && /超时/.test(r.stderr),
      `exit=${r.exitCode}`,
    )
    let pid = 0
    try {
      pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    } catch {
      pid = 0
    }
    check('1b. 命令确实派生出了子进程（用例前提成立）', pid > 0, `pid=${pid}`)
    if (pid > 0) {
      // Windows 上 taskkill /T 完成后进程可能需要一点时间真正消失
      let still = alive(pid)
      for (let i = 0; i < 30 && still; i++) {
        await new Promise((r2) => setTimeout(r2, 100))
        still = alive(pid)
      }
      check(
        '1c. 超时把派生进程一起结束（无孤儿）',
        !still,
        still ? `pid=${pid} 仍存活` : '已回收',
      )
    }
  }

  // ---- 2. 输出截断：头尾保留 + 如实记录原始字节 ----
  {
    const big = path.join(HOME, 'big.js')
    fs.writeFileSync(
      big,
      `const line="x".repeat(1024);for(let i=0;i<3000;i++)console.log(line);`,
      'utf8',
    )
    const r = await dispatch.runVerifyCommand(
      `node "${big.replace(/\\/g, '/')}"`,
      HOME,
    )
    check(
      '2a. 3MB 输出不整段进内存（回传被截断）',
      r.output_truncated === true,
      `trunc=${r.output_truncated} len=${String(r.stdout || '').length}`,
    )
    check(
      '2b. 原始字节数如实记录（不是只看截断后的长度）',
      (r.stdout_bytes || 0) > 2 * 1024 * 1024,
      `bytes=${r.stdout_bytes}`,
    )
    check(
      '2c. 回传体积有硬上界（< 1MB）',
      String(r.stdout || '').length < 1024 * 1024,
      `len=${String(r.stdout || '').length}`,
    )
    check(
      '2d. 截断处有明确标记（不静默丢内容）',
      /已截断 \d+ 字节/.test(r.stdout),
    )
  }

  // ---- 3. 快照：内容寻址去重 + 每个 orig 只留最近 N 版 ----
  {
    const sid = 'dedup-' + Date.now()
    const work = path.join(HOME, 'work')
    fs.mkdirSync(work, { recursive: true })
    const target = path.join(work, 'a.txt')

    fs.writeFileSync(target, 'same-content\n', 'utf8')
    const e1 = dispatch.snapshotFiles(sid, ['a.txt'], work)
    const e2 = dispatch.snapshotFiles(sid, ['a.txt'], work)
    check(
      '3a. 同内容快照被识别为去重',
      e1[0].sha === e2[0].sha && e2[0].deduped === true,
      `sha=${String(e1[0].sha).slice(0, 8)} deduped=${e2[0].deduped}`,
    )
    check('3b. 同内容只占一个 blob 文件', e1[0].backup === e2[0].backup)

    // 再来 5 轮不同内容 → 应只保留最近 3 版
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(target, 'content-' + i + '\n', 'utf8')
      dispatch.snapshotFiles(sid, ['a.txt'], work)
    }
    const manifest = path.join(
      state.RUNS_DIR,
      state.sanitizeId(sid),
      'backup',
      'manifest.jsonl',
    )
    const entries = fs
      .readFileSync(manifest, 'utf8')
      .split('\n')
      .filter((x) => x.trim())
    check(
      '3c. manifest 每个 orig 只保留最近 3 版',
      entries.length === 3,
      `条目=${entries.length}`,
    )
    const blobs = fs
      .readdirSync(path.dirname(manifest))
      .filter((n) => n.startsWith('sha-'))
    check(
      '3d. 无引用的 blob 被删除（不残留）',
      blobs.length <= 3,
      `blob=${blobs.length}`,
    )

    // 还原语义必须不变：最新版仍能指回正确内容
    const last = JSON.parse(entries[entries.length - 1])
    const restored = fs.readFileSync(last.backup, 'utf8').trim()
    check(
      '3e. 保留的最新版内容正确（还原语义不变）',
      restored === 'content-4',
      restored,
    )
  }

  // ---- 4. flow_stats：只读 + 真能回答「占了多少、谁占的」----
  {
    // 造一个有状态的真实会话（只有状态文件才有「最近活跃时间」可报）
    state.saveState('stats-probe', {
      ...state.defaultState(),
      tier: 'single_file',
      card: { goal: '统计探针' },
      card_ts: Date.now(),
    })
    const before = fs.statSync(path.join(state.RUNS_DIR)).mtimeMs
    const { startMcpClient } = await import('./_mcp-client.mjs')
    const c = startMcpClient({
      // 必须用 fileURLToPath：POSIX 上 pathname 是 /home/...，去掉前导斜杠就变成
      // 相对路径 "home/..." —— 表现为「spawn 成功但永远连不上」，在 CI 上才暴露。
      entry: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'index.js',
      ),
      cwd: process.cwd(),
      env: { CARLOS_FLOW_HOME: HOME },
    })
    try {
      await c.initialize()
      const res = await c.request(
        'tools/call',
        { name: 'flow_stats', arguments: { limit: 5 } },
        30000,
      )
      const j = JSON.parse(res.result.content[0].text)
      check(
        '4a. flow_stats 返回总占用与会话数',
        typeof j.total.bytes === 'number' && j.total.sessions >= 1,
        `sessions=${j.total.sessions} bytes=${j.total.bytes}`,
      )
      check(
        '4b. 给出备份去重率（能看出备份值不值得清）',
        typeof j.backup.dedup_ratio === 'number',
        `ratio=${j.backup.dedup_ratio}`,
      )
      check('4c. 给出审计按日增长', Array.isArray(j.audit.recent_days))
      check(
        '4d. 给出陈旧会话清单（含终态标记）',
        Array.isArray(j.stale.samples) &&
          typeof j.stale.threshold_days === 'number',
      )
      const probe = (j.sessions_top || []).find(
        (x) => x.session === 'stats-probe',
      )
      check(
        '4e. 有状态的会话带最近活跃时间与卡片信息',
        !!probe &&
          probe.last_active != null &&
          probe.has_card === true &&
          probe.tier === 'single_file',
        probe
          ? `last_active=${probe.last_active} has_card=${probe.has_card}`
          : '未找到探针会话',
      )
    } finally {
      await c.close()
    }
    const after = fs.statSync(path.join(state.RUNS_DIR)).mtimeMs
    check('4f. flow_stats 是只读的（不改任何目录）', before === after)
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
console.log('HARDENING_OK')
