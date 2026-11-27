// state.js — Carlos 工作流：持久化 / 审计 / quote 数据源（Node ESM，零外部依赖）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

// 目录 fsync 在部分平台不受支持（Darwin 常见 EINVAL），不能把它当成持久化失败：
// 文件已 rename 成功，这里只是“目录项耐久性尽力而为”。其它错误照旧上抛。
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])
function isUnsupportedDirSync(error) {
  return !!error && DIR_SYNC_UNSUPPORTED.has(error.code)
}
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

// 展开路径里的 `~`（家目录）。
// 背景：README 让用户把 CARLOS_FLOW_HOME 写成 `~/.carlos-flow`，但此前**没有展开** ——
// path.normalize("~/.carlos-flow") 只是把斜杠改成反斜杠，路径仍是**字面量**，
// 于是状态/审计链被写到「当前工作目录下的一个名叫 ~ 的目录」里（Windows 实测
// FLOW_HOME = ~\.carlos-flow），位置诡异、极易丢失。
// 现在统一展开：`~` → homedir，`~/x` 与 `~\x` → homedir/x。
export function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

// 审计链的「链起点」占位值：64 个 0。
// 全零 prevHash = 「这条记录开启一条新链」，是合法的链首标记，
// 不是「校验失败」的证据 —— 早期版本写入器跨天不回连时就是这么写的。
const ZERO_HASH = '0'.repeat(64)

export const FLOW_HOME = path.normalize(
  expandHome(process.env.CARLOS_FLOW_HOME) ||
    path.join(os.homedir(), '.carlos-flow'),
)
export const AUDIT_DIR = path.join(FLOW_HOME, 'gate-audit')
export const RUNS_DIR = path.join(FLOW_HOME, 'gate-state', 'runs')

// OpenCode 会话库路径：环境变量优先，回落到跨平台默认
// OPENCODE_DB_PATH / OPENCODE_DB 与插件侧同一套约定
// ~ 路径同样需要展开（Windows PowerShell 下 CARLOS_OPENCODE_DB=~/.opencode 会字面写入）
const OPENCODE_DB = path.normalize(
  expandHome(process.env.OPENCODE_DB_PATH) ||
    expandHome(process.env.OPENCODE_DB) ||
    expandHome(process.env.CARLOS_OPENCODE_DB) ||
    path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
)

// OpenCode 会话库的**候选路径**（按平台习惯不同，取第一个存在的）。
// 背景：原先只写死 XDG 路径 ~/.local/share/opencode/opencode.db —— 那是 Linux 的约定。
// macOS 上 OpenCode 实际落在 ~/Library/Application Support/opencode/，
// Windows 上落在 %APPDATA%\opencode\ —— 只探 XDG 路径的话，
// macOS/Windows 用户会**永远拿不到用户原话**，导致 quote 锚点校验直接失败、卡片无法提交。
// 环境变量优先（显式指定时不做任何猜测）。
const OPENCODE_DB_CANDIDATES = (() => {
  const envPath =
    process.env.OPENCODE_DB_PATH ||
    process.env.OPENCODE_DB ||
    process.env.CARLOS_OPENCODE_DB
  if (envPath) return [path.normalize(envPath)]
  const home = os.homedir()
  const rel = ['opencode', 'opencode.db']
  const candidates = []
  // XDG 约定（Linux，以及部分 macOS 配置）
  candidates.push(path.join(home, '.local', 'share', ...rel))
  // macOS 原生
  candidates.push(path.join(home, 'Library', 'Application Support', ...rel))
  // Windows（APPDATA）
  const appData = process.env.APPDATA
  if (appData) candidates.push(path.join(appData, ...rel))
  // Windows（无 APPDATA 时的兜底）
  candidates.push(path.join(home, 'AppData', 'Roaming', ...rel))
  // 去重（保持顺序）
  return [...new Set(candidates.map((p) => path.normalize(p)))]
})()

// 选出第一个真实存在的候选；都不存在则返回 null（不抛错，降级为“无历史消息”）。
function resolveOpenCodeDb() {
  for (const p of OPENCODE_DB_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

function localDate() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function sanitizeId(s) {
  const v = String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_')
  if (v === '') return 'unknown'
  // 路径穿越防护：拒绝包含 .. 的 ID
  if (v.includes('..')) {
    throw new Error(`invalid session id (path traversal detected): ${s}`)
  }
  return v
}

// 当前状态文件结构版本号。
// 改动 defaultState() 的**字段结构**时，必须 +1 并在 migrate() 里加一条迁移。
export const CURRENT_SCHEMA_VERSION = 5

/**
 * 迁移旧版本的状态文件。
 *
 * 逐版本迁移，每一步都只处理「从 vN 到 vN+1」的差异，
 * 保证任何历史版本都能一路迁到当前版本（不跳步）。
 *
 * v0 → v1：最早的版本没有 schemaVersion 字段（等于 v0）。
 *   · 补上 schemaVersion
 *   · dispatch_baseline 早期不存在 → 补空数组（无基线时裁定走全量判定，更保守）
 *
 * v1 → v2：新增 last_falsify（负对照记录）。
 *   · 旧状态没有这个字段 → 补 null（表示「还没做负对照」，裁定会拒绝 PASS）
 *
 * v2 → v3：新增 audit_axes / audit_axes_ts（双轴审查证据）。
 *   · 旧状态没有这两个字段 → 补默认结构（两轴均为 null = 尚未审查，裁定会拒绝 PASS）
 *   · audit_axes 存在但结构不全时也在此补齐，避免读到半初始化对象
 *
 * v3 → v4：新增 verdict_role（本条 PASS 是谁落的）。
 *   · 旧状态没有这个字段 → 补 null（仅影响可观测性，不影响门禁判定）
 *
 * v4 → v5：新增 advisory / advisory_log（调研与方案的轻量互审）。
 *   · 两者都是可选能力，旧状态补 null / [] 即可；不影响 T2 的卡、双轴与裁定。
 */
export function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed
  let v = Number(parsed.schemaVersion)
  if (!Number.isInteger(v) || v < 0) v = 0 // 无版本号 → 当作 v0
  const out = { ...parsed }

  if (v < 1) {
    // v0 → v1
    if (!Array.isArray(out.dispatch_baseline)) out.dispatch_baseline = []
    if (!Array.isArray(out.activation_pending)) out.activation_pending = []
    if (typeof out.activation_activated !== 'boolean')
      out.activation_activated = false
    v = 1
  }

  if (v < 2) {
    // v1 → v2
    if (out.last_falsify === undefined) out.last_falsify = null
    v = 2
  }

  if (v < 3) {
    // v2 → v3
    if (!out.audit_axes || typeof out.audit_axes !== 'object') {
      out.audit_axes = { standards: null, spec: null }
    } else {
      out.audit_axes = {
        standards: out.audit_axes.standards || null,
        spec: out.audit_axes.spec || null,
      }
    }
    if (typeof out.audit_axes_ts !== 'number') out.audit_axes_ts = 0
    v = 3
  }

  if (v < 4) {
    // v3 → v4
    if (out.verdict_role === undefined) out.verdict_role = null
    v = 4
  }

  if (v < 5) {
    // v4 → v5
    if (out.advisory === undefined) out.advisory = null
    if (!Array.isArray(out.advisory_log)) out.advisory_log = []
    v = 5
  }

  out.schemaVersion = CURRENT_SCHEMA_VERSION
  return out
}

export function defaultState() {
  return {
    mode: 'pro',
    mode_ts: 0,
    claimed_profile: null,
    // 状态文件结构版本号。
    // 为什么需要：早先靠 {...defaultState(), ...parsed} 做防御性合并，
    // 但**没有版本号** —— 将来改字段名（如 bypass_ts → bypass_at）时，
    // 老用户的 state.json 里那个旧字段会被当成「未知字段」静默丢弃，
    // 表现为「免检没清零」「待补项丢失」这类**很难定位**的退化。
    // 加了版本号 + migrate()，旧状态会被**显式迁移**而不是静默降级。
    schemaVersion: CURRENT_SCHEMA_VERSION,
    card: null,
    card_ts: 0,
    tier: 'read_only',
    task_id: null,
    dispatch_count: 0,
    claimed: false,
    claimed_role: null,
    write_files: 0,
    last_user_ts: 0,
    bypass: false,
    bypass_ts: 0,
    verdict: null,
    completed_ok: false,
    stale: false,
    // 智能触发引擎激活占位卡时尚待补齐的字段。
    // 非空时 flow_claim / flow_dispatch 会拒绝派发，防止空卡片被直接派发。
    activation_pending: [],
    // 该会话是否曾被智能触发引擎激活过（单调，只增不减）。
    // 闸门状态由「卡片内容 + 此标记」幂等派生，不再依赖上一轮的 pending 传递，
    // 这样跨进程并发写入也不会出现「卡片为空却 pending=[]」的矛盾组合。
    activation_activated: false,
    // 派发时记录的工作区改动基线（文件路径数组）。
    // 用途：裁定前用「当前改动 - 基线」算出**本次执行引入的**改动，
    // 再与卡片 scope 比对 —— 这样既能拦住越界，又不会把用户自己原有的
    // 未提交改动误判为越界。没有基线时退化为全量判定（更保守，fail-closed）。
    dispatch_baseline: [],
    // 负对照记录（flow_falsify 写入）。
    // 为什么需要：只看 exitCode===0 时，`verify.cmd` 可以是 `|| true` / `echo ok`
    // 这类**空测试** —— 改动前后都退 0，门禁却以为「验证通过了」。
    // 负对照要求：改动前必须失败、改动后必须通过，才证明这个测试真的在测本次改动。
    // null = 还没做负对照（此时 flow_verdict 拒绝 PASS）。
    last_falsify: null,
    // 双轴审查证据（flow_audit_submit 写入）。
    // 结构：{ standards: {verdict,findings,evidence,card_ts,ts} | null, spec: {...} | null }
    //
    // 为什么按轴绑定 card_ts，而不是只用一个全局时间戳：
    // 两轴是**分两次**提交的。卡A提交 standards → 换新卡B → 只补 spec，
    // 此时全局时间戳已被刷新到卡B之后，单看时间戳会放行，而 standards
    // 仍是卡A的结论 —— 「两轴跨卡拼接」。绑定 card_ts 后，换卡即两轴全失效。
    audit_axes: { standards: null, spec: null },
    // 两轴最后提交时间（审计链留痕用；不参与冒充校验，校验看 card_ts）。
    audit_axes_ts: 0,
    // 本条裁定是谁落的（"auditor" | "executor" | null）。
    // 与 claimed_role 的区别：claimed_role 是「会话最近 claim 的角色」（可能已过期），
    // verdict_role 是「实际写下这条裁定时传进来的 role」，直接回答「这条 PASS 是谁落的」。
    // 审计流水里也有 role，但那是日志；这是状态层的持久记录，可用 flow_status 直接查。
    verdict_role: null,
    // 调研/方案的轻量互审（v5）。结构与 T2 的双轴完全独立：
    // 它不参与 flow_verdict 的 PASS 门禁，只服务于“回答前的交付检查”。
    // 记录形状：互审编号、强度（single/dual）、问题原文与主题哈希、创建与过期时间、
    // 两轴结论（evidence / feasibility，初始为空）、以及交付方声明清单（文本、状态、证据引用）。
    // 未创建互审时为 null。
    advisory: null,
    // 判定日志（有界，最多保留 50 条）：用于冷却与预算，不参与门禁。
    advisory_log: [],
  }
}

// 同步退避：只用于 loadState 的**极短**重试（10~50ms，且是罕见的竞争窗口）。
// 它会短暂阻塞事件循环，所以绝不能拿去做锁等待 —— 见下面的 sleepAsync。
const sleepMs = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* SharedArrayBuffer 不可用时退化为自旋 */
  }
}

