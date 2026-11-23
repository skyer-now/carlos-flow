/**
 * 单人任务 Git Worktree 隔离（阶段三）
 *
 * 目标：每个任务在独立工作区执行，测试、快照与报告都绑定该工作区，
 * 不回到主目录；异常或有未交付改动时保留工作区，清理必须可控可核验。
 *
 * 边界（与 docs/THREE_STAGE_PLAN.md 阶段三一致）：
 * - 基线必须是明确提交；主工作区脏且未显式给基线时拒绝隐式迁移；
 * - 任务标识与路径做白名单校验，拒绝越界与符号链接逃逸；
 * - 只清理本工具登记过的工作区，用 Git 原生 `worktree remove`，不做全局 prune；
 * - 登记失败或创建中断留下可恢复的登记文件，不静默当作成功。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

function runGit(args, cwd) {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, env })
  return {
    ok: r && r.status === 0,
    status: r ? r.status : null,
    stdout: r && typeof r.stdout === 'string' ? r.stdout : '',
    stderr: r && typeof r.stderr === 'string' ? r.stderr : '',
  }
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

export function sanitizeTaskId(taskId) {
  const s = String(taskId == null ? '' : taskId).trim()
  if (!TASK_ID_RE.test(s) || s.includes('..')) return null
  // Windows 上尾点/尾空格会与无尾点名字落到同一目录；保留设备名同样不可用。
  if (/[. ]$/.test(s)) return null
  if (WINDOWS_RESERVED.test(s.split('.')[0])) return null
  return s
}

function taskDir(flowHome, taskId) {
  return path.join(path.resolve(flowHome), 'tasks', taskId)
}

function registrationPath(flowHome, taskId) {
  return path.join(taskDir(flowHome, taskId), 'worktree.json')
}

export function readTaskWorktree(taskId, options = {}) {
  const id = sanitizeTaskId(taskId)
  if (!id) return { ok: false, reason: '任务标识不合法' }
  let value
  try {
    const raw = fs.readFileSync(registrationPath(options.flowHome, id), 'utf8')
    value = JSON.parse(raw)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: '未登记该任务工作区' }
    return { ok: false, reason: '登记文件读取失败或损坏' }
  }
  // 登记被手改/写坏时必须拒绝，不能拿 undefined 路径继续走删除流程。
  const bad = (why) => ({ ok: false, reason: '登记内容不合法：' + why })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('不是对象')
  if (value.task_id !== id) return bad('task_id 与登记目录不一致')
  for (const key of ['repo_root', 'path', 'base_commit', 'root']) {
    if (typeof value[key] !== 'string' || !value[key]) return bad('缺少 ' + key)
  }
  if (!path.isAbsolute(value.path) || !path.isAbsolute(value.repo_root) || !path.isAbsolute(value.root)) {
    return bad('路径不是绝对路径')
  }
  // 登记路径必须就是受控根下的这个任务目录，防止被改成别的仓库的 worktree。
  if (path.resolve(value.path) !== path.join(path.resolve(value.root), id)) return bad('path 不在受控根的对应任务目录下')
  return { ok: true, taskId: id, record: value }
}

export function listTaskWorktrees(options = {}) {
  const dir = path.join(path.resolve(options.flowHome), 'tasks')
  let ids = []
  try {
    ids = fs.readdirSync(dir)
  } catch {
    return []
  }
  return ids
    .map((id) => readTaskWorktree(id, options))
    .filter((r) => r.ok)
    .map((r) => r.record)
}

/**
 * 创建任务工作区。
 * @param {object} o
 * @param {string} o.repoCwd  主仓库目录（必须已在 Git 仓库内）
 * @param {string} o.taskId   任务标识（白名单）
 * @param {string} o.root     工作区根目录（绝对路径，必须存在）
 * @param {string} [o.base]   基线提交（缺省 HEAD，但主工作区脏时必须显式给出）
 * @param {string} o.flowHome 状态根（任务登记写在这里）
 */
