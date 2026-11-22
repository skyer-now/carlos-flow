// 阶段二专项：项目隔离避坑记忆 + 真实质检单导出。
//
// 覆盖计划里的验收点：
//   1. 跨项目不串记忆（同仓库 worktree 复用、不同仓库隔离）；
//   2. 并发写不丢记录；
//   3. 坏文件可解释降级，且不假装保存成功；
//   4. 只采集明确业务断言失败，语法/缺模块/超时/未知不入库；
//   5. 脱敏：不写用户名、绝对家目录路径与凭据；
//   6. 旧全局记忆不自动归入任何项目、不参与注入；
//   7. 质检单缺证据不假绿，导出文件真实存在且可校验。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-stage2-'))
const flowHome = path.join(sandbox, 'flow')
process.env.CARLOS_FLOW_HOME = flowHome
process.env.HOME = process.env.USERPROFILE = path.join(sandbox, 'home')
fs.mkdirSync(process.env.HOME, { recursive: true })

const {
  resolveProjectIdentity,
  loadProjectFailureMemory,
  saveProjectFailureMemory,
  classifyVerifyFailure,
  collectVerifyFailure,
  listCandidates,
  confirmFailureExperience,
  redact,
} = await import('../src/failure-memory.js')
const { inferProactiveGuidelines } = await import('../src/dispatch.js')
const { generateQASheet, exportQASheet } = await import('../ui/narrator.js')