export function loadState(sid) {
  const file = path.join(RUNS_DIR, sanitizeId(sid), 'state.json')

  // 读失败必须区分「真的没有」与「暂时读不到」。
  //
  // 背景（2026-11-13 实测）：旧实现把**任何**读/解析失败都当成「状态不存在」，
  // 返回 defaultState()。而 saveState 用的是 tmp+rename，
  // 在 Windows 上 rename 与其他进程的 readFileSync 存在竞争窗口（EBUSY/EPERM），
  // 读失败 → prev 退化成默认值 → activation_activated 丢成 false →
  // 紧接着的写入把「占位卡的 pending=[三项]」覆盖成「普通卡的 pending=[]」
  // → **激活闸门被绕过**。
  // 这正是并发测试「零泄漏」偶发失败的根因（实测 370 轮里漏 1）。
  //
  // 现在：只有「文件不存在」才返回默认值；
  // 瞬时错误先重试；仍失败则**报错**（fail-closed），
  // 绝不静默把一个有闸门的状态当成无闸门的状态。
  let raw = null
  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      raw = fs.readFileSync(file, 'utf8')
      lastErr = null
      break
    } catch (e) {
      if (e.code === 'ENOENT') return defaultState() // 真的没有
      lastErr = e
      sleepMs(10 * (attempt + 1)) // 瞬时竞争窗口，退避重试
    }
  }
  if (lastErr) {
    throw new Error(
      '读取状态失败（' +
        (lastErr.code || lastErr.message) +
        '）：' +
        file +
        '。为避免丢掉门禁状态，本次操作已中止，请稍后重试。',
    )
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      '状态文件损坏，无法解析：' +
        file +
        '（' +
        e.message +
        '）。' +
        '为避免丢掉门禁状态，本次操作已中止；如确认可丢弃该会话状态，可删除该文件后重试。',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return defaultState()
  return {
    mode: 'pro',
    mode_ts: 0,
    claimed_profile: null,
    ...defaultState(),
    ...migrate(parsed),
  }
}

export function saveState(sid, state) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid))
  const tmp = path.join(dir, `state.json.tmp-${process.pid}-${randomBytes(12).toString('hex')}`)
  const target = path.join(dir, 'state.json')
  let fd
  let phase = 'mkdir'
  let renamed = false
  const errors = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    phase = 'encode'
    const bytes = Buffer.from(JSON.stringify(sanitizeFields(state ?? defaultState()), null, 2))
    phase = 'open'
    fd = fs.openSync(tmp, 'wx')
    phase = 'write'
    fs.writeFileSync(fd, bytes)
    phase = 'file-fsync'
    fs.fsyncSync(fd)
    phase = 'close'
    fs.closeSync(fd)
    fd = undefined
    phase = 'rename'
    fs.renameSync(tmp, target)
    renamed = true
    phase = 'directory-sync'
    // Windows 的 Node 目录句柄同步不可用，不冒充掉电目录项耐久保证。
    // POSIX 同步整个祖先链，涵盖此次 mkdir 创建的目录项。
    if (process.platform !== 'win32') {
      for (let current = dir; ;) {
        const directory = fs.openSync(current, 'r')
        const directoryErrors = []
        try { fs.fsyncSync(directory) } catch (error) { directoryErrors.push(error) } finally {
          try { fs.closeSync(directory) } catch (error) { directoryErrors.push(error) }
        }
        const fatal = directoryErrors.filter((error) => !isUnsupportedDirSync(error))
        if (fatal.length) throw new AggregateError(fatal, fatal.map(error => error.message).join('; '), { cause: fatal[0] })
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    return target
  } catch (cause) {
    const error = new Error(`状态保存失败 phase=${phase}，${renamed || phase === 'rename' ? '提交未确认，勿盲重试' : '未确认提交'}: ${cause.message}`, { cause })
    error.phase = phase
    error.commitStatus = renamed || phase === 'rename' ? 'unknown' : 'not-committed'
    errors.push(error)
  } finally {
    // 只操作本次唯一路径，绝不回滚或删除 target。
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (cause) {
        errors.push(new Error(`状态保存 phase=close-cleanup ${cause.message}`, { cause }))
      }
    }
    try { fs.unlinkSync(tmp) } catch (error) {
      if (error.code !== 'ENOENT') {
        errors.push(new Error(`状态保存 phase=temp-cleanup ${error.message}`, { cause: error }))
      }
    }
    if (errors.length) {
      const error = new AggregateError(errors, errors.map(error => error.message).join('; '), { cause: errors[0] })
      error.phase = errors[0].phase || 'cleanup'
      error.commitStatus = errors[0].commitStatus || (renamed ? 'unknown' : 'not-committed')
      throw error
    }
  }
}

// 跨进程排他锁。
// 问题背景：flow_submit_requirement 是「读状态 → 算 pending → 写状态」的读-改-写，
// 多个 MCP server 进程共享同一个 CARLOS_FLOW_HOME 时会互相丢更新：
//   进程A 写（占位卡, pending=[三项]） 与 进程B 写（普通空卡, pending=[]）
// 若两者交错，后写入者可能用**过期的 prevState** 算出 pending=[]，
// 而它写入的卡片字段仍为空 —— 闸门就被绕过了（红队实测 40 轮复现 4 次）。
// 这里用 mkdir 的原子性做锁（open(..., "wx") 同理），把读-改-写包成临界区。
// 异步退避：锁等待必须用它。
//
// 历史实现用 Atomics.wait 做锁自旋（15ms/次、上限 5s）—— 那是**同步阻塞主线程**：
// 一旦有别的进程持锁，本进程的整个事件循环被冻住，同一 MCP server 上的其它请求
// （甚至只是 ping）在锁释放前全部无响应。现在等待期让出事件循环。
const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 跨进程状态锁（异步）。
 *
 * 用法：`await withStateLock(sid, () => { const s = loadState(sid); ...; saveState(sid, s); })`
 *
 * ⚠️ 铁律：**锁内只做内存操作**（读最新状态 → 合并 → 写）。
 * 不要把外部命令（verify.cmd 最长 120s）包进临界区：
 * 活 owner 不按年龄抢占，但长持锁仍会阻塞其他写入并导致等待超时。
 */
