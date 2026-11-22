// carlos-flow MCP server — stdio transport.
// Carlos 工作流的机械门禁工具集（留痕 / 派发 / 裁定 / 审计 / 快照还原计划）。
// 重要：stdout 是 MCP 传输通道，所有日志一律走 stderr。
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'
import { createServer, connect } from 'node:net'
// MCP stdio 服务端：自己实现的零依赖版本（见 src/mcp-stdio.mjs 开头的理由）。
// 不再依赖 @modelcontextprotocol/sdk —— 插件要以 .cindy 形态随包运行，
// 打包会跳过 node_modules，运行期也不许联网装依赖。
import { AsyncLocalStorage } from 'node:async_hooks'
import { serveStdio } from '../mcp-stdio.mjs'
import { PROTOCOL, loadProjectSensitiveConfig } from '../protocol.js'
import { parseCard, validateCard, validateNewFiles, riskTier, isSensitive, pathKey, checkNewFilesBoundary, detectProjectTestCommand, validateAgentMesh } from '../card.js'
import { checkCardScopeRules, checkCommandRules, checkGitDiffRules, checkCodePatternRules, checkPhantomDependencies } from '../rules.js'
import { deriveWizardStatus, generateQASheet } from '../../ui/narrator.js'
import { storageOverview } from '../storage.js'
import {
  loadState,
  saveState,
  defaultState,
  audit as appendAudit,
  readAuditDetailed,
  getUserMessages,
  writeUserMessage,
  pathExists,
  gitHead,
  isStale,
  isBypassed,
  verifyAuditChain,
  withStateLock,
  commitState,
  auditHashMode,
  workspaceFingerprintAsync,
  FLOW_HOME,
  AUDIT_DIR,
  RUNS_DIR,
  sanitizeId,
  sanitizeFields,
} from '../state.js'
import {
  buildContractPrompt,
  snapshotFiles,
  readManifest,
  readManifestAll,
  writeDispatchPrompt,
  saveAgentResult,
  runVerifyCommand,
  runNegativeControl,
  snapshotIdentity,
  computeOutputHash,
  enforceScope,
  formatError,
  MAX_DISPATCH,
} from '../dispatch.js'

const auditRequests = new AsyncLocalStorage()

// 身份只保存摘要；补记载荷使用 state.audit 已脱敏的回执，不保存原始入参/卡片。
const auditIdentity = (value) => {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) :
    v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
const pendingAuditEntries = (state) => {
  const p = state.audit_pending
  if (!p) return []
  if (Array.isArray(p.entries)) return p.entries
  // 老 verdict 标记沿用全门禁重审；无完整载荷的老非 verdict 失败不能猜测补记。
  return p.kind === 'verdict' ? [] : [p]
}
function storeAuditEntries(state, entries) {
  if (entries.length) state.audit_pending = { kind: 'events', entries }
  else delete state.audit_pending
}
const historicalAuditEntries = (state) => state.audit_history_pending || []
const auditCardIdentity = (state) => ({ card_ts: state.card_ts, card_identity: auditIdentity(sanitizeFields(state.card)) })
// 绑定实际接纳/提交的卡快照（按落盘脱敏表示），长操作后不追认届时 latest 卡。
function bindAuditVersion(sid, state) {
  const request = auditRequests.getStore()
  if (request) request.version = { sid, card_ts: state.card_ts, card: structuredClone(sanitizeFields(state.card)) }
  return state
}
const readAuditState = sid => bindAuditVersion(sid, loadState(sid))
const isCurrentAuditFailure = (entry, state) => {
  const same = version => entry.card_ts === version.card_ts && entry.card_identity === version.card_identity
  return same(auditCardIdentity(state)) || !!state.card && (state.audit_scope_ancestors || []).some(same)
}
// 仅明确完整换卡/取消调用；scope 延续绝不迁移。无归属/载荷的老标记保守留在活动队列。
function archiveCardAudit(state) {
  const entries = pendingAuditEntries(state)
  const movable = entries.filter(e => e.id && e.event && e.request && isCurrentAuditFailure(e, state))
  if (!movable.length) return
  const moved = new Set(movable.map(e => e.id))
  const history = historicalAuditEntries(state)
  const known = new Set(history.map(e => e.id))
  state.audit_history_pending = [...history, ...movable.filter(e => !known.has(e.id))]
  storeAuditEntries(state, entries.filter(e => !moved.has(e.id)))
}
const matchesAuditRequest = (entry, request) => typeof entry.request === 'string' && entry.request === request?.identity
const isRetryableVerdict = (entry, state, request) => entry.kind === 'verdict' &&
  entry.card_ts === state.card_ts && entry.card_identity === auditCardIdentity(state).card_identity && matchesAuditRequest(entry, request)

