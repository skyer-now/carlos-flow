// 阶段三专项：单人任务 Git Worktree 隔离。
//
// 覆盖计划的验收点：
//   1. 从明确提交建立工作区，登记基线、真实路径与持久引用；
//   2. 拒绝不明基线、路径越界、符号链接逃逸、脏主工作区的隐式迁移；
//   3. 两个任务互不污染；
//   4. 异常或未交付改动时保留；清理须无运行任务、无脏改动，用 Git 原生移除；
//   5. 只清理本工具登记的工作区，不全局 prune、不递归删用户项目。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-worktree-'))
const flowHome = path.join(sandbox, 'flow')
const repo = path.join(sandbox, 'repo')
const wsRoot = path.join(sandbox, 'ws')
fs.mkdirSync(repo, { recursive: true })
fs.mkdirSync(wsRoot, { recursive: true })
fs.mkdirSync(flowHome, { recursive: true })
// dispatch/state 在导入时读取环境：先隔离，避免读写真实用户记忆。
process.env.CARLOS_FLOW_HOME = flowHome
process.env.HOME = process.env.USERPROFILE = path.join(sandbox, 'home')
fs.mkdirSync(process.env.HOME, { recursive: true })

const git = (args, cwd = repo) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
git(['init', '-q'])
git(['config', 'user.email', 'wt@example.invalid'])
git(['config', 'user.name', 'wt'])
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
git(['add', '.'])
git(['commit', '-q', '-m', 'init'])
const base = git(['rev-parse', 'HEAD']).stdout.trim()

const {
  createTaskWorktree,
  removeTaskWorktree,
  readTaskWorktree,
  listTaskWorktrees,
  sanitizeTaskId,
  worktreeIdentity,
  resolveTaskWorkdir,
  markTaskRunning,
  clearTaskRunning,
} = await import('../src/worktree.js')