// 转换 gate 只保护锁路径转换，不覆盖业务 fn；所有等待均让出事件循环。
async function stateTransition(lockFile, gateRoot, fn, deadline, abortOwner) {
  // 协调元数据不属于任务证据；根与身份均由同一物理 RUNS_DIR 定位。
  const gateKey = process.platform === 'win32' ? lockFile.toLowerCase() : lockFile
  const dir = path.join(gateRoot, createHash('sha256').update(gateKey).digest('hex'))
  fs.mkdirSync(dir, { recursive: true })
  const id = `${process.pid}-${randomBytes(12).toString('hex')}`
  const slot = path.join(dir, `${id}.json`)
  const temp = `${slot}.tmp`
  const errors = []
  let result
  let gateHeld = false
  let publishedText
  let compensationAttempted = false
  const compensate = async () => {
    if (!gateHeld || !abortOwner || compensationAttempted) return
    compensationAttempted = true
    try {
      if (fs.readFileSync(slot, 'utf8') !== publishedText) throw new Error('自身 gate 身份不再可确认')
      await abortOwner()
    } catch (cause) {
      errors.push(new Error(`状态转换 phase=owner-compensation 未确认: ${cause.message}`, { cause }))
    }
  }
  const publish = async value => {
    const text = JSON.stringify(value)
    fs.writeFileSync(temp, text, { flag: 'wx' })
    const until = Math.min(deadline, Date.now() + 500)
    for (;;) {
      try {
        fs.renameSync(temp, slot)
        publishedText = text
        return
      } catch (error) {
        // 仅本次独占槽；Windows 读句柄短暂占用时允许有界异步重试。
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= until) throw error
        try {
          if (fs.readFileSync(temp, 'utf8') !== text) throw new Error('状态槽发布身份改变')
        } catch (verifyError) {
          throw new AggregateError([error, verifyError], '状态转换 phase=gate-publish 未确认')
        }
        await sleepAsync(5)
      }
    }
  }
  const peers = async () => {
    const out = []
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
      let value
      const until = Math.min(deadline, Date.now() + 500)
      for (;;) {
        try {
          value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
          break
        } catch (error) {
          if (error.code === 'ENOENT') break
          if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code) && Date.now() < until) {
            await sleepAsync(5)
            continue
          }
          throw new Error('状态转换 phase=gate-read 未知槽，拒绝抢占', { cause: error })
        }
      }
      if (value === undefined) continue
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0 ||
          !Number.isSafeInteger(value.ticket) || value.ticket < 0 ||
          typeof value.choosing !== 'boolean' || !name.startsWith(`${value.pid}-`))
        throw new Error('状态转换 phase=gate-read 无效槽，拒绝抢占')
      if (!statePidDead(value.pid)) out.push({ ...value, id: name.slice(0, -5) })
    }
    return out
  }
  try {
    await publish({ pid: process.pid, ticket: 0, choosing: true })
    const ticket = Math.max(0, ...(await peers()).map(peer => peer.ticket)) + 1
    if (!Number.isSafeInteger(ticket)) throw new Error('状态转换 ticket 溢出')
    await publish({ pid: process.pid, ticket, choosing: false })
    for (;;) {
      const blocked = (await peers()).some(peer => peer.id !== id &&
        (peer.choosing || peer.ticket < ticket || (peer.ticket === ticket && peer.id < id)))
      if (!blocked) {
        gateHeld = true
        result = await fn()
        break
      }
      if (Date.now() >= deadline) throw new Error('状态转换 phase=gate-wait 超时，未抢占')
      await sleepAsync(5)
    }
  } catch (error) { errors.push(error) } finally {
    if (errors.length) await compensate()
    // 先清唯一 temp，最后撤销槽；清理失败时仍保有 gate 才能补偿 owner。
    for (const file of [temp, slot]) {
      const until = Date.now() + 500
      for (;;) {
        try {
          fs.unlinkSync(file)
          break
        } catch (error) {
          if (error.code === 'ENOENT') break
          const beforeCompensation = errors.length
          await compensate()
          const compensationFailed = errors.length > beforeCompensation
          const cleanupError = new Error(`状态转换 phase=gate-cleanup ${error.message}`, { cause: error })
          if (compensationFailed) errors.splice(beforeCompensation, 0, cleanupError)
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= until) {
            if (!compensationFailed) errors.push(cleanupError)
            break
          }
          await sleepAsync(10)
        }
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '), { cause: errors[0] })
  return result
}

function statePidDead(pid) {
  let holderDead = false
  try { process.kill(pid, 0) } catch (err) {
    if (err && err.code === 'ESRCH') holderDead = true
    else if (err.code !== 'EPERM') throw err
  }
  return holderDead
}

function stateOwnerPid(text) {
  const match = /^([1-9][0-9]*)(?:\n[a-f0-9]{24})?$/.exec(text)
  const pid = match ? Number(match[1]) : 0
  return Number.isSafeInteger(pid) ? pid : 0
}

// 调用方始终持有转换 gate；rename 报错后先核身份，禁止盲重试共享路径。
async function retireStateOwner(lockFile, ownText, phase) {
  const retired = `${lockFile}.${phase}-${process.pid}-${randomBytes(12).toString('hex')}`
  const until = Date.now() + 500
  for (;;) {
    if (fs.readFileSync(lockFile, 'utf8') !== ownText)
      throw new Error(`状态锁 phase=${phase} owner 身份改变`)
    try {
      fs.renameSync(lockFile, retired)
      break
    } catch (error) {
      let stillOwn = false
      try { stillOwn = fs.readFileSync(lockFile, 'utf8') === ownText } catch (readError) {
        if (readError.code !== 'ENOENT') throw new AggregateError([error, readError], `状态锁 phase=${phase} 核验失败`)
      }
      if (!stillOwn || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= until)
        throw new Error(`状态锁 phase=${phase} rename 未确认，未重试共享路径: ${error.message}`, { cause: error })
      await sleepAsync(10)
    }
  }
  // 已移出共享路径，失败也只留下私有诊断文件。
  try { fs.unlinkSync(retired) } catch (error) {
    throw new Error(`状态锁 phase=${phase}-cleanup ${error.message}`, { cause: error })
  }
}

function canonicalStatePath(file) {
  // 保留真实 IO 路径大小写；Windows 可存在大小写敏感目录，不能 lower 后执行 IO。
  return fs.realpathSync.native(file)
}

// 私有归档退出钩子：业务 owner 先正常释放，目录 rename 仍在同一转换 gate 内。
const archiveExit = Symbol('archiveExit')

// validate 只读重验；move 必须是同步短操作，不持业务 owner 移动含锁的目录。
// 普通 withStateLock 创建语义不变；归档不创建 session，等待者身份变化则拒绝。
export async function archiveStateSession(sid, validate, move) {
  return withStateLock(sid, validate, { [archiveExit]: move })
}

export async function withStateLock(sid, fn, opts = {}) {
  // 先创建再 realpath，不以字符串路径/盘符大小写或 junction 作为锁身份。
  const archiving = typeof opts[archiveExit] === 'function'
  if (!archiving) fs.mkdirSync(RUNS_DIR, { recursive: true })
  const runs = canonicalStatePath(RUNS_DIR)
  const requestedDir = path.join(runs, sanitizeId(sid))
  if (!archiving) fs.mkdirSync(requestedDir, { recursive: true })
  if (archiving && fs.lstatSync(requestedDir).isSymbolicLink())
    throw new Error('状态归档拒绝 session 路径别名')
  const dir = canonicalStatePath(requestedDir)
  const sessionIdentity = fs.statSync(dir, { bigint: true })
  const relative = path.relative(runs, dir)
  const runsIdentity = fs.statSync(runs, { bigint: true })
  const parentIdentity = fs.statSync(path.dirname(dir), { bigint: true })
  // session 必须仍为同一物理 RUNS 的直接子目录；前缀相似/.. 或跨根 junction 均拒绝。
  // 额外核 dev/ino，防止 Windows 大小写不敏感的 relative 误认不同的物理父目录。
  if (!relative || path.isAbsolute(relative) || relative === '..' ||
      relative.startsWith(`..${path.sep}`) || relative.includes(path.sep) ||
      !runsIdentity.ino || runsIdentity.ino !== parentIdentity.ino || runsIdentity.dev !== parentIdentity.dev)
    throw new Error('状态锁 phase=session-layout 物理 session 不是 RUNS_DIR 的直接子目录，拒绝转换')
  const lockFile = path.join(dir, '.state.lock')
  const gateRoot = path.join(path.dirname(runs), 'state-transitions')
  const timeoutMs = Number(opts.timeoutMs) || 5000
  const deadline = Date.now() + timeoutMs
  const ownText = `${process.pid}\n${randomBytes(12).toString('hex')}`
  let acquired = false
  let holder = ''
  const verifySession = () => {
    const current = fs.statSync(dir, { bigint: true })
    if (!sessionIdentity.ino || !current.isDirectory() ||
        current.dev !== sessionIdentity.dev || current.ino !== sessionIdentity.ino ||
        current.birthtimeNs !== sessionIdentity.birthtimeNs ||
        canonicalStatePath(requestedDir) !== dir)
      throw new Error('状态锁 phase=session-identity 等待期间物理 session 已改变，拒绝写入')
  }
  while (!acquired) {
    await stateTransition(lockFile, gateRoot, async () => {
      verifySession()
      try {
        // wx 是业务锁的真实排他边界，gate 不跨业务 fn。
        const fd = fs.openSync(lockFile, 'wx')
        const ownerErrors = []
        let createdIdentity
        try {
          createdIdentity = fs.fstatSync(fd)
          fs.writeFileSync(fd, ownText, 'utf8')
        } catch (error) {
          ownerErrors.push(new Error(`状态锁 phase=owner-write ${error.message}`, { cause: error }))
        } finally {
          try { fs.closeSync(fd) } catch (error) {
            ownerErrors.push(new Error(`状态锁 phase=owner-close ${error.message}`, { cause: error }))
            // 此间未打开其他 fd，重试只针对本次句柄；after-effect 的 EBADF 表示已关闭。
            try { fs.closeSync(fd) } catch (cleanupError) {
              if (cleanupError.code !== 'EBADF') ownerErrors.push(new Error(`状态锁 phase=owner-close-cleanup ${cleanupError.message}`, { cause: cleanupError }))
            }
          }
        }
        if (ownerErrors.length) {
          try {
            const current = fs.statSync(lockFile)
            if (!createdIdentity || !createdIdentity.ino || current.ino !== createdIdentity.ino ||
                current.dev !== createdIdentity.dev || current.birthtimeMs !== createdIdentity.birthtimeMs)
              throw new Error('创建文件身份无法证明，保留锁 fail-closed')
            await retireStateOwner(lockFile, fs.readFileSync(lockFile, 'utf8'), 'create-compensation')
          } catch (cause) {
            ownerErrors.push(new Error(`状态锁 phase=create-compensation 未确认: ${cause.message}`, { cause }))
          }
          throw new AggregateError(ownerErrors, ownerErrors.map(error => error.message).join('; '), { cause: ownerErrors[0] })
        }
        acquired = true
      } catch (error) {
        if (error.code !== 'EEXIST' || acquired) throw error
        let text
        try { text = fs.readFileSync(lockFile, 'utf8') } catch (readError) {
          if (readError.code === 'ENOENT') return
          throw readError
        }
        const pid = stateOwnerPid(text)
        holder = pid ? `（持有者 pid=${pid}）` : '（持有者未知）'
        if (pid && statePidDead(pid)) {
          if (fs.readFileSync(lockFile, 'utf8') === text && statePidDead(pid))
            await retireStateOwner(lockFile, text, 'dead')
        }
        return
      }
    }, deadline, async () => {
      if (!acquired) return
      await retireStateOwner(lockFile, ownText, 'acquire-compensation')
      acquired = false
    })
    if (!acquired) {
      if (Date.now() >= deadline) throw new Error(`获取状态锁超时（session=${sanitizeId(sid)}${holder}），未抢占`)
      await sleepAsync(5)
    }
  }
  const errors = []
  let result
  try { verifySession(); result = await fn() } catch (error) { errors.push(error) } finally {
    try {
      // 释放使用独立预算；归档只在 owner 已正常退出且 gate 尚未撤销时移动目录。
      await stateTransition(lockFile, gateRoot, async () => {
        verifySession()
        await retireStateOwner(lockFile, ownText, 'release')
        if (!errors.length && archiving && result === true) {
          verifySession()
          result = opts[archiveExit]()
        }
      }, Date.now() + timeoutMs)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '), { cause: errors[0] })
  return result
}

/**
 * 状态增量变更 (Delta Patching)
 * 对 state 对象进行原子补丁更新，支持字段级的深浅合并，避免并发全量重写
 */
export function applyDeltaPatch(state, patch = {}) {
  if (!state || typeof state !== 'object' || !patch || typeof patch !== 'object') {
    return state
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof state[key] === 'object' && state[key] !== null && !Array.isArray(state[key])) {
      state[key] = { ...state[key], ...value }
    } else {
      state[key] = value
    }
  }
  return state
}

/**
 * 「读最新状态 → 增量补丁/合并 → 写」的短临界区封装。
 *
 * 为什么需要它：flow_run_verify / flow_falsify 的读-改-写窗口横跨整个命令执行期
 * （最长 120s×2），期间别的进程可能提交了新的任务卡或写了别的字段。
 * 正确做法是**命令在锁外跑**，跑完再用这个函数在短锁内重新读最新状态、只合并自己那份结果。
 */
export async function commitState(sid, mutateOrPatch, opts = {}) {
  return withStateLock(
    sid,
    () => {
      const state = loadState(sid)
      const before = opts.skipUnchanged ? JSON.stringify(state) : null
      let ret
      if (typeof mutateOrPatch === 'function') {
        ret = mutateOrPatch(state)
      } else if (mutateOrPatch && typeof mutateOrPatch === 'object') {
        applyDeltaPatch(state, mutateOrPatch)
        ret = state
      }
      if (!opts.skipUnchanged || JSON.stringify(state) !== before)
        saveState(sid, state)
      return ret
    },
    opts,
  )
}

// 向导只对同一旧验证代发一次 offer；当前工作区变化不参与 caseKey。
function receiptHash(value) {
  const stable = item => item && typeof item === 'object'
    ? Array.isArray(item) ? item.map(stable) : Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]))
    : item
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function receiptSessionIdentity(sid) {
  const runs = fs.realpathSync.native(RUNS_DIR)
  const requested = path.join(runs, sanitizeId(sid))
  // 仅向导拒绝预存在的 session junction/符号链接，不改变普通状态锁/CLI。
  if (fs.lstatSync(requested).isSymbolicLink())
    throw new Error('receipt session-layout 不支持 session 路径别名')
  const session = fs.realpathSync.native(requested)
  const runStat = fs.statSync(runs, { bigint: true })
  const sessionStat = fs.statSync(session, { bigint: true })
  const parentStat = fs.statSync(path.dirname(session), { bigint: true })
  if ([runStat, sessionStat, parentStat].some(stat => typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino === 0n) ||
      !sessionStat.isDirectory() ||
      runStat.dev !== parentStat.dev || runStat.ino !== parentStat.ino)
    throw new Error('receipt session-layout 物理身份无法确认')
  // 身份只取物理 dev/ino，不 lower IO 或按平台猜测文件系统大小写语义。
  const key = receiptHash([String(runStat.dev), String(runStat.ino), String(sessionStat.dev), String(sessionStat.ino)])
  return { key, directory: path.join(path.dirname(runs), 'verify-receipts', key) }
}

export function staleCaseIdentity(sid, state) {
  return receiptHash([receiptSessionIdentity(sid).key, state.card_ts, state.card, state.last_verify])
}

// 永久 wx 文件从不删除/移动/修复；空文件和 partial 也会阻止再次领取。
function writeReceiptFile(file, value) {
  let fd
  let phase = 'open'
  const errors = []
  try {
    fd = fs.openSync(file, 'wx')
    phase = 'write'
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8')
    phase = 'file-sync'
    fs.fsyncSync(fd)
  } catch (error) { errors.push(error) } finally {
    if (fd !== undefined) {
      if (!errors.length) phase = 'close'
      try { fs.closeSync(fd) } catch (error) {
        errors.push(error)
        // 首次 close 前效失败也有界再关闭；不改变已消耗文件或首因。
        try { fs.closeSync(fd) } catch (cleanupError) {
          if (cleanupError.code !== 'EBADF') errors.push(cleanupError)
        }
      }
    }
  }
  if (!errors.length && process.platform !== 'win32') {
    phase = 'directory-sync'
    let dirFd
    try {
      dirFd = fs.openSync(path.dirname(file), 'r')
      fs.fsyncSync(dirFd)
    } catch (error) {
      if (!isUnsupportedDirSync(error)) errors.push(error)
    } finally {
      if (dirFd !== undefined) try { fs.closeSync(dirFd) } catch (error) { errors.push(error) }
    }
  }
  if (errors.length) throw new AggregateError(errors, `receipt ${phase} 未确认，禁止自动重试`, { cause: errors[0] })
}