// 原请求重试优先补记，而不是再消费额度/永久 claim 或重跑命令。
// 锁内追加确认后只移除匹配 ID；换卡仍能补记旧卡历史，但不执行旧业务、不产生新卡证据。
async function recoverRequestAudit(sid) {
  const request = auditRequests.getStore()
  const observed = loadState(sid)
  const candidates = state => [
    ...pendingAuditEntries(state).filter(e => matchesAuditRequest(e, request) &&
      !(request.tool === 'flow_verdict' && isRetryableVerdict(e, state, request))),
    ...historicalAuditEntries(state).filter(e => matchesAuditRequest(e, request)),
  ]
  if (!candidates(observed).length) return null
  // 等锁期间另一恢复者可能已清除匹配项；本请求仍只做恢复，不能意外降级为业务重放。
  let recovered
  await commitState(sid, (latest) => {
    recovered = { ok: true, audit_recovered: [], business_replayed: false,
      completed_ok: latest.completed_ok === true, note: '匹配审计已由并发请求补记；本次未执行原业务，请复核 flow_status。' }
    const entries = pendingAuditEntries(latest)
    const history = historicalAuditEntries(latest)
    const matching = candidates(latest)
    if (!matching.length) return
    const removed = new Set()
    for (const entry of matching) {
      if (!entry.event || !entry.id) throw new Error('旧审计待确认缺少可信补记载荷，需人工核验，不能自动清除')
      const receipt = appendAudit('resolution', sid, {
        kind: 'audit_recovery', pending_id: entry.id, card_ts: entry.card_ts,
        card_identity: entry.card_identity, original_event: entry.event,
        business_replayed: false, note: '仅补记原未确认事件，不证明原业务重新执行或完整完成；允许未知追加造成重复',
      })
      if (!receipt.persisted) throw new Error(`审计补记未确认持久化: ${receipt.error}`)
      removed.add(entry.id)
    }
    if (entries.some(e => removed.has(e.id)))
      storeAuditEntries(latest, entries.filter(e => !removed.has(e.id)))
    if (history.some(e => removed.has(e.id))) {
      const remaining = history.filter(e => !removed.has(e.id))
      if (remaining.length) latest.audit_history_pending = remaining
      else delete latest.audit_history_pending
    }
    // 补记只改对应队列，不改完成/验证/领取；旧代恢复不能取消新卡的完成状态。
    recovered = { ok: true, audit_recovered: [...removed], business_replayed: false,
      completed_ok: latest.completed_ok === true, note: '本次仅补记审计，未重跑业务；请核对 flow_status 与原操作产物，需继续业务时另行调用。' }
  })
  return recovered
}

function audit(...args) {
  const sid = args[1]
  // 只读请求版本用于绑定旧事件；绝不在同步审计 API 内写状态。
  const request = auditRequests.getStore()
  const version = request?.version?.sid === sid ? request.version : loadState(sid)
  const receipt = appendAudit(...args)
  if (!receipt.persisted) {
    const failure = {
      id: randomUUID(),
      sid,
      card_ts: args[2]?.card_ts ?? version.card_ts,
      card_identity: auditCardIdentity(version).card_identity,
      request: request?.identity,
      event: Object.fromEntries(Object.entries(receipt).filter(([key]) => !['hash', 'prevHash'].includes(key))),
      kind: args[2]?.kind || args[0],
      failed_at: Date.now(),
      error: receipt.error,
    }
    auditRequests.getStore()?.push(failure)
    throw new Error(`审计未确认持久化，请重试并复核状态: ${receipt.error}`)
  }
  return receipt
}

const log = (msg) => {
  try {
    process.stderr.write(`[carlos-flow] ${msg}\n`)
  } catch {
    /* stderr 不可写时静默 */
  }
}
// 往上找**第一个包含 package.json 的目录**（项目根），处理 server 从包 src 目录启动导致 workdir 错位的场景
function findProjectRoot(dir) {
  if (!dir) return undefined
  let cur = dir
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(cur)
    if (parent === cur) return undefined
    if (existsSync(path.join(cur, 'package.json'))) return cur
    cur = parent
  }
  return undefined
}
// ---- 通用工具函数 ----------------------------------------------------------