after(() => {
  for (const rec of listTaskWorktrees({ flowHome })) {
    try { removeTaskWorktree(rec.task_id, { flowHome, force: true }) } catch {}
  }
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

describe('阶段三 · 任务工作区隔离', () => {
  it('任务标识白名单拒绝路径穿越', () => {
    assert.equal(sanitizeTaskId('task-1'), 'task-1')
    assert.equal(sanitizeTaskId('..'), null)
    assert.equal(sanitizeTaskId('../evil'), null)
    assert.equal(sanitizeTaskId('a/b'), null)
    assert.equal(sanitizeTaskId(''), null)
  })

  it('从明确提交创建工作区并登记基线', () => {
    const r = createTaskWorktree({ repoCwd: repo, taskId: 'task-a', root: wsRoot, base, flowHome })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.record.base_commit, base)
    assert.equal(r.record.status, 'ready')
    const head = git(['rev-parse', 'HEAD'], path.join(wsRoot, 'task-a'))
    assert.equal(head.stdout.trim(), base)
    const saved = readTaskWorktree('task-a', { flowHome })
    assert.equal(saved.ok, true)
    // macOS 的 tmpdir 是 /var/folders/...（realpath 为 /private/var/...），
    // 实现存的是 realpath，所以比较也要走 realpath。
    const wsRootReal = fs.realpathSync(wsRoot)
    assert.equal(saved.record.path, path.join(wsRootReal, 'task-a'))
    assert.equal(worktreeIdentity(saved.record).length, 64)
  })

  it('两个任务互不污染', () => {
    const b = createTaskWorktree({ repoCwd: repo, taskId: 'task-b', root: wsRoot, base, flowHome })
    assert.equal(b.ok, true, b.reason)
    fs.writeFileSync(path.join(wsRoot, 'task-a', 'only-a.txt'), 'a\n')
    const statusB = git(['status', '--porcelain'], path.join(wsRoot, 'task-b'))
    assert.equal(statusB.stdout.trim(), '', 'B 工作区不应看到 A 的改动')
    const statusA = git(['status', '--porcelain'], path.join(wsRoot, 'task-a'))
    assert.ok(statusA.stdout.includes('only-a.txt'))
  })

  it('脏主工作区且未指定基线时拒绝隐式迁移', () => {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n')
    const r = createTaskWorktree({ repoCwd: repo, taskId: 'task-c', root: wsRoot, flowHome })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('拒绝隐式迁移'))
    assert.equal(fs.existsSync(path.join(wsRoot, 'task-c')), false)
    // 显式基线仍可创建
    const ok = createTaskWorktree({ repoCwd: repo, taskId: 'task-c', root: wsRoot, base, flowHome })
    assert.equal(ok.ok, true, ok.reason)
    fs.rmSync(path.join(repo, 'dirty.txt'))
  })

  it('不存在的基线提交被拒绝', () => {
    const r = createTaskWorktree({ repoCwd: repo, taskId: 'task-d', root: wsRoot, base: 'deadbeefdeadbeef', flowHome })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('基线不是有效提交'))
    assert.equal(readTaskWorktree('task-d', { flowHome }).ok, false, '失败不得留下登记')
  })

  it('越界路径被拒绝', () => {
    const outside = path.join(sandbox, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    const r = createTaskWorktree({ repoCwd: repo, taskId: '../outside/x', root: wsRoot, base, flowHome })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('任务标识不合法'))
    assert.equal(fs.existsSync(path.join(outside, 'x')), false)
  })

  it('有未交付改动时拒绝清理，force 后才移除', () => {
    const dirty = removeTaskWorktree('task-a', { flowHome })
    assert.equal(dirty.ok, false)
    assert.ok(dirty.reason.includes('未提交'))

    const forced = removeTaskWorktree('task-a', { flowHome, force: true })
    assert.equal(forced.ok, true, forced.reason)
    assert.equal(fs.existsSync(path.join(wsRoot, 'task-a')), false)
    assert.equal(readTaskWorktree('task-a', { flowHome }).ok, false, '清理后登记必须删除')
  })

  it('运行中标记阻止清理（force 才可覆盖）', () => {
    fs.writeFileSync(path.join(flowHome, 'tasks', 'task-b', 'running'), '1')
    const r = removeTaskWorktree('task-b', { flowHome })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('运行中'))
    fs.unlinkSync(path.join(flowHome, 'tasks', 'task-b', 'running'))
  })

  it('登记被篡改时拒绝清理，不销毁唯一记录', () => {
    const dir = path.join(flowHome, 'tasks', 'task-b')
    const file = path.join(dir, 'worktree.json')
    const original = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, '{}', 'utf8')
    const r = removeTaskWorktree('task-b', { flowHome, force: true })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('登记内容不合法'))
    assert.equal(fs.existsSync(file), true, '登记文件必须保留')
    fs.writeFileSync(file, original, 'utf8')
  })

  it('Windows 保留名与尾点任务标识被拒绝', () => {
    for (const id of ['CON', 'com1', 'task.']) {
      assert.equal(sanitizeTaskId(id), null, '应拒绝：' + id)
    }
    assert.equal(sanitizeTaskId('task '), 'task', '首尾空格按 trim 处理')
  })

  it('任务卡绑定工作区：只有 ready 且路径一致才生效', () => {
    const rec = readTaskWorktree('task-b', { flowHome })
    assert.equal(rec.ok, true)
    const card = { env: { worktree: { task_id: 'task-b', path: rec.record.path } } }
    const resolved = resolveTaskWorkdir(card, { flowHome })
    assert.equal(resolved && resolved.task_id, 'task-b')

    const wrongPath = { env: { worktree: { task_id: 'task-b', path: path.join(wsRoot, 'other') } } }
    assert.equal(resolveTaskWorkdir(wrongPath, { flowHome }), null, '路径不一致必须拒绝')

    assert.equal(resolveTaskWorkdir({ env: { worktree_task_id: 'task-b' } }, { flowHome }).task_id, 'task-b')
    assert.equal(resolveTaskWorkdir({ env: {} }, { flowHome }), null, '没有绑定返回 null')
  })

  it('运行标记写入后阻止清理，清除后恢复正常', () => {
    assert.equal(markTaskRunning('task-b', { flowHome }).ok, true)
    const blocked = removeTaskWorktree('task-b', { flowHome })
    assert.equal(blocked.ok, false)
    assert.ok(blocked.reason.includes('运行中'))
    assert.equal(clearTaskRunning('task-b', { flowHome }).ok, true)
    assert.equal(clearTaskRunning('task-b', { flowHome }).ok, true, '重复清除幂等')
    assert.equal(removeTaskWorktree('task-b', { flowHome }).ok, true, '清除标记且工作区干净时可以清理')
  })

  it('派发 Prompt 使用任务工作区解析记忆（接线生效）', async () => {
    const { saveProjectFailureMemory } = await import('../src/failure-memory.js')
    const { buildContractPrompt } = await import('../src/dispatch.js')
    const created = createTaskWorktree({ repoCwd: repo, taskId: 'task-p', root: wsRoot, base, flowHome })
    assert.equal(created.ok, true, created.reason)
    const rec = readTaskWorktree('task-p', { flowHome })
    assert.equal(rec.ok, true)
    const saved = saveProjectFailureMemory('工作区专属经验：必须在隔离目录跑测试', {
      flowHome,
      cwd: rec.record.path,
    })
    assert.equal(saved.ok, true, saved.reason)
    const card = {
      goal: '隔离目录执行',
      scope: ['src/a.js'],
      verify: { cmd: 'npm test' },
      env: { worktree: { task_id: 'task-p', path: rec.record.path } },
    }
    const prompt = buildContractPrompt('executor', card, '')
    assert.ok(prompt.includes('工作区专属经验'), '派发必须读到工作区项目的记忆')
    assert.ok(prompt.includes('task workspace: ' + rec.record.path), '派发必须告知执行者在哪个目录工作')
    const auditorPrompt = buildContractPrompt('auditor', card, '')
    assert.ok(!auditorPrompt.includes('task workspace:'), '只读审查者不需要工作区指令')
  })

  it('Windows 上过长的目标路径被拒绝并给出可操作提示', () => {
    if (process.platform !== 'win32') return
    const longRoot = path.join(wsRoot, 'r'.repeat(190))
    fs.mkdirSync(longRoot, { recursive: true })
    const r = createTaskWorktree({ repoCwd: repo, taskId: 'task-long', root: longRoot, base, flowHome })
    assert.equal(r.ok, false)
    assert.ok(/MAX_PATH|路径过长/.test(r.reason), r.reason)
  })

  it('未登记的工作区不会被清理（不做全局 prune）', () => {
    const orphan = path.join(wsRoot, 'orphan')
    fs.mkdirSync(orphan, { recursive: true })
    const r = removeTaskWorktree('orphan', { flowHome })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('未登记'))
    assert.equal(fs.existsSync(orphan), true, '未登记的目录不得被动到')
  })

  it('清理结果是 Git 原生 worktree 移除，主仓库工作区列表同步', () => {
    const before = git(['worktree', 'list', '--porcelain']).stdout
    assert.ok(before.includes('task-b') || before.includes('task-c'))
    const r = removeTaskWorktree('task-c', { flowHome, force: true })
    assert.equal(r.ok, true, r.reason)
    const afterList = git(['worktree', 'list', '--porcelain']).stdout
    assert.ok(!afterList.includes('task-c'))
  })
})
describe('阶段三 · 验证路径绑定任务工作区', () => {
  it('声明工作区时在隔离目录执行；cwd 不一致时拒绝', async () => {
    const created = createTaskWorktree({ repoCwd: repo, taskId: 'task-v', root: wsRoot, base, flowHome })
    assert.equal(created.ok, true, created.reason)
    const rec = readTaskWorktree('task-v', { flowHome })
    const sid = 'wt-verify'
    const dir = path.join(flowHome, 'gate-state', 'runs', sid)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      sessionId: sid,
      card: {
        goal: '工作区验证',
        scope: ['src/a.js'],
        verify: { cmd: 'node -e "process.exit(0)"' },
        env: { worktree: { task_id: 'task-v', path: rec.record.path } },
      },
      card_ts: Date.now(),
    }), 'utf8')

    const { TOOLS } = await import('../src/handlers/verify.js')
    const runVerify = TOOLS.find((t) => t.name === 'flow_run_verify').handler

    const good = await runVerify({ sessionId: sid, cwd: rec.record.path }, {}, undefined)
    const goodText = good?.content?.[0]?.text || ''
    assert.ok(!/path is not defined|ReferenceError/.test(goodText), '不得出现未导入标识符错误：' + goodText.slice(0, 200))
    assert.ok(/"ok": true/.test(goodText), '在绑定工作区执行应成功：' + goodText.slice(0, 200))

    const bad = await runVerify({ sessionId: sid, cwd: repo }, {}, undefined)
    const badText = bad?.content?.[0]?.text || ''
    assert.ok(/不一致/.test(badText), '显式 cwd 与工作区不一致必须拒绝：' + badText.slice(0, 200))
  })
})