function readStaleOffer(dir, caseKey) {
  if (!/^[a-f0-9]{64}$/.test(caseKey || '')) throw new Error('receipt 身份无效')
  const file = path.join(dir, `${caseKey}.offer.json`)
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 65536) throw new Error('receipt offer 文件无效')
  const offer = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (offer.version !== 1 || offer.caseKey !== caseKey || typeof offer.sid !== 'string' || !Number.isFinite(offer.cardTs) || typeof offer.cmd !== 'string' || !offer.cmd ||
      typeof offer.cwd !== 'string' || !Number.isFinite(offer.expiresAt) || !Number.isFinite(offer.detectedAt))
    throw new Error('receipt offer 内容无效')
  return offer
}

export async function issueStaleOffer(sid, original, cwd) {
  receiptSessionIdentity(sid)
  return withStateLock(sid, () => {
    const current = loadState(sid)
    const caseKey = staleCaseIdentity(sid, original)
    if (staleCaseIdentity(sid, current) !== caseKey) throw new Error('receipt 验证代已变化')
    const identity = receiptSessionIdentity(sid)
    const dir = identity.directory
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${caseKey}.offer.json`)
    if (fs.existsSync(file)) return readStaleOffer(dir, caseKey)
    const entries = fs.readdirSync(dir)
    // 每个 offer 预留一个永久 claim 槽：最多128代、合计256文件，无自动淘汰。
    if (entries.some(name => !/^[a-f0-9]{64}\.(offer\.json|claim)$/.test(name)) ||
        entries.filter(name => name.endsWith('.offer.json')).length >= 128 || entries.length >= 256)
      throw new Error('receipt 容量已满或目录未知，仅可手动验证')
    const detectedAt = Date.now()
    const offer = {
      version: 1, caseKey, sid: identity.key, cardTs: current.card_ts, cmd: current.card.verify.cmd,
      cwd: fs.realpathSync.native(cwd), detectedAt, expiresAt: detectedAt + 10 * 60 * 1000,
    }
    writeReceiptFile(file, offer)
    return offer
  })
}

export async function claimStaleOffer(sid, expected, cwd, contextCwd) {
  receiptSessionIdentity(sid)
  return withStateLock(sid, () => {
    const identity = receiptSessionIdentity(sid)
    const dir = identity.directory
    const offer = readStaleOffer(dir, expected?.caseKey)
    const current = loadState(sid)
    if (offer.sid !== identity.key || staleCaseIdentity(sid, current) !== offer.caseKey ||
        Date.now() >= offer.expiresAt || current.card?.verify?.cmd !== offer.cmd)
      throw new Error('receipt 已过期或卡/原验证已变化，禁止重放')
    const boundCwd = current.card?.env?.project || offer.cwd
    if (fs.realpathSync.native(boundCwd) !== offer.cwd || (cwd && fs.realpathSync.native(cwd) !== offer.cwd) ||
        (contextCwd && fs.realpathSync.native(contextCwd) !== offer.cwd))
      throw new Error('receipt 工作目录已变化')
    writeReceiptFile(path.join(dir, `${offer.caseKey}.claim`), { version: 1, caseKey: offer.caseKey, claimedAt: Date.now() })
    return offer
  })
}

// 追加审计返回明确回执；错误不抛出，由调用者决定 fail-closed 策略。
// 读取审计文件最后一条记录的 hash（多进程安全：每次从磁盘尾部取，不依赖进程内变量）
// 无 hash 的旧格式记录及坏行继续向前跳过，返回最近符合格式的 hash；找不到才退全 0。
// 此处容忍旧格式及坏行，不代表这些行获得完整性保证。
function lastHashOf(file) {
  const ZERO = ZERO_HASH
  try {
    const fd = fs.openSync(file, 'r')
    try {
      let pos = fs.fstatSync(fd).size
      let parts = []
      const readHash = () => {
        // 先拼完整行的字节再解码，避免反向块边界切断 UTF8 多字节字符。
        const line = Buffer.concat(parts.reverse()).toString('utf8')
        parts = []
        try {
          const r = JSON.parse(line)
          if (r && typeof r.hash === 'string' && r.hash.length === 64)
            return r.hash
        } catch {
          /* 坏行跳过；兼容不代表该行获得完整性保证 */
        }
        return null
      }
      while (pos > 0) {
        const len = Math.min(pos, 8192)
        pos -= len
        const buf = Buffer.allocUnsafe(len)
        let used = 0
        while (used < len) {
          const n = fs.readSync(fd, buf, used, len - used, pos + used)
          if (n === 0) throw new Error('审计尾读取意外结束')
          used += n
        }
        let end = len
        for (let i = len - 1; i >= 0; i--) {
          if (buf[i] !== 10) continue
          parts.push(buf.subarray(i + 1, end))
          const hash = readHash()
          if (hash) return hash
          end = i
        }
        parts.push(buf.subarray(0, end))
      }
      return readHash() || ZERO
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    throw e
  }
}

// 审计文件按天分片（`${localDate()}.jsonl`）。
//
// 审计链是「分片链表」：前一天的最后一条记录的 hash 应当传给后一天的第一条
// 的 prevHash。**旧代码 `audit()` 只取当天文件的 tail**（当天文件不存在时退化成
// 全 0），于是链子每天都在午夜断开——攻击者篡改**任意历史天**的记录，今天
// 的 `verifyAuditChain()` 查不出来。
//
// 新增三个辅助：
//   · auditDayFiles()    → 按日期升序排列的审计文件清单
//   · lastHashOfDay(date)→ 某天文件最后一条记录的 hash（不存在那一天退化为 ZERO）
//   · nextPrevHash(date) → 取「当天 tail」，当天没有则往前找最近一天的 tail
//
// `audit()` 用 nextPrevHash 把每天的 tail 串成完整链，
// `verifyAuditChain()` 用同一套规则逐天串联验证。
// 审计单文件上限：超过就滚动成 <date>.1.jsonl、<date>.2.jsonl …
//
// 为什么滚动：单日文件实测已到 2MB 量级，全年约 180MB。整文件 readFileSync 校验
// 会随使用时间线性变慢、并一次性吃掉几百 MB 内存；按 8MB 滚动后单文件有硬上界，
// 校验可以逐行流式累加哈希（不整体读入），归档（按月 gzip）也不会因为一个巨文件
// 而卡住。可用 CARLOS_FLOW_AUDIT_MAX_BYTES 调整。
const AUDIT_MAX_BYTES = (() => {
  const raw = process.env.CARLOS_FLOW_AUDIT_MAX_BYTES
  const n = Number(raw)
  return Number.isFinite(n) && n >= 64 * 1024 ? n : 8 * 1024 * 1024
})()

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

// 当前该往哪个分片写：当天最后一个分片没超过上限就续写，否则滚动到下一个序号的**新文件**。
// 只做 stat（不读内容），开销可忽略；滚动判定以「写入前的大小」为准，
// 因此单个文件最多超出上限一条记录的量级。
function auditWriteFileName(date) {
  const files = auditDayFilesOf(date)
  if (files.length === 0) return `${date}.jsonl`
  const last = files[files.length - 1]
  const size = fs.statSync(path.join(AUDIT_DIR, last)).size
  if (size < AUDIT_MAX_BYTES) return last
  const m = DAY_FILE_RE.exec(last)
  const nextSeq = (m && m[2] !== undefined ? Number(m[2]) : 0) + 1
  return `${date}.${nextSeq}.jsonl`
}

// 某一天的**全部**分片文件名，按写入顺序（base → .1 → .2 …）。
function auditDayFilesOf(date) {
  let names = []
  try {
    names = fs.readdirSync(AUDIT_DIR)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const hits = []
  for (const n of names) {
    const m = DAY_FILE_RE.exec(n)
    if (!m || m[1] !== date) continue
    hits.push({ name: n, seq: m[2] === undefined ? 0 : Number(m[2]) })
  }
  hits.sort((a, b) => a.seq - b.seq)
  return hits.map((x) => x.name)
}

// 全部分片文件名（跨天），按「日期升序 → 当天分片序」排列。
// 这是校验链的扫描顺序，也是 readAudit 的读取顺序。
function auditDayFiles() {
  let names = []
  try {
    names = fs.readdirSync(AUDIT_DIR)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const hits = []
  for (const n of names) {
    const m = DAY_FILE_RE.exec(n)
    if (!m) continue
    hits.push({
      name: n,
      date: m[1],
      seq: m[2] === undefined ? 0 : Number(m[2]),
    })
  }
  hits.sort((a, b) =>
    a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1,
  )
  return hits.map((x) => x.name)
}

// 某天文件的最后一条 hash（跨分片：取当天最后一个分片的 tail）
function lastHashOfDay(date) {
  const files = auditDayFilesOf(date)
  for (let i = files.length - 1; i >= 0; i--) {
    const h = lastHashOf(path.join(AUDIT_DIR, files[i]))
    if (h !== ZERO_HASH) return h
  }
  return ZERO_HASH
}

// 取「当天 tail」，当天没有就往前找最近一天的 tail（修跨天断链）
function nextPrevHash(date) {
  const prev = lastHashOfDay(date)
  if (prev !== '0'.repeat(64)) return prev // 当天有链，正常运行
  // 当天还没有记录：**从 date 前一天起**按日期降序找最近已有 tail，绝不看 future。
  const today = localDate()
  const sorted = auditDayFiles().filter((f) => f.slice(0, 10) < today)
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].slice(0, 10) >= date) continue // 只能找 date 之前的
    const h = lastHashOf(path.join(AUDIT_DIR, sorted[i]))
    if (h !== '0'.repeat(64)) return h
  }
  return '0'.repeat(64)
}
// 哈希载荷：除链字段外的全部字段，保持写入/校验口径完全一致
function auditPayload(rec) {
  const SKIP = new Set(['ts', 'type', 'sessionID', 'prevHash', 'hash'])
  const out = {}
  for (const k of Object.keys(rec)) {
    if (!SKIP.has(k)) out[k] = rec[k]
  }
  return JSON.stringify(out)
}

// 敏感信息脱敏
//
// 用户卡片里可能包含密钥/密码（`verify.cmd` 里的 `sk_live_xxx`、`token`、
// `password`），审计记录也接受任意 `fields`——如果原样落盘，**门禁本身成了泄露源**。
//
// 规则：
//   · key 命中 `secret/key/password/pwd/token/credential/auth` 之一（不区分大小写）
//   · 或 string value 里含有 `sk_|secret=|password=|token=|api_key=|sk_live|sk_test`
//   → 记为敏感 value，脱敏：长度 ≤ 8 → `[脱敏]`，否则头尾各保留 4 个字符中间 ***
//
// 任何异常都不可抛（`audit` 必须永不抛错），脱敏失败则原地返回原值。
function isSensitiveKey(k) {
  try {
    return (
      typeof k === 'string' &&
      /[Ss]ecret|[Kk]ey|[Pp]assword|[Pp]wd|[Tt]oken|[Cc]redential|[Aa]uth/.test(
        k,
      )
    )
  } catch {
    return false
  }
}
const SENSITIVE_VALUES_RE =
  /sk_|secret=|password=|token=|api_key=|sk_live|sk_test|secret:/i
function isSensitiveValue(v) {
  try {
    return typeof v === 'string' && v.length > 0 && SENSITIVE_VALUES_RE.test(v)
  } catch {
    return false
  }
}
function maskValue(v) {
  try {
    if (typeof v === 'string' && v.length > 0) {
      if (v.length <= 8) return '[脱敏]'
      return v.slice(0, 4) + '***' + v.slice(-4)
    }
    return v
  } catch {
    return v
  }
}
function sanitizeValue(v) {
  try {
    if (Array.isArray(v)) return v.map(sanitizeValue)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) {
        const val = v[k]
        out[k] =
          isSensitiveKey(k) || isSensitiveValue(val)
            ? maskValue(val)
            : sanitizeValue(val)
      }
      return out
    }
    return v
  } catch {
    return v
  }
}
export function sanitizeFields(o) {
  return sanitizeValue(o ?? {})
}

// ---- 审计链哈希模式 ----
//
// 裸 SHA-256 哈希链能防的是「**意外**损坏」（截断、位翻转、误删），
// **防不了有意篡改**：攻击者能读文件，就能重算整条链。
//
// 因此提供两种模式：
//   · hmac  —— 设置了 CARLOS_FLOW_AUDIT_KEY 时使用带密钥的 HMAC-SHA256。
//              攻击者没有密钥 → 重算不出正确 hash → 篡改必被发现。
//   · plain —— 未设置密钥时的降级模式（裸 SHA-256），**在 verify 结果里
//              显式标注 mode**，让调用方知道自己拿到的是哪种保证。
//
// 不做「默认启用 HMAC」：没有密钥就签不了名，用户第一次用就会报错。
// 也不做「假装 HMAC」：plain 模式必须诚实地说自己只是弱保证。
const AUDIT_KEY = (() => {
  const k = process.env.CARLOS_FLOW_AUDIT_KEY
  return typeof k === 'string' && k.length >= 16 ? k : null
})()

export function auditHashMode() {
  return AUDIT_KEY ? 'hmac' : 'plain'
}

// 计算一条记录的 hash（写入与校验必须用同一套函数，否则永远对不上）
function computeAuditHash(rec, prev) {
  const payload = rec.ts + rec.type + rec.sessionID + auditPayload(rec) + prev
  if (AUDIT_KEY) {
    return createHmac('sha256', AUDIT_KEY).update(payload).digest('hex')
  }
  return createHash('sha256').update(payload).digest('hex')
}

// Lamport bakery：每个回收者独占不可复用的槽位，避免「回收锁的回收锁」递归。
// 新参与者先发布 choosing，再领取递增 ticket；死 PID 槽位可忽略，未知持有者保守阻塞。
// 仅调用者自有回收声明的原子替换/撤销可重试；永久权限错误有界传播。
export function retryOwnReaperOperation(action) {
  const until = Date.now() + 500
  for (let attempt = 0; ; attempt++) {
    try {
      return action()
    } catch (e) {
      if (
        !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) ||
        attempt >= 50 ||
        Date.now() >= until
      )
        throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
}

export function cleanupOwnReaperFiles(files) {
  const errors = []
  for (const file of files) {
    try {
      retryOwnReaperOperation(() => {
        try {
          fs.unlinkSync(file)
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      })
    } catch (e) {
      errors.push(e)
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `自身回收声明清理失败: ${errors.map((e) => e.message).join('; ')}`,
    )
}

function withAuditReaper(lock, fn, until) {
  const dir = `${lock}.reapers`
  fs.mkdirSync(dir, { recursive: true })
  const id = `${process.pid}-${randomBytes(12).toString('hex')}`
  const slot = path.join(dir, `${id}.json`)
  const temp = `${slot}.tmp`
  const publish = (value) => {
    try {
      fs.writeFileSync(temp, JSON.stringify(value))
      retryOwnReaperOperation(() => fs.renameSync(temp, slot))
    } catch (e) {
      throw new Error(`审计回收锁发布失败: ${e.message}`, { cause: e })
    }
  }
  const list = () => {
    const peers = []
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const file = path.join(dir, name)
      let value
      try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (e) {
        if (e.code === 'ENOENT') continue
        throw new Error('审计回收锁所有者未知，保守拒绝')
      }
      if (
        !Number.isInteger(value.pid) ||
        value.pid <= 0 ||
        !Number.isSafeInteger(value.ticket) ||
        value.ticket < 0 ||
        typeof value.choosing !== 'boolean'
      ) {
        throw new Error('审计回收锁所有者未知，保守拒绝')
      }
      let dead = false
      try {
        process.kill(value.pid, 0)
      } catch (e) {
        dead = e.code === 'ESRCH'
      }
      // 槽位名不可复用；不删除他人槽位，避免并发 list/unlink 竞态。
      if (!dead) peers.push({ ...value, id: name.slice(0, -5) })
    }
    return peers
  }
  const errors = []
  let result
  try {
    publish({ pid: process.pid, ticket: 0, choosing: true })
    const ticket = Math.max(0, ...list().map((p) => p.ticket)) + 1
    publish({ pid: process.pid, ticket, choosing: false })
    for (;;) {
      const blocked = list().some(
        (p) =>
          p.id !== id &&
          (p.choosing ||
            p.ticket < ticket ||
            (p.ticket === ticket && p.id < id)),
      )
      if (!blocked) {
        result = fn()
        break
      }
      if (Date.now() >= until)
        throw new Error('审计回收锁活持有者等待超时，未抢占')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  } catch (e) {
    errors.push(e)
  } finally {
    try {
      cleanupOwnReaperFiles([slot, temp])
    } catch (e) {
      errors.push(new Error(`审计回收锁清理失败: ${e.message}`, { cause: e }))
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      `审计回收锁失败: ${errors.map((e) => e.message).join('; ')}`,
      { cause: errors[0] },
    )
  }
  return result
}

// 同步跨进程锁：持有者存活时绝不按年龄抢锁。
function withAuditLock(fn) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true })
  const lock = path.join(AUDIT_DIR, '.append-lock')
  const owner = path.join(lock, 'owner.json')
  const until = Date.now() + 5000
  const candidate = `${lock}.candidate-${process.pid}-${randomBytes(8).toString('hex')}`
  const ownText = JSON.stringify({ pid: process.pid, token: randomBytes(12).toString('hex') })
  const errors = []
  let result
  try {
    fs.mkdirSync(candidate)
    fs.writeFileSync(path.join(candidate, 'owner.json'), ownText)
    for (;;) {
      try {
        // 完整发布持有者目录，避免 mkdir 后进程死亡留下无 owner 的锁。
        fs.renameSync(candidate, lock)
        break
      } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code))
          throw e
        try {
          const ownerText = fs.readFileSync(owner, 'utf8')
          const { pid, token } = JSON.parse(ownerText)
          if (
            Number.isInteger(pid) && pid > 0 &&
            (token === undefined ||
              (typeof token === 'string' && /^[a-f0-9]{24}$/.test(token)))
          ) {
            let dead = false
            try {
              process.kill(pid, 0)
            } catch (err) {
              dead = err.code === 'ESRCH'
            }
            if (dead) {
              withAuditReaper(
                lock,
                () => {
                  // 其他回收者可能已经换了持有者，必须重新核对。
                  if (
                    fs.readFileSync(owner, 'utf8') === ownerText
                  ) {
                    const stale = `${lock}.dead-${process.pid}-${randomBytes(12).toString('hex')}`
                    try {
                      fs.renameSync(lock, stale)
                    } catch (err) {
                      throw new Error(
                        `审计回收锁 dead rename 失败 (${err.code || 'UNKNOWN'}): ${err.message}`,
                        { cause: err },
                      )
                    }
                    try {
                      fs.rmSync(stale, { recursive: true })
                    } catch (err) {
                      throw new Error(
                        `审计回收锁 dead cleanup 失败 (${err.code || 'UNKNOWN'}): ${err.message}`,
                        { cause: err },
                      )
                    }
                  }
                },
                until,
              )
              continue
            }
          }
        } catch (err) {
          if (/审计回收锁/.test(err.message)) throw err
          // 未知主锁持有者不抢占，等待有界。
        }
        if (Date.now() >= until)
          throw new Error('审计锁等待超时（持有者存活或未知；可重试；未追加）')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try {
      result = fn()
    } catch (e) {
      errors.push(e)
    } finally {
      // 仅在完整唯一 owner 仍属于本进程时重试共享错误。
      // 移动成功（含报错但可能已移动）后，永不重试共享路径。
      const retired = `${lock}.retired-${process.pid}-${randomBytes(12).toString('hex')}`
      try {
        retryOwnReaperOperation(() => {
          if (fs.readFileSync(owner, 'utf8') !== ownText)
            throw new Error('审计锁 owner 身份改变，未重试共享路径')
          try {
            fs.renameSync(lock, retired)
          } catch (e) {
            let stillOwn = false
            try {
              stillOwn = fs.readFileSync(owner, 'utf8') === ownText
            } catch {}
            if (!stillOwn) {
              const uncertain = new Error(`${e.code || 'UNKNOWN'}: ${e.message}; owner 已移走或改变`, { cause: e })
              throw uncertain
            }
            throw e
          }
        })
      } catch (e) {
        throw new Error(`审计锁 retire 失败 (${e.code || e.cause?.code || 'UNKNOWN'}): ${e.message}; 追加可能已完成，勿盲重试`, { cause: e })
      }
      try {
        retryOwnReaperOperation(() => fs.rmSync(retired, { recursive: true, force: true }))
      } catch (e) {
        throw new Error(`审计锁 retired cleanup 失败 (${e.code || 'UNKNOWN'}): ${e.message}; 追加可能已完成，勿盲重试`, { cause: e })
      }
    }
  } catch (e) {
    errors.push(e)
  } finally {
    try {
      fs.rmSync(candidate, { recursive: true, force: true })
    } catch (e) {
      errors.push(new Error(
        `审计锁 candidate cleanup 失败 (${e.code || 'UNKNOWN'}): ${e.message}; 追加可能已完成，勿盲重试`,
        { cause: e },
      ))
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      errors.map((e) => e.message).join('; '),
      { cause: errors[0] },
    )
  }
  return result
}

// 返回的 persisted 是回执元数据，不参与落盘哈希。
export function audit(type, sid, fields = {}) {
  // 落盘脱敏：用户卡片/审计字段里的密钥片段（verify.cmd 等）不能明文入盘。
  const sanitized = sanitizeFields(fields)
  const rec = {
    ts: new Date().toISOString(),
    type,
    sessionID: sanitizeId(sid),
    ...sanitized,
  }
  try {
    withAuditLock(() => {
      const file = path.join(AUDIT_DIR, auditWriteFileName(localDate()))
      const prev = nextPrevHash(localDate())
      rec.prevHash = prev
      rec.hash = computeAuditHash(rec, prev)
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR)
      const offset = fs.fstatSync(fd).size
      try {
        if (offset > 0) {
          const tail = Buffer.alloc(1)
          if (fs.readSync(fd, tail, 0, 1, offset - 1) !== 1 || tail[0] !== 10) {
            throw new Error('审计脏尾：拒绝拼接追加，需人工复核；未修改历史')
          }
        }
        try {
          const bytes = Buffer.from(JSON.stringify(rec) + '\n', 'utf8')
          let written = 0
          while (written < bytes.length) {
            const n = fs.writeSync(
              fd,
              bytes,
              written,
              bytes.length - written,
              offset + written,
            )
            if (n <= 0) throw new Error('审计追加未取得进展')
            written += n
          }
          fs.fsyncSync(fd)
        } catch (e) {
          // 锁内只回滚本次写入范围；不截断此前历史。回滚失败必须公开不确定性。
          try {
            fs.ftruncateSync(fd, offset)
            fs.fsyncSync(fd)
          } catch (rollback) {
            throw new Error(
              `${e.message}; 本次追加回滚未确认: ${rollback.message}`,
            )
          }
          throw e
        }
      } finally {
        fs.closeSync(fd)
      }
    })
    Object.defineProperty(rec, 'persisted', { value: true, enumerable: false })
  } catch (e) {
    Object.defineProperties(rec, {
      persisted: { value: false, enumerable: false },
      error: { value: String(e.message || e), enumerable: false },
    })
    try {
      process.stderr.write(
        `[flow-audit] 写入失败: ${e && e.message ? e.message : e}\n`,
      )
    } catch {}
  }
  return rec
}

// 逐行流式读取（同步）：不把整份文件读进内存。
//
// 审计文件按 8MB 滚动后单文件有上界，但全年仍有上百个文件；
// 校验时若每个文件都 readFileSync + split，峰值内存会随「当天最大文件」而不是
// 实际需要增长。这里用 256KB 缓冲块 + StringDecoder 处理多字节字符跨块问题，
// 保证不把半个汉字当成坏行。
function forEachLineSync(file, cb) {
  let fd = null
  fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(256 * 1024)
    const decoder = new StringDecoder('utf8')
    let rest = ''
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      rest += decoder.write(buf.subarray(0, n))
      let idx
      while ((idx = rest.indexOf('\n')) >= 0) {
        cb(rest.slice(0, idx))
        rest = rest.slice(idx + 1)
      }
    }
    rest += decoder.end()
    if (rest.trim()) cb(rest)
  } finally {
    fs.closeSync(fd)
  }
}

// 把「文件名列表」按日期分组（同一天的多个滚动分片保持写入顺序）。
function groupAuditFilesByDay(files) {
  const groups = []
  for (const f of files) {
    const date = f.slice(0, 10)
    const last = groups[groups.length - 1]
    if (last && last.date === date) last.files.push(f)
    else groups.push({ date, files: [f] })
  }
  return groups
}

// 校验审计链完整性（可选：需完整文件，不能只看尾部）。
//
// 审计文件按天分片（`localDate().jsonl`），审计链是「分片链表」：
// 前一天最后一条记录的 hash 是后一天第一条记录的 prevHash（nextPrevHash）。
// 所以默认 `verifyAuditChain()` **逐天串联所有记录** 验证整条链——
// 攻击者篡改任意一天的任意记录，整链检测都会 break（配合 CARLOS_FLOW_AUDIT_KEY
// 为 HMAC 时做得到；plain 模式可在推荐结果里看到 mode 降级声明）。
//
// `opts.date` 给定的一天 → 只验证那一天（验证起点是前一天 tail，跨天）。
// `opts.fullChain` 默认 true → 验证全部天的完整链。
export function verifyAuditChain(opts = {}) {
  const coverage = {
    complete: true,
    readErrors: [],
    invalidLines: 0,
    coverage: 'present-files-only',
    guarantee: '不证明历史文件未丢失、尾部未删除或 legacy 内容完整',
  }
  try {
    const result = verifyAuditChainInternal(opts, coverage)
    coverage.complete = coverage.invalidLines === 0
    return {
      ...result,
      ...coverage,
      empty: result.total === 0,
      ok: result.ok && coverage.complete,
    }
  } catch (e) {
    coverage.readErrors.push(String(e.message || e))
    return { ok: false, ...coverage, complete: false, mode: auditHashMode() }
  }
}

function verifyAuditChainInternal(opts, coverage) {
  const rawDate =
    typeof opts.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)
      ? opts.date
      : localDate()
  // ⚠️ 必须用 rawDate（而不是 localDate()）—— 否则 opts.date 完全失效：
  // 传 date='2020-01-01' 读的仍是**今天**的文件，调用方以为在查历史、
  // 实际拿到今天的数据（错而不报，最难发现）。
  const fullChain = typeof opts.fullChain === 'boolean' ? opts.fullChain : true
  if (fullChain && !opts.date) {
    // 全链验证：按「日期升序 → 当天分片序」逐条串联；每天的 tail 是下一天的前驱。
    //
    // 跨天重启容忍（2026-11-14）与分片说明（2026-11-18）：
    //   写入侧 nextPrevHash() 取「当天最后一条带 hash 记录」作为前驱；
    //   若当天先前记录都是 v2.5 升级上来的 legacy 记录（无 hash），取不到 tail，
    //   这条链首记录的 prevHash 只能是全 0 —— 这是**合法链首**，不是篡改。
    //   「链首」的判定按**天**做（不是按分片）：当天第一个分片的第一条带 hash 记录
    //   才可能是链首；滚动出来的后续分片一律必须严格接上 prev，不允许重新起链。
    const groups = groupAuditFilesByDay(auditDayFiles())
    const byDay = []
    let total = 0,
      broken = 0,
      legacy = 0,
      restart = 0
    const brokenAt = []
    let prev = ZERO_HASH // 链起点
    for (const g of groups) {
      let dayBroken = 0,
        dayLegacy = 0,
        dayRestart = 0
      let hashedSeen = 0
      for (const f of g.files) {
        forEachLineSync(path.join(AUDIT_DIR, f), (line) => {
          const t = line.trim()
          if (!t) return
          let r
          try {
            r = JSON.parse(t)
            if (!r || typeof r !== 'object' || Array.isArray(r))
              throw new Error('invalid record')
          } catch {
            coverage.invalidLines++
            return
          }
          total++
          if (typeof r.hash !== 'string') {
            // 旧格式记录（无 hash）→ 计入 legacy，但**不重置链起点**
            legacy++
            dayLegacy++
            return
          }
          hashedSeen++
          const isDayStart = hashedSeen === 1 && r.prevHash === ZERO_HASH
          const base = isDayStart ? ZERO_HASH : prev
          const expect = computeAuditHash(r, base)
          if (isDayStart) {
            // 只有当它自己的 hash 确实是用全 0 前驱算出来的才算合法链首；
            // 否则仍按 broken 处理（防「把任意记录伪装成链首」）。
            if (expect === r.hash) {
              restart++
              dayRestart++
              prev = r.hash
              return
            }
          }
          if (expect !== r.hash || r.prevHash !== base) {
            broken++
            dayBroken++
            if (brokenAt.length < 10)
              brokenAt.push({
                date: g.date,
                ts: r.ts,
                type: r.type,
                kind: r.kind,
              })
          }
          prev = r.hash
        })
      }
      byDay.push({
        date: g.date,
        shards: g.files.length,
        dayBroken,
        dayLegacy,
        dayRestart,
        tailHash: prev,
      })
    }
    return {
      mode: 'pro',
      mode_ts: 0,
      claimed_profile: null,
      ok: broken === 0,
      total,
      broken,
      legacy,
      restart,
      brokenAt,
      byDay,
      mode: auditHashMode(),
      note: '全链验证：逐天（含当天滚动分片）串联，每天的 tail 是下一天的前驱；逐行流式累加，不整文件读入。dayRestart 为「当天首条带 hash 记录以全 0 前驱合法起链」的处数，不是篡改。',
    }
  }

  // 单日验证：读该日全部分片，链起点用前一天 tail（跨天联动）或全 0（新链第一天）。
  const shards = auditDayFilesOf(rawDate).map((f) => path.join(AUDIT_DIR, f))
  if (shards.length === 0) {
    return {
      mode: 'pro',
      mode_ts: 0,
      claimed_profile: null,
      ok: true,
      total: 0,
      broken: 0,
      legacy: 0,
      brokenAt: [],
      file: path.join(AUDIT_DIR, `${rawDate}.jsonl`),
      mode: auditHashMode(),
    }
  }
  // 单日的链起点：前一个 tail hash（跨天）或全 0（新链第一天）。
  let prev = ZERO_HASH
  for (const f of auditDayFiles()) {
    if (f.slice(0, 10) >= rawDate) break
    prev = lastHashOf(path.join(AUDIT_DIR, f))
  }
  let total = 0,
    broken = 0,
    legacy = 0
  const brokenAt = []
  let hashedSeen = 0
  for (const file of shards) {
    forEachLineSync(file, (line) => {
      const t = line.trim()
      if (!t) return
      let r
      try {
        r = JSON.parse(t)
        if (!r || typeof r !== 'object' || Array.isArray(r))
          throw new Error('invalid record')
      } catch {
        coverage.invalidLines++
        return
      }
      total++
      if (typeof r.hash !== 'string') {
        // 旧格式记录（无 hash）→ 计入 legacy，但**不重置链起点**。
        // 早先这里写的是 prev = "0".repeat(64)，于是**一条**旧记录就会让它之后
        // 所有记录的 prevHash 全部对不上 → 全判 broken。误报比漏报更伤信任。
        legacy++
        return
      }
      hashedSeen++
      const isDayStart = hashedSeen === 1 && r.prevHash === ZERO_HASH
      const base = isDayStart ? ZERO_HASH : prev
      const expect = computeAuditHash(r, base)
      if (isDayStart && expect === r.hash) {
        prev = r.hash
        return
      }
      if (expect !== r.hash || r.prevHash !== base) {
        broken++
        if (brokenAt.length < 10)
          brokenAt.push({ ts: r.ts, type: r.type, kind: r.kind })
      }
      prev = r.hash
    })
  }
  // mode 字段说明本次校验的**保证强度**：
  //   hmac → 带密钥（CARLOS_FLOW_AUDIT_KEY），能发现有意篡改
  //   plain → 裸 SHA-256，只能发现意外损坏（攻击者能重算整条链）
  return {
    mode: 'pro',
    mode_ts: 0,
    claimed_profile: null,
    ok: broken === 0,
    total,
    broken,
    legacy,
    brokenAt,
    file: shards[shards.length - 1],
    mode: auditHashMode(),
  }
}

export function readAudit(opts = {}) {
  const result = readAuditDetailed(opts)
  if (!result.complete)
    throw new Error(
      `审计读取不完整: ${JSON.stringify(result.readErrors)}; invalidLines=${result.invalidLines}`,
    )
  return result.rows
}

export function readAuditDetailed(opts = {}) {
  const { sessionId, type, limit } = opts
  const bounded =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
  const cap = bounded ? Math.floor(limit) : Infinity
  const result = {
    rows: [],
    complete: true,
    readErrors: [],
    invalidLines: 0,
    coverage: 'present-files-only',
  }
  if (cap === 0) return { ...result, empty: true, coverage: 'not-scanned' }
  const rawDate =
    typeof opts.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)
      ? opts.date
      : localDate()
  const out = []
  let cursor = 0
  try {
    const files = auditDayFilesOf(rawDate).map((f) => path.join(AUDIT_DIR, f))
    for (const file of files) {
      try {
        forEachLineSync(file, (line) => {
          if (!line.trim()) return
          let rec
          try {
            rec = JSON.parse(line)
            if (!rec || typeof rec !== 'object' || Array.isArray(rec))
              throw new Error('invalid record')
          } catch {
            result.invalidLines++
            return
          }
          if (sessionId != null && rec.sessionID !== sanitizeId(sessionId))
            return
          if (type != null && rec.type !== type) return
          if (out.length < cap) out.push(rec)
          else {
            out[cursor] = rec
            cursor = (cursor + 1) % cap
          }
        })
      } catch (e) {
        result.readErrors.push({ file, error: String(e.message || e) })
      }
    }
  } catch (e) {
    result.readErrors.push({ error: String(e.message || e) })
  }
  result.rows = cursor ? out.slice(cursor).concat(out.slice(0, cursor)) : out
  result.empty = out.length === 0
  result.complete = result.readErrors.length === 0 && result.invalidLines === 0
  return result
}

// 从用户消息源读取原文（quote 锚点数据源）。
// 三个来源按优先级合并：
//   1. $CARLOS_USER_MSGS          —— 启动时注入的 JSON 数组（最直接）
//   2. RUNS_DIR/<sid>/user_msgs.jsonl —— 本会话写入的用户原话（Cindy 路径）
//   3. OpenCode SQLite            —— 宿主是 OpenCode 时直接读它的会话库
// 任何异常 → 返回 null，绝不抛错。
export async function getUserMessages(sid, limit = 20) {
  const out = []

  // 1. 环境变量注入
  try {
    const envMsgs = process.env.CARLOS_USER_MSGS
    if (envMsgs) {
      const arr = JSON.parse(envMsgs)
      if (Array.isArray(arr)) {
        for (const m of arr) if (typeof m === 'string' && m !== '') out.push(m)
      }
    }
  } catch {}

  // 2. 会话目录里的 user_msgs.jsonl
  try {
    const file = path.join(RUNS_DIR, sanitizeId(sid), 'user_msgs.jsonl')
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const rec = JSON.parse(t)
          if (rec && typeof rec.text === 'string' && rec.text !== '')
            out.push(rec.text)
        } catch {}
      }
    }
  } catch {}

  // 3. OpenCode 会话库（宿主是 OpenCode 时的权威来源）
  const fromOpenCode = await getOpenCodeUserMessages(sid, limit)
  if (fromOpenCode && fromOpenCode.length) out.push(...fromOpenCode)

  if (!out.length) return null
  return out.slice(-limit)
}

// 从 OpenCode 的 SQLite 会话库读用户原话。
// 路径可用 OPENCODE_DB_PATH / OPENCODE_DB 覆盖，默认 ~/.local/share/opencode/opencode.db。
// 任何异常（node:sqlite 不可用 / 库不存在 / 表结构变化）→ 返回 null，绝不抛错。
export async function getOpenCodeUserMessages(sid, limit = 20) {
  let db = null
  try {
    const mod = await import('node:sqlite')
    const DatabaseSync = mod && mod.DatabaseSync
    if (typeof DatabaseSync !== 'function') return null
    const dbPath = resolveOpenCodeDb()
    if (!dbPath) return null
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
    } catch {
      db = new DatabaseSync(dbPath, { readonly: true }) // 选项名兜底
    }
    let sql =
      'SELECT p.data AS d FROM part p JOIN message m ON p.message_id=m.id' +
      " WHERE json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text'"
    const params = []
    if (sid) {
      sql += ' AND m.session_id=?'
      params.push(sid)
    }
    sql += ' ORDER BY p.time_created DESC LIMIT ?'
    params.push(limit)
    const rows = db.prepare(sql).all(...params)
    const out = []
    for (const row of rows) {
      let parsed
      try {
        parsed = JSON.parse(row.d)
      } catch {
        continue
      }
      const text = parsed && parsed.text
      if (typeof text === 'string' && text !== '') out.push(text)
    }
    return out
  } catch {
    return null
  } finally {
    if (db) {
      try {
        db.close()
      } catch {}
    }
  }
}

// 写入用户消息到会话目录（供 quote 锚点校验使用）
export function writeUserMessage(sid, text) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'user_msgs.jsonl')
    const rec = JSON.stringify({ ts: new Date().toISOString(), text }) + '\n'
    fs.appendFileSync(file, rec, 'utf8')
    return true
  } catch {
    return false
  }
}

export function pathExists(cwd, p) {
  const abs = path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p)
  return fs.existsSync(abs)
}

export function gitHead(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      shell: false,
    })
    return r.status === 0 ? String(r.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

// card_ts 距今超过 ttlSec → true；无卡（card_ts 缺失/0）不视为过期
export function isStale(state, ttlSec = 14400) {
  const ts = state ? Number(state.card_ts) : 0
  if (!ts) return false
  return Date.now() - ts > ttlSec * 1000
}

// Phase 1-1: 检查 bypass 是否启用
export function isBypassed(state) {
  if (!state || state.bypass !== true) return false
  // 免检必须显式开启（bypass_ts 有值）且发生在当前卡片之后，
  // 否则旧卡片的免检状态会错误地作用于新卡片
  if (!state.bypass_ts) return false
  if (state.card_ts && state.bypass_ts < state.card_ts) return false
  return true
}

// ---------------------------------------------------------------------------
// workspaceFingerprint —— 工作区代码状态指纹
//
// 为什么需要（A1）：
//   原来的 PASS 闸门只看 last_verify 的三个字段（存在 / ok===true / cmd 与卡片一致），
//   **不绑定代码状态**。于是存在这条绕过路径：
//     1. flow_run_verify 跑通 → last_verify = {ok:true, cmd:"npm test"}
//     2. executor 继续改代码（甚至改坏）
//     3. flow_verdict(PASS) → 三个条件全满足 → 放行
//   指纹把「验证通过」绑定到**一次可复现的运行**：验证之后再动过代码，指纹就变了。
//
// 指纹构成：HEAD 提交 + `git diff HEAD` 的全文 + 全部未跟踪文件（路径 + 内容）。
//   · 未跟踪文件必须计入：新建文件是最常见的越界/破坏手段。
//   · `.carlos-flow/` 必须排除：跑一次检查会创建状态目录，计入则立即自我失效。
//
// 非 git 目录：显式返回 {ok:false, reason:"not_a_git_repo"}，**不崩**。
//   Carlos Flow 明确支持非 Git 项目，所以调用方要 fail-open（不阻断 PASS），
//   但要在 flow_status 里如实标注指纹不可用。
export function workspaceFingerprint(cwd) {
  const steps = fingerprintSteps(cwd)
  const first = steps.next()
  if (first.done) return first.value
  const { gitRoot, payload } = first.value
  // 普通Node CLI保持原同步路线及原环境兼容，不冒称Host环境白名单。
  const code = `import fs from 'node:fs'; import { hashWorkspaceContent } from ${JSON.stringify(import.meta.url)}; const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(hashWorkspaceContent(data)));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: gitRoot, env: process.env, windowsHide: true, encoding: 'utf8', input: payload,
    timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  })
  return steps.next(child).value
}

