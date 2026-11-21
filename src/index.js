// carlos-flow MCP server — stdio transport.
// Carlos 工作流的机械门禁工具集（留痕 / 派发 / 裁定 / 审计 / 快照还原计划）。
// 重要：stdout 是 MCP 传输通道，所有日志一律走 stderr。
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
import { serveStdio } from './mcp-stdio.mjs'
import { PROTOCOL, loadProjectSensitiveConfig } from './protocol.js'
import { parseCard, validateCard, validateNewFiles, riskTier, isSensitive, pathKey, checkNewFilesBoundary, detectProjectTestCommand, validateAgentMesh } from './card.js'
import { checkCardScopeRules, checkCommandRules, checkGitDiffRules, checkCodePatternRules, checkPhantomDependencies } from './rules.js'
import { deriveWizardStatus, generateQASheet } from '../ui/narrator.js'
import { storageOverview } from './storage.js'
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
} from './state.js'
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
} from './dispatch.js'

const auditRequests = new AsyncLocalStorage()

function audit(...args) {
  const sid = args[1]
  // 只读版本用于拒绝旧失败补偿；绝不在同步审计 API 内写状态。
  const before = loadState(sid)
  const request = auditRequests.getStore()
  const version =
    args[2]?.card_ts !== undefined
      ? before
      : request?.version?.sid === sid
        ? request.version
        : before
  const receipt = appendAudit(...args)
  if (!receipt.persisted) {
    const failure = {
      sid,
      card_ts: args[2]?.card_ts ?? version.card_ts,
      card: JSON.stringify(version.card),
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
let GUIDE_TRANSLATED = false

const fail = (message) => {
  // 一次性消费：读完之后立即复位，避免影响下一条错误。
  const alreadyHuman = GUIDE_TRANSLATED
  GUIDE_TRANSLATED = false
  const explained = alreadyHuman
    ? String(message)
    : formatError(String(message))
  return {
    content: [{ type: 'text', text: 'ERROR: ' + explained }],
    isError: true,
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
  GUIDE_TRANSLATED = true
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
    return activationCardGuide(state) + '\n（原始提示：' + msg + '）'
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
async function invalidateLastFalsify(sid, cardTs, reason) {
  try {
    await commitState(sid, (s2) => {
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

const TOOLS = [
  // 1 -----------------------------------------------------------------------
  {
    name: 'flow_protocol',
    description:
      '读取 Carlos 工作流协议全文（路由档位 T0/T1/T2、四段合同、报告规格、错误分层、状态字段、审计事件类型、免检触发词、任务卡模板）。' +
      '当你不确定该走哪一档、任务卡该怎么写、executor/auditor 报告格式或门禁规则时，先调用本工具拿到权威定义，不要凭记忆猜。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => ok({ protocol: PROTOCOL }),
  },

  // 2 -----------------------------------------------------------------------
  {
    name: 'flow_submit_requirement',
    description:
      '提交（留痕）一张任务卡，作为后续派发的唯一依据。任何 T2 改动前必须先调用本工具。' +
      '可以传结构化参数（goal/quote/scope/newFiles/newFilesReason/acceptance/unknowns/assumptions/files/verify/confirmed），' +
      '也可以直接传 cardText（形如 FLOW_CARD:{...} 的单行 JSON）。' +
      '本工具会做锚点校验（quote 必须能在用户原话里定位）、scope 路径存在性校验、必填字段校验、敏感路径确认；' +
      '新增文件请用 newFiles（相对仓库根、派发时尚不存在）单独授权，必须同时带 confirmed=true 与 newFilesReason；' +
      '校验不通过会返回 ok:false 与 findings，此时不得派发。返回 ok:true 表示留痕成功，可以继续调 flow_claim。',
    inputSchema: {
      type: 'object',
      properties: {
        appendScope: {
          type: 'array',
          items: { type: 'string' },
          description: '经用户确认只追加范围，保留既有派发与快照',
        },
        reason: { type: 'string', description: '追加范围的用户授权说明' },
        goal: { type: 'string', description: '一句话目标（任务卡 objective）' },
        quote: {
          type: 'string',
          description: '用户原话摘录，用于锚点校验，必须能在用户消息中定位',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: '只准改动的文件清单（相对 cwd 的路径）',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '可判定的验收标准',
        },
        unknowns: {
          type: 'array',
          items: { type: 'string' },
          description: '未知/待澄清事项',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: '已做的假设',
        },
        files: {
          type: 'array',
          description: '关键定位点，每项需带 path 与 line',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'number' },
            },
            required: ['path', 'line'],
          },
        },
        verify: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          description: '主 Agent 指定的验证命令',
        },
        confirmed: {
          type: 'boolean',
          description: '敏感路径是否已获用户确认（sensitive 档必须为 true）',
        },
        newFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            '获授权可新建的文件路径（相对仓库根，派发时尚不存在）。' +
            '必须同时带 confirmed=true 与 newFilesReason；已存在的文件请放进 scope',
        },
        newFilesReason: {
          type: 'string',
          description: '新文件授权的用户授权说明（与 newFiles 配套，必填且非空）',
        },
        parallel_plan: {
          type: 'string',
          description: '并行派发计划说明（可选）',
        },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
        userMessages: {
          type: 'array',
          items: { type: 'string' },
          description: '用户原话列表（可选，会与自动读取的结果合并）',
        },
        cardText: {
          type: 'string',
          description:
            '完整任务卡文本，含 FLOW_CARD: 前缀；提供时优先于结构化参数',
        },
        activation: {
          type: 'boolean',
          description:
            'true = 这是智能触发引擎自动开的占位卡；在 scope/acceptance/verify.cmd 补齐前会阻止派发',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        // scope 校验基准 = git 仓库根（与 git diff 同基准）；
        // verify 执行目录 = 调用方显式给的目录，没给才用仓库根。
        const cwdInput = a.cwd || process.cwd()
        const scopeRoot = resolveRepoRoot(cwdInput)
        const execDir = a.cwd || scopeRoot

        if (Object.hasOwn(a, 'appendScope')) {
          const allowed = new Set([
            'sessionId',
            'cwd',
            'appendScope',
            'confirmed',
            'reason',
            'newFiles',
            'newFilesReason',
          ])
          if (Object.keys(a).some((key) => !allowed.has(key)))
            return fail('追加范围不能混用完整重提交参数')
          if (a.confirmed !== true)
            return fail('追加范围需要用户明确确认 confirmed=true')
          if (typeof a.reason !== 'string' || !a.reason.trim())
            return fail('追加范围必须提供授权说明 reason')
          if (!Array.isArray(a.appendScope) || !a.appendScope.length)
            return fail('追加范围必须是非空路径数组')
          if (!loadState(sessionId).card)
            return fail('没有既有任务卡，不能追加范围')
          // ---- 追加新文件授权（与追加 scope 同语义：确认 + 授权说明缺一不可）----
          // 追加的是「获授权可新建的文件」：派发时它们不存在，
          // 追加后卡片的既有派发次数、快照、角色与证据保持不变。
          let newFileAdditions = []
          let newFileReasonText = ''
          // 锚点数据源（用户原话）：与提交路径同源。
          let appendMessages = []
          if (
            Object.hasOwn(a, 'newFiles') &&
            a.newFiles !== undefined &&
            a.newFiles !== null
          ) {
            if (typeof a.newFilesReason !== 'string' || !a.newFilesReason.trim())
              return fail('追加新文件授权必须提供授权说明 newFilesReason')
            const before = loadState(sessionId)
            try {
              const fetched = await getUserMessages(sessionId, 50)
              if (Array.isArray(fetched)) appendMessages = appendMessages.concat(fetched)
            } catch (e) {
              log(`getUserMessages 失败：${e && e.message ? e.message : e}`)
            }
            const checkedNew = validateNewFiles(
              a.newFiles,
              before.card.scope,
              scopeRoot,
              {
                confirmed: true,
                reason: a.newFilesReason,
                userMessages: appendMessages,
              },
            )
            if (!checkedNew.ok) return fail(checkedNew.reason)
            newFileAdditions = checkedNew.files
            newFileReasonText = a.newFilesReason.trim()
          }
          const root = realpathSync(scopeRoot)
          const additions = a.appendScope.map((p) => {
            if (typeof p !== 'string' || !p.trim())
              throw new Error('追加范围包含无效路径')
            const full = realpathSync(
              path.resolve(scopeRoot, p.replace(/\\/g, '/')),
            )
            const rel = path.relative(root, full).replace(/\\/g, '/')
            if (
              !rel ||
              rel === '..' ||
              rel.startsWith('../') ||
              path.isAbsolute(rel) ||
              !statSync(full).isFile()
            ) {
              throw new Error('追加范围必须是仓库内存在的文件')
            }
            return rel
          })
          const appended = await commitState(
            sessionId,
            (latest) => {
              if (!latest.card) throw new Error('没有既有任务卡，不能追加范围')
              if (
                latest.card.env?.project &&
                realpathSync(resolveRepoRoot(latest.card.env.project)) !== root
              ) {
                throw new Error('追加范围的仓库与原卡项目不一致')
              }
              const oldScope = Array.isArray(latest.card.scope)
                ? latest.card.scope
                : []
              // 路径键用**平台感知**的那一把（card.js 的 pathKey）：
              // win32 折叠大小写、其它平台敏感 —— 与授权校验、越界检测同一口径。
              const scopeKey = (p) => pathKey(path.resolve(scopeRoot, p))
              const keys = new Set(oldScope.map(scopeKey))
              const added = additions.filter((p) => {
                const key = scopeKey(p)
                if (keys.has(key)) return false
                keys.add(key)
                return true
              })
              // 新文件授权：去重口径与 scope 追加一致（已存在的不重复加）
              const oldNewFiles = Array.isArray(latest.card.new_files)
                ? latest.card.new_files
                : []
              const newKeys = new Set(oldNewFiles.map(scopeKey))
              for (const p of oldScope) newKeys.add(scopeKey(p))
              const addedNewFiles = newFileAdditions.filter((p) => {
                const key = scopeKey(p)
                if (newKeys.has(key)) return false
                newKeys.add(key)
                return true
              })
              if (!added.length && !addedNewFiles.length)
                return {
                  added: [],
                  added_new_files: [],
                  card_ts: latest.card_ts,
                  preserved_dispatch: true,
                }
              // 逐文件保留新文件授权依据：旧文件的授权说明**不得被新说明覆盖**
              // （否则追加一次就把之前的授权依据抹掉了，事后无法回答「当时凭什么授权的」）。
              const oldNewFilesReasons =
                latest.card.new_files_reasons &&
                typeof latest.card.new_files_reasons === 'object'
                  ? { ...latest.card.new_files_reasons }
                  : {}
              const newFilesReasons = { ...oldNewFilesReasons }
              for (const p of addedNewFiles) {
                newFilesReasons[p] = newFileReasonText
              }
              const candidate = {
                ...latest.card,
                scope: [...oldScope, ...added],
                ...(addedNewFiles.length
                  ? {
                      new_files: [...oldNewFiles, ...addedNewFiles],
                      // 汇总字段只保留**首次**授权说明；逐文件依据见 new_files_reasons。
                      new_files_reason:
                        typeof latest.card.new_files_reason === 'string' &&
                        latest.card.new_files_reason.trim()
                          ? latest.card.new_files_reason
                          : newFileReasonText,
                      new_files_reasons: newFilesReasons,
                    }
                  : {}),
              }
              const checked = validateCard(candidate, {
                // 用户原话 + 原卡的 quote：quote 在落卡时已锚定过，
                // 这里带上它是为了不因为数据源窗口滚动而误杀追加操作。
                userMessages: appendMessages.concat([
                  latest.card.quote || '',
                ]),
                confirmed: true,
                scopeExists: (p) => pathExists(scopeRoot, p),
                repoRoot: scopeRoot,
              })
              if (!checked.ok)
                throw new Error(checked.reason || '追加范围后的卡片不合规')
              const cardTs = Math.max(
                Date.now(),
                Number(latest.card_ts || 0) + 1,
              )
              // 失败审计不触发常规失败补偿；本分支在改卡前必须得到持久化回执。
              const receipt = appendAudit('run', sessionId, {
                kind: 'scope_append_prepared',
                phase: 'prepared',
                reason: a.reason,
                added,
                added_new_files: addedNewFiles,
                previous_card_ts: latest.card_ts,
                card_ts: cardTs,
                preserved_dispatch: true,
              })
              if (!receipt.persisted)
                throw new Error(`追加范围审计未确认持久化: ${receipt.error}`)
              latest.card = candidate
              latest.card_ts = cardTs
              latest.tier = riskTier(candidate.scope)
              latest.last_verify = null
              latest.last_falsify = null
              latest.audit_axes = { standards: null, spec: null }
              latest.audit_axes_ts = 0
              latest.verdict = null
              latest.verdict_role = null
              latest.completed_ok = false
              delete latest.audit_pending
              return {
                added,
                added_new_files: addedNewFiles,
                card_ts: cardTs,
                preserved_dispatch: true,
              }
            },
            { skipUnchanged: true },
          )
          // ---- 追加的新文件必须补记快照（created:true）----
          //
          // 为什么：负对照的「改动前态」来自派发快照。如果追加授权的新文件
          // 没有进快照，负对照还原不到「它们不存在」的改动前态 ——
          // 验证命令在「改动前」照样通过 → 负对照变成 vacuous（空测试）。
          // 补记的条目在还原时按「删除该文件」处理。
          if (appended && Array.isArray(appended.added_new_files) && appended.added_new_files.length) {
            try {
              snapshotFiles(sessionId, appended.added_new_files, scopeRoot)
            } catch (e) {
              // 补记失败必须如实报告：卡片已生效，但负对照会失去判别力。
              audit('run', sessionId, {
                kind: 'snapshot',
                role: 'append_scope',
                files: appended.added_new_files.length,
                new_files: appended.added_new_files.length,
                ok: false,
                error: e && e.message ? e.message : String(e),
              })
              return fail(
                '追加范围已生效，但补记新文件快照失败：' +
                  (e && e.message ? e.message : String(e)) +
                  '（负对照将无法还原到改动前态，请重新派发后再做负对照）',
              )
            }
          }
          return ok({
            ok: true,
            ...appended,
            preserved: '既有派发次数、基线、角色及所有快照保持不变',
          })
        }

        let card = null
        if (typeof a.cardText === 'string' && a.cardText.trim() !== '') {
          const parsed = parseCard(a.cardText)
          if (parsed && parsed.error) return fail(parsed.error)
          if (!parsed || !parsed.card)
            return fail(
              'FLOW_CARD 解析失败：请按模板重写（单行 JSON，英文双引号）。',
            )
          card = parsed.card
        } else {
          card = {
            goal: a.goal,
            quote: a.quote,
            scope: asRawArray(a.scope),
            acceptance: asRawArray(a.acceptance),
            unknowns: asRawArray(a.unknowns),
            assumptions: asRawArray(a.assumptions),
            files: Array.isArray(a.files) ? a.files : [],
            verify: asObject(a.verify),
            confirmed: a.confirmed === true,
          }
          // Auto-Verify: 若未显式传入 verify.cmd，且调用方显式提供了非空 scope 时，才推断测试命令
          // （防止在空 scope 或未初始化的普通卡上提前填入 verify.cmd 导致 activation_pending 丢失 verify.cmd 校验项）
          const hasExplicitScope = Array.isArray(a.scope) && a.scope.length > 0
          if (!a.activation && hasExplicitScope && (!card.verify || !card.verify.cmd)) {
            const detectedCmd = detectProjectTestCommand(scopeRoot || execDir);
            if (detectedCmd) {
              card.verify = { ...(card.verify || {}), cmd: detectedCmd, autoInferred: true };
            }
          }
          if (typeof a.parallel_plan === 'string' && a.parallel_plan !== '')
            card.parallel_plan = a.parallel_plan
        }

        // 锚点数据源：调用方传入的 userMessages + 自动从 opencode SQLite 读取的用户原话
        // （quote 与**新文件授权说明**共用这一份数据源 —— 两者都是「能在用户原话中定位」的锚点）
        let messages = asStringArray(a.userMessages)
        try {
          const fetched = await getUserMessages(sessionId, 20)
          if (Array.isArray(fetched)) messages = messages.concat(fetched)
        } catch (e) {
          log(`getUserMessages 失败：${e && e.message ? e.message : e}`)
        }

        // ---- 新文件授权：两条入口（结构化参数 / cardText）口径必须一致 ----
        //
        // 结构化入口用 newFiles / newFilesReason；
        // cardText 入口用卡片里的 new_files（授权说明可放 new_files_reason）。
        // 两条入口的拒绝条件完全相同，否则 cardText 路径就能绕开门禁。
        //
        // **冲突必须显式拒绝**：cardText 里已经声明了 new_files（或 new_files_reason），
        // 而参数里又给了 newFiles（或 newFilesReason）—— 两处都声明了授权依据，
        // 静默取其中一份等于「把另一份授权依据丢掉」。宁可报错让调用方自己说清用哪份。
        // 两处**完全一致**时不算冲突（没有丢信息），不算冲突时直接按同一份处理。
        const paramHasNewFiles =
          Object.hasOwn(a, 'newFiles') &&
          a.newFiles !== undefined &&
          a.newFiles !== null
        const paramHasNewFilesReason =
          typeof a.newFilesReason === 'string' && a.newFilesReason.trim() !== ''
        const cardHasNewFiles =
          Array.isArray(card.new_files) && card.new_files.length > 0
        const cardHasNewFilesReason =
          typeof card.new_files_reason === 'string' &&
          card.new_files_reason.trim() !== ''
        const sameFileList =
          cardHasNewFiles &&
          paramHasNewFiles &&
          JSON.stringify(card.new_files) === JSON.stringify(a.newFiles)
        if (cardHasNewFiles && paramHasNewFiles && !sameFileList) {
          return fail(
            'cardText 里的 new_files 与参数 newFiles 冲突：两处都声明了获授权的新文件，' +
              '请只保留其中一处（不要静默丢弃其中一份授权依据）',
          )
        }
        if (
          cardHasNewFilesReason &&
          paramHasNewFilesReason &&
          card.new_files_reason.trim() !== a.newFilesReason.trim()
        ) {
          return fail(
            'cardText 里的 new_files_reason 与参数 newFilesReason 冲突：两处都声明了授权说明，' +
              '请只保留其中一处',
          )
        }
        let newFilesInput = null
        let newFilesReasonText = ''
        if (paramHasNewFiles) {
          newFilesInput = a.newFiles
          newFilesReasonText =
            typeof a.newFilesReason === 'string' ? a.newFilesReason.trim() : ''
        } else if (cardHasNewFiles) {
          newFilesInput = card.new_files
          newFilesReasonText = paramHasNewFilesReason
            ? a.newFilesReason.trim()
            : card.new_files_reason.trim()
        }
        if (newFilesInput) {
          const tierNow = riskTier(card.scope)
          const rejectNewFiles = (reason, findings) => {
            for (const f of findings || [])
              audit('finding', sessionId, {
                kind: 'card_finding',
                detail: f,
                tier: tierNow,
              })
            audit('decision', sessionId, {
              kind: 'blocked',
              reason,
              tier: tierNow,
            })
            return ok({ ok: false, reason, findings: findings || [], tier: tierNow })
          }
          // 规则本体在 src/card.js 的 validateNewFiles（卡片层与提交层同一份）。
          // 这里只负责把上下文喂进去：仓库根 / scope / 授权说明 / 用户原话。
          const checkedNew = validateNewFiles(
            newFilesInput,
            card.scope,
            scopeRoot,
            {
              confirmed: a.confirmed === true || card.confirmed === true,
              reason: newFilesReasonText,
              userMessages: messages,
            },
          )
          if (!checkedNew.ok)
            return rejectNewFiles(checkedNew.reason, checkedNew.findings)
          card.new_files = checkedNew.files
          // 授权说明随卡片落盘：卡片层复核时要求它存在（非空），
          // 事后审计也能看到「当时凭什么授权了这个新文件」。
          card.new_files_reason = newFilesReasonText
          // 逐文件保留授权依据：追加授权时旧文件的说明不得被覆盖。
          card.new_files_reasons = Object.fromEntries(
            checkedNew.files.map((f) => [f, newFilesReasonText]),
          )
        }

        const options = {
          userMessages: messages,
          scopeExists: (p) => pathExists(scopeRoot, p),
          // 走 cardText 提交的卡片，其自身的 confirmed 字段同样必须生效，否则敏感路径永远无法通过
          confirmed: a.confirmed === true || card.confirmed === true,
          // new_files 的仓库边界由 card.js 的 validateNewFiles 统一判定（不再各写一份）
          repoRoot: scopeRoot,
        }

        // 多 Agent 网格校验
        if (a.agents && typeof a.agents === 'object') {
          const meshCheck = validateAgentMesh(a.agents, card.scope)
          if (!meshCheck.ok) {
            return fail(meshCheck.reason)
          }
          card.agents = meshCheck.agents
        }

        // 15条通用防撞规则：在提交层前置校验白名单敏感资产 (R1~R3, R15)
        // 占位卡阶段（空 scope）或只读调研不阻断
        const isActivationInit = a.activation === true || card.activation === true
        if (!isActivationInit && Array.isArray(card.scope) && card.scope.length > 0) {
          const scopeRulesCheck = checkCardScopeRules(card.scope, card.new_files, {
            confirmed: a.confirmed === true || card.confirmed === true,
          })
          if (!scopeRulesCheck.ok) {
            const failViolation = scopeRulesCheck.violations.find((v) => v.level === 'FAIL')
            if (failViolation) {
              audit('decision', sessionId, {
                kind: 'blocked',
                rule: failViolation.rule,
                reason: failViolation.message,
                tier: riskTier(card.scope),
              })
              return ok({
                ok: false,
                reason: `${failViolation.message}\n💡 提示：${failViolation.hint}`,
                findings: [failViolation.message],
                tier: riskTier(card.scope),
              })
            }
          }
        }

        const tier = riskTier(card.scope)
        const result = validateCard(card, options)
        const findings =
          result && Array.isArray(result.findings) ? result.findings : []

        if (!result || result.ok !== true) {
          const reason = (result && result.reason) || '卡片不合规'
          for (const f of findings)
            audit('finding', sessionId, {
              kind: 'card_finding',
              detail: f,
              tier,
            })
          audit('decision', sessionId, { kind: 'blocked', reason, tier })
          return ok({ ok: false, reason, findings, tier })
        }

        card.env = { git_head: gitHead(execDir), project: execDir }

        // ---- 闸门待补项：服务端从当前卡片内容**幂等派生** ----
        // 内容判定：与 validateCard 的必填字段口径**严格一致**（两边都要求
        // 「每个元素都是非空字符串」）。acceptance=[""] / [null] / ["a",null] 这类
        // 含无效元素的伪填充，既不算卡片合规，也不算闸门已补齐 —— 统一卡严，避免绕过。
        const cardHasScope =
          Array.isArray(card.scope) &&
          card.scope.length > 0 &&
          card.scope.every(
            (p) =>
              typeof p === 'string' &&
              p.trim() !== '' &&
              p !== '.' &&
              p !== '..',
          )
        const cardHasAcceptance =
          Array.isArray(card.acceptance) &&
          card.acceptance.length > 0 &&
          card.acceptance.every((x) => typeof x === 'string' && x.trim() !== '')
        const cardHasVerify = !!(
          card.verify &&
          typeof card.verify.cmd === 'string' &&
          card.verify.cmd.trim() !== ''
        )
        const currentMissing = [
          ...(!cardHasScope ? ['scope'] : []),
          ...(!cardHasAcceptance ? ['acceptance'] : []),
          ...(!cardHasVerify ? ['verify.cmd'] : []),
        ]

        // activation 标记既可能来自工具参数（结构化提交），也可能来自卡片本身（cardText 提交）。
        // 两条路径必须一致，否则 cardText 路径可以完全绕开闸门。
        const isActivation = a.activation === true || card.activation === true

        // ---- 读-改-写放进跨进程排他锁 ----
        // 多个 MCP server 进程共享同一 CARLOS_FLOW_HOME 时，未加锁会丢更新：
        // 后写入者用过期 prevState 算出 pending=[]，而它写的卡片字段仍为空 ⇒ 闸门被绕过。
        const gated = await withStateLock(sessionId, () => {
          const prev = loadState(sessionId)
          const wasActivatedBefore = prev.activation_activated === true
          const prevPendingBefore = Array.isArray(prev.activation_pending)
            ? prev.activation_pending
            : []

          let activationPending
          if (isActivation) {
            // 显式占位卡：待补项 = 服务端从这张卡实际缺什么推导出来的。
            activationPending = currentMissing
          } else if (wasActivatedBefore) {
            // 该会话开过占位卡：继续按**当前卡片实际缺什么**锁定。
            // 幂等派生（而不是「上一轮 pending 传递」），所以即使并发丢更新，
            // 落盘的 pending 永远与同一份落盘卡片一致，不会出现「卡片空却 pending=[]」。
            activationPending = currentMissing
          } else {
            // 普通卡（未标 activation，且本会话从未激活过）：不上闸门。
            // 档位必填项已由 validateCard 按 tier 强制（read_only 只要 goal+quote），
            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = []
          }

          const state = {
            ...defaultState(),
            ...prev,
            card,
            card_ts: Date.now(),
            tier,
            dispatch_count: 0,
            claimed: false,
            claimed_role: null,
            write_files: 0,
            last_user_ts: Date.now(),
            bypass: false,
            verdict: null,
            completed_ok: false,
            stale: false,
            activation_pending: activationPending,
            // 单调标记：一旦激活过就永不清除
            activation_activated: isActivation || wasActivatedBefore,
          }
          saveState(sessionId, state)
          return {
            state,
            activationPending,
            wasActivatedBefore,
            prevPendingBefore,
          }
        })

        const {
          state,
          activationPending,
          wasActivatedBefore,
          prevPendingBefore,
        } = gated

        // 闸门事件：建立 / 保持 / 解除，都要在审计链里留痕。
        if (isActivation) {
          audit('decision', sessionId, {
            kind: 'activation_gate_activated',
            reason: '智能触发占位卡激活（服务端从卡片内容派生待补字段）',
            pending: activationPending,
          })
        } else if (
          wasActivatedBefore &&
          prevPendingBefore.length > 0 &&
          activationPending.length === 0
        ) {
          // 解锁事件统一由「pending 由非空变空」触发，避免被误记成 activated。
          audit('decision', sessionId, {
            kind: 'activation_gate_unlocked',
            reason: '字段已补齐，激活闸门解除',
            released: prevPendingBefore,
          })
        } else if (wasActivatedBefore && activationPending.length > 0) {
          audit('decision', sessionId, {
            kind: 'activation_gate_held',
            reason: '字段尚未补齐，激活闸门继续保持',
            pending: activationPending,
          })
        }

        audit('run', sessionId, { kind: 'record', tier, goal: card.goal })
        audit('decision', sessionId, {
          kind: 'accepted',
          tier,
          goal: card.goal,
        })
        for (const f of findings)
          audit('finding', sessionId, { kind: 'card_finding', detail: f, tier })

        // 激活占位卡建立 / 闸门解除都要在审计链里留专属事件，
        // 否则事后无法从 gate-audit 流水回答「这是不是占位卡、有没有解闸过」。
        if (isActivation) {
          audit('run', sessionId, {
            kind: 'activation',
            tier,
            goal: card.goal,
            pending: activationPending,
          })
        } else if (
          wasActivatedBefore &&
          prevPendingBefore.length > 0 &&
          activationPending.length === 0
        ) {
          audit('decision', sessionId, {
            kind: 'activation_released',
            tier,
            goal: card.goal,
            released: prevPendingBefore,
          })
        }

        const sensitivePaths = (
          Array.isArray(card.scope) ? card.scope : []
        ).filter((p) => isSensitive(p))

        return ok({
          ok: true,
          tier,
          findings,
          card,
          state,
          sensitive: sensitivePaths,
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 3 -----------------------------------------------------------------------
  {
    name: 'flow_claim',
    description:
      '领取一次派发名额（executor 或 auditor）。返回四段合同 prompt，可直接作为子 Agent 的任务描述。' +
      '前置条件：必须有 flow_submit_requirement 留下的卡；卡过期（stale）或派发次数达到上限会直接报错。' +
      '每次 claim 都会消耗一次派发额度，重复 claim 前先想清楚是否必要。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        role: {
          type: 'string',
          enum: ['executor', 'auditor'],
          description: '领取角色',
        },
      },
    },
    handler: async (args) => {
      try {
        // Phase 1-1: role 白名单校验（非法值必须报错，不得静默降级）
        const a = args || {}
        const rawRole =
          a.role === undefined || a.role === null || a.role === ''
            ? 'executor'
            : String(a.role)
        if (rawRole !== 'executor' && rawRole !== 'auditor') {
          return fail('非法 role：' + rawRole + '，必须是 executor 或 auditor')
        }
        const role = rawRole
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)

        if (!state.card) {
          return fail(
            guideError(
              state,
              '没有留痕（record），executor/auditor 不得开工。请先由主 Agent 调用 flow_submit_requirement 提交任务卡。',
            ),
          )
        }
        if (isStale(state)) {
          return fail(
            guideError(state, '留痕已过期（stale），请重新提交任务卡。'),
          )
        }
        if (state.dispatch_count >= MAX_DISPATCH) {
          return fail(
            guideError(
              state,
              '派发次数已达上限 ' + MAX_DISPATCH + '，停止派发并向用户汇报。',
            ),
          )
        }
        // 激活占位卡闸门：占位卡未补齐字段时不允许领取派发名额
        if (
          Array.isArray(state.activation_pending) &&
          state.activation_pending.length > 0
        ) {
          return fail(
            guideError(
              state,
              '激活占位卡尚未补齐（待补：' +
                state.activation_pending.join('、') +
                '）。请先补齐后重新调用 flow_submit_requirement，再来领取派发名额。',
            ),
          )
        }

        // Phase 1-1: 不在 claim 时增加 dispatch_count，改在 dispatch 时增加
        // claim 只标记已领取（state.claimed），不消耗派发额度。
        // 读-改-写放进短锁：上面刚做完整卡校验，这里用最新状态合并，
        // 避免把「校验时的快照」整体写回、回滚掉别人在间隙里写的字段。
        await commitState(sessionId, (latest) => {
          latest.claimed = true
          latest.claimed_role = role
          latest.last_user_ts = Date.now()
          state.claimed = latest.claimed
          state.claimed_role = latest.claimed_role
        })

        audit('decision', sessionId, {
          kind: 'claimed',
          role,
          dispatch_count: state.dispatch_count,
        })

        const result = {
          ok: true,
          role,
          card: state.card,
          tier: state.tier,
          dispatch_count: state.dispatch_count,
          prompt: buildContractPrompt(role, state.card),
        }
        if (state.bypass === true) result.bypass = true
        return ok(result)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 4 -----------------------------------------------------------------------
  {
    name: 'flow_dispatch',
    description:
      '按四段合同派发子 Agent（executor 写代码 / auditor 独立复核）。' +
      '派发前会自动对 scope 内文件做快照（用于事后还原），message 会以原样附在合同末尾。' +
      'run=false（默认）只生成 prompt 供你自己派子 Agent；run=true 则由本工具拉起 opencode 子进程直接跑并回传 stdout/stderr。' +
      '必须先 flow_submit_requirement 留痕，否则报错。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        role: {
          type: 'string',
          enum: ['executor', 'auditor'],
          description: '派发角色',
        },
        message: { type: 'string', description: '附加说明，原样附在合同末尾' },
        run: {
          type: 'boolean',
          description:
            'true = 由本工具直接运行 opencode；false/absent = 只返回 prompt',
        },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        // Phase 1-1: role 白名单校验（非法值必须报错，不得静默降级）
        const rawRole =
          a.role === undefined || a.role === null || a.role === ''
            ? 'executor'
            : String(a.role)
        if (rawRole !== 'executor' && rawRole !== 'auditor') {
          return fail('非法 role：' + rawRole + '，必须是 executor 或 auditor')
        }
        const role = rawRole

        // Phase 1-1: dispatch 前强制校验 stale / dispatch_count / claim
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        if (!state.card)
          return fail(guideError(state, '没有留痕，不允许派发。'))
        if (isStale(state))
          return fail(
            guideError(state, '留痕已过期（stale），请重新提交任务卡。'),
          )
        if (state.dispatch_count >= MAX_DISPATCH)
          return fail(
            guideError(
              state,
              '派发次数已达上限 ' + MAX_DISPATCH + '，停止派发并向用户汇报。',
            ),
          )
        // 激活占位卡闸门：占位卡未补齐字段时不允许派发
        if (
          Array.isArray(state.activation_pending) &&
          state.activation_pending.length > 0
        ) {
          return fail(
            guideError(
              state,
              '激活占位卡尚未补齐（待补：' +
                state.activation_pending.join('、') +
                '）。请先补齐后重新调用 flow_submit_requirement，再来派发。',
            ),
          )
        }
        // 必须先 flow_claim 领取派发名额（claimed 标记由 claim 设置）
        if (state.claimed !== true)
          return fail(
            guideError(state, '未 claim，请先 flow_claim 领取派发名额。'),
          )

        // 派发基准必须**按卡片登记的项目根**（card.env.project）：
        // scope 是仓库根相对路径，snapshot / baseline / 裁定三处要用同一个基准，
        // 否则越界判定会自相矛盾。
        //
        // 为什么不能拿「派发时 cwd 的仓库根」当基准：授权（落卡）与执行（派发）
        // 可能不在同一个仓库/目录 —— 拿新根复核等于「换个基准重新判一次」，
        // 原本越出卡片项目根的授权路径会被判成「在新根里没越界」。
        // 口径：卡片登记了项目根时，**一律按它复核**；
        // 派发目录不在卡片项目根之内 → 明确拒绝派发并说明原因。
        const newFiles = Array.isArray(state.card.new_files)
          ? state.card.new_files
          : []
        const cardProjectRaw =
          state.card && state.card.env && typeof state.card.env.project === 'string'
            ? state.card.env.project
            : ''
        const cardProjectRoot = cardProjectRaw.trim()
          ? resolveRepoRoot(cardProjectRaw)
          : ''
        // 派发目录：显式给了就用它；没给就回落到卡片项目根
        // （卡片已经定义了「这次工作在哪个项目」，没给 cwd 不是「换个项目」）。
        const dispatchRoot = a.cwd
          ? resolveRepoRoot(a.cwd)
          : cardProjectRoot || resolveRepoRoot(process.cwd())
        if (!cardProjectRoot) {
          // 卡片没登记项目根 → 无从复核授权路径的边界（fail-open 风险）。
          // 有待复核的新文件时不得派发。
          if (newFiles.length > 0) {
            audit('decision', sessionId, {
              kind: 'dispatch_project_root_missing',
              dispatch_root: dispatchRoot,
            })
            return fail(
              formatError(
                '卡片未登记项目根（card.env.project），无法按卡片项目根复核新文件授权边界，拒绝派发。' +
                  '请重新提交带工作目录的任务卡。',
              ),
            )
          }
        } else if (!dispatchDirInsideProject(cardProjectRoot, dispatchRoot)) {
          audit('decision', sessionId, {
            kind: 'dispatch_project_root_mismatch',
            card_project_root: cardProjectRoot,
            dispatch_root: dispatchRoot,
          })
          return fail(
            formatError(
              '派发目录与卡片登记的项目根不一致（卡片项目根：' +
                cardProjectRoot +
                '；派发目录：' +
                dispatchRoot +
                '），拒绝派发：新文件授权的越界复核必须按卡片项目根进行。',
            ),
          )
        }
        const cwd = cardProjectRoot || dispatchRoot

        // 获授权的新文件在**派发时**要再核一次真实路径边界。
        //
        // 为什么：授权（落卡）与执行（派发）之间可能隔很久 —— 期间授权路径的
        // 父目录可能被换成指向仓库外的符号链接 / junction。落卡时安全，
        // 执行时文件已经写到仓库外了。
        // 口径与落卡时一致（card.js 的 checkNewFilesBoundary）：解析不出真实路径
        // 一律按保守口径拒绝 → 拒绝派发，并给出原因。
        // 复核的根 = **卡片登记的项目根**（不是派发时 cwd 的仓库根）。
        if (newFiles.length > 0) {
          const boundary = checkNewFilesBoundary(cwd, newFiles)
          if (!boundary.ok) {
            audit('decision', sessionId, {
              kind: 'new_files_boundary_violation',
              reason: boundary.reason,
            })
            return fail(
              formatError(
                '新文件授权路径复核未通过，拒绝派发：' + boundary.reason,
              ),
            )
          }
        }
        // 计数与清零在短锁内合并（不整体回写校验时的快照）
        let bypassReset = false
        await commitState(sessionId, (latest) => {
          latest.dispatch_count = (Number(latest.dispatch_count) || 0) + 1
          // 额度已消耗，需要重新 claim 才能再次派发
          latest.claimed = false
          latest.write_files = 0
          // Phase 1-1: 派发后自动清零免检，避免“忘记关免检”长期生效
          if (latest.bypass === true) {
            latest.bypass = false
            latest.bypass_ts = 0
            bypassReset = true
          }
          state.dispatch_count = latest.dispatch_count
          state.bypass = latest.bypass
        })
        if (bypassReset) {
          audit('decision', sessionId, {
            kind: 'bypass_auto_reset',
            reason: '派发后自动清零',
          })
        }

        const prompt = buildContractPrompt(role, state.card, a.message)

        const scope = Array.isArray(state.card.scope) ? state.card.scope : []
        // 快照必须覆盖「获授权可新建的文件」：它们在派发时尚不存在，
        // snapshotFiles 会按 created:true 记录（派发时不存在 → 还原时删除）。
        const snapshotTargets = [...scope, ...newFiles]
        const entries = snapshotFiles(sessionId, snapshotTargets, cwd)
        audit('run', sessionId, {
          kind: 'snapshot',
          role,
          files: snapshotTargets.length,
          new_files: newFiles.length,
          ok: true,
        })

        // Phase 1-1: 记录「派发前基线」。
        // 使用与后续校验一致的 cwd，修正基准
        const baseline = enforceScope(snapshotTargets, cwd)
        const baselineFiles = Array.isArray(baseline.checked)
          ? baseline.checked
          : []
        // 快照 + git diff 是慢操作，必须在锁外；这里只合并 dispatch_baseline 一个字段
        await commitState(sessionId, (latest) => {
          latest.dispatch_baseline = baselineFiles
          state.dispatch_baseline = baselineFiles
        })
        audit('run', sessionId, {
          kind: 'dispatch_baseline',
          role,
          files: state.dispatch_baseline.length,
        })

        if (a.run === true) {
          // 写入 prompt 文件，供主 Agent 读取后通过 subagent 工具派发
          const { file } = writeDispatchPrompt(sessionId, role, prompt, cwd)
          audit('run', sessionId, { kind: 'dispatch', role, prompt_file: file })
          return ok({
            ok: true,
            role,
            prompt,
            snapshot: entries,
            run: {
              prompt_file: file,
              note: '主 Agent 请读取 prompt_file 内容，使用 subagent 工具按角色派发（executor=worker, auditor=reviewer）。执行完成后调用 save_agent_result 保存结果。',
            },
          })
        }

        return ok({ ok: true, role, prompt, snapshot: entries, run: null })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 5 -----------------------------------------------------------------------
  {
    name: 'flow_audit_axes',
    description:
      '派发两个并行审计 subagent（Standards 轴 / Spec 轴），生成两段审计合同 prompt。' +
      'executor 改动通过 flow_run_verify 与负对照后、落 PASS 裁定前必须先调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        cwd: {
          type: 'string',
          description: '仓库工作目录，默认 process.cwd()',
        },
      },
    },
    handler: async (args) => {
      try {
        const sid = args.sessionId || 'unknown'
        const state = loadState(sid)
        if (!state.card) return fail('无卡，无法派发审计轴')

        const cwd = args.cwd || process.cwd()
        const res = { standards: null, spec: null }
        for (const axis of ['standards', 'spec']) {
          const prompt = buildContractPrompt('auditor', state.card, '', axis)
          const { file } = writeDispatchPrompt(sid, 'auditor', prompt, cwd)
          res[axis] = { prompt, file }
        }
        return ok({ ok: true, ...res })
      } catch (e) {
        return fail(String(e))
      }
    },
  },
  {
    name: 'flow_audit_submit',
    description:
      '保存某一审计轴（standards|spec）的结论与证据到会话状态。' +
      'PASS 裁定前必须两轴都提交，且各自绑定的 card_ts 与当前卡一致。同轴可重复提交（后者覆盖）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        axis: {
          type: 'string',
          enum: ['standards', 'spec'],
          description: '审计轴',
        },
        verdict: {
          type: 'string',
          enum: ['PASS', 'FAIL', 'WARN'],
          description: '轴判定；WARN=坏味道等 judgement call，不硬拦',
        },
        findings: {
          type: 'array',
          items: { type: 'string' },
          description: '每条含 file:line 或证据',
        },
        evidence: { type: 'string', description: '实跑命令输出 / diff 摘录' },
      },
    },
    handler: async (args) => {
      try {
        const sid = args.sessionId || 'unknown'
        const state = loadState(sid)
        if (!state.card) return fail('无卡，无法提交审计轴结论')
        const axisCardTs = state.card_ts
        await commitState(sid, (latest) => {
          if (!latest.card) return
          latest.audit_axes[args.axis] = {
            verdict: args.verdict,
            findings: args.findings,
            evidence: args.evidence,
            // 绑定提交时的卡片：换卡后该轴证据立即失效，必须重审
            card_ts: axisCardTs,
            ts: Date.now(),
          }
          latest.audit_axes_ts = Date.now()
          state.audit_axes = latest.audit_axes
        })

        // 审计留痕：只落在 state 里的轴结论可被覆盖、不可追溯。
        // 因此补一条审计事件，回答「这条结论是谁在什么时候提交的」。
        // 只记结论与证据摘要，不整段拷贝 evidence（验证输出可能很长）。
        audit('decision', sid, {
          kind: 'audit_axis_submitted',
          axis: args.axis,
          verdict: args.verdict,
          findings: Array.isArray(args.findings) ? args.findings : [],
          has_evidence:
            typeof args.evidence === 'string' && args.evidence.trim() !== '',
          card_ts: state.card_ts,
        })
        const stored = [
          state.audit_axes.standards,
          state.audit_axes.spec,
        ].filter(Boolean).length
        return ok({ ok: true, axis: args.axis, stored_axes_count: stored })
      } catch (e) {
        return fail(String(e))
      }
    },
  },
  {
    name: 'flow_audit_guard',
    description:
      '校验两轴是否已通过且证据齐全（与 flow_verdict 内的双轴门禁同口径）。' +
      '主 Agent 落 PASS 前可主动自查；flow_verdict 不受此调用影响，仍会再拦一道。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '会话 ID' } },
    },
    handler: async (args) => {
      try {
        const sid = args.sessionId || 'unknown'
        const state = loadState(sid)
        const ax = state.audit_axes
        // 口径与 flow_verdict 的双轴门禁完全一致：
        // 两轴都有 verdict（不能缺失/空）、card_ts 与当前卡一致、且无轴 FAIL。
        const axisOk = (a) =>
          ax && ax[a] && ax[a].verdict && ax[a].card_ts === state.card_ts
        if (!axisOk('standards') || !axisOk('spec')) {
          return fail(
            '两轴审计未齐或证据失效（需 flow_audit_axes 派发 + flow_audit_submit 两轴且 card_ts 与当前卡一致）',
          )
        }
        if (ax.standards.verdict === 'FAIL' || ax.spec.verdict === 'FAIL') {
          return fail(
            '两轴中至少一轴 FAIL（standards=' +
              ax.standards.verdict +
              ', spec=' +
              ax.spec.verdict +
              '）。',
          )
        }
        return ok({ ok: true })
      } catch (e) {
        return fail(String(e))
      }
    },
  },
  {
    name: 'flow_verdict',
    description:
      '记录 auditor 的裁定结果（PASS / DIRECTION / LOCAL）。只有 PASS 会把 completed_ok 置为 true。' +
      'DIRECTION 表示方向对但需返工，LOCAL 表示问题局限在局部。在向用户汇报完成前必须先落裁定，否则视为未复核。' +
      '【双轴门禁】记 PASS 前必须先 flow_audit_axes 派发 Standards/Spec 两轴、由 subagent 取证后 flow_audit_submit 提交两轴结论；任一轴 FAIL 会被拒，WARN 不硬拦。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        verdict: {
          type: 'string',
          enum: ['PASS', 'DIRECTION', 'LOCAL'],
          description: '裁定结果',
        },
        notes: { type: 'string', description: '裁定说明/证据摘要' },
        role: { type: 'string', description: '记录裁定者角色（通常 auditor）' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        const judgedSnapshot = JSON.stringify(state)

        // 裁定闸门的分组与顺序与 docs/TOOL_CONTRACTS.md 第 1.2 节严格一致：
        //   【无条件 2 组】1 有卡 · 2 占位卡已补齐
        //   【仅 PASS 7 组】3 派发过 · 4 验证有效 · 5 验证未过期 · 6 无越界
        //                 · 7 role=auditor · 8 负对照 · 9 双轴齐且无 FAIL
        // 顺序不可调换：先证实验证有效（4/5）→ 再证改动合规（6/7）→ 再证测试有判别力（8）
        // → 再证审查到位（9）。错位会让「未验证」被「双轴未齐」掩盖，调用方拿到不可操作的下一步。
        // 另有 8e「既有负对照结论可作废」：它是**前置否决闸**（先于 3~9 求值）——
        // 标记存在就意味着旧结论不可信，任何 PASS 都不该落；先说它是因为
        // 它给出的下一步最具体（先修状态存储，再重做负对照）。
        if (!state.card)
          return fail(guideError(state, '没有留痕，无法记录裁定。'))

        const verdict = a.verdict

        // ── 门禁 2/9（无条件）：激活占位卡必须已补齐 ──
        // 否则会出现「未派发、未验证、却直接 PASS」的假闭环。
        // （先于 dispatch_count 检查：占位卡的错误信息更具体，也更可操作）
        if (
          Array.isArray(state.activation_pending) &&
          state.activation_pending.length > 0
        ) {
          audit('decision', sessionId, {
            kind: 'verdict_denied',
            reason: '激活占位卡未补齐',
            pending: state.activation_pending,
          })
          return fail(
            guideError(
              state,
              '激活占位卡尚未补齐（待补：' +
                state.activation_pending.join('、') +
                '），不能记录裁定。请先补齐后重新调用 flow_submit_requirement。',
            ),
          )
        }

        // ── 前置否决闸（仅 PASS，计入门禁 8e）：既有负对照结论必须可作废 ──
        //
        // 负对照失败/异常时必须作废上一轮的 last_falsify；**作废这一步本身失败**
        // （状态锁损坏 / 超时）时，旧结论会继续支撑 PASS。
        // 这种情况下状态里写不进「已作废」，所以作废失败会另外落一个持久标记；
        // 标记在时任何 PASS 都不许落 —— 宁可拒，也不能让旧结论冒充新证据。
        // 放在最前面是因为它给出的下一步最具体（先修状态存储，再重做负对照）。
        if (verdict === 'PASS') {
          const invalidationFailure = readFalsifyInvalidationFailure(sessionId)
          const hardDeny = readHardDenyFalsifyInvalidation(sessionId)
          // 硬拒（标记文件写不进去时的进程内兜底）与持久标记同口径：
          // 属于当前卡（或未绑定卡）时一律拒 PASS。
          const hardDenyApplies =
            hardDeny &&
            (hardDeny.card_ts === null ||
              hardDeny.card_ts === undefined ||
              Number(hardDeny.card_ts) === Number(state.card_ts))
          if (
            (invalidationFailure &&
              (invalidationFailure.card_ts === null ||
                invalidationFailure.card_ts === undefined ||
                Number(invalidationFailure.card_ts) === Number(state.card_ts))) ||
            hardDenyApplies
          ) {
            const failureReason = invalidationFailure
              ? invalidationFailure.reason || '未知原因'
              : hardDeny.reason || '未知原因'
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '既有负对照结论未能作废',
              invalidation_reason: failureReason,
              invalidation_persisted: !!invalidationFailure,
            })
            return fail(
              formatError(
                '上一次的负对照结论未能作废（状态写入失败：' +
                  failureReason +
                  '），不能记录 PASS 裁定。请先修复状态存储，再对当前卡片重新调用 flow_falsify。',
              ),
            )
          }
        }

        // ── 门禁 3/9（仅 PASS）：确实派发过 ──
        // 从未派发过任何执行，就不允许落 PASS 裁定。
        // 否则一张刚提交、什么都没跑的卡也能直接标 completed_ok=true。
        // 只施加于 PASS：DIRECTION / LOCAL 是「有问题」的裁定，不构成「完成」，
        // 允许在未派发时先记录返工意见。
        if (verdict === 'PASS' && !(Number(state.dispatch_count) > 0)) {
          audit('decision', sessionId, {
            kind: 'verdict_denied',
            reason: '尚未派发任何执行',
            dispatch_count: state.dispatch_count,
          })
          return fail(
            guideError(
              state,
              '尚未派发任何执行（dispatch_count=0），不能记录 PASS 裁定。' +
                '请先 flow_claim / flow_dispatch 派发并完成验证后再落 PASS。',
            ),
          )
        }

        // ── 门禁 4/9（仅 PASS）：验证真实有效 ──
        // 记 PASS 必须有**真实验证通过**的证据。
        // 「派发过」≠「验证过」——只查 dispatch_count 时，一张跑过但验证失败的卡
        // 照样能落 PASS（completed_ok=true），等于把验证环节架空。
        // 三个条件同时成立才放行：
        //   1) 存在 flow_run_verify 写入的 state.last_verify；
        //   2) last_verify.ok === true（真实执行退出码为 0）；
        //   3) last_verify.cmd 与**当前卡片**的 verify.cmd 一致（防止旧卡结果冒充新卡）。
        // 只施加于 PASS：DIRECTION / LOCAL 是返工意见，不要求已完成验证。
        if (verdict === 'PASS') {
          const lv = state.last_verify
          const want = cardVerifyCmd(state)
          if (!lv || typeof lv !== 'object') {
            // 区分两种「没验证」：卡片压根没写 verify.cmd（用户无从下手）
            // vs 写了但还没跑。前者必须给出可操作的下一步，否则是死路。
            if (!want) {
              audit('decision', sessionId, {
                kind: 'verdict_denied',
                reason: '卡片未指定验证命令',
              })
              return fail(
                '卡片未指定 verify.cmd，没有可核验的验证依据，不能记录 PASS 裁定。' +
                  '请重新提交带 verify.cmd 的任务卡（flow_submit_requirement），' +
                  '用 flow_run_verify 跑通后再记录裁定。',
              )
            }
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '尚未执行验证',
            })
            return fail(
              '尚未执行验证，不能记录 PASS 裁定。请先调用 flow_run_verify ' +
                '跑通卡片里的 verify.cmd，再记录裁定。',
            )
          }
          if (lv.ok !== true) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证未通过',
              exitCode: lv.exitCode,
              verify_cmd: lv.cmd,
            })
            return fail(
              formatError(
                '验证未通过（exitCode=' +
                  lv.exitCode +
                  '），不能记录 PASS 裁定。' +
                  '请先修复问题、让 verify.cmd 真实跑通（flow_run_verify），再记录裁定。',
              ),
            )
          }
          // 「证据属于当前这张卡」：旧卡的绿灯不能给新卡复用。
          // 兼容历史状态：2.15.0 之前写入的 last_verify 没有 card_ts 字段 —— 那时
          // 只能靠命令一致性把关，缺字段按「无法证明属于当前卡」处理会更安全，
          // 但会让所有升级用户手上跑通的验证立刻作废。这里取折中：
          //   缺 card_ts 时要求验证时间晚于当前卡的提交时间（证据不可能早于卡）。
          if (
            lv.card_ts !== undefined &&
            Number(lv.card_ts) !== Number(state.card_ts)
          ) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证证据属于另一张任务卡',
              verify_card_ts: lv.card_ts,
              card_ts: state.card_ts,
            })
            return fail(
              formatError(
                '现有的验证结果属于**上一张任务卡**（card_ts 不一致），不能给当前卡记 PASS 裁定。' +
                  '请对当前卡片重新执行 flow_run_verify（或 flow_falsify）后再记录裁定。',
              ),
            )
          }
          if (lv.card_ts === undefined) {
            const verifiedAt = Date.parse(String(lv.ts || ''))
            if (
              Number.isFinite(verifiedAt) &&
              Number(verifiedAt) < Number(state.card_ts || 0)
            ) {
              audit('decision', sessionId, {
                kind: 'verdict_denied',
                reason: '验证早于当前卡提交时间',
                verify_ts: lv.ts,
                card_ts: state.card_ts,
              })
              return fail(
                formatError(
                  '现有的验证结果早于当前任务卡的提交时间，不能给当前卡记 PASS 裁定。' +
                    '请重新执行 flow_run_verify 后再记录裁定。',
                ),
              )
            }
          }
          if (!want || typeof lv.cmd !== 'string' || lv.cmd.trim() !== want) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证命令与当前卡片不一致',
              verify_cmd: lv.cmd,
              card_cmd: want,
            })
            return fail(
              formatError(
                '已有的验证结果对应的命令与当前卡片的 verify.cmd 不一致，不能记录 PASS 裁定。' +
                  '请对当前卡片重新执行 flow_run_verify，再记录裁定。',
              ),
            )
          }

          // ── 门禁 5/9（仅 PASS）：验证结果未过期 ──
          // 验证结果必须绑定当时的**代码状态**（A1）。
          //
          // 前面三道判断只看「验证跑过 / 跑通了 / 命令对得上」，**不看代码变没变**。
          // 于是存在这条绕过路径：
          //   1. flow_run_verify 跑通 → last_verify = {ok:true, cmd:"npm test"}
          //   2. executor 继续改代码（甚至改坏）
          //   3. flow_verdict(PASS) → 三道全过 → 放行
          // 指纹把「验证通过」绑定到一次**可复现的运行**：验证之后再动过代码，指纹就变了。
          //
          // 非 git 目录：fail-open（Carlos Flow 支持非 Git 项目），但要在 flow_status
          // 里如实标注指纹不可用（见 R1）。
          const fpCwd =
            a.cwd ||
            (state.last_verify && state.last_verify.cwd) ||
            process.cwd()
          const fpWas = lv.fingerprint
          const fpNow = await workspaceFingerprintAsync(fpCwd, runtime)
          const legacyNonGit = fpWas == null && fingerprintKind(fpNow) === 'non_git'
          if ((!legacyNonGit && fingerprintFailed(fpWas)) || fingerprintFailed(fpNow))
            return fail(fingerprintError(!legacyNonGit && fingerprintFailed(fpWas) ? fpWas : fpNow))
          if (
            fingerprintKind(fpWas) === 'git' &&
            fingerprintKind(fpNow) === 'git' &&
            (fpNow.head !== fpWas.head || fpNow.diff_sha256 !== fpWas.diff_sha256)
          ) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证结果已过期（代码在验证后被修改）',
              fp_was: fpWas.diff_sha256,
              fp_now: fpNow.diff_sha256,
            })
            let offer
            if (context?.session_id === sessionId && context.workdir_is_local === true && context.workdir_is_read_only === false) {
              try { offer = await issueStaleOffer(sessionId, state, fpCwd) } catch { /* 不确定时只保留普通手动验证入口 */ }
            }
            return {
              ...fail(formatError('验证结果已过期（STALE）：验证通过后代码又被修改，请重新执行 flow_run_verify 再记录裁定。')),
              structuredContent: { code: 'VERIFY_STALE', detectedAt: offer?.detectedAt || Date.now(),
                ...(offer ? { expected: { caseKey: offer.caseKey }, expiresAt: offer.expiresAt } : {}),
              },
            }
          }

          // ── 门禁 6/9（仅 PASS）：无越界改动 ──
          // 越界改动必须被拦住。
          //
          // 「越界直接阻断」的**真实落点**在这里：判定「本次执行有没有改到
          // scope 之外的文件」，而不是「派发前工作区干不干净」。
          //
          // 做法：拿「当前 git 改动清单」减去「派发时记录的基线」，
          // 剩下的就是**本次执行引入的**改动 —— 用户自己原有的未提交改动
          // 不会被误判为越界。
          //
          // 无基线（未走过 flow_dispatch）时退化为「全量改动」判定：
          // 此时没有参照点，用全量更保守（fail-closed）。
          const scopeNow = Array.isArray(state.card.scope)
            ? state.card.scope
            : []
          // 允许集 = scope + new_files：获授权可新建的文件被创建后不得判越界。
          // scope 为空且没有新文件授权时，仍然是空 allow 集 → fail-closed。
          const newFilesNow = Array.isArray(state.card.new_files)
            ? state.card.new_files
            : []
          const allowedScope = [...scopeNow, ...newFilesNow]
          const scopeRootNow = resolveRepoRoot(a.cwd || process.cwd())
          const current = enforceScope(allowedScope, scopeRootNow)
          const introduced = introducedChanges(
            current.checked || [],
            state.dispatch_baseline,
          )
          const scopeCheck = enforceScope(allowedScope, scopeRootNow, introduced)
          if (!scopeCheck.ok) {
            audit('decision', sessionId, {
              kind: 'scope_violation',
              reason: '越界改动',
              violations: scopeCheck.violations,
              introduced: introduced.length,
            })
            return fail(
              formatError(
                '检测到越界改动，不能记录 PASS 裁定：' +
                  (scopeCheck.violations || []).join(', ') +
                  '。这些文件不在卡片 scope 白名单内。' +
                  '请把越界文件加入 scope（重新提交任务卡）后重试，或先撤销这些改动。',
              ),
            )
          }

          // 15条通用防撞规则：R11 降级断言 / R13 格式污染检查
          try {
            const diffProc = spawnSync('git', ['diff', 'HEAD'], { cwd: scopeRootNow, encoding: 'utf8', windowsHide: true })
            if (diffProc.status === 0 && diffProc.stdout) {
              const diffRules = checkGitDiffRules(diffProc.stdout)
              if (!diffRules.ok) {
                const failV = diffRules.violations.find((v) => v.level === 'FAIL')
                if (failV) {
                  audit('decision', sessionId, { kind: 'verdict_denied', rule: failV.rule, reason: failV.message })
                  return fail(`${failV.message}\n💡 提示：${failV.hint}`)
                }
              }
            }
          } catch { /* ignore git diff errors */ }

          // ── 门禁 7/9（仅 PASS）：裁定角色必须是 auditor ──
          // role 门禁绑定到会话 ID（claimed_role），而非调用方自述字符串
          if (verdict === 'PASS' && state.claimed_role !== 'auditor') {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: 'role 未绑定到 auditor 会话',
              claimed_role: state.claimed_role,
            })
            return fail(
              'PASS 裁定必须由已领取 auditor 角色的会话（flow_claim role=auditor）落下。当前会话 claimed_role=' +
                (state.claimed_role || 'null'),
            )
          }

          // ── 门禁 8/9（仅 PASS）：负对照证明测试有判别力 ──
          // 证明 verify.cmd 真的在测「本次改动」。
          //
          // 「验证通过」本身不是证据：verify.cmd 可以是 `|| true` / `echo ok`，
          // 改动前后都退 0，门禁却以为测试过了。负对照要求：
          //   · 还原到派发时（改动前）跑同一命令 → 必须失败
          //   · 还原回改动后跑同一命令 → 必须通过
          // 只有「改动前失败 + 改动后通过」才说明这个测试有判别力。
          const lf = state.last_falsify
          if (!lf || typeof lf !== 'object') {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '尚未做负对照',
            })
            return fail(
              '尚未做负对照（flow_falsify），不能记录 PASS 裁定。' +
                '请先用 flow_falsify 证明 verify.cmd 在改动前失败、改动后通过。',
            )
          }
          if (lf.verdict !== 'meaningful') {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '负对照未通过',
              falsify_verdict: lf.verdict,
            })
            return fail(
              formatError(
                '负对照未通过（' +
                  lf.verdict +
                  '）：' +
                  (lf.reason || '') +
                  ' 不能记录 PASS 裁定。请修正 verify.cmd 或改动后重试。',
              ),
            )
          }
          // 还原不完整 → 负对照结论不成立（PASS 闸不能只看 verdict）。
          //
          // 「改动前失败 + 改动后通过」只说明命令有区分度；如果工作区**没能完整回到**
          // 进入负对照时的状态，那「改动后」这一态就不是我们以为的那一态。
          // 这里再独立核一次还原回执：还原核对失败一律拒 PASS（双保险）。
          if (lf.restore && lf.restore.ok === false) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '负对照还原未通过核对',
              falsify_verdict: lf.verdict,
              restore_mismatched: lf.restore.mismatched || [],
            })
            return fail(
              formatError(
                '负对照的工作区还原未通过核对（' +
                  ((lf.restore.mismatched || []).join(', ') || '详见负对照回执') +
                  '），不能记录 PASS 裁定。请先确认工作区状态并重新做负对照。',
              ),
            )
          }
          // 证据必须属于当前卡：旧卡的负对照结论不得冒充新卡（缺 card_ts 的旧记录宽容放行）。
          if (lf.card_ts !== undefined && lf.card_ts !== state.card_ts) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '负对照证据不属于当前卡',
              falsify_card_ts: lf.card_ts,
              card_ts: state.card_ts,
            })
            return fail(
              '负对照证据不属于当前卡片（card_ts 不一致），不能记录 PASS 裁定。' +
                '请对当前卡片重新调用 flow_falsify。',
            )
          }
          // 绑定：裁定的证据必须就是负对照里「改动后」的那次运行。
          if (
            typeof lf.after === 'object' &&
            lf.after &&
            typeof lf.after.hash === 'string' &&
            state.last_verify &&
            state.last_verify.output_hash !== lf.after.hash
          ) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证证据与负对照不一致',
            })
            return fail(
              '已有的验证结果与负对照的运行结果不一致，不能记录 PASS 裁定。' +
                '请重新调用 flow_falsify（它会把改动后的运行写为验证证据）。',
            )
          }

          // ── 门禁 9/9（仅 PASS）：双轴审查齐且无 FAIL ──
          //
          // 位置说明（重要）：必须放在负对照**之后**。语义顺序是
          // 「先证实验证有效 → 再证审查到位」，九道门（2 无条件 + 7 仅 PASS）
          // 各自独立、互不掩盖。
          // 若前置，会让「未验证」「未派发」「未做负对照」这些更基础的问题被
          // 双轴错误信息掩盖，调用方拿到的是不可操作的下一步。
          //
          // 判定口径：
          //   · 两轴都必须有结论，且 card_ts 与当前卡一致（防旧卡审查结果冒充新卡，
          //     也防两轴跨卡拼接：卡A的 standards + 卡B的 spec 不算数）；
          //   · FAIL 硬拦（规范硬违规 / 未实现验收）；
          //   · WARN 不硬拦（坏味道是 judgement call），由主 Agent 读 audit_axes 后标注。
          const ax = state.audit_axes
          const axisOk = (a) =>
            ax && ax[a] && ax[a].verdict && ax[a].card_ts === state.card_ts
          const hasStandards = axisOk('standards')
          const hasSpec = axisOk('spec')
          if (!hasStandards || !hasSpec) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '两轴审查未齐',
              standards: ax && ax.standards ? ax.standards.verdict : null,
              spec: ax && ax.spec ? ax.spec.verdict : null,
              card_ts: state.card_ts,
            })
            return fail(
              '两轴审查未齐，不能记录 PASS 裁定。请先 flow_audit_axes 派发两轴、' +
                '由 subagent 取证后分别 flow_audit_submit 提交 Standards 与 Spec 两轴结论，再记录裁定。',
            )
          }
          const standardsFail = ax.standards.verdict === 'FAIL'
          const specFail = ax.spec.verdict === 'FAIL'
          if (standardsFail || specFail) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '有轴不通过',
              standards: ax.standards.verdict,
              spec: ax.spec.verdict,
            })
            return fail(
              'PASS 被拒：两轴中至少一轴 FAIL（standards=' +
                ax.standards.verdict +
                ', spec=' +
                ax.spec.verdict +
                '）。请修复后重跑验证与审计。',
            )
          }
        }

        // 写入用**短锁 + card_ts CAS**：所有门禁判定都在锁外（只读快照）完成，
        // 拿锁后先核对卡片没被替换，再写。否则出现「判定用的卡 A、写进去的是卡 B」：
        // 裁定看起来合规，实际对着一张已经不存在的卡。
        const judgedCardTs = state.card_ts
        const findings = []
        const prevVerdict = state.verdict
        let cardReplaced = false
        await withStateLock(sessionId, () => {
          const latest = loadState(sessionId)
          if (JSON.stringify(latest) !== judgedSnapshot) {
            cardReplaced = true
            return
          }
          // 先取消已有 PASS，再进行可能失败的审计。
          latest.completed_ok = false
          latest.audit_pending = {
            kind: 'verdict',
            verdict,
            card_ts: judgedCardTs,
          }
          saveState(sessionId, latest)
          if (latest.verdict && latest.verdict !== verdict) {
            findings.push(`裁定被覆盖：${latest.verdict} → ${verdict}`)
            audit('finding', sessionId, {
              kind: 'verdict_overwrite',
              from: latest.verdict,
              to: verdict,
              tier: latest.tier,
            })
          }
          // 中断或失败可重试同一裁定；成功后清除可选 pending 字段。
          audit('resolution', sessionId, {
            kind: 'verdict',
            verdict,
            notes: a.notes,
            role: a.role,
            card_ts: judgedCardTs,
          })
          delete latest.audit_pending
          latest.verdict = verdict
          latest.completed_ok = verdict === 'PASS'
          latest.verdict_ts = Date.now()
          // 落盘裁定者角色：审计链据此回溯「这条 PASS 是谁落的」。
          latest.verdict_role = a.role === undefined ? null : a.role
          saveState(sessionId, latest)
          state.verdict = latest.verdict
          state.completed_ok = latest.completed_ok
          state.verdict_role = latest.verdict_role
        })
        if (verdict === 'PASS' && state.card && state.card.quote) {
          try {
            const { LearnedRulesManager } = await import('./trigger.js')
            LearnedRulesManager.recordPositiveFeedback(state.card.quote)
          } catch {}
        }
        if (cardReplaced) {
          audit('decision', sessionId, {
            kind: 'verdict_denied',
            reason: '裁定期间任务卡被替换',
            judged_card_ts: judgedCardTs,
          })
          return fail(
            formatError(
              '裁定期间任务卡或判定证据已变化，本次裁定未写入。' +
                '请重新读 flow_status 确认当前卡，再重新走验证与裁定。',
            ),
          )
        }
        void prevVerdict

        // 裁定审计已在状态临界区内确认持久化。

        const warns = collectAxisWarnings(state)
        const result = {
          ok: true,
          verdict,
          completed_ok: state.completed_ok,
          notes: a.notes,
          verdict_role: state.verdict_role,
          // WARN 汇总：两轴里判 WARN（坏味道等 judgement call）的结论。
          // 以前 WARN 只躺在 state.audit_axes 里，主 Agent 不主动读就看不到，
          // 「带坏味道通过」在汇报里等于被吞掉 —— 现在随裁定一起返回。
          warn_count: warns.length,
        }
        if (warns.length) result.warn_findings = warns
        if (findings.length) result.findings = findings
        if (verdict === 'PASS') {
          result.qa_sheet = generateQASheet(state, a.notes)
        }
        return ok(result)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  {
    name: 'flow_mode',
    description: '切换工作流模式：pro（专业）/ guide（向导）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['pro', 'guide'] },
        reason: { type: 'string' },
      },
      required: ['mode'],
    },
    handler: async (args) => {
      const { sessionId, mode, reason } = args
      const sid = sessionId || 'unknown'
      let nextMode = mode
      await commitState(sid, (latest) => {
        latest.mode = mode
        latest.mode_ts = Date.now()
        nextMode = latest.mode
      })
      audit('decision', sid, { kind: 'mode_on', mode: mode, reason: reason })
      return ok({ mode: nextMode })
    },
  },
  // 6 -----------------------------------------------------------------------
  {
    name: 'flow_stats',
    description:
      '存储与运行态统计（**只读**）：各会话占用 Top N、备份去重率、审计日志按日增长、' +
      '陈旧会话清单（含最近活跃时间与是否终态）。清理/归档前先用它看清楚「现在占了多少、谁占的、删了会不会影响回溯」，' +
      '不要凭感觉删目录。不会修改任何文件。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '返回多少个会话/多少天（默认 10，最大 50）',
        },
        inactiveDays: {
          type: 'integer',
          description: '判定「陈旧会话」的天数阈值（默认 7）',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const limit = Math.min(50, Math.max(1, Number(a.limit) || 10))
        const inactiveDays = Math.max(1, Number(a.inactiveDays) || 7)

        // 口径统一在 src/storage.js（度量和清理必须用同一份，否则「统计说 4MB、
        // 清理删了 6MB」这类对不上账的情况迟早发生）。
        const o = storageOverview({ limit, inactiveDays })

        return ok({
          ok: true,
          home: FLOW_HOME,
          generated_at: new Date().toISOString(),
          total: {
            bytes: o.totalBytes,
            sessions: o.summaries.length,
            backup_bytes: o.backupBytes,
            backup_share:
              o.totalBytes > 0
                ? Number((o.backupBytes / o.totalBytes).toFixed(3))
                : 0,
          },
          sessions_top: o.top,
          backup: o.dedup,
          audit: {
            total_bytes: o.auditBytes,
            days: o.auditDays.length,
            recent_days: o.auditDays.slice(0, limit),
            note: '单文件上限由 CARLOS_FLOW_AUDIT_MAX_BYTES 控制（默认 8MB），超出后滚动为 <date>.N.jsonl。',
          },
          trigger_state: o.triggerUsage,
          stale: {
            threshold_days: inactiveDays,
            count: o.staleCandidates.length,
            terminal_count: o.terminal.length,
            samples: o.staleCandidates.slice(0, limit),
            note: 'verdict 非 null 的会话属终态，可安全归档；没有结论的会话请先确认没有在跑的派发。',
          },
          advice:
            o.staleCandidates.length > 0
              ? '存在陈旧会话：' +
                o.terminal.length +
                ' 个已是终态（可归档），其余 ' +
                (o.staleCandidates.length - o.terminal.length) +
                ' 个仍有未完成状态，建议先看 flow_status 再决定。' +
                '归档用 `carlos prune --apply`（移动，不删除；审计目录永不参与）。'
              : '没有超过阈值的陈旧会话。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  {
    name: 'flow_status',
    description:
      '查询当前会话的门禁状态：是否有任务卡、风险档、已派发次数/上限、裁定结果、是否过期、是否处于免检模式、卡片内容与时间戳。' +
      '在汇报进度、判断能否继续派发、或确认任务是否真的收尾时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        includeSnapshots: { type: 'boolean', default: false },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        let state = loadState(sessionId)
        const sampledIdentity = evidenceIdentity(state)
        let verification = await verifyState(state, runtime)
        const latest = loadState(sessionId)
        if (evidenceIdentity(latest) !== sampledIdentity) {
          verification = { state: 'fail', fingerprint: 'unavailable' }
        }
        state = latest
        const warns = collectAxisWarnings(state)
        const verificationPassed = verification.fingerprint === 'unavailable' && verification.state === 'fail' ? false : verifyPassed(state)
        const taskStale = isStale(state)

        const result = {
          sessionId,
          has_card: !!state.card,
          tier: state.tier,
          dispatch_count: state.dispatch_count,
          max_dispatch: MAX_DISPATCH,
          verdict: state.verdict,
          // 本条裁定是谁落的（"auditor" | "executor" | null）。
          // 与 claimed_role 不同：后者是「会话最近 claim 的角色」，可能已过期；
          // 这个字段直接回答「这条 PASS 是谁落的」。
          verdict_role:
            state.verdict_role === undefined ? null : state.verdict_role,
          verified: !!state.verdict,
          // verify_passed：真实验证是否通过（last_verify.ok===true 且命令与当前卡片一致）。
          // 注意 verified 只表示「是否已有裁定」，不代表验证通过——两者语义不同，不可混用。
          verify_passed: verificationPassed,
          // 四态验证状态：not_run / fail / stale / pass。
          // stale = 验证通过后代码被改过 —— 不阻断（fail-open），但必须如实告知。
          verify_state: verification.state,
          wizard: deriveWizardStatus(state, {
            verify_state: verification.state,
            verify_passed: verificationPassed,
            fingerprint_available: typeof verification.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(verification.fingerprint),
            task_stale: taskStale,
            sampled_at: Date.now(),
          }),
          completed_ok: state.completed_ok === true,
          stale: taskStale,
          bypass: !!state.bypass,
          card: state.card,
          card_ts: state.card_ts,
          activation_pending: Array.isArray(state.activation_pending)
            ? state.activation_pending
            : [],
          // 双轴审查证据：主 Agent 落 PASS 前可读它确认两轴状态与 card_ts 绑定。
          // axes_ready = 两轴都有结论且 card_ts 与当前卡一致且无轴 FAIL。
          audit_axes: state.audit_axes,
          audit_axes_ts: state.audit_axes_ts,
          axes_ready: (() => {
            const ax = state.audit_axes
            const axisOk = (x) =>
              ax && ax[x] && ax[x].verdict && ax[x].card_ts === state.card_ts
            return (
              axisOk('standards') &&
              axisOk('spec') &&
              ax.standards.verdict !== 'FAIL' &&
              ax.spec.verdict !== 'FAIL'
            )
          })(),
          // WARN 汇总（与 flow_verdict 同一份派生口径）：只读镜像，供事后复查。
          warn_count: warns.length,
        }
        if (a.includeSnapshots === true) {
          result.snapshot_identity = snapshotIdentity(
            sessionId,
            state.dispatch_baseline,
          )
        }
        if (warns.length) result.warn_findings = warns
        if (state.card && !state.verdict) result.unreviewed = true
        return ok(result)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 7 -----------------------------------------------------------------------
  {
    name: 'flow_audit',
    description:
      '读取审计流水（gate-audit/*.jsonl），返回事件列表与按 type / kind 的统计。可按 sessionId、type（run/finding/decision/resolution）、日期过滤。' +
      '不给 sessionId 则聚合全部会话。用于复核“到底派发了什么、改了什么、谁批的”，也用于事后追溯。' +
      '同时可验证审计链完整性。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID；不传则聚合全部' },
        type: {
          type: 'string',
          description: '事件类型过滤：run / finding / decision / resolution',
        },
        limit: { type: 'number', description: '最多返回最近 N 条' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        verifyChain: { type: 'boolean', description: '是否验证审计链完整性' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const opts = {}
        if (a.sessionId != null && a.sessionId !== '')
          opts.sessionId = a.sessionId
        if (a.type != null && a.type !== '') opts.type = a.type
        if (typeof a.limit === 'number') opts.limit = a.limit
        if (typeof a.date === 'string' && a.date !== '') opts.date = a.date

        const readResult = readAuditDetailed(opts)
        const rows = readResult.rows
        const by_type = {}
        const by_kind = {}
        for (const row of rows) {
          const t = row.type || 'none'
          by_type[t] = (by_type[t] || 0) + 1
          const k = row.kind || 'none'
          by_kind[k] = (by_kind[k] || 0) + 1
        }

        let chainResult = null
        if (a.verifyChain) {
          chainResult = verifyAuditChain(opts)
        }

        return ok({
          ok: readResult.complete,
          complete: readResult.complete,
          readErrors: readResult.readErrors,
          invalidLines: readResult.invalidLines,
          empty: readResult.empty,
          coverage: readResult.coverage,
          total: rows.length,
          by_type,
          by_kind,
          events: rows,
          chain: chainResult,
          mode: auditHashMode(),
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 8 -----------------------------------------------------------------------
  {
    name: 'flow_diff_hunks',
    description:
      '对指定文件跑 git diff -U0 并解析出每个文件的 hunk 范围（oldStart/oldCount/newStart/newCount）。' +
      '用于独立复核 executor 到底改了哪些行、是否越界。cwd 不是 git 仓库或 git 失败时返回 files:[] 与 error 字段（不算工具错误）。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '仓库工作目录，默认 process.cwd()',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要检查的文件路径列表',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const cwd = resolveRepoRoot(a.cwd || process.cwd())
        const paths = asStringArray(a.paths)

        const proc = spawnSync('git', ['diff', '-U0', '--no-color', ...paths], {
          cwd,
          encoding: 'utf8',
          shell: false,
          maxBuffer: 10 * 1024 * 1024,
        })

        const stderr = proc.stderr ? String(proc.stderr) : ''
        if (proc.error || (proc.status !== 0 && !stderr)) {
          return ok({
            ok: false,
            files: [],
            raw_length: 0,
            error: proc.error
              ? String(proc.error.message || proc.error)
              : stderr || `git exited with status ${proc.status}`,
          })
        }

        const out = proc.stdout ? String(proc.stdout) : ''
        const files = []
        let current = null
        for (const line of out.split('\n')) {
          if (line.startsWith('+++ ')) {
            const p = line.slice(4).trim()
            current = { path: p.startsWith('b/') ? p.slice(2) : p, hunks: [] }
            files.push(current)
            continue
          }
          if (line.startsWith('@@')) {
            const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
            if (m && current) {
              current.hunks.push({
                oldStart: Number(m[1]),
                oldCount: m[2] === undefined ? 1 : Number(m[2]),
                newStart: Number(m[3]),
                newCount: m[4] === undefined ? 1 : Number(m[4]),
              })
            }
          }
        }

        return ok({ ok: true, files, raw_length: out.length })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 9 -----------------------------------------------------------------------
  {
    name: 'flow_cancel',
    description:
      '一键撤销/取消当前任务卡，重置门禁状态回自由态。' +
      '当用户明确说“取消门禁 / 撤销任务 / 不走流程 / 随便问问”时调用。' +
      '会清空未决占位卡，记录审计事件并释放派发锁。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        reason: { type: 'string', description: '取消理由（建议写用户原话）' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)

        await commitState(sessionId, (latest) => {
          latest.card = null
          latest.card_ts = 0
          latest.activation_pending = []
          latest.activation_activated = false
          latest.claimed = false
          latest.claimed_role = null
          latest.dispatch_count = 0
          latest.verdict = null
          latest.completed_ok = false
          latest.stale = false
        })

        audit('decision', sessionId, {
          kind: 'card_cancelled',
          reason: a.reason || '用户请求撤销',
        })

        // 在线学习：捕获负向信号，自动将触发句式与特征存入本地抑制规则库
        try {
          const { LearnedRulesManager } = await import('./trigger.js')
          if (state && state.card && state.card.quote) {
            LearnedRulesManager.recordNegativeFeedback(state.card.quote, 'hard_negative')
          }
        } catch {}

        return ok({
          ok: true,
          sessionId,
          cancelled: true,
          reason: a.reason || '用户请求撤销',
          note: '门禁任务卡已一键撤销，会话已恢复自由态。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 9b -----------------------------------------------------------------------
  {
    name: 'flow_bypass',
    description:
      '开关免检模式（bypass）。当用户明确说“直接干 / 跳过门禁 / 免检 / 别管流程”时调用。' +
      'on=true 打开，on=false 关闭，每次开关都会写入审计流水并留下时间戳与理由。' +
      '仅在用户明确授权时使用，不要自行开启。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        on: { type: 'boolean', description: 'true 开启免检，false 关闭' },
        confirmed: {
          type: 'boolean',
          description: '开启免检时必须为 true（表示用户已明确授权）',
        },
        reason: {
          type: 'string',
          description: '开启/关闭理由（建议写用户原话）',
        },
      },
      required: ['on'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)

        if (!state.card) {
          return fail(
            '没有留痕，无法开启免检。免检只能在已提交任务卡的前提下使用。',
          )
        }

        // Phase 1-1: 开启免检必须显式确认，不允许隐式触发
        if (a.on === true && a.confirmed !== true) {
          audit('decision', sessionId, {
            kind: 'bypass_denied',
            reason: '未确认',
          })
          return fail(
            '开启免检需要显式确认：用户必须明确授权后，传入 confirmed=true。',
          )
        }

        let bypassNow = false
        await commitState(sessionId, (latest) => {
          latest.bypass = a.on === true
          latest.bypass_ts = Date.now()
          bypassNow = latest.bypass
          state.bypass = bypassNow
        })
        void bypassNow
        audit('decision', sessionId, {
          kind: state.bypass ? 'bypass_on' : 'bypass_off',
          reason: a.reason,
          confirmed: a.confirmed === true,
        })
        if (state.bypass && state.card && state.card.quote) {
          try {
            const { LearnedRulesManager } = await import('./trigger.js')
            LearnedRulesManager.recordNegativeFeedback(state.card.quote, 'hard_negative')
          } catch {}
        }
        return ok({
          ok: true,
          bypass: state.bypass,
          reason: a.reason,
          note: state.bypass
            ? '免检已开启；下次 flow_dispatch 后会自动清零。'
            : '免检已关闭。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 10 -----------------------------------------------------------------------
  {
    name: 'flow_add_user_msg',
    description:
      '写入一条用户原话到会话消息文件，供 quote 锚点校验使用。' +
      '在提交任务卡之前调用，把用户消息原文存下来。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        text: { type: 'string', description: '用户原话原文' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const text = String(a.text || '')
        if (!text) return fail('text 不能为空')
        const ok2 = writeUserMessage(sessionId, text)
        return ok({ ok: ok2, sessionId, text_len: text.length })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 11 -----------------------------------------------------------------------
  {
    name: 'flow_save_result',
    description:
      '保存子 Agent（executor/auditor）的执行结果到会话目录。' +
      '主 Agent 通过 subagent 工具拿到结果后调用本工具持久化，便于后续审计与还原。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        role: {
          type: 'string',
          enum: ['executor', 'auditor'],
          description: '执行角色',
        },
        stdout: { type: 'string', description: '子 Agent 的 stdout' },
        stderr: { type: 'string', description: '子 Agent 的 stderr' },
        code: { type: 'number', description: '退出码' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const role = a.role === 'auditor' ? 'auditor' : 'executor'
        const file = saveAgentResult(
          sessionId,
          role,
          a.stdout,
          a.stderr,
          a.code,
        )
        audit('run', sessionId, {
          kind: 'agent_result',
          role,
          code: a.code,
          file,
        })
        return ok({ ok: !!file, sessionId, role, file })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 12 -----------------------------------------------------------------------
  {
    name: 'flow_revert_plan',
    description:
      '根据本次会话的快照 manifest 生成还原计划：新建文件（created）→ delete，原有文件 → 从 backup 恢复到 orig。' +
      '只返回计划，绝不自动执行；实际还原需人工确认后按 plan 操作。用于改动出问题需要回滚的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const entries = readManifest(sessionId)
        const plan = []
        for (const entry of entries) {
          if (!entry) continue
          if (entry.created === true) {
            plan.push({ action: 'delete', target: entry.orig, source: null })
          } else {
            plan.push({
              action: 'restore',
              source: entry.backup,
              target: entry.orig,
            })
          }
        }
        return ok({
          sessionId,
          count: plan.length,
          plan,
          note: '这是还原计划，不会自动执行；实际还原需人工确认后按 plan 操作。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 13 -----------------------------------------------------------------------
  {
    name: 'flow_run_verify',
    description:
      '执行卡片中指定的验证命令，返回执行结果（退出码、stdout、stderr）。' +
      '用于在派发 executor 后验证其工作成果，或手动触发验证。',
    inputSchema: {
      type: 'object',
      properties: {
        expected: { type: 'object', description: '可选向导领取身份；无效绝不回退手动执行', properties: { caseKey: { type: 'string' } }, required: ['caseKey'], additionalProperties: false },
        isolateHome: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        if (!state.card) return fail('没有留痕，无法执行验证。')
        if (!state.card.verify || !state.card.verify.cmd)
          return fail('卡片未指定验证命令。')

        // 工作目录优先级：显式 cwd > 卡片提交时的项目目录 > server 进程 cwd。
        // 不能只拿 process.cwd() —— MCP server 是常驻进程，
        // 它的 cwd 是**启动时**的目录（可能是几个月前的某个旧仓库），
        // 于是 verify.cmd 会在错误的目录里跑，测试脚本找不到、路径全错，
        // 而门禁把这种失败当成了「验证不通过」（真 PASS 被误杀）。
        const cardProject =
          state.card.env && typeof state.card.env.project === 'string'
            ? state.card.env.project
            : ''
        let workdir = a.cwd || cardProject || undefined
        // 记住「这次验证针对哪张卡」：命令跑完再写状态时，卡片可能已被替换。
        const verifiedIdentity = evidenceIdentity(state)
        const verifiedCardTs = state.card_ts
        let verifiedCmd = state.card.verify.cmd
        const hasExpected = Object.prototype.hasOwnProperty.call(a, 'expected')
        let receipt
        if (hasExpected) {
          if (!a.expected || typeof a.expected !== 'object' || Array.isArray(a.expected) ||
              Object.keys(a.expected).some(key => key !== 'caseKey') ||
              context?.session_id !== sessionId || context.workdir_is_local !== true || context.workdir_is_read_only !== false)
            return fail('向导领取身份或本地会话位置无效；不会自动重试或回退执行。')
          receipt = await claimStaleOffer(sessionId, a.expected, a.cwd, context.workdir)
          verifiedCmd = receipt.cmd
          workdir = receipt.cwd
        }

        // 15条通用防撞规则：R7/R8 危险命令与全局盲杀前置拦截
        const cmdRulesCheck = checkCommandRules(verifiedCmd)
        if (!cmdRulesCheck.ok) {
          const failViolation = cmdRulesCheck.violations.find((v) => v.level === 'FAIL')
          if (failViolation) {
            audit('decision', sessionId, {
              kind: 'command_denied',
              rule: failViolation.rule,
              reason: failViolation.message,
            })
            return fail(`${failViolation.message}\n💡 提示：${failViolation.hint}`)
          }
        }

        // ⚠️ 命令必须在**锁外**跑（最长 120s）。若把整段包进 withStateLock，
        // 持锁超过 staleMs（30s）就会被判陈旧并回收，另一个进程随即拿到同一把锁
        // → 两个进程同时写，比不加锁更难复现。
        const result = await runVerifyCommand(verifiedCmd, workdir, {
          timeoutMs: a.timeoutMs,
          isolateHome: a.isolateHome,
        })
        const fingerprint = await workspaceFingerprintAsync(workdir || process.cwd(), runtime)
        const outputHash = computeOutputHash(
          result.exitCode,
          result.stdout,
          result.stderr,
        )

        // 短锁内重新读最新状态，只合并 last_verify（不覆盖别人写的其它字段）。
        let merged = false
        await commitState(sessionId, (state2) => {
          if (evidenceIdentity(state2) !== verifiedIdentity) return
          if (receipt && staleCaseIdentity(sessionId, state2) !== receipt.caseKey) return
          merged = true
          state2.last_verify = {
            ts: new Date().toISOString(),
            cmd: verifiedCmd,
            cwd: workdir || process.cwd(),
            exitCode: result.exitCode,
            ok: result.ok && !fingerprintFailed(fingerprint),
            // card_ts：把证据绑定到**当前这张卡**，防止「旧卡的验证结果」被新卡复用
            // （新卡即使写了同一条命令，也不该继承上一张卡的绿灯）。
            card_ts: receipt ? receipt.cardTs : verifiedCardTs,
            // 输出指纹：把「验证通过」绑定到一次可复现的运行，而不是「我说过了」。
            output_hash: outputHash,
            // 代码状态指纹：把「验证通过」绑定到**当时的代码状态**。
            // 没有它，验证通过后再改坏代码，flow_verdict(PASS) 仍会放行（见 A1）。
            fingerprint,
          }
        })

        if (!merged) return fail('命令已执行，但卡或原验证已变化；旧结果未覆盖新证据，禁止重放。')
        if (fingerprintFailed(fingerprint)) return fail(fingerprintError(fingerprint))
        return ok({
          ok: result.ok,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          cwd: workdir || process.cwd(),
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 13b -----------------------------------------------------------------------
  {
    name: 'flow_falsify',
    description:
      '负对照（negative control）：把工作区还原到派发时的「改动前」状态跑同一 verify.cmd，要求它**失败**；' +
      '再还原「改动后」状态跑一次，要求它**通过**。只有「改动前失败 + 改动后通过」才证明这个测试真的在测本次改动' +
      '（而不是 `|| true` / `echo ok` 这类空测试）。记 PASS 裁定前必须先做负对照。',
    inputSchema: {
      type: 'object',
      properties: {
        isolateHome: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        if (!state.card) return fail('没有留痕，无法做负对照。')
        if (!state.card.verify || !state.card.verify.cmd)
          return fail('卡片未指定验证命令，无法做负对照。')

        const cardProject =
          state.card.env && typeof state.card.env.project === 'string'
            ? state.card.env.project
            : ''
        const workdir = a.cwd || cardProject || undefined

        const falsifiedIdentity = evidenceIdentity(state, true)
        let r
        try {
          r = await runNegativeControl(
            sessionId,
            state.card.verify.cmd,
            workdir,
            { timeoutMs: a.timeoutMs, isolateHome: a.isolateHome },
          )
        } catch (e) {
          // 负对照**抛异常**（如参数非法、工作区不可读）同样必须作废既有 last_falsify。
          // 否则上一次「meaningful」的旧结论会继续支撑 PASS —— 门禁就变成了
          // 「只要历史上通过过一次就永远通过」。
          const reason =
            '负对照执行异常：' + (e && e.message ? e.message : String(e));
          audit('run', sessionId, {
            kind: 'falsify_denied',
            reason: reason,
          })
          const invalidated = await invalidateLastFalsify(
            sessionId,
            state.card_ts,
            reason,
          )
          if (!invalidated.ok) {
            return fail(
              reason +
                '（既有负对照结论**未能作废**：' +
                invalidated.reason +
                '；' +
                (invalidated.marker === 'not_written'
                  ? '「不可 PASS」标记也写不进去，本进程内已硬拒 PASS（跨进程持久化需先修复状态存储），请修复状态存储后重新做负对照'
                  : '本会话已被标记为不可 PASS，请修复状态存储后重新做负对照') +
                '）',
            )
          }
          return fail(reason + '（既有负对照结论已作废，请修复后重新做负对照）');
        }
        if (!r.ok) {
          audit('run', sessionId, {
            kind: 'falsify_denied',
            reason: r.error || '负对照无法执行',
          })
          // 负对照失败 → **既有 last_falsify 立即作废**。
          // 否则上一轮「meaningful」的旧结论会被沿用：坏掉的负对照照样能放行 PASS，
          // 门禁就变成了「只要历史上通过过一次就永远通过」。
          const invalidated = await invalidateLastFalsify(
            sessionId,
            state.card_ts,
            r.error || '负对照无法执行',
          )
          if (!invalidated.ok) {
            return fail(
              (r.error || '负对照无法执行') +
                '（既有负对照结论**未能作废**：' +
                invalidated.reason +
                '；' +
                (invalidated.marker === 'not_written'
                  ? '「不可 PASS」标记也写不进去，本进程内已硬拒 PASS（跨进程持久化需先修复状态存储），请修复状态存储后重新做负对照'
                  : '本会话已被标记为不可 PASS，请修复状态存储后重新做负对照') +
                '）',
            )
          }
          return fail(r.error || '负对照无法执行')
        }

        const falsifiedCardTs = state.card_ts
        const falsifiedCmd = state.card.verify.cmd
        // 指纹要 spawn 一次 git，属于「慢操作」，必须在拿锁之前算好。
        const falsifiedFingerprint = await workspaceFingerprintAsync(
          workdir || process.cwd(), runtime,
        )

        // 负对照本身跑了两次命令（最长 240s），同样只能在锁外跑；写入段用短锁合并，
        // 只覆盖 last_falsify / last_verify 两个字段，不碰别人写的其它字段。
        let merged = false
        await commitState(sessionId, (state2) => {
          if (evidenceIdentity(state2, true) !== falsifiedIdentity) return
          merged = true
          state2.last_falsify = {
            ts: new Date().toISOString(),
            cmd: falsifiedCmd,
            cwd: workdir || process.cwd(),
            verdict: r.verdict,
            reason: r.reason,
            // 证据必须属于**当前卡片**（与 last_verify 同口径）：
            // 旧卡的负对照结论不得冒充新卡的证据。
            card_ts: falsifiedCardTs,
            before: {
              exitCode: r.before.exitCode,
              ok: r.before.ok,
              hash: r.before.hash,
            },
            after: {
              exitCode: r.after.exitCode,
              ok: r.after.ok,
              hash: r.after.hash,
            },
            // 工作区还原是否被核对通过（ok=false 表示负对照过程中改动可能没被完整写回）。
            // 还原核对结果随裁定一起暴露 —— 免得「改动消失」只留在 stderr 里。
            // 裁定闸另外独立核一次 restore.ok（还原没核对通过就不给 PASS）。
            restore: r.restore
              ? {
                  ok: r.restore.ok,
                  checked: r.restore.checked,
                  mismatched: r.restore.mismatched,
                }
              : null,
          }
          // 把「改动后」的运行写为 last_verify —— 裁定的证据绑定到这一次运行。
          state2.last_verify = {
            ts: new Date().toISOString(),
            cmd: falsifiedCmd,
            cwd: workdir || process.cwd(),
            exitCode: r.after.exitCode,
            ok: r.after.ok && !fingerprintFailed(falsifiedFingerprint),
            output_hash: r.after.hash,
            card_ts: falsifiedCardTs,
            // 代码状态指纹：负对照同样是一次「验证通过」，
            // 必须与 flow_run_verify 一样绑定代码状态，
            // 否则「先负对照、再改代码、再记 PASS」这条路径会绕过 STALE 闸门。
            fingerprint: falsifiedFingerprint,
          }
        })

        if (!merged) return fail('负对照已还原，但卡或证据已变化；旧结果未覆盖新证据，禁止重放。')
        // 本次负对照的结论已经写进状态：之前「作废旧结论失败」留下的不可 PASS 标记
        // 可以撤销（新的结论属于当前卡，且已通过证据一致性校验）。
        // 撤不掉必须**如实报告**：标记留着就一直挡着 PASS，而用户重跑负对照也清不掉。
        const clearedMarker = clearFalsifyInvalidationFailure(sessionId)
        if (!clearedMarker.ok) {
          hardDenyFalsifyInvalidation(
            sessionId,
            falsifiedCardTs,
            '旧的「不可 PASS」标记清除失败：' + clearedMarker.error,
          )
        } else {
          clearHardDenyFalsifyInvalidation(sessionId)
        }
        audit('run', sessionId, {
          kind: 'falsify',
          verdict: r.verdict,
          before_exit: r.before.exitCode,
          after_exit: r.after.exitCode,
          before_hash: r.before.hash,
          after_hash: r.after.hash,
          restore_ok: r.restore ? r.restore.ok : null,
          restore_mismatched: r.restore ? r.restore.mismatched : [],
          recovered_files: r.recovered ? r.recovered.files : 0,
        })

        if (fingerprintFailed(falsifiedFingerprint))
          return fail(fingerprintError(falsifiedFingerprint))
        const trunc = (s) =>
          typeof s === 'string' && s.length > 2000 ? s.slice(0, 2000) + '…' : s
        return ok({
          ok: true,
          verdict: r.verdict,
          reason: r.reason,
          before: {
            exitCode: r.before.exitCode,
            ok: r.before.ok,
            hash: r.before.hash,
            stdout: trunc(r.before.stdout),
            stderr: trunc(r.before.stderr),
          },
          after: {
            exitCode: r.after.exitCode,
            ok: r.after.ok,
            hash: r.after.hash,
            stdout: trunc(r.after.stdout),
            stderr: trunc(r.after.stderr),
          },
          // 工作区还原的核对结果（失败时备份已保留，下次调用会先尝试恢复）
          restore: r.restore || null,
          // 本次调用开始时恢复掉的「上一次被中断的负对照」残留
          recovered: r.recovered || null,
          note:
            (r.verdict === 'meaningful'
              ? '负对照通过：测试有判别力，可以记 PASS。'
              : '负对照未通过：不能记 PASS。' + r.reason) +
            (r.restore && r.restore.ok === false
              ? ' ⚠️ 但工作区还原未通过核对，以下文件与进入负对照前不一致：' +
                (r.restore.mismatched || []).join(', ') +
                '（备份已保留，请人工确认后修复）'
              : '') +
            (!clearedMarker.ok
              ? ' ⚠️ 旧的「不可 PASS」标记清除失败（' +
                clearedMarker.error +
                '）：标记仍在，裁定闸会继续拒 PASS，请人工删除该文件后重试。'
              : ''),
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // 14 -----------------------------------------------------------------------
  {
    name: 'flow_check_scope',
    description:
      '检查指定文件列表是否在卡片 scope 范围内。用于在提交裁定前自查越界改动。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要检查的文件路径列表',
        },
        cwd: {
          type: 'string',
          description: '仓库工作目录，默认 process.cwd()',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        if (!state.card) return fail('没有留痕，无法检查 scope。')

        const scope = Array.isArray(state.card.scope) ? state.card.scope : []
        // 允许集 = scope + new_files（获授权可新建的文件同样算在允许范围内）
        const newFiles = Array.isArray(state.card.new_files)
          ? state.card.new_files
          : []
        const allowed = [...scope, ...newFiles]
        const paths = Array.isArray(a.paths) ? a.paths : []
        // 不传 paths → 自动跑 `git diff --name-only` 取当前实际改动清单。
        // 传了 paths → 用调用方给的清单（自查场景）。
        // 自查同样按仓库根基准，否则「自查没越界、裁定却报越界」会自相矛盾
        const scopeRoot = resolveRepoRoot(a.cwd || process.cwd())
        // 自动模式（不传 paths）：与裁定路径**一致**地减去派发时基线。
        // 派发前就存在的未跟踪文件属于基线，不是本次执行引入的改动，
        // 自查时不得把它报成越界（否则「自查没越界、裁定却报越界」自相矛盾）。
        // 传了 paths → 用调用方给的清单逐项自查（调用方自己指定要查什么）。
        const result = paths.length
          ? enforceScope(allowed, scopeRoot, paths)
          : (() => {
              const current = enforceScope(allowed, scopeRoot)
              const introduced = introducedChanges(
                current.checked || [],
                state.dispatch_baseline,
              )
              const scoped = enforceScope(allowed, scopeRoot, introduced)
              return {
                ...scoped,
                checked: introduced,
                baseline_excluded: (current.checked || []).length - introduced.length,
              }
            })()

        return ok({
          ok: result.ok,
          scope,
          new_files: newFiles,
          checked: paths.length ? paths : result.checked || [],
          ...result,
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
  // 15 -----------------------------------------------------------------------
  {
    name: 'flow_trigger_check',
    description:
      '智能触发检查：判断当前这条用户消息是否应该启动 Carlos 工作流，并在达标时**实际完成激活**（写入用户原话 + 开占位卡 → 会话进入门禁态）。' +
      '宿主在收到用户消息时调用本工具，就能获得与命令行客户端完全一致的自动触发行为。' +
      '未达阈值时只如实返回评分与决策，不做任何动作；被限流时也如实返回真实评分。' +
      '中文流程词（工作流/门禁/派发/审计…）已内置，中文需求同样能触发。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        message: {
          type: 'string',
          description: '用户本轮消息原文（必须是真实原话，用于 quote 锚点）',
        },
        complexity: { type: 'number', description: '任务复杂度系数，默认 1.0' },
        execute: {
          type: 'boolean',
          description:
            'true = 达标时实际执行激活步骤（默认 true）；false = 只评分不动作',
        },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
      required: ['message'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const message = String(a.message || '')
        if (!message.trim()) {
          return fail(
            'message 不能为空：触发检查需要用户本轮消息原文（quote 锚点与评分都依赖它）',
          )
        }
        const shouldExecute = a.execute !== false

        // 触发引擎（纯 JS，零外部依赖）：与 CLI 客户端共用同一份实现，
        // 保证「命令行路径」与「MCP 路径」的评分与决策完全一致。
        const { TriggerEngine } = await import('./trigger.js')
        const result = TriggerEngine.processUserMessage(message, {
          sessionId,
          complexity: typeof a.complexity === 'number' ? a.complexity : 1.0,
        })

        const base = {
          ok: true,
          sessionId,
          decision: result.decision,
          score: result.score,
          confidence: result.confidence,
          breakdown: result.breakdown,
          reason: result.reason,
          should_trigger: result.shouldTrigger === true,
          executed: [],
        }

        // 未达标 / 被限流：只如实报告，不做任何动作。
        if (
          !result.shouldTrigger ||
          !result.activationPlan ||
          !result.activationPlan.activated
        ) {
          return ok({
            ...base,
            activated: false,
            pending_fields:
              (result.activationPlan && result.activationPlan.pendingFields) ||
              [],
            note:
              result.decision === 'throttled'
                ? '被限流：本轮不触发（已如实返回真实评分）'
                : result.decision === 'review'
                  ? '接近阈值：建议手动启动门禁，未自动激活'
                  : '未达触发阈值：不激活',
          })
        }

        // 只读调研意图不进门禁（占位卡恒为 read_only，待补项永远无法满足 → 会话会被锁死）
        const plan = result.activationPlan
        if (plan.activated === false) {
          return ok({
            ...base,
            activated: false,
            pending_fields: plan.pendingFields || [],
            note: plan.reason || '不激活',
          })
        }

        if (!shouldExecute) {
          return ok({
            ...base,
            activated: false,
            execute_suppressed: true,
            pending_fields: plan.pendingFields || [],
            note: '只评分不动作（execute=false）',
          })
        }

        // ---- 执行激活计划中 auto=true 的步骤 ----
        // 安全约束（与 CLI 客户端一致）：
        //   · 会话已有任务卡 → 不自动开卡（不覆盖用户已有任务）
        //   · 只执行 auto 步骤；needsFill 步骤交回 Agent 补齐
        const existing = loadState(sessionId)
        if (existing.card) {
          return ok({
            ...base,
            activated: false,
            note: '会话已有任务卡，跳过自动开卡（不覆盖用户已有任务）',
          })
        }

        const executed = []
        for (const step of plan.steps || []) {
          if (!step || step.auto !== true) continue
          const stepArgs = { ...(step.args || {}), sessionId }
          if (step.tool === 'flow_add_user_msg') {
            writeUserMessage(sessionId, String(stepArgs.text || message))
            executed.push({ tool: step.tool, ok: true })
          } else if (step.tool === 'flow_submit_requirement') {
            // 触发器落卡路径与提交路径**口径一致**：
            //   · 同样给卡片层校验补上仓库根（缺了就按保守口径拒绝）；
            //   · 同样用 card.js 的 validateNewFiles 校新文件授权
            //     （确认 + 授权说明 + 授权说明能在用户原话中定位）。
            const triggerRoot = resolveRepoRoot(a.cwd || process.cwd())
            const triggerMessages = [message]
            const triggerCard = { ...stepArgs }
            if (Array.isArray(stepArgs.newFiles) && stepArgs.newFiles.length) {
              const checkedNew = validateNewFiles(
                stepArgs.newFiles,
                stepArgs.scope,
                triggerRoot,
                {
                  confirmed: stepArgs.confirmed === true,
                  reason:
                    typeof stepArgs.newFilesReason === 'string'
                      ? stepArgs.newFilesReason
                      : '',
                  userMessages: triggerMessages,
                },
              )
              if (!checkedNew.ok) {
                executed.push({
                  tool: step.tool,
                  ok: false,
                  reason: checkedNew.reason,
                })
                continue
              }
              triggerCard.new_files = checkedNew.files
              triggerCard.new_files_reason = checkedNew.reason
              triggerCard.new_files_reasons = Object.fromEntries(
                checkedNew.files.map((f) => [f, checkedNew.reason]),
              )
            }
            const r = validateCard(triggerCard, {
              userMessages: triggerMessages,
              scopeExists: () => true,
              confirmed: stepArgs.confirmed === true,
              repoRoot: triggerRoot,
            })
            if (!r || r.ok !== true) {
              executed.push({
                tool: step.tool,
                ok: false,
                reason: (r && r.reason) || '卡片不合规',
              })
              continue
            }
            const card = { ...triggerCard }
            card.env = {
              git_head: gitHead(a.cwd || process.cwd()),
              project: a.cwd || process.cwd(),
            }
            const tier = riskTier(card.scope)
            const withLock = await withStateLock(sessionId, () => {
              const prev = loadState(sessionId)
              const state = {
                ...defaultState(),
                ...prev,
                card,
                card_ts: Date.now(),
                tier,
                dispatch_count: 0,
                claimed: false,
                claimed_role: null,
                write_files: 0,
                last_user_ts: Date.now(),
                bypass: false,
                verdict: null,
                completed_ok: false,
                stale: false,
                // 幂等派生：待补项由当前卡片内容算出，落盘状态自洽
                activation_pending: ['scope', 'acceptance', 'verify.cmd'],
                activation_activated: true,
              }
              saveState(sessionId, state)
              return state
            })
            audit('run', sessionId, {
              kind: 'activation',
              tier,
              goal: card.goal,
              pending: withLock.activation_pending,
            })
            executed.push({ tool: step.tool, ok: true, tier })
          }
        }

        const after = loadState(sessionId)
        return ok({
          ...base,
          activated: true,
          executed,
          has_card: !!after.card,
          activation_pending: Array.isArray(after.activation_pending)
            ? after.activation_pending
            : [],
          pending_fields: plan.pendingFields || [],
          note: '已自动激活：会话进入门禁态，补齐 scope/acceptance/verify.cmd 后方可派发',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },

  // =========================================================================
  // 四大高阶复合门面工具 (High-Level Facades)
  // 聚合并替代繁杂的底层单次调用，降低模型交互轮次与 Token 消耗
  // =========================================================================

  // Facade 1: 任务生命周期门面 (carlos_task)
  {
    name: 'carlos_task',
    description:
      '【高阶复合门面】统一管理任务的留痕、开卡、认领与派发流程。' +
      '支持 action: "submit"（提交卡片）/ "claim"（认领角色）/ "dispatch"（派发执行）/ "start"（留痕并直接开卡）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'claim', 'dispatch', 'start'],
          description: '操作类型：submit/claim/dispatch/start',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        goal: { type: 'string', description: '任务目标' },
        quote: { type: 'string', description: '用户原话摘录' },
        scope: { type: 'array', items: { type: 'string' }, description: '允许修改的文件范围' },
        newFiles: { type: 'array', items: { type: 'string' }, description: '获授权新建的文件' },
        newFilesReason: { type: 'string', description: '新建文件授权说明' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准' },
        role: { type: 'string', enum: ['executor', 'auditor'], description: '认领/派发角色' },
        verify: { type: 'object', description: '验证命令配置，如 { cmd: "npm test" }' },
        confirmed: { type: 'boolean', description: '敏感路径或新文件确认' },
        message: { type: 'string', description: '派发附加说明' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'submit'
      const {
        sessionId,
        goal,
        quote,
        scope,
        newFiles,
        newFilesReason,
        acceptance,
        role,
        verify,
        confirmed,
        message,
        cwd,
      } = a
      void sessionId
      void goal
      void quote
      void scope
      void newFiles
      void newFilesReason
      void acceptance
      void role
      void verify
      void confirmed
      void message
      void cwd
      const toolMap = {
        submit: 'flow_submit_requirement',
        start: 'flow_submit_requirement',
        claim: 'flow_claim',
        dispatch: 'flow_dispatch',
      }
      const targetTool = toolMap[action] || 'flow_submit_requirement'
      const toolObj = TOOLS.find((t) => t.name === targetTool)
      if (!toolObj) return fail('未找到对应的任务处理程序：' + targetTool)
      return toolObj.handler(args, context, runtime)
    },
  },

  // Facade 2: 验证与反向证伪门面 (carlos_verify)
  {
    name: 'carlos_verify',
    description:
      '【高阶复合门面】统一执行真实验证命令、反向负对照证伪与越界自查。' +
      '支持 action: "run"（执行验证）/ "falsify"（负对照证伪）/ "check_scope"（越界检查）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'falsify', 'check_scope'],
          description: '操作类型：run/falsify/check_scope',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        cmd: { type: 'string', description: '验证命令' },
        paths: { type: 'array', items: { type: 'string' }, description: '待查路径列表' },
        timeoutMs: { type: 'number', description: '超时毫秒数' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'run'
      const { sessionId, cmd, paths, timeoutMs, cwd } = a
      void sessionId
      void cmd
      void paths
      void timeoutMs
      void cwd
      // 代理调用：若 action === 'check_scope' 且提供了 paths，先委托 enforceScope 做预检
      if (action === 'check_scope' && Array.isArray(paths)) {
        enforceScope(paths, cwd || process.cwd())
      }
      const toolMap = {
        run: 'flow_run_verify',
        falsify: 'flow_falsify',
        check_scope: 'flow_check_scope',
      }
      const targetTool = toolMap[action] || 'flow_run_verify'
      const toolObj = TOOLS.find((t) => t.name === targetTool)
      if (!toolObj) return fail('未找到对应的验证处理程序：' + targetTool)
      return toolObj.handler(args, context, runtime)
    },
  },

  // Facade 3: 独立审查与最终裁定门面 (carlos_review)
  {
    name: 'carlos_review',
    description:
      '【高阶复合门面】统一派发双轴独立审查、提交审查结论与记录最终裁定。' +
      '支持 action: "axes"（派发审查）/ "submit"（提交单轴结论）/ "guard"（双轴自查）/ "verdict"（记录裁定）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['axes', 'submit', 'guard', 'verdict'],
          description: '操作类型：axes/submit/guard/verdict',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        axis: { type: 'string', enum: ['standards', 'spec'], description: '审查轴' },
        verdict: { type: 'string', enum: ['PASS', 'DIRECTION', 'LOCAL', 'WARN', 'FAIL'], description: '裁定结论' },
        notes: { type: 'string', description: '审查说明或证据' },
        role: { type: 'string', description: '裁定角色' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'verdict'
      const { sessionId, axis, verdict, notes, role, cwd } = a
      void sessionId
      void axis
      void verdict
      void notes
      void role
      void cwd
      const toolMap = {
        axes: 'flow_audit_axes',
        submit: 'flow_audit_submit',
        guard: 'flow_audit_guard',
        verdict: 'flow_verdict',
      }
      const targetTool = toolMap[action] || 'flow_verdict'
      const toolObj = TOOLS.find((t) => t.name === targetTool)
      if (!toolObj) return fail('未找到对应的审查处理程序：' + targetTool)
      return toolObj.handler(args, context, runtime)
    },
  },

  // Facade 4: 状态管理与一键运维门面 (carlos_manage)
  {
    name: 'carlos_manage',
    description:
      '【高阶复合门面】统一管理门禁状态查询、撤销任务、一键回滚计划与存储度量。' +
      '支持 action: "status"（查状态）/ "cancel"（一键撤销）/ "revert"（回滚计划）/ "stats"（存储分析）/ "bypass"（免检开关）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'cancel', 'revert', 'stats', 'bypass'],
          description: '操作类型：status/cancel/revert/stats/bypass',
        },
        sessionId: { type: 'string', description: '会话 ID' },
        reason: { type: 'string', description: '撤销或操作理由' },
        on: { type: 'boolean', description: '免检开关' },
        confirmed: { type: 'boolean', description: '确认授权' },
        cwd: { type: 'string', description: '工作目录' },
      },
      required: ['action'],
    },
    handler: async (args, context, runtime) => {
      const a = args || {}
      const action = a.action || 'status'
      const { sessionId, reason, on, confirmed, cwd } = a
      void sessionId
      void reason
      void on
      void confirmed
      void cwd
      const toolMap = {
        status: 'flow_status',
        cancel: 'flow_cancel',
        revert: 'flow_revert_plan',
        stats: 'flow_stats',
        bypass: 'flow_bypass',
      }
      const targetTool = toolMap[action] || 'flow_status'
      const toolObj = TOOLS.find((t) => t.name === targetTool)
      if (!toolObj) return fail('未找到对应的运维处理程序：' + targetTool)
      return toolObj.handler(args, context, runtime)
    },
  },
]

// ---- 工具去重自检 ----------------------------------------------------------
//
// TOOLS 数组里出现两个同名工具定义时：
// 路由用 TOOLS.find((t) => t.name === name) **只取第一个匹配项**，
// 后一份健壮实现就成了永不执行的死代码 —— 而整个过程**没有任何报错**，
// 属于静默失效，非常危险。
//
// 这里在模块加载时做一次硬校验：一旦发现重名就抛出带明确信息的 Error
// （指出工具名 + 首次/重复出现的索引），让 MCP server 拒绝启动。
// 正常情况下（无重名）不产生任何副作用，直接返回 true。
function assertNoDuplicateTools(tools = TOOLS) {
  const seen = new Map() // 工具名 -> 首次出现的索引
  const dups = [] // { name, first, second }
  tools.forEach((tool, idx) => {
    const key = tool && tool.name
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        'TOOLS[' + idx + '] 缺少合法的 name 字段，无法完成工具去重校验',
      )
    }
    if (seen.has(key)) {
      dups.push({ name: key, first: seen.get(key), second: idx })
    } else {
      seen.set(key, idx)
    }
  })
  if (dups.length > 0) {
    const detail = dups
      .map(
        (d) =>
          '「' +
          d.name +
          '」（首次出现于 TOOLS[' +
          d.first +
          ']，重复出现于 TOOLS[' +
          d.second +
          ']）',
      )
      .join('、')
    throw new Error(
      'TOOLS 中存在重复的工具名：' +
        detail +
        ' —— 重名会导致 TOOLS.find() 只路由到第一份，后一份成为永不执行的死代码。已拒绝启动 MCP server。',
    )
  }
  return true
}

// 启动前自检：重名即拒绝启动，并打印清晰错误（不静默失效）。
try {
  assertNoDuplicateTools()
} catch (e) {
  process.stderr.write(
    '[carlos-flow] 致命错误：工具定义校验失败，MCP server 拒绝启动 —— ' +
      (e && e.message ? e.message : String(e)) +
      '\n',
  )
  throw e
}

// ---- 服务器装配 ------------------------------------------------------------

// server 版本号必须从 package.json 读：写死版本号会让客户端 initialize
// 拿到错版本，无法据此判断真实能力。
const pkgVersion = (() => {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(pkgUrl, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// 对外工具清单（tools/list 的载荷）：**绝不能**把 handler 带出去 ——
// 它是函数，序列化后会变成 undefined 或被宿主拒收。
const TOOL_SCHEMAS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}))

// ⚠️ 必须守住：不得重复装配 handler（后装配的会覆盖先装配的），
// 否则参数校验（required / 类型 / enum）静默失效。
// 口径：只有 `callTool` 一条通路，且它**必须先过 validateToolArgs**。
// check:no-dead-handler 门禁守着「按 name 分发 + 真的调用了参数校验」这两点。

// ---- Phase 1-1: 工具参数校验器（required 字段 / 类型 / enum）----
function validateToolArgs(toolName, args) {
  const tool = TOOLS.find((t) => t.name === toolName)
  if (!tool || !tool.inputSchema) return { ok: true }
  const schema = tool.inputSchema

  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      const v = args[field]
      if (v === undefined || v === null || v === '') {
        return { ok: false, error: '缺少必填字段：' + field }
      }
    }
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const v = args[key]
      if (v === undefined || v === null) continue
      if (prop.type) {
        const expected = prop.type === 'integer' ? 'number' : prop.type
        if (expected === 'number' && typeof v !== 'number') {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 number' }
        }
        if (expected === 'array' && !Array.isArray(v)) {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 array' }
        }
        if (expected === 'string' && typeof v !== 'string') {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 string' }
        }
        if (expected === 'boolean' && typeof v !== 'boolean') {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 boolean' }
        }
      }
      // 数组**元素**类型校验：schema 已声明 items:{type:"string"} 时，
      // 只校验顶层 array 类型是不够的 —— 元素类型不符会一路传到 Node 内部
      // 才报错（例：flow_check_scope 的 paths:["README.md",123] 会抛
      // "The \"path\" argument must be of type string" 这种底层错误），
      // 调用方拿到的是不可读的堆栈信息。改为在入口就给出明确提示。
      // 注意：**null 也要拦**（typeof null !== "string"）—— 否则 unknowns=[null]
      // 这类值会静默落盘（虽然不参与档位必填、不进 executor 合同文本，
      // 但会在 flow_status 回显整卡时露出 null 元素）。
      if (
        prop.type === 'array' &&
        Array.isArray(v) &&
        prop.items &&
        prop.items.type
      ) {
        const want = prop.items.type === 'integer' ? 'number' : prop.items.type
        for (let i = 0; i < v.length; i++) {
          const el = v[i]
          if (el === undefined) continue
          const bad =
            (want === 'number' && typeof el !== 'number') ||
            (want === 'string' && typeof el !== 'string') ||
            (want === 'boolean' && typeof el !== 'boolean') ||
            (want === 'object' &&
              (typeof el !== 'object' || el === null || Array.isArray(el)))
          if (bad) {
            return {
              ok: false,
              error: '字段 ' + key + '[' + i + '] 类型错误，期望 ' + want,
            }
          }
        }
      }
      if (prop.enum && !prop.enum.includes(v)) {
        return {
          ok: false,
          error: '字段 ' + key + ' 值非法，可选：' + prop.enum.join(', '),
        }
      }
    }
  }
  return { ok: true }
}

import { issueStaleOffer, claimStaleOffer, staleCaseIdentity } from './state.js'

// ---- CallTool：先校验参数，再分发到工具 handler ----
async function callTool(toolName, args, context, runtime) {
  const t = TOOLS.find((x) => x.name === toolName)
  if (!t) {
    return {
      content: [{ type: 'text', text: 'Unknown tool: ' + toolName }],
      isError: true,
    }
  }

  const validation = validateToolArgs(toolName, args)
  if (!validation.ok) {
    return {
      content: [{ type: 'text', text: 'ERROR: ' + validation.error }],
      isError: true,
    }
  }

  // 项目级敏感路径扩展：从 cwd 逐级向上找 `.carlos.json`（只追加，不能缩减）。
  // 放在这里统一加载，保证同一请求里所有路径判定用同一份规则；
  // 配置缺失 / 损坏时自动退回内置基线，不影响门禁。
  try {
    loadProjectSensitiveConfig(
      typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd(),
    )
  } catch {
    /* 配置不可读：保持内置基线 */
  }

  return auditRequests.run([], async () => {
    let result
    let error
    try {
      // 锁外操作即使等待期间换卡，旧请求的失败也不能取消新卡的完成状态。
      const sid = args.sessionId || 'unknown'
      auditRequests.getStore().version = { ...loadState(sid), sid }
      if (runtime?.failure && (toolName === 'flow_run_verify' || toolName === 'flow_falsify' ||
          (toolName === 'flow_verdict' && args.verdict === 'PASS')))
        throw new Error('Host固定哈希能力不可用，未执行操作。')
      result = await t.handler(args, context, runtime)
    } catch (e) {
      error = e && e.message ? e.message : String(e)
    }
    // handler（包括其 catch）已返回，所有状态临界区均已释放。
    // 失败仍返回失败；补记失败不能被原 handler 的成功回执遮掩。
    for (const failure of auditRequests.getStore()) {
      error = `审计未确认持久化，请重试并复核状态: ${failure.error}`
      try {
        await commitState(failure.sid, (latest) => {
          if (
            latest.card_ts !== failure.card_ts ||
            JSON.stringify(latest.card) !== failure.card
          )
            return
          latest.completed_ok = false
          latest.audit_pending = {
            kind: failure.kind,
            card_ts: failure.card_ts,
            failed_at: failure.failed_at,
            error: failure.error,
            retry:
              '重试原操作并复核 flow_status；失败追加可能已落盘，允许重复事件',
          }
        })
      } catch (e) {
        error += `；失败状态补记也未持久化: ${e && e.message ? e.message : String(e)}`
      }
    }
    return error
      ? {
          content: [{ type: 'text', text: 'ERROR: ' + formatError(error) }],
          isError: true,
        }
      : result
  })
}

// ---- 传输模式：stdio（逐行 JSON-RPC 2.0） ----
// 启动日志必须在 await 之前写：serveStdio 会一直阻塞到 stdin 关闭（宿主退出），
// 写在后面等于「只在退出时打印」，排查时看不到任何启动痕迹。
process.stderr.write('carlos-flow MCP server ready (stdio)\n')
// ⚠️ 这里**不能**用顶层 await。
// 实测：Cindy 的随包 Node 进程用 require() 加载入口，
// ESM 图里只要有顶层 await，require 就抛 ERR_REQUIRE_ASYNC_MODULE，
// 插件表现为「一调就 Node 工作进程已退出」。
// serveStdio 返回的 Promise 不 await 也没关系：readline 订阅着 stdin，
// 进程不会被事件循环判定为空闲而退出；失败走 catch 落 stderr + 非零退出码。
serveStdio({
  name: 'carlos-flow',
  version: pkgVersion,
  tools: TOOL_SCHEMAS,
  callTool,
  log,
}).catch((e) => {
  try {
    process.stderr.write(
      '[carlos-flow] stdio 服务端异常退出：' +
        (e && e.message ? e.message : e) +
        '\n',
    )
  } catch {
    /* stderr 不可写时静默 */
  }
  process.exitCode = 1
})
