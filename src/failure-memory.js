/**
 * 项目隔离的避坑记忆（阶段二）
 *
 * 设计边界（与 docs/THREE_STAGE_PLAN.md 阶段二一致）：
 * - 存储根仍是 CARLOS_FLOW_HOME，不另建知识库；按项目分区存放。
 * - 项目身份取自 Git 共享目录（同项目 worktree 复用），非 Git 目录退化为真实路径。
 * - 旧全局 failure-memory.json 只读统计，不自动归入任何项目，也不参与注入。
 * - 只采集「明确的业务断言失败」，语法/缺模块/超时/未知 IO 一律不入库。
 * - 写入原子（tmp + fsync + rename），有去重、条数上限、字节上限与脱敏。
 * - 损坏文件可解释降级，不假装保存成功。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { redact } from './redact.js'

export { redact }

export const MAX_RULES = 40
export const MAX_TEXT = 500
export const MAX_FILE_BYTES = 64 * 1024
// 读侧硬上限：超过它才当“损坏/异常大”；预算内超限按降级+裁剪处理，给出自愈路径。
export const MAX_HARD_BYTES = 1024 * 1024
export const MAX_CANDIDATES = 60

const MEMORY_FILE = 'failure-memory.json'
const CANDIDATE_FILE = 'candidates.json'
const INDEX_FILE = 'index.json'

function nowIso() {
  return new Date().toISOString()
}

function asFlowHome(flowHome) {
  if (!flowHome) throw new Error('failure-memory: 缺少 FLOW_HOME')
  return path.resolve(flowHome)
}

function projectsRoot(flowHome) {
  return path.join(asFlowHome(flowHome), 'projects')
}

/** 去掉终端颜色，避免把 ANSI 控制符写进记忆文件。 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

function clip(text, max = MAX_TEXT) {
  const s = String(text == null ? '' : text).trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const body = JSON.stringify(value, null, 2)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, body, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
  // rename 后尽力刷目录项；失败不影响已成功的 rename，但不能因此谎报未写。
  try {
    const dfd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
  } catch {}
}

// 读路径也做上限：被外部放大的文件不整份读入内存。
function readJson(file, maxBytes = MAX_FILE_BYTES) {
  let raw
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) return { ok: false, reason: `文件超过上限（${st.size} > ${maxBytes} 字节）` }
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, missing: true, value: null }
    return { ok: false, reason: `读取失败：${e && e.code ? e.code : 'UNKNOWN'}` }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, reason: 'JSON 解析失败（文件损坏）' }
  }
}

// 读-改-写必须互斥，否则两个进程各自基于旧快照 rename，后写者会丢掉前者的记录。
const LOCK_STALE_MS = 10000
const LOCK_WAIT_MS = 5000
function withFileLock(file, fn) {
  const lock = `${file}.lock`
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true })
  } catch (e) {
    return { ok: false, reason: `锁目录不可写：${e && e.code ? e.code : 'UNKNOWN'}` }
  }
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx')
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, reason: `锁获取失败：${e && e.code ? e.code : 'UNKNOWN'}` }
      // 持有者崩溃留下的陈旧锁必须能回收，否则写入永久卡死。
      try {
        const st = fs.statSync(lock)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock)
          continue
        }
      } catch {}
      if (Date.now() > deadline) return { ok: false, reason: '写入锁等待超时' }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    fs.writeSync(fd, token)
    const ret = fn()
    // 临界区必须是同步的：异步 fn 会在 finally 解锁后继续写，等于没锁。
    if (ret && typeof ret.then === 'function') throw new Error('withFileLock 只支持同步临界区')
    return ret
  } finally {
    try { fs.closeSync(fd) } catch {}
    // 只删自己持有的锁：临界区超时被他人回收后，不能再删别人的锁。
    try {
      if (fs.readFileSync(lock, 'utf8').trim() === token) fs.unlinkSync(lock)
    } catch {}
  }
}

/**
 * 解析项目身份。
 * Git 仓库用 --git-common-dir：同一仓库的多个 worktree 共享同一身份；
 * 非 Git 目录退化为真实路径，保证不同目录不会互相串记忆。
 */