// 同步与Host异步路线共享全部Git采样/结果校验，只在固定哈希执行边界分流。
function* fingerprintSteps(cwd) {
  const dir = cwd || process.cwd()
  const gitOptions = {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }
  const valid = (result) => !result.error && result.status === 0 && !result.signal
  const failed = (phase, result) => ({
    mode: 'pro',
    mode_ts: 0,
    claimed_profile: null,
    ok: false,
    reason: 'git_command_failed',
    phase,
    errorCode: result.error?.code || null,
    status: result.status,
    signal: result.signal || null,
  })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], gitOptions)
  if (!valid(head)) {
    // 只有 Git 自身在固定语言下确认非仓库才保留兼容；未知故障不可冒充非 Git。
    const repo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], gitOptions)
    let discoveryAbsent = true
    try {
      // 先把符号链接解析掉：macOS 的 os.tmpdir() 是 /var/...（真实路径 /private/var/...），
      // 若按原样逐级 lstat，第一层就撞到符号链接，会被误判成“无法确定是否非仓库”。
      let current
      try { current = fs.realpathSync(dir) } catch { current = path.resolve(dir) }
      if (!fs.statSync(current).isDirectory()) discoveryAbsent = false
      while (discoveryAbsent) {
        try {
          fs.lstatSync(path.join(current, '.git'))
          discoveryAbsent = false
          break
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR)
        discoveryAbsent = false
    } catch { discoveryAbsent = false }
    // 非仓库的 fatal 文案有两种：普通目录是 “or any of the parent directories”，
    // 跨挂载点时是 “or any parent up to mount point /mnt” + “Stopping at filesystem boundary”。
    // 只认 fatal 前缀与 status 128，其它错误（权限、损坏）仍然判为 git_command_failed。
    if (discoveryAbsent && !repo.error && !repo.signal && repo.status === 128 &&
        /^fatal: not a git repository \(or (?:any of the parent directories|any parent up to mount point [^)]*)\)/i.test(String(repo.stderr || '').trim())) {
      return { mode: 'pro', mode_ts: 0, claimed_profile: null, ok: false, reason: 'not_a_git_repo' }
    }
    return failed('head', head)
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(String(head.stdout || '').trim()))
    return failed('head', head)
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { ...gitOptions, encoding: null })
  if (!valid(root)) return failed('root', root)
  const rootBytes = root.stdout || Buffer.alloc(0)
  const rootText = rootBytes.toString('utf8')
  if (!Buffer.from(rootText, 'utf8').equals(rootBytes)) return failed('root_encoding', root)
  if (!rootBytes.length || rootBytes[rootBytes.length - 1] !== 10)
    return failed('root_protocol', root)
  // Git 记录仅以 LF 结束；路径自身的 CR 不可剥离，否则会误选相邻有效仓库。
  const gitRoot = rootText.slice(0, -1)
  if (!path.isAbsolute(gitRoot)) return failed('root', root)
  const diff = spawnSync('git', ['diff', 'HEAD', '--no-color'], { ...gitOptions, cwd: gitRoot })
  if (!valid(diff)) return failed('diff', diff)
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { ...gitOptions, cwd: gitRoot, encoding: null },
  )
  if (!valid(untracked)) return failed('untracked', untracked)
  const rawFiles = untracked.stdout || Buffer.alloc(0)
  const fileText = rawFiles.toString('utf8')
  if (!Buffer.from(fileText, 'utf8').equals(rawFiles)) return failed('untracked_encoding', untracked)

  const payload = JSON.stringify({ diff: String(diff.stdout || ''), files: fileText.split('\0').filter(Boolean).sort(), gitRoot, flowHomeAbs: path.resolve(FLOW_HOME) })
  if (Buffer.byteLength(payload) > 8 * 1024 * 1024)
    return { mode: 'pro', mode_ts: 0, claimed_profile: null, ok: false, reason: 'untracked_read_failed', phase: 'hash_input', errorCode: 'ENOBUFS' }
  const child = yield { gitRoot, payload }
  if (!valid(child)) return {
    mode: 'pro', mode_ts: 0, claimed_profile: null,
    ok: false, reason: 'untracked_read_failed', phase: 'hash_child',
    errorCode: child.error?.code || 'CHILD_FAILED', status: child.status, signal: child.signal || null,
  }
  let result
  try { result = JSON.parse(child.stdout) } catch {
    return { mode: 'pro', mode_ts: 0, claimed_profile: null, ok: false, reason: 'untracked_read_failed', phase: 'hash_child', errorCode: 'INVALID_RESULT' }
  }
  if (result.ok !== true || !/^[a-f0-9]{64}$/.test(result.diff_sha256 || ''))
    return { mode: 'pro', mode_ts: 0, claimed_profile: null, ok: false, reason: 'untracked_read_failed', phase: result.phase || 'hash_child', errorCode: result.errorCode || 'INVALID_RESULT' }
  return { mode: 'pro', mode_ts: 0, claimed_profile: null, ok: true, head: String(head.stdout).trim(), diff_sha256: result.diff_sha256 }
}