// 成功响应：统一注入 ok:true。
//
// 之前各工具的 payload 有的显式写 \`ok: true\`、有的没写（如 flow_audit），
// 于是调用方拿到手的心智模型不一致 —— 想判断成败只能逐个工具记「这个有没有 ok」。
// 现在由 ok() 统一注入：
//   · payload 里没有 ok 字段 → 补上 ok:true
//   · payload 里已有 ok 字段 → 保留原值（不改 ok:false 的语义）
// 这是**增量兼容**：现有调用方读取 total / events / by_type 等字段不受影响。
const ok = (obj) => {
  const payload =
    obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { value: obj }
  const withOk = 'ok' in payload ? payload : { ok: true, ...payload }
  return { content: [{ type: 'text', text: JSON.stringify(withOk, null, 2) }] }
}
// 报错解释层的「模式闸门」。
//
// 背景：guide 模式已经由 guideError() 把技术报错翻译成中文人话，
// 如果 fail() 再追加一层「为什么被拦」的机制说明，用户会看到两段解释（重复且啰嗝）。
// 因此这里用一次性闼门：guideError 真的翻译了 → fail 原样输出；
// 否则（pro 模式 / 未翻译的错误）→ 追加机制说明。
// 翻译标记跟随请求，避免异步请求串扰。

const fail = (message) => {
  // 一次性消费：读完之后立即复位，避免影响下一条错误。
  const request = auditRequests.getStore()
  const alreadyHuman = request?.guideTranslated === true
  if (request) request.guideTranslated = false
  const recovery = message?.recovery
  if (recovery) message = message.message
  const explained = alreadyHuman
    ? String(message)
    : formatError(String(message))
  return {
    content: [{ type: 'text', text: 'ERROR: ' + explained }],
    isError: true,
    ...(recovery ? { structuredContent: { ok: false, code: 'ACTIVATION_INCOMPLETE', recovery } } : {}),
  }
}

// ---- 向导模式（mode==='guide'）报错人话翻译 --------------------------------
//
// 目的：普通用户看不懂技术性门禁报错（STALE / 未 claim / 占位卡未补齐…），
// 在 guide 模式下把技术码翻译成「发生了什么 + 下一步该怎么做」的中文人话。
// pro 模式或未知 mode → 原样返回 technicalMsg，行为绝对不变（向后兼容守护）。
//
// 激活占位卡的「补齐骨架」。
//
// 背景：智能触发只开一张占位卡（scope / acceptance / verify 全空），必须补齐才能开工。
// 旧提示只说「还差三项」，新手 Agent 仍不知道每一项该怎么填，于是在同一个报错上来回空转。
// 现在直接给出一份可复制的调用骨架：已填好的字段原样保留，缺的项用尖括号占位。
// 只在 guide 模式 + 占位卡未补齐时输出，pro 模式零影响。
function activationCardGuide(state) {
  const pending = asStringArray(state && state.activation_pending)
  const card =
    state && state.card && typeof state.card === 'object' ? state.card : {}
  const kept = (v) =>
    Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim()) : []
  const goal =
    typeof card.goal === 'string' && card.goal.trim()
      ? card.goal.trim()
      : '<一句话目标>'
  const quote =
    typeof card.quote === 'string' && card.quote.trim()
      ? card.quote.trim()
      : '<用户原话摘录>'
  const scope = kept(card.scope)
  const acceptance = kept(card.acceptance)
  const verifyCmd =
    card.verify && typeof card.verify.cmd === 'string'
      ? card.verify.cmd.trim()
      : ''
  const skeleton = {
    goal,
    quote,
    scope: scope.length ? scope : ['<要改的文件，仓库根相对路径，可写多个>'],
    acceptance: acceptance.length
      ? acceptance
      : ['<怎么算做完：一条可判定的验收标准>'],
    verify: { cmd: verifyCmd || '<能真正跑起来的验证命令，例如 npm test>' },
    confirmed: false,
  }
  const missing = pending.length ? pending : ['scope', 'acceptance', 'verify']
  return [
    '这张卡还差 ' +
      missing.length +
      ' 项才能开工：' +
      missing.join(' / ') +
      '。',
    '把下面骨架里尖括号的内容换成真实的，再调用一次 flow_submit_requirement 就行（已经填好的字段原样保留）：',
    'flow_submit_requirement(' + JSON.stringify(skeleton, null, 2) + ')',
    '补齐之后才能 flow_claim / flow_dispatch；不需要重新开卡。',
  ].join('\n')
}

