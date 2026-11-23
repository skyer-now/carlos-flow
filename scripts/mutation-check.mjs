#!/usr/bin/env node
// 变异只注入独占副本；锚点体检和执行共用同一份定义，不求值源码字符串。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mutant = (id, desc, file, from, to) => ({ id, desc, file, from, to })
const gate = /Array\.isArray\(state\.activation_pending\)\s*&&\s*state\.activation_pending\.length > 0/

export const MUTANTS = [
  mutant('M1-激活只打印日志', '激活调用改为假成功', 'client/carlos.js', "const r = await callMCP('tools/call', { name: step.tool, arguments: step.args });", `const r = { result: { isError: false, content: [{ text: '{"ok":true}' }] } };`),
  mutant('M2-claim闸门失效', '领取的外层与锁内占位检查均失效，保留卡代和额度CAS', 'src/index.js', /\/\/ 激活占位卡闸门：占位卡未补齐字段时不允许领取派发名额[\s\S]*?latest\.claimed = true/, (s) => s.replace(gate, 'false').replace('latest.activation_pending?.length', 'false')),
  mutant('M3-verdict闸门失效', '裁定不再检查占位卡', 'src/index.js', /if \(\s*Array\.isArray\(state\.activation_pending\)\s*&&\s*state\.activation_pending\.length > 0\s*\) \{\s*audit\('decision', sessionId, \{\s*kind: 'verdict_denied'/, (s) => s.replace(gate, 'false')),
  mutant('M4-会话撞名', '删除清洗后会话哈希后缀', 'src/trigger.js', "return safe + '-' + suffix;", 'return safe;'),
  mutant('M5-scope不算补齐项', '缺失项忽略scope', 'src/index.js', "...(!cardHasScope ? ['scope'] : []),", "...(false ? ['scope'] : []),"),
  mutant('M6-半补齐绕过闸门', '曾激活会话提交就解闸', 'src/index.js', /else if \(wasActivatedBefore\) \{[\s\S]*?activationPending = currentMissing/, (s) => s.replace('activationPending = currentMissing', 'activationPending = []')),
  mutant('M9-闸门派生回退', '普通卡回退上一轮pending传递', 'src/index.js', /\/\/ 此处再加闸门会误伤 T1 只读调研。\s*activationPending = \[\]/, (s) => s.replace('activationPending = []', 'activationPending = prevPendingBefore')),
  mutant('M10-普通卡也上闸', '普通卡也派生待补项', 'src/index.js', /\/\/ 普通卡（未标 activation，且本会话从未激活过）：不上闸门。[\s\S]*?activationPending = \[\]/, (s) => s.replace('activationPending = []', 'activationPending = currentMissing')),
  mutant('M11-占位卡硬编码三项', '占位卡不再按实际内容派生', 'src/index.js', /if \(isActivation\) \{\s*\/\/ 显式占位卡：待补项 = 服务端从这张卡实际缺什么推导出来的。\s*activationPending = currentMissing/, (s) => s.replace('activationPending = currentMissing', "activationPending = ['scope', 'acceptance', 'verify.cmd']")),
  mutant('M12-跨进程锁失效', '非排他创建锁', 'src/state.js', "const fd = fs.openSync(lockFile, 'wx')", "const fd = fs.openSync(lockFile, 'a')"),
  mutant('M13-只读意图误判', '无视改动动词', 'src/trigger.js', "if (hasMutating) return 'LEVEL_2';", "if (hasMutating) return 'LEVEL_0';"),
  mutant('M14-审计链断链', '记录哈希不链接上一条', 'src/state.js', 'rec.hash = computeAuditHash(rec, prev)', "rec.hash = computeAuditHash(rec, '')"),
  mutant('M15-审计链校验恒真', '单日链校验忽略损坏计数', 'src/state.js', /ok: broken === 0,(?=\s*total,\s*broken,\s*legacy,\s*brokenAt,\s*file: shards\[shards.length - 1\])/, 'ok: true,'),
  mutant('M16-越界检查退回 fail-open', '越界改动放行', 'src/dispatch.js', /if \(violations.length > 0\) \{[\s\S]*?ok: false,/, (s) => s.replace('ok: false,', 'ok: true,')),
  mutant('M17-date 参数失效', '历史读取始终读今天', 'src/state.js', 'const files = auditDayFilesOf(rawDate).map((f) => path.join(AUDIT_DIR, f))', 'const files = auditDayFilesOf(localDate()).map((f) => path.join(AUDIT_DIR, f))'),
  mutant('M7-空scope fail-open', '空scope允许任意改动', 'src/dispatch.js', /if \(!Array\.isArray\(scope\) \|\| scope.length === 0\) \{\s*return \{\s*ok: false,/, (s) => s.replace('ok: false,', 'ok: true,')),
  mutant('M21-快照不去重', '同内容快照再次写盘且不标记去重', 'src/dispatch.js', 'deduped = true', 'fs.writeFileSync(backup, buf)'),
  mutant('M22-快照不裁剪', '快照历史不再裁剪', 'src/dispatch.js', 'pruneSnapshotsLocked(bdir, SNAPSHOT_KEEP_VERSIONS)', 'void 0'),
  mutant('M23-审计不滚动', '忽略大小阈值', 'src/state.js', 'if (size < AUDIT_MAX_BYTES) return last', 'if (true) return last'),
  mutant('M24-校验只读首个分片', '跳过后续审计分片', 'src/state.js', 'hits.sort((a, b) => a.seq - b.seq)', 'hits.sort((a, b) => a.seq - b.seq)\n  if (hits.length > 1) hits.length = 1'),
  mutant('M25-输出不截断', '忽略输出大小阈值', 'src/dispatch.js', 'if (bytes <= keepBytes * 2) return { text: s, bytes, truncated: false }', 'return { text: s, bytes, truncated: false }'),
  mutant('M26-超时只杀外壳', '超时仅杀外壳不杀进程树', 'src/dispatch.js', /if \(!child \|\| !child.pid\) return\s*if \(process.platform === 'win32'\)/, "if (!child || !child.pid) return\n    child.kill('SIGKILL')\n    return\n    if (process.platform === 'win32')"),
  mutant('M18-项目级敏感规则不生效', '忽略项目追加敏感规则', 'src/protocol.js', '// 项目级扩展（只能追加；为空时零开销）', 'return false; // 忽略项目追加敏感规则'),
  mutant('M19-负对照还原不核对', '还原摘要核对恒真', 'src/dispatch.js', 'restoreReport = verifyRestoredState(saved, currentDigests)', 'restoreReport = { ok: true, checked: 0, mismatched: [], unreadable: [] }'),
  mutant('M20-死锁号不回收', '忽略已死锁持有者', 'src/state.js', "if (err && err.code === 'ESRCH') holderDead = true", 'if (false) holderDead = true'),
  mutant('M8-未派发可记PASS', '裁定不再检查真实派发计数', 'src/index.js', "if (verdict === 'PASS' && !(Number(state.dispatch_count) > 0)) {", 'if (false) {'),
].map(m => m.file === 'src/index.js' ? { ...m, file: 'src/handlers/gate.js' } : m)

export function inject(m, source) {
  const text = source.replace(/\r\n/g, '\n')
  const re = m.from instanceof RegExp
    ? new RegExp(m.from.source, 'g')
    : new RegExp(m.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  const matches = [...text.matchAll(re)]
  if (matches.length !== 1) throw new Error(`${m.id}: 锚点匹配 ${matches.length} 次（要求唯一）`)
  const hit = matches[0]
  const replacement = typeof m.to === 'function' ? m.to(hit[0]) : m.to
  if (replacement === hit[0]) throw new Error(`${m.id}: 未注入实际变化`)
  return text.slice(0, hit.index) + replacement + text.slice(hit.index + hit[0].length)
}

export function checkSyntax(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
  if (r.error || r.signal || r.status !== 0) throw new Error(`注入语法无效：${r.stderr || r.error || r.signal}`)
}

// 只创建新目录；已有路径无论属于谁均不删除或复用。全部证据保留供复核。
export function freshWorkspace(prefix = 'carlos-flow-mutation-') {
  const parent = resolve(process.env.MUTATION_WORK || tmpdir())
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

const SUITES = ['e2e', 'trigger', 'concurrency', 'scope', 'audit', 'sensitive', 'lock', 'falsify', 'hardening', 'cas', 'roll']

const COPY_NAMES = ['ui', 'src', 'client', 'bridge', 'test', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'README.zh.md', 'README.en.md', 'CHANGELOG.md', 'RELEASE_NOTES.md']

function fingerprint(repo) {
  const hashes = {}
  const visit = (name) => {
    const file = join(repo, name)
    if (statSync(file).isDirectory()) {
      for (const child of readdirSync(file).sort()) visit(`${name}/${child}`)
    } else {
      hashes[name] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
  for (const name of COPY_NAMES) visit(name)
  return hashes
}

function copyRepo(src, dst) {
  mkdirSync(dst)
  // 不读取插件部署清单、宿主配置、历史证据；仅复制这些测试所需代码。
  for (const name of COPY_NAMES) {
    cpSync(join(src, name), join(dst, name), { recursive: true })
  }
  if (existsSync(join(src, 'node_modules'))) cpSync(join(src, 'node_modules'), join(dst, 'node_modules'), { recursive: true })
}

// 异步等待关闭事件：同步超时会阻塞事件循环，且只结束直接进程。
export function runSuiteCommand(command, args, { cwd, env, timeout = 600000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const win = process.platform === 'win32'
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = { stdout: [], stderr: [] }
    const bytes = { stdout: 0, stderr: 0 }
    let error
    let cleanup
    let cleanupError
    let timer
    const stop = (reason) => {
      if (cleanup) return
      error = reason
      clearTimeout(timer)
      // 在关闭事件返回结果之前，必须等待整树回收工具退出。
      cleanup = Promise.resolve().then(() => {
        if (!child.pid) return
        if (!win) {
          try { process.kill(-child.pid, 'SIGKILL') } catch (err) {
            if (err.code !== 'ESRCH') throw err
          }
          return
        }
        return new Promise((done, reject) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          const killTimer = setTimeout(() => {
            killer.kill('SIGKILL')
            reject(new Error('整树回收工具超时'))
          }, 10000)
          killer.once('error', (err) => {
            clearTimeout(killTimer)
            reject(err)
          })
          killer.once('close', (code) => {
            clearTimeout(killTimer)
            if (code === 0) done()
            else reject(new Error(`整树回收失败：${code}`))
          })
        })
      }).catch((err) => {
        cleanupError = new Error(`${reason.message}；${err.message}`)
        child.kill('SIGKILL')
      })
    }
    for (const which of ['stdout', 'stderr']) {
      child[which].on('data', (data) => {
        bytes[which] += data.length
        if (bytes[which] <= maxBuffer) chunks[which].push(data)
        else stop(new Error(`${which} 超出输出上限`))
      })
    }
    timer = setTimeout(() => stop(new Error(`套件超时 (${timeout}ms)`)), timeout)
    child.once('error', (err) => {
      error = err
      clearTimeout(timer)
    })
    child.once('close', async (status, signal) => {
      clearTimeout(timer)
      await cleanup
      if (cleanupError) {
        rejectResult(cleanupError)
        return
      }
      resolveResult({ status, signal, error, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') })
    })
  })
}

async function runSuites(repo, root, label, port) {
  const state = join(root, label)
  mkdirSync(state)
  const env = { ...process.env }
  for (const key of ['HOME', 'USERPROFILE', 'CARLOS_FLOW_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'TMP', 'TEMP', 'TMPDIR']) {
    env[key] = join(state, key.toLowerCase())
    mkdirSync(env[key], { recursive: true })
  }
  env.CARLOS_FLOW_MCP_ROOT = repo
  env.BRIDGE_PORT = String(port)
  const results = []
  for (const suite of SUITES) {
    const started = Date.now()
    console.log(`[${label}] 开始 test:${suite}`)
    const win = process.platform === 'win32'
    const r = await runSuiteCommand(win ? 'cmd.exe' : 'npm', win ? ['/d', '/s', '/c', `npm run test:${suite}`] : ['run', `test:${suite}`], {
      cwd: repo, env, timeout: 600000, maxBuffer: 64 * 1024 * 1024,
    })
    const output = (r.stdout || '') + (r.stderr || '')
    const seconds = (Date.now() - started) / 1000
    writeFileSync(join(state, `${suite}.log`), output + `\n真实退出码=${r.status} 信号=${r.signal} 错误=${r.error || ''}\n耗时=${seconds}s\n`)
    // 语法、超时、启动错误不是有效检出；异常保留而不粉饰为通过。
    // 非零必须有测试断言或失败用例证据，普通启动报错不能冒充检出。
    const failureEvidence = /AssertionError|✗|❌\s*失败:\s*[1-9]|结果:.*[1-9]\d* 失败/.test(output)
    const invalid = !!r.error || !!r.signal || r.status === null || /SyntaxError:|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(output) || (r.status !== 0 && !failureEvidence)
    results.push({ suite, status: r.status, invalid, failureEvidence, seconds })
    console.log(`[${label}] test:${suite} exit=${r.status} ${seconds}s${invalid ? '（无效执行）' : ''}`)
  }
  return results
}

export async function main() {
  const src = resolve(process.argv[2] || process.env.MUTATION_SRC || REPO_ROOT)
  const root = freshWorkspace()
  const report = resolve(process.env.MUTATION_REPORT || join(root, 'report.md'))
  if (existsSync(report)) throw new Error(`拒绝覆盖已有报告：${report}`)
  mkdirSync(dirname(report), { recursive: true })
  const snapshot = join(root, 'snapshot')
  const before = fingerprint(src)
  copyRepo(src, snapshot)
  const frozen = fingerprint(snapshot)
  if (JSON.stringify(before) !== JSON.stringify(frozen) || JSON.stringify(before) !== JSON.stringify(fingerprint(src))) {
    throw new Error('复制期间源仓变化，拒绝使用漂移快照')
  }
  writeFileSync(join(root, 'snapshot-sha256.json'), JSON.stringify(frozen, null, 2))
  console.log(`冻结副本完成：${snapshot}；此后不再从源仓复制，父可并行固定验证/负对照`)
  const baselineRepo = join(root, 'baseline-repo')
  copyRepo(snapshot, baselineRepo)
  const started = Date.now()
  const results = []
  const save = () => {
    writeFileSync(join(root, 'results.json'), JSON.stringify({ root, baseline, results, seconds: (Date.now() - started) / 1000 }, null, 2))
    writeFileSync(report, '# 真实变异报告\n\n' + `证据：${root}\n\n基线：${baseline.every((r) => !r.invalid && r.status === 0) ? 'PASS' : 'FAIL'}\n\n` + results.map((r) => `- ${r.id}：${r.verdict}；失败套件：${r.failed.join('、') || '无'}\n`).join(''))
  }
  // 同一冻结快照、同一命令清单，基线必须每个退出码均为零。
  const baseline = await runSuites(baselineRepo, root, 'baseline', Number(process.env.MUTATION_PORT_BASE || 20100))
  save()
  if (baseline.some((r) => r.invalid || r.status !== 0)) { process.exitCode = 1; return }
  for (const [i, m] of MUTANTS.entries()) {
    const repo = join(root, `mutant-${i + 1}`)
    copyRepo(snapshot, repo)
    const target = join(repo, m.file)
    writeFileSync(target, inject(m, readFileSync(target, 'utf8')))
    checkSyntax(target)
    const runs = await runSuites(repo, root, `run-${i + 1}`, Number(process.env.MUTATION_PORT_BASE || 20100) + i + 1)
    const failed = runs.filter((r) => !r.invalid && r.status !== 0).map((r) => r.suite)
    const verdict = runs.some((r) => r.invalid) ? 'INVALID' : failed.length ? 'DETECTED' : 'SURVIVED'
    results.push({ id: m.id, desc: m.desc, file: m.file, verdict, failed, runs })
    save()
    console.log(`[${i + 1}/${MUTANTS.length}] ${m.id} ${verdict}`)
  }
  process.exitCode = results.length === MUTANTS.length && results.every((r) => r.verdict === 'DETECTED') ? 0 : 1
  console.log(`证据保留：${root}；报告：${report}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