// 内部请求能力不接受JSON参数或自报函数；每条真实收行独立捕获。
const hashContexts = new WeakSet()
/**
 * 把宿主已发布的 `spawnEntry(entry, argv)` 适配成 bindLaunch 形状。
 *
 * 已发布的 Cindy 只向插件暴露 spawnEntry（node.entry / node.entries 内的 JS 子入口），
 * 没有 bindLaunch。旧代码只认 bindLaunch，于是把“宿主有这个能力”误判成
 * HOST_HASH_UNSUPPORTED，验证与 PASS 裁定全部被拦。这里只做接口适配，
 * 哈希仍然在独立子进程里算，不退回同进程自证。
 */
function bindSpawnEntryLaunch(spawnEntry) {
  return async (relative, args, options = {}) => {
    const child = await spawnEntry(relative, args)
    const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : 5000
    let settled = false
    let timer
    const completion = new Promise((resolve) => {
      const settle = (receipt) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(Object.freeze(receipt))
      }
      timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        settle({ status: 'killed', completionScope: 'direct', code: null, signal: null })
      }, deadlineMs)
      timer.unref?.()
      child.on('exit', (code, signal) => settle({ status: 'exited', completionScope: 'direct', code, signal }))
      child.on('error', () => settle({ status: 'error', completionScope: 'direct', code: null, signal: null }))
    })
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: child.stdin,
      kill: () => { try { child.kill() } catch { /* 已退出 */ } },
      completion,
    }
  }
}