// 接入原则：最小侵入——只在**典型门禁拦截点**调用，不做大规模重构。
function guideError(state, technicalMsg) {
  if (!state || state.mode !== 'guide') return technicalMsg
  // 打了这个标记，fail() 就知道「已经是人话」，不再叠机制说明。
  if (auditRequests.getStore()) auditRequests.getStore().guideTranslated = true
  const msg = String(technicalMsg)
  // 按关键词映射到通俗解释 + 操作指引
  const translations = [
    {
      match: /没有留痕|record/,
      human:
        '还没有提交任务卡哦。请先让主 Agent 调用 flow_submit_requirement 提交一张任务卡，把要做的事写清楚，然后才能继续。',
    },
    {
      match: /stale|过期/i,
      human:
        '这张任务卡已经过期了（可能太久没动或者被新的卡替换了）。请重新提交一张新的任务卡（flow_submit_requirement），然后再继续操作。',
    },
    {
      match: /未\s*claim|领取派发名额/,
      human:
        '你还没有领取这次工作的「入场券」。请先调用 flow_claim 领取 executor 或 auditor 角色，领取成功后再派发。',
    },
    {
      match: /占位卡尚未补齐|激活占位卡/,
      human:
        '系统自动创建了一张待填写的任务卡，但还缺少一些必要信息（比如要改哪些文件、怎么算做完了、用什么命令验证）。请先补齐这些信息后重新提交（flow_submit_requirement），补齐后才能开始干活。',
    },
    {
      match: /派发次数已达上限/,
      human:
        '这个任务的派发次数已经用完了，不能再继续派发了。请向用户汇报当前进度，让用户决定是否需要重新开始。',
    },
    {
      match: /非法\s*role/,
      human:
        '角色名称不对哦，只能是 executor（执行者）或 auditor（审计员）这两种。请检查后重试。',
    },
    {
      match: /两轴审查未齐|双轴/,
      human:
        '在宣布任务完成之前，需要先做两项独立审查（规范审查 + 验收审查）。请先调用 flow_audit_axes 派发审查，再由审查员分别提交结论（flow_audit_submit），两轴都通过后才能记 PASS。',
    },
    {
      match: /至少一轴\s*FAIL/,
      human:
        '审查发现了问题，有一项审查没通过。请先修复这些问题，重新跑验证和审查后再试。',
    },
    {
      match: /尚未执行验证|验证.*不能记录\s*PASS/,
      human:
        '还没有运行验证命令来确认改动是否正确。请先调用 flow_run_verify 跑通卡片里指定的验证命令，通过后再记录裁定。',
    },
    {
      match: /验证未通过/,
      human:
        '验证命令跑失败了，说明还有问题没解决。请先修复代码，让验证命令能通过（flow_run_verify），然后再记录裁定。',
    },
    {
      match: /越界改动/,
      human:
        '发现有些改动超出了任务卡允许的范围（改了不该改的文件）。请把多改的文件撤销掉，或者把它们加进任务卡的 scope 列表里重新提交。',
    },
    {
      match: /负对照|falsify/,
      human:
        '需要做一次「反向验证」来证明测试确实在起作用。请先调用 flow_falsify 做负对照，通过后再记录裁定。',
    },
    {
      match: /卡片未指定\s*verify/,
      human:
        '任务卡里没有写验证命令，没法确认改动对不对。请重新提交一张带 verify.cmd 的任务卡（flow_submit_requirement），这样才有办法验证。',
    },
  ]
  // 占位卡未补齐：优先给「可复制的补齐骨架」，而不是只说「还差三项」。
  if (
    Array.isArray(state.activation_pending) &&
    state.activation_pending.length > 0 &&
    /占位卡/.test(msg)
  ) {
    return {
      message: activationCardGuide(state) + '\n（原始提示：' + msg + '）',
      recovery: {
        tool: 'flow_submit_requirement',
        missing: [...state.activation_pending],
        preservedCard: structuredClone(state.card || {}),
        requiresUserFacts: true,
        instructions: '保留已填字段；向用户澄清缺项，不生成授权、范围或验收事实；不得自动确认。',
      },
    }
  }
  for (const t of translations) {
    if (t.match.test(msg)) {
      return t.human + '\n（原始提示：' + msg + '）'
    }
  }
  // 无匹配时仍给人话兜底
  return (
    '遇到一个问题：' +
    msg +
    '\n如果你不确定怎么处理，可以让主 Agent 帮你看看具体原因。'
  )
}

const asStringArray = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : [])

// ---- 路径基准统一 ----------------------------------------------------------
//
// scope 的校验基准必须与 `git diff --name-only` 的基准**完全一致**。
//
// 实测事实：git diff 即使在子目录里执行，输出的也是**仓库根相对路径**；
// 因此校验基准必须与 git 的仓库根一致。拿 process.cwd() 当基准是不行的：
// MCP server 是常驻进程，它的 cwd 是**启动时**的目录（可能是几个月前的旧仓库，
// 也可能只是用户随手打开终端的位置），于是出现「明明文件就在那，却报 scope
// 路径不存在」—— 使用者根本猜不到真实原因是「基准目录不对」。
//
// 口径：一律先求 git 仓库根；非 git 项目才退回调用方给的目录。
const REPO_ROOT_CACHE = new Map()
function resolveRepoRoot(cwd) {
  const base = cwd || process.cwd()
  // 缓存：本函数会 spawn 一次 git，而裁定链路上会被调用多次（scope 自查 / 越界判定）。
  // 只缓存**命中**结果；未命中不缓存 —— 目录可能稍后才变成 git 仓库（测试里就是如此）。
  const cached = REPO_ROOT_CACHE.get(base)
  if (cached !== undefined) return cached
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: base,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: false,
    })
    const top = r.status === 0 ? String(r.stdout || '').trim() : ''
    if (top) {
      if (REPO_ROOT_CACHE.size > 64) REPO_ROOT_CACHE.clear()
      REPO_ROOT_CACHE.set(base, top)
      return top
    }
  } catch {
    /* git 不可用：退回原目录 */
  }
  return base
}