export function createTaskWorktree(o = {}) {
  const id = sanitizeTaskId(o.taskId)
  if (!id) return { ok: false, reason: '任务标识不合法（只允许字母数字与 ._-，最长 40）' }
  if (!o.repoCwd || !o.root) return { ok: false, reason: '缺少 repoCwd 或 root' }
  if (!o.flowHome) return { ok: false, reason: '缺少 FLOW_HOME' }

  const repoCwd = path.resolve(o.repoCwd)
  const top = runGit(['rev-parse', '--show-toplevel'], repoCwd)
  if (!top.ok || !top.stdout.trim()) return { ok: false, reason: '目标目录不是 Git 仓库' }
  const repoRoot = realOrNull(top.stdout.trim()) || top.stdout.trim()

  const root = path.resolve(o.root)
  const rootReal = realOrNull(root)
  if (!rootReal || !fs.statSync(rootReal).isDirectory()) return { ok: false, reason: '工作区根目录不存在或不可用' }

  const target = path.join(rootReal, id)
  // lstat 不跟随链接：悬空符号链接也会被发现并拒绝，不能只靠 existsSync。
  try {
    fs.lstatSync(target)
    return { ok: false, reason: '目标工作区已存在（或存在同名链接），拒绝覆盖' }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, reason: '目标路径状态不可判定，拒绝创建' }
  }
  if (path.dirname(target) !== rootReal) return { ok: false, reason: '目标路径越出工作区根目录' }

  const dirty = runGit(['status', '--porcelain'], repoRoot)
  if (!dirty.ok) return { ok: false, reason: '无法读取主工作区状态' }
  const isDirty = dirty.stdout.trim().length > 0
  if (isDirty && !o.base) {
    return { ok: false, reason: '主工作区有未提交改动且未指定基线提交，拒绝隐式迁移' }
  }

  const baseRef = o.base || 'HEAD'
  const baseCommit = runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot)
  if (!baseCommit.ok || !baseCommit.stdout.trim()) return { ok: false, reason: `基线不是有效提交：${baseRef}` }
  const commit = baseCommit.stdout.trim()

  // 先登记再创建：创建中断时登记仍在，可据实恢复或清理，不会“凭空多出工作区”。
  const record = {
    task_id: id,
    repo_root: repoRoot,
    path: target,
    base_ref: baseRef,
    base_commit: commit,
    root: rootReal,
    created_at: new Date().toISOString(),
    status: 'creating',
  }
  try {
    fs.mkdirSync(taskDir(o.flowHome, id), { recursive: true })
    fs.writeFileSync(registrationPath(o.flowHome, id), JSON.stringify(record, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, reason: `登记写入失败：${e && e.code ? e.code : 'UNKNOWN'}` }
  }

  const add = runGit(['worktree', 'add', '--detach', target, commit], repoRoot)
  if (!add.ok) {
    // 可能已经建了一半（目录/元数据），保留登记并标记失败：清理路径仍能回收，
    // 删登记会让孤儿工作区永久无法用本工具清理。
    const failed = { ...record, status: 'failed', error: (add.stderr || '').trim().slice(0, 300) }
    try {
      fs.writeFileSync(registrationPath(o.flowHome, id), JSON.stringify(failed, null, 2), 'utf8')
    } catch {}
    return { ok: false, reason: `git worktree add 失败：${failed.error}`, record: failed }
  }

  const head = runGit(['rev-parse', 'HEAD'], target)
  if (!head.ok || head.stdout.trim() !== commit) {
    // 保留登记与工作区：这是“创建结果未知”，交给人工确认，不自动删。
    return { ok: false, reason: '工作区 HEAD 与基线不一致，已保留现场待人工确认', record: { ...record, status: 'mismatch' } }
  }

  record.status = 'ready'
  try {
    fs.writeFileSync(registrationPath(o.flowHome, id), JSON.stringify(record, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, reason: `登记更新失败：${e && e.code ? e.code : 'UNKNOWN'}`, record }
  }
  return { ok: true, record }
}

/**
 * 清理任务工作区：只清理本工具登记过的工作区。
 * - 有未提交/未跟踪改动默认拒绝（除非 force）；
 * - 有运行中标记（tasks/<id>/running）拒绝；
 * - 使用 Git 原生 worktree remove，不做全局 prune。
 */
export function removeTaskWorktree(taskId, options = {}) {
  const got = readTaskWorktree(taskId, options)
  if (!got.ok) return got
  const record = got.record
  const id = got.taskId
  // force 是人工确认过的强清，可以覆盖运行标记；否则运行中一律拒绝。
  if (options.force !== true && fs.existsSync(path.join(taskDir(options.flowHome, id), 'running'))) {
    return { ok: false, reason: '任务仍标记为运行中，拒绝清理' }
  }
  if (fs.existsSync(record.path)) {
    const status = runGit(['status', '--porcelain'], record.path)
    if (!status.ok) return { ok: false, reason: '无法读取工作区状态，拒绝清理' }
    if (status.stdout.trim() && options.force !== true) {
      return { ok: false, reason: '工作区有未提交或未跟踪改动，拒绝清理（确认后可 force）' }
    }
    const rm = runGit(['worktree', 'remove', ...(options.force === true ? ['--force'] : []), record.path], record.repo_root)
    if (!rm.ok) return { ok: false, reason: `git worktree remove 失败：${(rm.stderr || '').trim().slice(0, 300)}` }
  }
  if (fs.existsSync(record.path)) return { ok: false, reason: '工作区目录仍存在，清理未完成' }
  try {
    fs.rmSync(taskDir(options.flowHome, id), { recursive: true, force: true })
  } catch (e) {
    return { ok: false, reason: `登记清理失败：${e && e.code ? e.code : 'UNKNOWN'}` }
  }
  return { ok: true, taskId: id }
}

/** 任务工作区身份摘要：用于把验证/报告绑定到具体工作区。 */
export function worktreeIdentity(record = {}) {
  const text = `${record.task_id || ''}\0${record.path || ''}\0${record.base_commit || ''}`
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 解析任务卡绑定的工作区。
 * 只有“已登记、状态 ready、路径一致且真实存在”才返回记录，否则返回 null，
 * 让调用方回落到原有目录（不回落到登记文件里不可信的路径）。
 */
export function resolveTaskWorkdir(card, options = {}) {
  const ref = card && card.env ? card.env.worktree : null
  const taskId = (card && card.env && card.env.worktree_task_id) || (ref && typeof ref === 'object' ? ref.task_id : null)
  if (!taskId) return null
  const got = readTaskWorktree(taskId, options)
  if (!got.ok || got.record.status !== 'ready') return null
  if (!fs.existsSync(got.record.path)) return null
  if (ref && typeof ref === 'object' && ref.path && path.resolve(ref.path) !== path.resolve(got.record.path)) return null
  return got.record
}

/** 运行中标记：存在即拒绝清理。 */
export function markTaskRunning(taskId, options = {}) {
  const id = sanitizeTaskId(taskId)
  if (!id) return { ok: false, reason: '任务标识不合法' }
  try {
    const dir = taskDir(options.flowHome, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'running'), String(process.pid), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `运行标记写入失败：${e && e.code ? e.code : 'UNKNOWN'}` }
  }
}

export function clearTaskRunning(taskId, options = {}) {
  const id = sanitizeTaskId(taskId)
  if (!id) return { ok: false, reason: '任务标识不合法' }
  try {
    fs.unlinkSync(path.join(taskDir(options.flowHome, id), 'running'))
    return { ok: true }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, missing: true }
    return { ok: false, reason: `运行标记删除失败：${e && e.code ? e.code : 'UNKNOWN'}` }
  }
}