export function captureHashContext() {
  let context
  try {
    const host = globalThis.__CINDY_NODE__
    if (host === undefined) context = { host: false }
    // 新宿主：绑定式启动（带完成回执）。
    else if (typeof host.bindLaunch === 'function') context = { host: true, launch: host.bindLaunch() }
    // 已发布宿主：只暴露 spawnEntry，适配成同一形状。
    else if (typeof host.spawnEntry === 'function') context = { host: true, launch: bindSpawnEntryLaunch(host.spawnEntry) }
    else context = { host: true }
    if (context.host && typeof context.launch !== 'function') context.failure = 'HOST_HASH_UNSUPPORTED'
  } catch {
    context = { host: true, failure: 'HOST_HASH_CAPTURE_FAILED' }
  }
  hashContexts.add(context)
  return Object.freeze(context)
}

export async function workspaceFingerprintAsync(cwd, context) {
  const unavailable = (errorCode) => ({ mode: 'pro', mode_ts: 0, claimed_profile: null,
    ok: false, reason: 'untracked_read_failed', phase: 'hash_child', errorCode })
  if (!hashContexts.has(context)) {
    if (globalThis.__CINDY_NODE__ !== undefined) return unavailable('HOST_HASH_UNSUPPORTED')
    return workspaceFingerprint(cwd)
  }
  if (!context.host) return workspaceFingerprint(cwd)
  if (context.failure) return unavailable(context.failure)
  const steps = fingerprintSteps(cwd)
  const first = steps.next()
  if (first.done) return first.value
  let handle
  try { handle = await context.launch('src/state.js', ['--hash-child'], { deadlineMs: 5000 }) } catch {
    return unavailable('HOST_HASH_LAUNCH_FAILED')
  }
  // completion由候选Host保证有界且始终resolve；不另建race丢弃子生命周期。
  const completion = handle.completion
  if (!completion || typeof completion.then !== 'function') {
    handle.kill()
    return unavailable('HOST_HASH_UNSUPPORTED')
  }
  let stdout = ''
  let bytes = 0
  let failed = false
  // 输出可能分开UTF8帧；累计原始字节后统一解码，end与真实退出分别确认。
  const chunks = []
  let ended = false
  let resolveEnd
  const end = new Promise(resolve => { resolveEnd = resolve })
  handle.stdout.on('data', chunk => {
    const data = Buffer.from(chunk)
    if (data.length > 64 * 1024 - bytes) { failed = true; handle.kill(); return }
    bytes += data.length
    chunks.push(data)
  })
  handle.stderr.on('data', chunk => {
    const size = Buffer.byteLength(chunk)
    if (size > 64 * 1024 - bytes) { failed = true; handle.kill() }
    else bytes += size
  })
  const streamError = () => { failed = true; handle.kill(); ended = true; resolveEnd() }
  handle.stdout.on('error', streamError)
  handle.stderr.on('error', streamError)
  handle.stdout.on('end', () => { ended = true; resolveEnd() })
  try {
    const payload = Buffer.from(first.value.payload)
    for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
      if (!handle.stdin.write(payload.subarray(offset, offset + 64 * 1024))) { failed = true; break }
    }
    handle.stdin.end()
  } catch { failed = true; handle.kill() }
  let receipt
  try { receipt = await completion } catch { return unavailable('HOST_HASH_CLEANUP_UNKNOWN') }
  if (receipt?.completionScope !== 'direct' || receipt.status !== 'exited')
    return unavailable('BOUND_LAUNCH_CLEANUP_UNKNOWN')
  // 实际Host先stdout.end再complete；end事件可能在nextTick，不可丢尾部输出。
  if (!ended) await end
  if (failed) return unavailable('HOST_HASH_STREAM_FAILED')
  stdout = Buffer.concat(chunks).toString('utf8')
  return steps.next({ status: receipt.code, signal: receipt.signal, stdout }).value
}

