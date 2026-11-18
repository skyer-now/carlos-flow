// state.js — Carlos 工作流：持久化 / 审计 / quote 数据源（Node ESM，零外部依赖）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

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
export const CURRENT_SCHEMA_VERSION = 4

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
  // 落盘脱敏：`state.card` 可能携带密钥片段（verify.cmd/token/password），
  // 不能明文落盘。sanitizeFields 只脱敏 value，key 名保留。
  const safeState = sanitizeFields(state ?? defaultState())
  const dir = path.join(RUNS_DIR, sanitizeId(sid))
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, 'state.json.tmp')
  const target = path.join(dir, 'state.json')
  fs.writeFileSync(tmp, JSON.stringify(safeState, null, 2), 'utf8')
  fs.renameSync(tmp, target)
  return target
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
 * 持锁超过 staleMs（默认 30s）会被判为陈旧锁并回收，另一个进程随即拿到同一把锁
 * → 两个进程同时写 → 比不加锁更难复现的丢更新。
 */
export async function withStateLock(sid, fn, opts = {}) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid))
  const lockFile = path.join(dir, '.state.lock')
  const timeoutMs = Number(opts.timeoutMs) || 5000
  const staleMs = Number(opts.staleMs) || 30000
  const deadline = Date.now() + timeoutMs
  let acquired = false
  let attempt = 0

  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      // wx = O_CREAT|O_EXCL，文件已存在则抛 EEXIST —— 原子排他
      const fd = fs.openSync(lockFile, 'wx')
      fs.closeSync(fd)
      // 把持有者 pid 写进锁文件：**排他性仍完全由 O_CREAT|O_EXCL 保证**，
      // 写内容只发生在拿到锁之后，用途有两个：
      //   ① 诊断 —— 锁超时时能说清「是哪个进程占着」；
      //   ② 即时回收 —— 持有者崩了（ESRCH）可以立刻回收，不必干等满 staleMs。
      try {
        fs.writeFileSync(lockFile, String(process.pid), 'utf8')
      } catch {
        /* 内容非必需 */
      }
      acquired = true
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // 陈旧锁（持有者已崩溃）→ 回收。两道判定：
      //   ① 锁文件里记录的 pid 已不是活进程（ESRCH）→ 立即回收；
      //   ② 老版本锁文件没有 pid，或 pid 不可解析 → 只能按 mtime 超过 staleMs 判陈旧。
      // EPERM 表示「进程存在但无权发信号」→ 按活着处理，绝不误删别人的锁。
      try {
        const st = fs.statSync(lockFile)
        let holderDead = false
        let holderPid = 0
        try {
          holderPid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10)
          if (
            Number.isInteger(holderPid) &&
            holderPid > 0 &&
            holderPid !== process.pid
          ) {
            try {
              process.kill(holderPid, 0)
            } catch (err) {
              if (err && err.code === 'ESRCH') holderDead = true
            }
          }
        } catch {
          /* 内容读不到：按时间判定 */
        }
        if (holderDead || Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile)
          continue
        }
      } catch {
        continue // 锁刚好被释放，重试
      }
      if (Date.now() > deadline) {
        // 拿不到锁：fail-closed —— 宁可报错也不要在无锁下写状态
        let holder = ''
        try {
          const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10)
          if (Number.isInteger(pid) && pid > 0) holder = `（持有者 pid=${pid}）`
        } catch {
          /* 读不到内容就不提 */
        }
        throw new Error(
          `获取状态锁超时（session=${sanitizeId(sid)}${holder}），请稍后重试`,
        )
      }
      // 指数退避 + 抖动（异步等待，把事件循环让给其它请求）。
      // 固定 15ms 会让多个进程「同步醒来」反复撞在一起（并发套件里表现为偶发超时）；
      // 抖动把重试错开，退避上限 120ms 保证总吞吐不被拖垮。
      attempt++
      const base = Math.min(120, 5 * Math.pow(1.6, attempt))
      const jitter = Math.floor(Math.random() * base * 0.3)
      await sleepAsync(Math.floor(base + jitter))
    }
  }

  try {
    return await fn()
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockFile)
      } catch {
        /* 已回收 */
      }
    }
  }
}

/**
 * 「读最新状态 → 合并 → 写」的短临界区封装。
 *
 * 为什么需要它：flow_run_verify / flow_falsify 的读-改-写窗口横跨整个命令执行期
 * （最长 120s×2），期间别的进程可能提交了新的任务卡或写了别的字段。
 * 正确做法是**命令在锁外跑**，跑完再用这个函数在短锁内重新读最新状态、只合并自己那份结果。
 */