export function resolveProjectIdentity(cwd, options = {}) {
  const base = path.resolve(cwd || options.cwd || process.cwd())
  let commonDir = null
  try {
    // 不继承 GIT_DIR/GIT_WORK_TREE：否则任意 cwd 都会被解析到同一个仓库，
    // 把不同项目合并成一个记忆分区。
    const env = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    delete env.GIT_OBJECT_DIRECTORY
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: base,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env,
    })
    if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
      commonDir = path.resolve(base, r.stdout.trim())
    }
  } catch {
    commonDir = null
  }
  let root
  if (commonDir) {
    try {
      root = fs.realpathSync(commonDir)
    } catch {
      root = commonDir
    }
  } else {
    try {
      root = fs.realpathSync(base)
    } catch {
      root = base
    }
  }
  const kind = commonDir ? 'git-common-dir' : 'directory'
  // Windows 路径大小写不敏感：身份键按小写归一，避免同一项目分裂成两个分区。
  const key = createHash('sha256')
    .update(kind + '\0' + (process.platform === 'win32' ? root.toLowerCase() : root))
    .digest('hex')
    .slice(0, 16)
  const name = commonDir ? path.basename(path.dirname(root)) : path.basename(root)
  return { key, kind, root, name }
}

function projectDir(flowHome, identity) {
  return path.join(projectsRoot(flowHome), identity.key)
}

function memoryPath(flowHome, identity) {
  return path.join(projectDir(flowHome, identity), MEMORY_FILE)
}

function candidatePath(flowHome, identity) {
  return path.join(projectDir(flowHome, identity), CANDIDATE_FILE)
}

function registerProject(flowHome, identity) {
  const file = path.join(projectsRoot(flowHome), INDEX_FILE)
  const locked = withFileLock(file, () => {
    const read = readJson(file, MAX_FILE_BYTES)
    let index
    if (!read.ok) {
      // 索引损坏不静默清空：先改名保留证据，再重建。
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      index = {}
    } else {
      index = read.value && typeof read.value === 'object' && !Array.isArray(read.value) ? read.value : {}
    }
    index[identity.key] = {
      name: identity.name,
      kind: identity.kind,
      root: redact(identity.root),
      updated_at: nowIso(),
    }
    try {
      atomicWriteJson(file, index)
    } catch (e) {
      return { ok: false, reason: `索引写入失败：${e && e.code ? e.code : 'UNKNOWN'}` }
    }
    return { ok: true }
  })
  return locked
}

function normalizeRuleText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function legacyCount(flowHome) {
  const legacy = path.join(asFlowHome(flowHome), MEMORY_FILE)
  const read = readJson(legacy)
  if (!read.ok || !read.value || !Array.isArray(read.value.rules)) return 0
  return read.value.rules.length
}

function sanitizeRules(rules) {
  const out = []
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r !== 'object') continue
    const text = clip(redact(r.text))
    if (!text) continue
    out.push({
      text,
      tag: clip(redact(r.tag || 'general'), 40),
      source: clip(redact(r.source || 'unknown'), 40),
      added_at: typeof r.added_at === 'string' ? r.added_at : nowIso(),
    })
  }
  return out
}

function enforceBudget(rules, projectKey) {
  let list = rules.slice(-MAX_RULES)
  // 必须按**真正落盘的序列化形式**计预算：
  // 之前用紧凑 JSON 估算，pretty JSON + project 字段会超 64KB，
  // 导致写完自己读不回来（不可自愈）。字节数只保留提前 1KB 余量。
  const size = (arr) => Buffer.byteLength(JSON.stringify({ project: projectKey, rules: arr }, null, 2), 'utf8')
  let dropped = rules.length - list.length
  while (list.length > 1 && size(list) > MAX_FILE_BYTES - 1024) {
    list = list.slice(1)
    dropped++
  }
  return { list, dropped }
}

/**
 * 读取项目记忆。
 * 返回值永远带 project 与 degraded 标记，调用方不能把 degraded 当成“没有经验”。
 */
export function loadProjectFailureMemory(options = {}) {
  const flowHome = options.flowHome
  const identity = resolveProjectIdentity(options.cwd, options)
  // 硬上限只用来挡“异常大的文件”；预算内超限不直接判损坏，而是裁剪并提示。
  const read = readJson(memoryPath(flowHome, identity), MAX_HARD_BYTES)
  const result = {
    project: { key: identity.key, name: identity.name, kind: identity.kind },
    rules: [],
    degraded: false,
    degraded_reason: null,
    trimmed: false,
    // 旧全局记忆只做可见性统计：不归入任何项目，也不注入。
    legacy: { count: legacyCount(flowHome), ignored: true },
  }
  if (!read.ok) {
    result.degraded = true
    result.degraded_reason = read.reason
    return result
  }
  if (read.missing) return result
  const value = read.value
  if (!value || typeof value !== 'object' || !Array.isArray(value.rules)) {
    result.degraded = true
    result.degraded_reason = '文件结构不符合预期（缺少 rules 数组）'
    return result
  }
  const sanitized = sanitizeRules(value.rules)
  const { list, dropped } = enforceBudget(sanitized, identity.key)
  result.rules = list
  if (dropped > 0) {
    result.trimmed = true
    result.degraded = true
    result.degraded_reason = `超出预算，已裁剪 ${dropped} 条；下次写入会落盘为裁剪后的内容`
  }
  return result
}