// 仅由上述短命受信子进程运行；读取阶段 metadata / content / close 均在可终止边界内。
export function hashWorkspaceContent({ diff, files, gitRoot, flowHomeAbs }) {
  const h = createHash('sha256')
  h.update(diff)
  const readDeadline = Date.now() + 5000
  let readBytes = 0
  const chunk = Buffer.alloc(64 * 1024)

  // 状态目录必须排除（R3）：跑一次检查就会往里写审计/状态文件，
  // 若计入指纹则「验证 → 落审计 → 记裁定」之间指纹必变 → 每次都误报 STALE。
  //
  // ⚠️ 不能只硬编码 ".carlos-flow/"：状态目录由 CARLOS_FLOW_HOME 决定，
  // 用户完全可以把它设在**项目内部**（如 <repo>/.flowhome），那就会自我失效。
  // 所以这里按**解析后的绝对路径**排除真正的 FLOW_HOME，
  // 同时保留 .carlos-flow/ 的字面排除以兼容默认布局。
  //
  // ⚠️ 比较前必须两边都取规范长名：Windows 上 CARLOS_FLOW_HOME 可能是 8.3 短名
  // （RUNNER~1），而 gitRoot 是长名（runneradmin）；字符串前缀比较会失效，
  // 导致状态文件被计入指纹 → 每写一次状态就 STALE。
  const canon = (p) => {
    try { return fs.realpathSync.native(p) } catch {
      try { return fs.realpathSync(p) } catch { return p }
    }
  }
  const flowHomeCanon = canon(flowHomeAbs)
  const gitRootCanon = canon(gitRoot)
  for (const f of files) {
    const abs = path.resolve(gitRoot, f)
    const absCanon = canon(abs)
    const inFlowHome =
      abs === flowHomeAbs || abs.startsWith(flowHomeAbs + path.sep) ||
      absCanon === flowHomeCanon || absCanon.startsWith(flowHomeCanon + path.sep) ||
      abs === gitRootCanon || absCanon === gitRootCanon
    if (inFlowHome) continue
    if (f.startsWith('.carlos-flow/') || f.startsWith('.carlos-flow\\'))
      continue
    h.update(`\u0000untracked-file:${f}\u0000`)
    let fd
    try {
      if (!fs.lstatSync(abs).isFile()) throw Object.assign(new Error('非普通未跟踪文件'), { code: 'UNTRACKED_TYPE' })
      fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      const before = fs.fstatSync(fd)
      if (!before.isFile()) throw Object.assign(new Error('非普通未跟踪文件'), { code: 'UNTRACKED_TYPE' })
      let fileBytes = 0
      for (;;) {
        if (Date.now() > readDeadline) throw Object.assign(new Error('未跟踪读取超时'), { code: 'ETIMEDOUT' })
        const count = fs.readSync(fd, chunk, 0, chunk.length, null)
        if (!count) break
        fileBytes += count
        readBytes += count
        if (readBytes > 8 * 1024 * 1024) throw Object.assign(new Error('未跟踪内容超限'), { code: 'ENOBUFS' })
        h.update(chunk.subarray(0, count))
      }
      const after = fs.fstatSync(fd)
      const current = fs.lstatSync(abs)
      if (fileBytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs)
        throw Object.assign(new Error('未跟踪文件读取期间变化'), { code: 'UNTRACKED_CHANGED' })
    } catch (e) {
      return { ok: false, reason: 'untracked_read_failed', phase: 'untracked_read', errorCode: e.code || 'UNKNOWN' }
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch (e) {
          return { ok: false, reason: 'untracked_read_failed', phase: 'untracked_close', errorCode: e.code || 'UNKNOWN' }
        }
      }
    }
  }

  if (Date.now() > readDeadline)
    return { ok: false, reason: 'untracked_read_failed', phase: 'untracked_read', errorCode: 'ETIMEDOUT' }
  return {
    mode: 'pro',
    mode_ts: 0,
    claimed_profile: null,
    ok: true,
    diff_sha256: h.digest('hex'),
  }
}

// 只读固定入口：模块导入不激活；参数只作数据，不加载项目代码或启动后继进程。
function runHashChild() {
  const limit = 8 * 1024 * 1024
  const chunks = []
  let bytes = 0
  let finished = false
  let exited = false
  const exitOnce = (code) => {
    if (exited) return
    exited = true
    process.exit(code)
  }
  // 输出错误不再向已坏管道写JSON；回调与事件只允许一次受控退出。
  process.stdout.on('error', () => exitOnce(1))
  const failed = (errorCode) => ({ ok: false, reason: 'untracked_read_failed', phase: 'hash_child', errorCode })
  const timer = setTimeout(() => finish(failed('INPUT_TIMEOUT')), 5000)
  const finish = (result) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    process.stdin.pause()
    chunks.length = 0
    let output = JSON.stringify(result)
    const success = result.ok === true && Buffer.byteLength(output) <= 64 * 1024
    if (Buffer.byteLength(output) > 64 * 1024) output = JSON.stringify(failed('OUTPUT_LIMIT'))
    try {
      process.stdout.write(output, error => exitOnce(!error && success ? 0 : 1))
    } catch {
      exitOnce(1)
    }
  }
  process.stdin.on('error', () => finish(failed('INPUT_ERROR')))
  process.stdin.on('data', (chunk) => {
    if (finished) return
    const size = Buffer.byteLength(chunk)
    if (size > limit - bytes) return finish(failed('INPUT_LIMIT'))
    bytes += size
    chunks.push(Buffer.from(chunk))
  })
  process.stdin.on('end', () => {
    if (finished) return
    try {
      const raw = Buffer.concat(chunks, bytes)
      const text = raw.toString('utf8')
      if (!Buffer.from(text).equals(raw)) return finish(failed('INVALID_INPUT'))
      const data = JSON.parse(text)
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          Object.keys(data).sort().join(',') !== 'diff,files,flowHomeAbs,gitRoot' ||
          typeof data.diff !== 'string' || !Array.isArray(data.files) ||
          data.files.some(f => typeof f !== 'string' || f.includes('\0')) ||
          typeof data.gitRoot !== 'string' || !path.isAbsolute(data.gitRoot) || data.gitRoot.includes('\0') ||
          typeof data.flowHomeAbs !== 'string' || !path.isAbsolute(data.flowHomeAbs) || data.flowHomeAbs.includes('\0'))
        return finish(failed('INVALID_INPUT'))
      const result = hashWorkspaceContent(data)
      if (result.ok === true) return finish(result)
      return finish(failed(/^[A-Z0-9_]{1,64}$/.test(result.errorCode || '') ? result.errorCode : 'HASH_FAILED'))
    } catch {
      finish(failed('INVALID_INPUT'))
    }
  })
}

const hashChildEntry = fileURLToPath(import.meta.url)
if (process.argv[1] === hashChildEntry && path.isAbsolute(process.argv[1])) {
  if (process.argv.length === 3 && process.argv[2] === '--hash-child') runHashChild()
  else process.exitCode = 1
}