function initGitRepo(name) {
  const dir = path.join(sandbox, name)
  fs.mkdirSync(dir, { recursive: true })
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'stage2@example.invalid'])
  git(['config', 'user.name', 'stage2'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  return dir
}

const repoA = initGitRepo('repo-a')
const repoB = initGitRepo('repo-b')

describe('阶段二 · 项目隔离失败记忆', () => {
  it('项目身份：同仓库 worktree 复用，不同仓库隔离', () => {
    const a = resolveProjectIdentity(repoA)
    const b = resolveProjectIdentity(repoB)
    assert.equal(a.kind, 'git-common-dir')
    assert.notEqual(a.key, b.key, '不同仓库必须是不同项目分区')

    const wt = path.join(sandbox, 'repo-a-wt')
    const add = spawnSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], {
      cwd: repoA, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(add.status, 0, 'worktree 创建应成功')
    const w = resolveProjectIdentity(wt)
    assert.equal(w.key, a.key, '同一仓库的 worktree 必须共享项目身份')
  })

  it('经验只注入本项目，不串到其他项目', () => {
    const saved = saveProjectFailureMemory(
      { rule: 'A 项目：写状态前必须先拿短锁', tag: 'lock', source: 'manual' },
      { flowHome, cwd: repoA },
    )
    assert.equal(saved.ok, true)
    assert.equal(saved.added, true)

    const tipsA = inferProactiveGuidelines(['src/state.js'], { cwd: repoA })
    assert.ok(tipsA.includes('A 项目：写状态前必须先拿短锁'))

    const tipsB = inferProactiveGuidelines(['src/state.js'], { cwd: repoB })
    assert.ok(!tipsB.includes('A 项目'), 'B 项目不得看到 A 项目的经验')
  })

  it('重复写入去重，条数超限时丢弃最旧记录', () => {
    const dup = saveProjectFailureMemory('重复经验：同一句话', { flowHome, cwd: repoA })
    const dup2 = saveProjectFailureMemory('重复经验：同一句话', { flowHome, cwd: repoA })
    assert.equal(dup.ok, true)
    assert.equal(dup2.deduped, true)

    for (let i = 0; i < 45; i++) {
      const r = saveProjectFailureMemory(`批量经验 ${i}`, { flowHome, cwd: repoA })
      assert.equal(r.ok, true)
    }
    const mem = loadProjectFailureMemory({ flowHome, cwd: repoA })
    assert.ok(mem.rules.length <= 40, '规则条数必须有上限')
    assert.ok(!mem.rules.some((r) => r.text === 'A 项目：写状态前必须先拿短锁'), '最旧记录应被淘汰')
  })

  it('并发写不丢记录（真实多进程同时写入）', async () => {
    const dir = initGitRepo('repo-concurrent')
    const writer = path.join(sandbox, 'writer.mjs')
    fs.writeFileSync(writer, [
      "import { pathToFileURL } from 'node:url';",
      "const mod = await import(pathToFileURL(" + JSON.stringify(path.join(process.cwd(), 'src/failure-memory.js')) + ").href);",
      'const [flowHome, cwd, tag] = process.argv.slice(2);',
      "mod.saveProjectFailureMemory({ rule: '并发经验 ' + tag, tag: 'concurrency' }, { flowHome, cwd });",
    ].join('\n'))
    // 必须同时启动（spawn 不等退出），否则测不到读-改-写的丢更新窗口。
    const children = []
    for (let i = 0; i < 8; i++) {
      const child = spawn(process.execPath, [writer, flowHome, dir, String(i)], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      children.push(new Promise((resolve) => {
        let stderr = ''
        child.stderr.on('data', (d) => { stderr += String(d) })
        child.on('close', (code) => resolve({ code, stderr }))
      }))
    }
    const results = await Promise.all(children)
    for (const r of results) assert.equal(r.code, 0, r.stderr || '写入进程必须正常退出')
    const mem = loadProjectFailureMemory({ flowHome, cwd: dir })
    assert.equal(mem.rules.length, 8, '并发写入的每条记录都必须保留（互斥锁不能丢数据）')
    assert.equal(mem.degraded, false)
  })

  it('坏文件可解释降级，且保存失败时如实返回 ok=false', () => {
    const dir = initGitRepo('repo-corrupt')
    const id = resolveProjectIdentity(dir)
    const target = path.join(flowHome, 'projects', id.key, 'failure-memory.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ 这不是合法 JSON ', 'utf8')

    const mem = loadProjectFailureMemory({ flowHome, cwd: dir })
    assert.equal(mem.degraded, true)
    assert.ok(mem.degraded_reason)
    assert.deepEqual(mem.rules, [])

    const tips = inferProactiveGuidelines(['src/a.js'], { cwd: dir })
    assert.ok(tips.includes('暂不可用'), '降级必须在注入里显式说明，不能静默当成无经验')

    const saved = saveProjectFailureMemory('损坏时不得覆盖原文件', { flowHome, cwd: dir })
    assert.equal(saved.ok, false, '损坏文件不得被静默覆盖')
    assert.ok(fs.readFileSync(target, 'utf8').includes('这不是合法 JSON'), '原损坏文件必须保留')
  })

  it('候选文件损坏时不被静默覆盖', () => {
    const dir = initGitRepo('repo-corrupt-candidates')
    const id = resolveProjectIdentity(dir)
    const target = path.join(flowHome, 'projects', id.key, 'candidates.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '[broken', 'utf8')
    const got = collectVerifyFailure(
      { exitCode: 1, stderr: 'AssertionError: expected 1 to equal 2' },
      { flowHome, cwd: dir, cmd: 'npm test', cardTs: 1, sessionId: 's' },
    )
    assert.equal(got.collected, false)
    assert.ok(got.reason)
    assert.equal(fs.readFileSync(target, 'utf8'), '[broken', '损坏的候选文件必须保留')
  })

  it('旧全局记忆不自动归入项目、不参与注入', () => {
    fs.mkdirSync(flowHome, { recursive: true })
    fs.writeFileSync(
      path.join(flowHome, 'failure-memory.json'),
      JSON.stringify({ rules: [{ text: '旧全局经验：不应出现在任何项目', tag: 'legacy' }] }),
      'utf8',
    )
    const mem = loadProjectFailureMemory({ flowHome, cwd: repoB })
    assert.equal(mem.legacy.count, 1)
    assert.equal(mem.legacy.ignored, true)
    assert.ok(!mem.rules.some((r) => r.text.includes('旧全局经验')))
    const tips = inferProactiveGuidelines(['src/a.js'], { cwd: repoB })
    assert.ok(!tips.includes('旧全局经验'))
  })

  it('脱敏：用户名、绝对家目录路径与凭据不入库', () => {
    const dir = initGitRepo('repo-redact')
    const dirty = 'C:\\Users\\alice\\proj\\a.js failed; token=ghp_ABCDEFGHIJKLMNOP; Bearer abcdefghijklmnop'
    const saved = saveProjectFailureMemory(dirty, { flowHome, cwd: dir })
    assert.equal(saved.ok, true)
    const mem = loadProjectFailureMemory({ flowHome, cwd: dir })
    const text = mem.rules[0].text
    assert.ok(!text.includes('alice'), '不得写入用户名')
    assert.ok(!text.includes('ghp_'), '不得写入凭据')
    assert.ok(text.includes('<用户目录>'))
    assert.equal(redact('/home/bob/x').includes('bob'), false)
  })

  it('脱敏覆盖 JSON 凭据、GitHub PAT、AWS Key 与非家目录绝对路径', () => {
    const cases = [
      ['{"password":"hunter2"}', 'hunter2'],
      ['github_pat_11ABCDEFG0123456789', 'github_pat_'],
      ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
      ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
      ['D:\\客户报价\\2026\\明细.xlsx', '客户报价'],
    ]
    for (const [input, secret] of cases) {
      const out = redact(input)
      assert.ok(!out.includes(secret), `未脱敏：${input} -> ${out}`)
    }
    // 文件名仍可用于定位排查
    assert.ok(redact('D:\\客户报价\\2026\\明细.xlsx').includes('明细.xlsx'))
  })
})

describe('阶段二 · 验证失败采集（只收业务断言失败）', () => {
  it('分类：断言失败入库，语法/缺模块/超时/未知不入库', () => {
    assert.equal(classifyVerifyFailure({ exitCode: 1, stderr: 'AssertionError [ERR_ASSERTION]: expected 1 to equal 2' }), 'assertion')
    assert.equal(classifyVerifyFailure({ exitCode: 1, stderr: 'SyntaxError: Unexpected token' }), 'infra')
    assert.equal(classifyVerifyFailure({ exitCode: 1, stderr: "Cannot find module 'x'" }), 'infra')
    assert.equal(classifyVerifyFailure({ exitCode: 1, stderr: 'ETIMEDOUT' }), 'timeout')
    assert.equal(classifyVerifyFailure({ exitCode: 1, stderr: 'something odd' }), 'unknown')
    // 运行器失败标记不是断言：网络/运行时错误也会带 not ok / ✗
    assert.equal(classifyVerifyFailure({ exitCode: 1, stderr: 'not ok 1 - x\n✗ TypeError: foo is not a function' }), 'runner-failure')
  })

  it('运行器失败不会入库（即使带 not ok 与 ✗）', () => {
    const dir = initGitRepo('repo-runner-failure')
    const got = collectVerifyFailure(
      { exitCode: 1, stderr: 'not ok 1 - x\n✗ TypeError: foo is not a function' },
      { flowHome, cwd: dir, cmd: 'npm test', cardTs: 1, sessionId: 's' },
    )
    assert.equal(got.collected, false)
    assert.equal(got.kind, 'runner-failure')
    assert.equal(listCandidates({ flowHome, cwd: dir }).candidates.length, 0)
  })

  it('只把断言失败写成待核实候选，核实后才进入注入', () => {
    const dir = initGitRepo('repo-collect')
    const infra = collectVerifyFailure(
      { exitCode: 1, stderr: 'Cannot find module "./missing.js"' },
      { flowHome, cwd: dir, cmd: 'npm test', cardTs: 1, sessionId: 's' },
    )
    assert.equal(infra.collected, false)
    assert.equal(infra.kind, 'infra')

    const got = collectVerifyFailure(
      { exitCode: 1, stderr: 'AssertionError [ERR_ASSERTION]: expected 1 to equal 2\n    at test/a.test.mjs:9:3' },
      { flowHome, cwd: dir, cmd: 'npm test', cardTs: 1, sessionId: 's' },
    )
    assert.equal(got.collected, true)
    assert.equal(got.kind, 'assertion')

    const before = inferProactiveGuidelines(['src/a.js'], { cwd: dir })
    assert.ok(!before.includes('expected 1 to equal 2'), '未核实的候选不得进入注入')

    const confirmed = confirmFailureExperience(got.id, { flowHome, cwd: dir, note: '人工核实' })
    assert.equal(confirmed.ok, true)
    const after = inferProactiveGuidelines(['src/a.js'], { cwd: dir })
    assert.ok(after.includes('expected 1 to equal 2'), '核实后的经验必须可复用')

    const listed = listCandidates({ flowHome, cwd: dir })
    assert.equal(listed.candidates[0].confirmed, true)
  })
})

describe('阶段二 · 质检单导出（忠于证据）', () => {
  const fullState = () => ({
    card: { goal: '导出测试', quote: '测试', scope: ['src/a.js'], verify: { cmd: 'npm test' } },
    card_ts: 2000,
    completed_ok: true,
    verdict: 'PASS',
    verdict_role: 'auditor',
    last_verify: { cmd: 'npm test', exitCode: 0, ok: true, card_ts: 2000, ts: '2026-11-22T10:00:00.000Z', output_hash: 'b'.repeat(64) },
    last_falsify: {
      cmd: 'npm test', verdict: 'meaningful', ts: '2026-11-22T10:05:00.000Z',
      before: { ok: false, exitCode: 1 }, after: { ok: true, exitCode: 0, hash: 'b'.repeat(64) },
      restore: { ok: true, checked: 2, mismatched: [] },
    },
    audit_axes: {
      standards: { verdict: 'PASS', evidence: '规范核对', card_ts: 2000 },
      spec: { verdict: 'PASS', evidence: '验收核对', card_ts: 2000 },
    },
  })

  it('证据齐全时导出真实文件，内容与返回值哈希一致', async () => {
    const out = path.join(sandbox, 'export-ok')
    const res = await exportQASheet(fullState(), { outDir: out, sessionId: 'stage2-export' })
    assert.equal(res.ok, true, res.reason)
    const body = fs.readFileSync(res.path, 'utf8')
    assert.equal(createHash('sha256').update(body, 'utf8').digest('hex'), res.sha256)
    assert.ok(body.includes('✅ PASS'))
    assert.ok(body.includes('无（证据齐备）'))
  })

  it('缺证据导出时不得写 PASS，且列出未验证项', async () => {
    const out = path.join(sandbox, 'export-missing')
    const res = await exportQASheet({ card: { goal: 'x', scope: ['a.js'] }, card_ts: 1 }, { outDir: out, sessionId: 'stage2-missing' })
    assert.equal(res.ok, true, res.reason)
    const body = fs.readFileSync(res.path, 'utf8')
    assert.ok(!/✅ PASS/.test(body))
    assert.ok(body.includes('未验证'))
    assert.ok(body.includes('验证命令未执行'))
  })

  it('导出必须显式给出绝对输出目录，否则拒绝且不写文件', async () => {
    const noDir = await exportQASheet(fullState(), { sessionId: 'x' })
    assert.equal(noDir.ok, false)
    const rel = await exportQASheet(fullState(), { outDir: 'relative/dir', sessionId: 'x' })
    assert.equal(rel.ok, false)
    assert.ok(!fs.existsSync(path.join(process.cwd(), 'relative')), '拒绝时不得留下目录')
  })

  it('导出内容脱敏', async () => {
    const out = path.join(sandbox, 'export-redact')
    const state = fullState()
    state.card.goal = 'C:\\Users\\alice\\secret\\a.js 失败'
    const res = await exportQASheet(state, { outDir: out, sessionId: 'stage2-redact' })
    assert.equal(res.ok, true)
    const body = fs.readFileSync(res.path, 'utf8')
    assert.ok(!body.includes('alice'))
    assert.ok(body.includes('<用户目录>'))
  })

  it('过期卡导出的状态必须是未完成', () => {
    const state = fullState()
    state.stale = true
    const sheet = generateQASheet(state, '')
    assert.ok(!/✅ PASS/.test(sheet))
    assert.ok(sheet.includes('stale'))
  })

  it('真实过期（调用方传入 isStale 结果）也不得 PASS', () => {
    const sheet = generateQASheet(fullState(), '', { stale: true })
    assert.ok(!/✅ PASS/.test(sheet))
    assert.ok(sheet.includes('任务卡已过期'))
  })

  it('PASS 落盘后验证又失败：不得再导出 PASS', () => {
    const state = fullState()
    state.last_verify = { ...state.last_verify, ok: false, exitCode: 1 }
    const sheet = generateQASheet(state, '')
    assert.ok(!/✅ PASS/.test(sheet), '验证失败必须压制 PASS 头条')
    assert.ok(sheet.includes('当前验证未通过'))
  })

  it('PASS 但负对照被清空/不属于当前卡：不得再导出 PASS', () => {
    const missing = fullState()
    missing.last_falsify = null
    assert.ok(!/✅ PASS/.test(generateQASheet(missing, '')))

    const oldCard = fullState()
    oldCard.last_falsify = { ...oldCard.last_falsify, card_ts: 1999 }
    const sheet = generateQASheet(oldCard, '')
    assert.ok(!/✅ PASS/.test(sheet))
    assert.ok(sheet.includes('负对照证据不属于当前卡'))
  })

  it('PASS 但双轴缺失或属于旧卡：不得再导出 PASS', () => {
    const noAxes = fullState()
    noAxes.audit_axes = {}
    assert.ok(!/✅ PASS/.test(generateQASheet(noAxes, '')))

    const oldAxes = fullState()
    oldAxes.audit_axes = {
      standards: { verdict: 'PASS', evidence: '旧结论', card_ts: 1999 },
      spec: { verdict: 'PASS', evidence: '旧结论', card_ts: 1999 },
    }
    assert.ok(!/✅ PASS/.test(generateQASheet(oldAxes, '')))
  })
})

describe('阶段二 · 预算自愈与导出 CLI', () => {
  it('超长中文经验写满后仍可读可写（不会把自己写坏）', () => {
    const dir = initGitRepo('repo-budget')
    const id = resolveProjectIdentity(dir)
    const file = path.join(flowHome, 'projects', id.key, 'failure-memory.json')
    for (let i = 0; i < 45; i++) {
      const r = saveProjectFailureMemory({ rule: '中文经验' + i + '：' + '长'.repeat(480), tag: 'budget' }, { flowHome, cwd: dir })
      assert.equal(r.ok, true, r.reason)
    }
    const size = fs.statSync(file).size
    assert.ok(size <= 64 * 1024, '落盘文件不得超过 64KB，实际 ' + size)
    const mem = loadProjectFailureMemory({ flowHome, cwd: dir })
    assert.ok(mem.rules.length > 0, '写满后仍必须能读回规则')
    const again = saveProjectFailureMemory('写满后的新经验', { flowHome, cwd: dir })
    assert.equal(again.ok, true, '写满后仍必须能继续写入（自愈），实际：' + again.reason)
    assert.ok(fs.statSync(file).size <= 64 * 1024)
  })

  it('超预算的合法文件：裁剪后仍注入规则，而不是整体作废', () => {
    const dir = initGitRepo('repo-trim')
    const id = resolveProjectIdentity(dir)
    const file = path.join(flowHome, 'projects', id.key, 'failure-memory.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 手工造一个 70KB 的“合法但超预算”文件（模拟旧版本/同步工具拼接）
    const rules = []
    for (let i = 0; i < 40; i++) {
      rules.push({ text: '裁剪经验' + i + '：' + '长'.repeat(900), tag: 't', source: 'manual', added_at: new Date().toISOString() })
    }
    fs.writeFileSync(file, JSON.stringify({ project: id.key, rules }, null, 2), 'utf8')
    assert.ok(fs.statSync(file).size > 64 * 1024)
    const mem = loadProjectFailureMemory({ flowHome, cwd: dir })
    assert.ok(mem.rules.length > 0, '超预算文件必须裁剪出可用规则')
    assert.equal(mem.trimmed, true)
    const tips = inferProactiveGuidelines(['src/a.js'], { cwd: dir })
    assert.ok(tips.includes('裁剪经验'), '裁剪后的规则必须仍被注入')
    assert.ok(tips.includes('已裁剪'))
    // 下一次写入应落盘为预算内
    const saved = saveProjectFailureMemory('自愈后新增', { flowHome, cwd: dir })
    assert.equal(saved.ok, true, saved.reason)
    assert.ok(fs.statSync(file).size <= 64 * 1024)
  })

  it('CLI list 不输出本机绝对路径', () => {
    const r = spawnSync(process.execPath, ['scripts/failure-memory.mjs', 'list', '--cwd', repoA], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, CARLOS_FLOW_HOME: flowHome, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(flowHome), '不得输出绝对 FLOW_HOME')
    assert.ok(!/[A-Za-z]:\\/.test(r.stdout.replace(/<[^>]+>/g, '')), '不得输出盘符绝对路径')
  })

  it('CLI qa-sheet 拒绝写入状态目录，并对过期卡不写 PASS', () => {
    const sid = 'stage2-cli-stale'
    const dir = path.join(flowHome, 'gate-state', 'runs', sid)
    fs.mkdirSync(dir, { recursive: true })
    const old = Date.now() - 5 * 60 * 60 * 1000
    const hash = 'c'.repeat(64)
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      sessionId: sid,
      card: { goal: 'CLI 导出测试', quote: 'q', scope: ['src/a.js'], verify: { cmd: 'npm test' } },
      card_ts: old,
      completed_ok: true,
      verdict: 'PASS',
      verdict_role: 'auditor',
      last_verify: { cmd: 'npm test', exitCode: 0, ok: true, card_ts: old, ts: new Date(old).toISOString(), output_hash: hash },
      last_falsify: {
        cmd: 'npm test', verdict: 'meaningful', ts: new Date(old + 1000).toISOString(),
        before: { ok: false, exitCode: 1 }, after: { ok: true, exitCode: 0, hash },
        restore: { ok: true, checked: 1, mismatched: [] },
      },
      audit_axes: {
        standards: { verdict: 'PASS', evidence: 'x', card_ts: old },
        spec: { verdict: 'PASS', evidence: 'y', card_ts: old },
      },
    }), 'utf8')

    const env = { ...process.env, CARLOS_FLOW_HOME: flowHome, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    const inside = spawnSync(process.execPath, ['scripts/failure-memory.mjs', 'qa-sheet', '--session', sid, '--out', path.join(flowHome, 'out')], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 60000, env,
    })
    assert.notEqual(inside.status, 0, '不得把交付物写进 CARLOS_FLOW_HOME')
    assert.ok(inside.stdout.includes('CARLOS_FLOW_HOME'))

    const out = path.join(sandbox, 'cli-export')
    const ok = spawnSync(process.execPath, ['scripts/failure-memory.mjs', 'qa-sheet', '--session', sid, '--out', out], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 60000, env,
    })
    assert.equal(ok.status, 0, ok.stderr)
    const body = fs.readFileSync(path.join(out, 'carlos-qa-sheet-' + sid + '.md'), 'utf8')
    assert.ok(!/✅ PASS/.test(body), '过期卡不得写出 PASS')
    assert.ok(body.includes('任务卡已过期'))
  })
})

// 不留下临时仓库、worktree 与记忆目录：每跑一次就清一次。
after(() => {
  try {
    spawnSync('git', ['worktree', 'remove', '--force', path.join(sandbox, 'repo-a-wt')], {
      cwd: repoA, encoding: 'utf8', windowsHide: true,
    })
  } catch {}
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {}
})