/**
 * 保存一条经验。
 * 返回 ok=false 时表示**没有保存成功**，调用方不得报告成功。
 */
export function saveProjectFailureMemory(item, options = {}) {
  const flowHome = options.flowHome
  const identity = resolveProjectIdentity(options.cwd, options)
  const rawText = typeof item === 'string' ? item : item && item.rule
  const text = clip(redact(rawText))
  if (!text) return { ok: false, added: false, reason: '经验内容为空' }

  const file = memoryPath(flowHome, identity)
  // 无项目身份时不写任何东西：宁可丢经验，也不写进错误的项目分区。
  if (options.requireProject === true && !identity.kind) {
    return { ok: false, added: false, reason: '无法确定项目身份' }
  }
  return withFileLock(file, () => {
    // 读侧用硬上限：超出预算但未到硬上限的文件仍可读，随后按预算裁剪并重写。
    const read = readJson(file, MAX_HARD_BYTES)
    if (!read.ok) return { ok: false, added: false, reason: read.reason }
    if (!read.missing && (!read.value || typeof read.value !== 'object' || !Array.isArray(read.value.rules))) {
      return { ok: false, added: false, reason: '现有记忆文件结构不符合预期，拒绝覆盖' }
    }
    const rules = sanitizeRules(read.missing ? [] : read.value.rules)
    const key = normalizeRuleText(text)
    if (rules.some((r) => normalizeRuleText(r.text) === key)) {
      return { ok: true, added: false, deduped: true, count: rules.length }
    }
    rules.push({
      text,
      tag: clip(redact((item && item.tag) || 'general'), 40),
      source: clip(redact((item && item.source) || 'manual'), 40),
      added_at: nowIso(),
    })
    const { list: next, dropped } = enforceBudget(rules, identity.key)
    try {
      atomicWriteJson(file, { project: identity.key, rules: next })
    } catch (e) {
      return { ok: false, added: false, reason: `写入失败：${e && e.code ? e.code : 'UNKNOWN'}` }
    }
    // 先写项目数据、再登记索引：索引写失败不影响数据，也不会谎报项目已存在。
    const indexRegister = registerProject(flowHome, identity)
    return {
      ok: true,
      added: true,
      count: next.length,
      dropped,
      index_warning: indexRegister && indexRegister.ok === false ? indexRegister.reason : null,
    }
  })
}

/**
 * 把验证输出分类。
 * 只有 assertion 才是可入库的业务失败；其余一律不入库。
 */
export function classifyVerifyFailure(result = {}) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const code = result.exitCode
  if (result.timedOut === true || /ETIMEDOUT|timed out|超时/i.test(text)) return 'timeout'
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND|SyntaxError|EACCES|EPERM|ENOENT|ECONNREFUSED|ECONNRESET|EADDRINUSE|spawn .* ENOENT/i.test(text)) return 'infra'
  // 只有真正的断言失败才算业务失败：
  // 裸 `not ok N` / `✗` 是测试运行器标记，网络或运行时错误也会带它们，不能单凭它们入库。
  if (/AssertionError|Assertion failed|\bassert\.\w|expected\s+.+\s+to\s+(be|equal|deepEqual|include|match)/i.test(text)) return 'assertion'
  if (/\bnot ok \d+/i.test(text) && /✗/.test(text)) return 'runner-failure'
  if (typeof code === 'number' && code > 0) return 'unknown'
  return 'none'
}

function firstAssertionLine(result = {}) {
  const text = stripAnsi(`${result.stderr || ''}\n${result.stdout || ''}`)
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // 不做“匹配不到就取第一行”的兜底：宁可采集不到，也不把无关输出当断言事实。
  return (
    lines.find((l) => /AssertionError|Assertion failed|\bassert\.\w|expected\s+.+\s+to\s+(be|equal|deepEqual|include|match)/i.test(l)) || ''
  )
}

/**
 * 采集一次验证失败事实（进入待核实候选，不直接成为注入规则）。
 */