// 派发目录是否落在卡片项目根**之内**（含项目根本身）。
//
// 口径：路径比较用 path.relative（win32 下大小写不敏感、其它平台敏感），
// 与卡片路径键同一套平台语义 —— 同一个项目写成大小写不同的盘符/目录名
// 不应该被判成「另一个项目」。
function dispatchDirInsideProject(cardProjectRoot, dispatchDir) {
  if (!cardProjectRoot || !dispatchDir) return false
  const root = path.resolve(cardProjectRoot)
  const dir = path.resolve(dispatchDir)
  const rel = path.relative(root, dir)
  if (rel === '') return true
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// 卡片文本字段（scope / acceptance / unknowns / assumptions）**保留原始元素类型**，
// 不做任何过滤/转换。
// 背景：早先用 asStringArray（String(x)）会把 null→「null」、{}→「[object Object]」，
// 垃圾串被当成合法验收标准；改成 asTextArray（filter 掉非字符串）虽然堵住了垃圾串，
// 但又让「[null, \"x\"]」静默变成合法的 [\"x\"] —— 严格口径根本没机会判定。
// 现在的做法：**两条入口都保留原样**，由 card.js 的必填校验统一判定
// （文本类数组必须每个元素都是非空字符串）。这样：
//   · 口径唯一，两条入口（结构化 / cardText）行为一致；
//   · 含无效元素的卡片被**明确拒绝**，而不是静默降级或静默过滤；
//   · 无效元素不会落盘、更不会进入 executor 的合同文本。
const asRawArray = (v) => (Array.isArray(v) ? v : [])
const asObject = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : {}

// ---- 新文件授权（new_files）-----------------------------------------------
//
// 语义（与 scope 严格分离，**不放宽** scope 的既有语义）：
//   · scope 里的路径必须**已经存在**；
//   · new_files 表达的是「获授权可以新建的文件」：派发时它们**不存在**，
//     快照按 created:true 记录，事后还原时按「删除」处理。
//
// 校验口径**只有一份**：实现在 src/card.js 的 validateNewFiles（卡片层与提交层共用），
// 入口层只负责把上下文（仓库根 / scope / 授权说明 / 用户原话）喂给它。
// 规则一旦有多份副本就会漂移，而漂移的后果是**门禁口径自相矛盾**
//（落卡时判在仓库内、执行时判在仓库外），所以规则只允许存在一份。
//
// 校验口径全部 fail-closed（任一条不满足即拒绝，且**不落卡**）：
//   ① 必须同时带 confirmed===true 与非空授权说明（newFilesReason）；
//   ② 授权说明必须能在**用户原话**中定位（与 quote 同级锚定）；
//   ③ 数组非空，每项是非空字符串；
//   ④ 按仓库根解析后必须仍在仓库内（拒绝 '..' 逃逸、绝对路径越界、指向仓库外）；
//   ⑤ 已存在的路径一律拒绝：目录拒绝；普通文件提示「已存在文件请放入 scope」；
//   ⑥ 父目录必须已存在（本轮只授权文件，不授权新建目录）；
//   ⑦ 与 scope 重复的路径拒绝；
//   ⑧ 授权列表内部出现重复路径拒绝（同一路径只留一条授权）；
//   ⑨ scope 为空时拒绝（空 scope = fail-closed）。

// 卡片里声明的验证命令（归一化后用于比较）
const cardVerifyCmd = (state) => {
  const c = state && state.card && state.card.verify
  return c && typeof c.cmd === 'string' ? c.cmd.trim() : ''
}

// 真实验证是否已通过：必须存在 flow_run_verify 写入的 last_verify、ok===true，
// 且验证的正是**当前卡片**的 verify.cmd（防止拿旧卡的验证结果冒充新卡）。
const verifyPassed = (state) => {
  const lv = state && state.last_verify
  if (!lv || typeof lv !== 'object') return false
  if (lv.ok !== true) return false
  const want = cardVerifyCmd(state)
  if (!want) return false
  return typeof lv.cmd === 'string' && lv.cmd.trim() === want
}

// 验证状态四态（R4：保持 verify_passed 为 boolean，只**新增**本字段）。
//
//   not_run  —— 没跑过 / 没有对应当前卡片的验证结果
//   fail     —— 跑了但没通过
//   stale    —— 跑通了，但验证之后代码又变了（指纹不一致）—— 这一态正是 A1 要堵的
//   pass     —— 跑通且代码自那以后没动过
//
// 指纹不可用时（非 git 目录）按 fail-open 处理：算 pass，但在 fingerprint 字段里
// 如实标注「不可用」，不装作验证过（A1 R1）。
// 只有确认非 Git 才可兼容放行；未知、截断和超时不构成有效验证证据。
const fingerprintKind = (fp) => {
  if (fp?.ok === false && fp.reason === 'not_a_git_repo') return 'non_git'
  if (fp?.ok === true && typeof fp.head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(fp.head) &&
      typeof fp.diff_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(fp.diff_sha256)) return 'git'
  return 'unknown'
}
const fingerprintFailed = (fp) => fingerprintKind(fp) === 'unknown'
const fingerprintError = (fp) =>
  `工作区指纹读取失败（${fp?.phase || 'unknown'} / ${fp?.errorCode || fp?.reason || 'unavailable'}），不能确认验证有效；请排除 Git 故障后重新验证。`

const verifyState = async (state, runtime) => {
  const lv = state && state.last_verify
  if (!lv || typeof lv !== 'object')
    return { state: 'not_run', fingerprint: 'unavailable' }
  const want = cardVerifyCmd(state)
  if (!want || typeof lv.cmd !== 'string' || lv.cmd.trim() !== want) {
    return { state: 'not_run', fingerprint: 'unavailable' }
  }
  if (lv.ok !== true) return { state: 'fail', fingerprint: 'unavailable' }

  const fpWas = lv.fingerprint
  const fpNow = await workspaceFingerprintAsync(lv.cwd || process.cwd(), runtime)
  // 非 Git 旧记录可能没有指纹字段；仅当前 Git 明确认定非仓库时兼容。
  const legacyNonGit = fpWas == null && fingerprintKind(fpNow) === 'non_git'
  if ((!legacyNonGit && fingerprintFailed(fpWas)) || fingerprintFailed(fpNow))
    return { state: 'fail', fingerprint: 'unavailable' }
  if (legacyNonGit || fingerprintKind(fpWas) === 'non_git' || fingerprintKind(fpNow) === 'non_git')
    return { state: 'pass', fingerprint: 'unavailable' }
  if (fpNow.head !== fpWas.head || fpNow.diff_sha256 !== fpWas.diff_sha256) {
    return { state: 'stale', fingerprint: fpNow.diff_sha256 }
  }
  return { state: 'pass', fingerprint: fpNow.diff_sha256 }
}

// WARN 汇总条数上限：防止 WARN 通胀把返回值灌成噪音，主 Agent 反而开始忽略。
const WARN_FINDINGS_LIMIT = 20

// 汇总两轴的 WARN 结论（坏味道等 judgement call）。
//
// 为什么即时派生、而不是再存一份进 state：
//   WARN 数据本来就在 state.audit_axes 里；再落一份进 state 就得 bump
//   schemaVersion 并写迁移分支，而派生是零迁移、零漂移的。
//
// 口径与双轴门禁完全一致（复用 axisOk 的 card_ts 绑定）：
//   只认 card_ts 与当前卡一致的轴结论 —— 换卡后旧卡的 WARN 必须失效，
//   否则「门禁判未齐、汇总却报 WARN」两种口径会打架。
//
// 附带回答 DIRECTION/LOCAL 路径：返工意见恰恰最需要坏味道清单，
// 所以三种裁定都带这份汇总。
function collectAxisWarnings(state) {
  if (!state || typeof state !== 'object') return []
  const out = []
  // ① 负对照的还原核对失败：改动可能没被完整写回工作区。
  // 这不是「审查意见」而是「环境事实」，优先级最高 —— 放在最前面，
  // 因为它意味着「你以为的改动后状态」可能已经不成立。
  const lf = state.last_falsify
  if (lf && typeof lf === 'object' && lf.restore && lf.restore.ok === false) {
    out.push({
      axis: 'falsify',
      finding:
        '负对照后工作区还原未通过核对：' +
        (lf.restore.mismatched || []).join(', '),
    })
  }
  // ② 两轴里的 WARN（坏味道等 judgement call）
  const ax = state.audit_axes
  if (!ax || typeof ax !== 'object') return out
  for (const name of ['standards', 'spec']) {
    const a = ax[name]
    if (!a || !a.verdict) continue
    if (a.card_ts !== state.card_ts) continue // 旧卡结论不算数
    if (a.verdict !== 'WARN') continue
    const findings = Array.isArray(a.findings) ? a.findings : []
    for (const f of findings) {
      if (out.length >= WARN_FINDINGS_LIMIT) return out
      out.push({ axis: name, finding: String(f) })
    }
  }
  return out
}

// 完整证据身份用于短锁CAS；时间/输出hash/指纹均不可省略。
const evidenceIdentity = (state, falsify = false) => JSON.stringify([
  state.card_ts, state.card, state.last_verify, ...(falsify ? [state.last_falsify] : []),
])

// 「本次执行引入的改动」= 当前改动清单 - 派发时基线。
//
// 裁定（flow_verdict）与自查（flow_check_scope 自动模式）**共用这一份口径**：
// 派发前就存在的未跟踪文件属于基线，不得被当成「本次执行越界」。
// 路径比较用 card.js 的 pathKey（平台感知：win32 折叠大小写、其它平台敏感），
// 与允许集比对同一把。
const introducedChanges = (currentChecked, baseline) => {
  const base = new Set(
    (Array.isArray(baseline) ? baseline : []).map((f) => pathKey(f)),
  )
  return (Array.isArray(currentChecked) ? currentChecked : []).filter(
    (f) => !base.has(pathKey(f)),
  )
}

// ---- 负对照结论的「作废」：失败也必须失败关闭 ------------------------------
//
// 作废 = 把状态里的 last_falsify 清空。作废失败往往正是因为**状态存储坏了**
// （锁损坏 / 超时）—— 这时旧结论还留在状态里，会继续支撑 PASS，
// 门禁就退化成「历史上通过过一次就永远通过」。
// 因此作废失败时除了报错，还必须留下「不可 PASS」的**持久标记**：
// 标记写在状态目录里、不依赖状态锁（状态写不进去时，只有它还能作证），
// 裁定闸看到标记一律拒 PASS。
//
// 三层防线（由弱到强，任何一层生效即拒 PASS）：
//   ① 状态写入成功 → 旧结论真被清空（最理想，什么都不用额外做）；
//   ② 状态写入失败但标记写得进去 → 标记作证，跨进程都拒 PASS；
//   ③ 状态与标记都写不进去 → 落进程内硬拒名单：本进程内一律拒 PASS。
//      此时**没有任何**跨进程持久化手段可用（存储不可写是物理限制），
//      所以只能保证进程内不放行 —— 宁可拒，也不能让旧结论冒充新证据。
const falsifyInvalidationMarker = (sid) =>
  path.join(RUNS_DIR, sanitizeId(sid), 'falsify_invalidation_failed.json')

// 进程内硬拒名单：标记文件写不进去时的兜底（键 = 会话 id）。
// 存储不可写时跨进程持久化在物理上不可能，这里保证的是「本进程内不放行」。
const falsifyInvalidationHardDeny = new Map()

function hardDenyFalsifyInvalidation(sid, cardTs, reason) {
  falsifyInvalidationHardDeny.set(String(sid), {
    card_ts: cardTs === undefined ? null : cardTs,
    reason: String(reason || ''),
    ts: new Date().toISOString(),
  })
}

function clearHardDenyFalsifyInvalidation(sid) {
  falsifyInvalidationHardDeny.delete(String(sid))
}

// 读进程内硬拒记录（裁定闸用）。
function readHardDenyFalsifyInvalidation(sid) {
  const hit = falsifyInvalidationHardDeny.get(String(sid))
  return hit && typeof hit === 'object' ? hit : null
}

function readFalsifyInvalidationFailure(sid) {
  try {
    const parsed = JSON.parse(
      readFileSync(falsifyInvalidationMarker(sid), 'utf8'),
    )
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// 写入「不可 PASS」标记。返回 { ok:true } 或 { ok:false, error }。
// 写不进去必须**如实返回**：忽略返回值等于「既没作废、也没标记」，
// 旧结论会继续支撑 PASS（门禁静默退化）。
function markFalsifyInvalidationFailure(sid, payload) {
  try {
    const file = falsifyInvalidationMarker(sid)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

// 清除「不可 PASS」标记。返回 { ok:true } 或 { ok:false, error }。
// 标记删不掉必须**如实报告**：静默吞掉会让「不可 PASS」永久挡着 PASS，
// 而用户重跑负对照也清不掉（看起来像门禁坏了，却查不到原因）。
// 标记本来就不存在 = 没有残留（ok:true）。
function clearFalsifyInvalidationFailure(sid) {
  try {
    unlinkSync(falsifyInvalidationMarker(sid))
    return { ok: true }
  } catch (e) {
    const code = e && e.code
    if (code === 'ENOENT') return { ok: true }
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

// 作废既有负对照结论。
// 返回 { ok, reason, marker }：
//   · ok=true  → 旧结论已真被清空（marker='none' 或 'cleared'）；
//   · ok=false → 旧结论**仍在**状态里，调用方必须原样报出失败，
//     marker='written'（持久标记已落盘，跨进程拒 PASS）
//     或 marker='not_written'（标记也写不进去：进程内已硬拒 PASS）。
async function invalidateLastFalsify(sid, cardTs, reason, identity) {
  let superseded = false
  try {
    await commitState(sid, (s2) => {
      if (s2.card_ts !== cardTs || (identity && evidenceIdentity(s2, true) !== identity)) {
        superseded = true
        return
      }
      s2.last_falsify = null
    })
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    const marked = markFalsifyInvalidationFailure(sid, {
      ts: new Date().toISOString(),
      card_ts: cardTs === undefined ? null : cardTs,
      reason: reason + '：' + msg,
    })
    if (!marked.ok) {
      // 标记也写不进去 → 没有任何持久化作证手段：进程内硬拒，绝不放行旧结论。
      hardDenyFalsifyInvalidation(
        sid,
        cardTs,
        reason + '：' + msg + '；「不可 PASS」标记写入失败：' + marked.error,
      )
      return {
        ok: false,
        marker: 'not_written',
        reason:
          msg +
          '；且「不可 PASS」标记写入失败（' +
          marked.error +
          '）：无法持久化拒绝 PASS，本进程内已硬拒',
      }
    }
    return { ok: false, marker: 'written', reason: msg }
  }
  if (superseded) return { ok: false, marker: 'superseded', reason: '卡片或证据已变化，拒绝作废新版本证据' }
  // 状态写入成功：旧结论已清空。此时旧的「不可 PASS」标记必须撤销 ——
  // 撤不掉要如实报告（否则它会一直挡着 PASS，且没人知道为什么）。
  const cleared = clearFalsifyInvalidationFailure(sid)
  if (!cleared.ok) {
    hardDenyFalsifyInvalidation(
      sid,
      cardTs,
      '旧的「不可 PASS」标记清除失败：' + cleared.error,
    )
    return {
      ok: true,
      marker: 'clear_failed',
      reason: '旧的「不可 PASS」标记清除失败：' + cleared.error,
    }
  }
  clearHardDenyFalsifyInvalidation(sid)
  return { ok: true, marker: 'cleared', reason: '' }
}


import { issueStaleOffer, claimStaleOffer, staleCaseIdentity } from '../state.js'
export { bindAuditVersion, readAuditState, archiveCardAudit, historicalAuditEntries, auditCardIdentity, isCurrentAuditFailure, auditIdentity, pendingAuditEntries, storeAuditEntries, matchesAuditRequest, isRetryableVerdict, recoverRequestAudit, auditRequests, audit, log, findProjectRoot, ok, fail, activationCardGuide, guideError, asStringArray, REPO_ROOT_CACHE, resolveRepoRoot, dispatchDirInsideProject, asRawArray, asObject, cardVerifyCmd, verifyPassed, fingerprintKind, fingerprintFailed, fingerprintError, verifyState, WARN_FINDINGS_LIMIT, collectAxisWarnings, evidenceIdentity, introducedChanges, falsifyInvalidationMarker, falsifyInvalidationHardDeny, hardDenyFalsifyInvalidation, clearHardDenyFalsifyInvalidation, readHardDenyFalsifyInvalidation, readFalsifyInvalidationFailure, markFalsifyInvalidationFailure, clearFalsifyInvalidationFailure, invalidateLastFalsify, spawnSync, existsSync, readFileSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync, unlinkSync, createServer, connect, AsyncLocalStorage, serveStdio, PROTOCOL, loadProjectSensitiveConfig, parseCard, validateCard, validateNewFiles, riskTier, isSensitive, pathKey, checkNewFilesBoundary, detectProjectTestCommand, validateAgentMesh, checkCardScopeRules, checkCommandRules, checkGitDiffRules, checkCodePatternRules, checkPhantomDependencies, deriveWizardStatus, generateQASheet, storageOverview, loadState, saveState, defaultState, appendAudit, readAuditDetailed, getUserMessages, writeUserMessage, pathExists, gitHead, isStale, isBypassed, verifyAuditChain, withStateLock, commitState, auditHashMode, workspaceFingerprintAsync, FLOW_HOME, AUDIT_DIR, RUNS_DIR, sanitizeId, buildContractPrompt, snapshotFiles, readManifest, readManifestAll, writeDispatchPrompt, saveAgentResult, runVerifyCommand, runNegativeControl, snapshotIdentity, computeOutputHash, enforceScope, formatError, MAX_DISPATCH, path, issueStaleOffer, claimStaleOffer, staleCaseIdentity }