export async function commitState(sid, mutate, opts = {}) {
  return withStateLock(
    sid,
    () => {
      const state = loadState(sid)
      const before = opts.skipUnchanged ? JSON.stringify(state) : null
      const ret = mutate(state)
      if (!opts.skipUnchanged || JSON.stringify(state) !== before)
        saveState(sid, state)
      return ret
    },
    opts,
  )
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
      if (!blocked) return fn()
      if (Date.now() >= until)
        throw new Error('审计回收锁活持有者等待超时，未抢占')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  } finally {
    try {
      cleanupOwnReaperFiles([slot, temp])
    } catch (e) {
      throw new Error(`审计回收锁清理失败: ${e.message}`, { cause: e })
    }
  }
}

// 同步跨进程锁：持有者存活时绝不按年龄抢锁。
function withAuditLock(fn) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true })
  const lock = path.join(AUDIT_DIR, '.append-lock')
  const owner = path.join(lock, 'owner.json')
  const until = Date.now() + 5000
  const candidate = `${lock}.candidate-${process.pid}-${randomBytes(8).toString('hex')}`
  fs.mkdirSync(candidate)
  try {
    fs.writeFileSync(
      path.join(candidate, 'owner.json'),
      JSON.stringify({ pid: process.pid }),
    )
  } catch (e) {
    fs.rmSync(candidate, { recursive: true, force: true })
    throw e
  }
  try {
    for (;;) {
      try {
        // 完整发布持有者目录，避免 mkdir 后进程死亡留下无 owner 的锁。
        fs.renameSync(candidate, lock)
        break
      } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code))
          throw e
        try {
          const { pid } = JSON.parse(fs.readFileSync(owner, 'utf8'))
          if (Number.isInteger(pid) && pid > 0) {
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
                    fs.readFileSync(owner, 'utf8') === JSON.stringify({ pid })
                  ) {
                    const stale = `${lock}.dead-${process.pid}-${Date.now()}`
                    fs.renameSync(lock, stale)
                    fs.rmSync(stale, { recursive: true })
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
      return fn()
    } finally {
      fs.unlinkSync(owner)
      fs.rmdirSync(lock)
    }
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true })
  }
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
  const dir = cwd || process.cwd()
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  })
  if (head.error || head.status !== 0) {
    return {
      mode: 'pro',
      mode_ts: 0,
      claimed_profile: null,
      ok: false,
      reason: 'not_a_git_repo',
    }
  }
  const diff = spawnSync('git', ['diff', 'HEAD', '--no-color'], {
    cwd: dir,
    encoding: 'utf8',
  })
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  )

  const h = createHash('sha256')
  h.update(String(diff.stdout || ''))

  const files = String(untracked.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()

  // 状态目录必须排除（R3）：跑一次检查就会往里写审计/状态文件，
  // 若计入指纹则「验证 → 落审计 → 记裁定」之间指纹必变 → 每次都误报 STALE。
  //
  // ⚠️ 不能只硬编码 ".carlos-flow/"：状态目录由 CARLOS_FLOW_HOME 决定，
  // 用户完全可以把它设在**项目内部**（如 <repo>/.flowhome），那就会自我失效。
  // 所以这里按**解析后的绝对路径**排除真正的 FLOW_HOME，
  // 同时保留 .carlos-flow/ 的字面排除以兼容默认布局。
  const flowHomeAbs = path.resolve(FLOW_HOME)
  for (const f of files) {
    const abs = path.resolve(dir, f)
    const inFlowHome =
      abs === flowHomeAbs || abs.startsWith(flowHomeAbs + path.sep)
    if (inFlowHome) continue
    if (f.startsWith('.carlos-flow/') || f.startsWith('.carlos-flow\\'))
      continue
    h.update(`\u0000untracked-file:${f}\u0000`)
    try {
      const buf = fs.readFileSync(path.join(dir, f))
      // 大文件只入路径 + 大小，不入内容（避免读上万文件/大文件）
      if (buf.length > 1024 * 1024) {
        h.update(`size:${buf.length}`)
      } else {
        h.update(buf)
      }
    } catch (e) {
      h.update(`<<unreadable: ${e}>>`)
    }
  }

  return {
    mode: 'pro',
    mode_ts: 0,
    claimed_profile: null,
    ok: true,
    head: String(head.stdout || '').trim(),
    diff_sha256: h.digest('hex'),
  }
}