export function collectVerifyFailure(result, options = {}) {
  const kind = classifyVerifyFailure(result)
  if (kind !== 'assertion') return { collected: false, kind }
  const flowHome = options.flowHome
  const identity = resolveProjectIdentity(options.cwd, options)
  const text = clip(redact(firstAssertionLine(result)), 300)
  if (!text) return { collected: false, kind, reason: '无法提取断言事实' }

  const file = candidatePath(flowHome, identity)
  return withFileLock(file, () => {
    const read = readJson(file, MAX_HARD_BYTES)
    // 候选文件损坏时不静默当空数组覆盖：宁可本次不采集，也不丢已有候选。
    if (!read.ok) return { collected: false, kind, reason: read.reason }
    if (!read.missing && (!read.value || typeof read.value !== 'object' || !Array.isArray(read.value.candidates))) {
      return { collected: false, kind, reason: '候选文件结构不符合预期，拒绝覆盖' }
    }
    const list = (read.missing ? [] : read.value.candidates).slice(-MAX_CANDIDATES)
    const normalized = normalizeRuleText(text)
    const existing = list.find((c) => normalizeRuleText(c.text) === normalized)
    if (existing) return { collected: false, kind, deduped: true, id: existing.id }

    const entry = {
      id: createHash('sha256').update(normalized + '\0' + nowIso()).digest('hex').slice(0, 12),
      text,
      kind,
      cmd: clip(redact(options.cmd || ''), 200),
      exit_code: Number.isInteger(result.exitCode) ? result.exitCode : null,
      card_ts: options.cardTs == null ? null : options.cardTs,
      session_id: clip(redact(options.sessionId || 'unknown'), 80),
      added_at: nowIso(),
      confirmed: false,
    }
    const next = list.concat(entry).slice(-MAX_CANDIDATES)
    try {
      atomicWriteJson(file, { project: identity.key, candidates: next })
    } catch (e) {
      return { collected: false, kind, reason: `写入失败：${e && e.code ? e.code : 'UNKNOWN'}` }
    }
    registerProject(flowHome, identity)
    return { collected: true, kind, id: entry.id }
  })
}

export function listCandidates(options = {}) {
  const identity = resolveProjectIdentity(options.cwd, options)
  const read = readJson(candidatePath(options.flowHome, identity), MAX_HARD_BYTES)
  if (!read.ok) return { ok: false, reason: read.reason, project: identity.key, candidates: [] }
  if (!read.missing && (!read.value || typeof read.value !== 'object' || !Array.isArray(read.value.candidates))) {
    return { ok: false, reason: '候选文件结构不符合预期', project: identity.key, candidates: [] }
  }
  const list = (read.missing ? [] : read.value.candidates).slice(-MAX_CANDIDATES)
  return { ok: true, project: identity.key, candidates: list }
}

/**
 * 核实后转正：候选 → 项目规则。只有被独立核实过的经验才会进入注入。
 */
export function confirmFailureExperience(id, options = {}) {
  const flowHome = options.flowHome
  const identity = resolveProjectIdentity(options.cwd, options)
  const file = candidatePath(flowHome, identity)
  const read = readJson(file, MAX_HARD_BYTES)
  if (!read.ok) return { ok: false, reason: read.reason }
  const list = read.missing ? [] : (read.value && Array.isArray(read.value.candidates) ? read.value.candidates : null)
  if (list === null) return { ok: false, reason: '候选文件结构不符合预期，拒绝覆盖' }
  const hit = list.find((c) => c.id === id)
  if (!hit) return { ok: false, reason: '未找到该候选记录' }
  const saved = saveProjectFailureMemory(
    { rule: hit.text, tag: hit.kind, source: `verified:${clip(redact(options.note || ''), 60) || 'audit'}` },
    { flowHome, cwd: options.cwd },
  )
  if (!saved.ok) return saved
  const updated = withFileLock(file, () => {
    const again = readJson(file, MAX_HARD_BYTES)
    if (!again.ok || again.missing || !Array.isArray(again.value?.candidates)) {
      return { ok: false, reason: again.ok ? '候选文件在核实期间消失或变形，状态未更新' : again.reason }
    }
    const next = again.value.candidates.map((c) => (c.id === id ? { ...c, confirmed: true, confirmed_at: nowIso() } : c))
    try {
      atomicWriteJson(file, { project: identity.key, candidates: next })
    } catch (e) {
      return { ok: false, reason: `规则已写入但候选状态更新失败：${e && e.code ? e.code : 'UNKNOWN'}` }
    }
    return { ok: true }
  })
  if (!updated.ok) return { ok: false, added: saved.added, reason: updated.reason }
  return { ok: true, added: saved.added, deduped: !!saved.deduped, count: saved.count }
}

/** 供派发 Prompt 注入的摘要：只取本项目最近 3 条。 */
/** 供派发 Prompt 注入的摘要：只取本项目最近 3 条；降级时返回空并带原因。 */
export function projectLessons(options = {}) {
  const mem = loadProjectFailureMemory(options)
  return { rules: mem.rules.slice(-3).map((r) => r.text), degraded: mem.degraded, degraded_reason: mem.degraded_reason }
}