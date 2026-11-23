// dispatch.js — Carlos 工作流：四段合同 prompt / 文件快照 / opencode 子进程 / 验证执行 / scope 校验（Node ESM）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  RUNS_DIR,
  FLOW_HOME,
  sanitizeId,
  retryOwnReaperOperation,
  cleanupOwnReaperFiles,
  loadState,
} from './state.js'
// 路径键与真实路径解析与卡片层共用同一份（src/card.js）：
//   · pathKey —— win32 折叠大小写、其它平台敏感，授权写法与落盘写法必须同口径；
//   · realTargetPath —— 唯一一份「这条路径真实落在哪里」的解析。
import { pathKey, realTargetPath } from './card.js'
import {
  loadProjectFailureMemory,
  saveProjectFailureMemory,
} from './failure-memory.js'
import { resolveTaskWorkdir } from './worktree.js'

export const MAX_DISPATCH = 5

// 通用设计基线（坏味道清单）—— Standards 轴的第二层基线。
//
// 出处与边界（重要，不要夸大）：
//   · 本表由 Carlos 项目自维护，**术语对齐** Fowler et al.《Refactoring:
//     Improving the Design of Existing Code》第二版第 3 章「Code Smells」；
//   · 但它**不是原书全表**，也不声称逐条等同原书 —— 原书两版条目数不同，
//     市面上流传的「Fowler 12 种坏味道」是二手博客的说法、不是书里的口径。
//     把一个无法核实的数字写进审计权威，subagent 就会拿着错的基准去判定。
//   · 显式化清单的价值不在「权威」，在**可枚举、可测试、口径一致**：
//     判定不再依赖模型记性，测试也能断言基线条目一条都没被静默删掉。
export const SMELL_BASELINE = [
  { name: 'Duplicated Code', desc: '同一段逻辑重复出现，改一处漏一处' },
  { name: 'Long Method', desc: '函数承担过多职责，应拆分' },
  { name: 'Long Parameter List', desc: '参数过多，应封装成对象' },
  { name: 'Large Class', desc: '类承担过多职责' },
  { name: 'Data Clumps', desc: '同一组字段/参数反复成组出现' },
  { name: 'Primitive Obsession', desc: '用基本类型代替领域对象' },
  { name: 'Feature Envy', desc: '方法比宿主对象更依赖别的对象的数据' },
  { name: 'Message Chains', desc: '过长的链式调用（a.getB().getC().getD()）' },
  { name: 'Middle Man', desc: '类/方法只做转发，自己没有职责' },
  { name: 'Divergent Change', desc: '一个类因多种不相关的原因被修改' },
  { name: 'Shotgun Surgery', desc: '一处逻辑改动要同步改多个文件' },
  { name: 'Speculative Generality', desc: '为尚不存在的需求预留扩展点' },
  { name: 'Temporary Field', desc: '字段只在某段流程内有值' },
  { name: 'Refused Bequest', desc: '子类继承父类却拒绝/覆盖其大部分行为' },
  { name: 'Data Class', desc: '只有数据没有行为' },
  { name: 'Lazy Class', desc: '只有方法没有实质职责' },
  { name: 'Comments', desc: '用注释掩盖代码本该表达的东西' },
  { name: 'Dead Code', desc: '永不可达的废弃代码' },
]

// 渲染审计 checklist 段：条目逐条编号，便于 subagent 按项检查、便于测试逐条断言。
function renderChecklist(checklist) {
  const items = (checklist.items || [])
    .map((it, i) => `${i + 1}. ${it.name} — ${it.desc}`)
    .join('\n')
  return `${checklist.title}（逐条检查，命中即给 file:line 证据）：\n${items}\n注：${checklist.note}`
}

// Dispatcher 配置：双轴审查 prompt 配置表。
// 新增轴只改这里，不动 buildContractPrompt 的函数体（避免分支膨胀）。
//
// 判定词表必须与 flow_audit_submit 的 enum（PASS / WARN / FAIL）对齐：
// 词表不一致时 subagent 会输出「通过/违规」这类自然语言，由主 Agent 手工映射，
// 而 FAIL（硬拦）与 WARN（不拦）的差别就在这一步 —— 映射错了硬拦就失效了。
const AXIS_PROMPTS = {
  standards: {
    objective: '审计：仓库代码规范与坏味道',
    format:
      '判定（PASS / WARN / FAIL） / 规范依据 / file:line 证据 / 是否硬违规',
    guidance:
      '两层基线同时执行：' +
      '① 仓库规范层：先在目标仓库内发现规范文件（eslint 配置、prettier 配置、editorconfig、' +
      'CONTRIBUTING.md、AGENTS.md、tsconfig 的 lint 选项、CI 里的 lint/test 命令），' +
      '把发现的规范文件清单写进报告，再逐条对照；' +
      '② 通用设计层：按下面的「坏味道基线」逐条检查。' +
      '只读取证 git diff，不轻信 executor 自述，每条命中都要给 file:line 证据。' +
      '判定口径：违反仓库明文规范判 FAIL；命中通用设计基线判 WARN。',
    boundaries: '零文件改动，只读取证',
    checklist: {
      title: '坏味道基线',
      items: SMELL_BASELINE,
      note: '本表由 Carlos 自维护，术语对齐 Fowler《Refactoring》第二版第 3 章 Code Smells，非原书全表',
    },
  },
  spec: {
    objective: '审计：任务卡验收标准忠实度',
    format:
      '判定（PASS / WARN / FAIL） / 验收标准逐条核对结果 / 越界改动（file:line）',
    guidance:
      '对照任务卡 goal/acceptance/scope，逐条核对卡上的验收标准，跑 flow_check_scope 校验越界，' +
      '独立跑验证命令取证。判定口径：验收标准全部满足且无越界判 PASS；未实现验收或越界改动判 FAIL；' +
      '仅部分存疑判 WARN。',
    boundaries: '零文件改动，只读取证',
  },
}

import { PROMPT_PROFILES } from './profiles.js'

/**
 * 本地错误自愈知识库 (Failure Memory & Self-Healing Guidelines)
 * 记录历史项目中踩过的坑与规则，避免重复犯错
 */
/**
 * 失败记忆：项目隔离存储（阶段二）。
 *
 * 旧实现在 FLOW_HOME 根下写单一 failure-memory.json，任何项目都读同一份，
 * 于是 A 仓库的坑会被注入到 B 仓库的派发 Prompt，且旧全局记录无法判断归属。
 * 现在改为按项目分区；仍复用同一个 CARLOS_FLOW_HOME，不建第二套知识库。
 * 旧全局文件只读统计（legacy.ignored），不自动归入任何项目、也不注入。
 */
function memoryOptions(options = {}) {
  return { flowHome: FLOW_HOME, cwd: options.cwd || process.cwd() }
}

export function loadFailureMemory(options = {}) {
  return loadProjectFailureMemory(memoryOptions(options))
}

export function saveFailureMemory(item, options = {}) {
  const saved = saveProjectFailureMemory(item, memoryOptions(options))
  if (!saved.ok) {
    // 调用方必须能知道没保存成功；旧接口返回 undefined，这里抛出可读错误由上层转为提示。
    const err = new Error(`失败记忆未保存：${saved.reason || '未知原因'}`)
    err.code = 'FAILURE_MEMORY_NOT_SAVED'
    throw err
  }
  return saved
}

/**
 * 根据 scope 文件类型推断事前最佳实践指南 (Proactive Guidelines)
 */
export function inferProactiveGuidelines(scope = [], options = {}) {
  const list = Array.isArray(scope) ? scope.map((s) => String(s).toLowerCase()) : []
  const tips = []

  // 0. 加载本项目错误自愈知识库（跨项目不串用）
  const mem = loadProjectFailureMemory(memoryOptions(options))
  if (Array.isArray(mem.rules) && mem.rules.length > 0) {
    // 超预算被裁剪时规则仍然有效：先注入，再附一句说明，不能整体作废。
    for (const r of mem.rules.slice(-3)) {
      tips.push(`• 历史避坑经验: ${r.text}`)
    }
    if (mem.degraded) {
      tips.push(`• 历史避坑经验: 已裁剪（${mem.degraded_reason || '超出预算'}）`)
    }
  } else if (mem.degraded) {
    tips.push(`• 历史避坑经验: 暂不可用（${mem.degraded_reason || '记忆文件损坏'}），已按无经验继续`)
  }

  if (list.length > 0) {
    // 1. API 接口 / Controller 相关
    if (list.some((f) => f.includes('api') || f.includes('route') || f.includes('controller') || f.includes('server') || f.includes('handler'))) {
      tips.push('• 接口安全：入参必须强类型校验，返回必须脱敏敏感字段，严格防范越界与空注入。')
    }

    // 2. 数据存储 / 状态 / 事务相关
    if (list.some((f) => f.includes('db') || f.includes('state') || f.includes('storage') || f.includes('lock') || f.includes('store') || f.includes('sql'))) {
      tips.push('• 存储与状态：并发写入必须加锁互斥，读写操作保证原子性与状态可回滚，禁止写死绝对路径。')
    }

    // 3. 工具链 / 跨平台 / CLI 相关
    if (list.some((f) => f.includes('cli') || f.includes('bridge') || f.includes('bin') || f.includes('script') || f.includes('spawn') || f.includes('process'))) {
      tips.push('• 跨平台健壮性：路径统一使用正斜杠或 path.join，子进程必须指定 windowsHide: true，杜绝控制台黑窗弹窗。')
    }

    // 4. 前端 / UI / 页面相关
    if (list.some((f) => f.includes('ui') || f.includes('html') || f.includes('css') || f.includes('view') || f.includes('page') || f.includes('component'))) {
      tips.push('• 界面体验：长文本输出默认折叠，移动端适配 <600px 响应式大触控区，关键报错转换为通俗人话。')
    }
  }

  return tips.length > 0 ? 'proactive guidelines (事前代码规范建议):\n' + tips.join('\n') : ''
}

// role ∈ "executor" | "auditor"
// options ∈ { axis?: "standards"|"spec", profile?: string }
export function buildContractPrompt(role, card, extra, options = {}) {
  const isAuditor = role === 'auditor'
  const isExecutor = role === 'executor'
  if (!isAuditor && !isExecutor) {
    throw new Error(
      `buildContractPrompt: 未知 role "${role}"（仅支持 executor/auditor）`,
    )
  }

  // 模式注入：指定了 axis/profile 就走配置表（覆盖式），否则走原有逻辑
  let objective, outputFormat, toolGuidance, taskBoundaries
  const { axis, profile } =
    typeof options === 'string' ? { axis: options } : options

  if (axis && AXIS_PROMPTS[axis]) {
    const cfg = AXIS_PROMPTS[axis]
    objective = `objective: ${cfg.objective}`
    outputFormat = `output format: ${cfg.format}`
    toolGuidance = `tool guidance: ${cfg.guidance}`
    taskBoundaries = `task boundaries: ${cfg.boundaries}`
  } else if (profile && PROMPT_PROFILES[profile]) {
    const cfg = PROMPT_PROFILES[profile]
    objective = `objective: ${cfg.objective}`
    outputFormat = `output format: ${cfg.format}`
    toolGuidance = `tool guidance: ${cfg.guidance}`
    taskBoundaries = isAuditor
      ? 'task boundaries: 零文件改动，只读取证'
      : 'task boundaries: 无文件可改，只读任务'
  } else {
    const c = card && typeof card === 'object' ? card : {}

    objective = `objective: ${c.goal || ''}`

    outputFormat = isExecutor
      ? 'output format: 报告 ≤300 字，四段：结论（一句话，做完/没做完） / 改动（file:line 逐条列出，没改写“无”） / 验证（命令 → 结果摘要，未跑写“未验证”） / 遗留风险'
      : 'output format: 报告 ≤200 字，五段：裁定（通过/不通过） / 失败类型（操作错误/环境问题/卡片问题） / scope 标注（是否越界改动） / 证据（file:line 或实跑命令输出） / 附注'

    const verifyCmd = c.verify && c.verify.cmd ? String(c.verify.cmd) : ''
    let guidance = verifyCmd || '未指定验证命令，用只读取证'
    if (isAuditor) {
      guidance +=
        '；独立跑 git status --porcelain 与 git diff 取证，不轻信 executor 自述'
    }
    toolGuidance = `tool guidance: ${guidance}`

    const scopeArr = Array.isArray(c.scope) ? c.scope.map(String) : []
    // 多 Agent 网格支持：若传入了特定的 subAgentName，提取该子 Agent 专属的 allowed_scope
    const agentMesh = c.agents && typeof c.agents === 'object' ? c.agents : null
    const subAgent = options.subAgent || options.agent
    let effectiveScope = scopeArr
    if (subAgent && agentMesh && agentMesh[subAgent] && Array.isArray(agentMesh[subAgent].allowed_scope)) {
      effectiveScope = agentMesh[subAgent].allowed_scope.map(String)
    }

    // 获授权可新建的文件（new_files）：必须与 scope 一起写进「任务边界」——
    // 执行者只看得到 prompt，看不到卡片字段；不列出来就等于没授权，
    // 而它新建的文件又会被越界检测当成越界改动。
    const newFilesArr = Array.isArray(c.new_files)
      ? c.new_files.map(String).filter((p) => p.trim() !== '')
      : []
    let boundaries
    if (isAuditor) {
      boundaries = '零文件改动，只读取证'
    } else {
      boundaries =
        effectiveScope.length > 0 ? effectiveScope.join(', ') : '无文件可改，只读任务'
    }
    if (newFilesArr.length) {
      boundaries +=
        (isAuditor ? '；获授权新建文件（只读核对，不得改动）：' : '；获授权新建文件：') +
        newFilesArr.join(', ')
    }
    taskBoundaries = `task boundaries: ${boundaries}`
  }

  // 任务卡绑定工作区时，明确告诉执行者“在哪个目录工作”，
  // 避免它按主仓库路径改文件、把快照与报告写回主工作区。
  const worktreePath = card && card.env && card.env.worktree
    ? (resolveTaskWorkdir(card, { flowHome: FLOW_HOME })?.path || null)
    : null
  if (worktreePath && isExecutor) {
    taskBoundaries += `；task workspace: ${worktreePath}（所有读写、测试与报告都在此目录）`
  }

  let prompt = [objective, outputFormat, toolGuidance, taskBoundaries].join(
    '\n',
  )

  // 事前代码规范注入：若是 executor 执行者，根据 scope 自动注入针对性编码最佳实践
  if (isExecutor && card && Array.isArray(card.scope) && card.scope.length > 0) {
    // 项目身份按本次派发的工作目录解析：拿不到真实工作目录就不注入，
    // 绝不回落到 MCP server 的启动目录（那会把记忆写进/读自错误项目）。
    const dispatchCwd = options.cwd || card.env?.worktree?.path || card.env?.project || card.verify?.cwd || null
    if (dispatchCwd) {
      const guidelines = inferProactiveGuidelines(card.scope, { cwd: dispatchCwd })
      if (guidelines) {
        prompt += '\n\n' + guidelines
      }
    }
  }

  // 轴模式：附上该轴的基线清单（Standards 轴的坏味道基线）。
  // 清单必须内联进 prompt —— 审计 subagent 跑在**目标仓库**里，
  // 读不到 carlos-flow 包内的文件，写成 docs/xxx.md 让它去读等于没写。
  const axisCfg = axis ? AXIS_PROMPTS[axis] : null
  if (axisCfg && axisCfg.checklist) {
    prompt += '\n\n' + renderChecklist(axisCfg.checklist)
  }

  if (extra && String(extra) !== '') {
    prompt += '\n\n' + String(extra) // 原样附在末尾
  }
  return prompt
}

// 每个 orig 保留几份历史快照。
//
// 为什么是 3：flow_revert_plan 的语义是「回到派发时」，多轮返工时真正需要的是
// 「最近几轮」；保留全部历史只有审计价值，却让 backup/ 随返工次数线性膨胀
// （实测单会话 94% 的目录占用都在 backup/）。改成 3 版后占用变成常数级上界。
export const SNAPSHOT_KEEP_VERSIONS = 3

// 内容寻址备份文件名：sha-<sha256 前 32 位><扩展名>。
//
// 为什么只带扩展名、不带原文件名：去重的关键是**内容**。实测里同内容的文件
// 常以不同文件名出现（a.txt / a.bak.txt / 改名后的同一份），带 basename 会让它们
// 各自占一份 blob，等于没去重。扩展名只用于肉眼分辨类型，不参与身份。
function backupFileNameFor(sha, orig) {
  const ext = path.extname(orig || '').toLowerCase()
  return `sha-${sha.slice(0, 32)}${ext}`
}

// 同步接口遇锁冲突立即失败，不阻塞事件循环等待。
// 活跃或未知身份不按时间过期；死亡身份由回收竞争协议处理。
function backupHash(data) {
  return createHash('sha256').update(data).digest('hex')
}
function backupWrite(file, data, flag = 'w') {
  fs.writeFileSync(file, data, { flag })
  const fd = fs.openSync(file, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
function backupSync(dir) {
  let fd
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch (e) {
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(e.code)
    )
      throw e
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
function backupPath(dir, file) {
  const full = path.resolve(file)
  if (
    path.dirname(full) !== path.resolve(dir) ||
    /^(manifest|\.backup)/.test(path.basename(full))
  )
    throw new Error('Unsafe backup path')
  if (fs.existsSync(full) && !fs.lstatSync(full).isFile())
    throw new Error('Unsafe backup symlink/type')
  return full
}
export function prepareBackupBlob(dir, target, bytes) {
  backupPath(dir, target)
  const sha = backupHash(bytes)
  if (fs.existsSync(target)) {
    if (backupHash(fs.readFileSync(target)) !== sha)
      throw new Error('Existing backup hash mismatch')
    return
  }
  // 进程退出也不会暴露未写完整的内容寻址备份。
  const temp = target + '.' + randomBytes(16).toString('hex') + '.tmp'
  backupWrite(temp, bytes, 'wx')
  fs.renameSync(temp, target)
  backupSync(dir)
}
function backupText(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return ''
    throw e
  }
}
export function backupManifestEntries(dir) {
  return backupText(dir)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const e = JSON.parse(l)
      if (!e || typeof e !== 'object')
        throw new Error('Invalid manifest record')
      if (e.backup) {
        const bytes = fs.readFileSync(backupPath(dir, e.backup))
        if (e.sha && backupHash(bytes) !== e.sha)
          throw new Error('Backup hash mismatch')
      }
      return e
    })
}
export function snapshotIdentity(sid, baseline = []) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid), 'backup')
    const manifest = path.join(dir, 'manifest.jsonl')
    // 不把缺失清单伪装成空快照；只读，不触发事务恢复。
    const before = fs.readFileSync(manifest)
    const entries = backupManifestEntries(dir).map((e) => {
      if (
        typeof e.orig !== 'string' ||
        !e.orig ||
        (e.created !== true && !e.backup)
      ) {
        throw new Error('快照记录无效')
      }
      const actualHash = e.backup
        ? backupHash(fs.readFileSync(backupPath(dir, e.backup)))
        : null
      if (e.sha && actualHash !== e.sha) throw new Error('备份摘要不符')
      return {
        orig: e.orig,
        backup: e.backup ?? null,
        created: e.created === true,
        sha: e.sha ?? null,
        backup_sha256: actualHash,
      }
    })
    const after = fs.readFileSync(manifest)
    if (!before.equals(after)) throw new Error('读取期间快照清单发生变化')
    return {
      ok: true,
      manifest_sha256: backupHash(before),
      dispatch_baseline_sha256: backupHash(JSON.stringify(baseline)),
      entries,
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

function recoverBackup(dir) {
  const journal = path.join(dir, '.backup-txn')
  if (!fs.existsSync(journal)) return
  if (!fs.lstatSync(journal).isFile())
    throw new Error('Unsafe recovery journal')
  const tx = JSON.parse(fs.readFileSync(journal, 'utf8'))
  if (
    tx.version !== 1 ||
    !Array.isArray(tx.garbage) ||
    !/^manifest-[a-f0-9]+\.tmp$/.test(tx.temp)
  )
    throw new Error('Invalid recovery journal')
  const garbage = tx.garbage.map((f) => backupPath(dir, f))
  const current = backupHash(backupText(dir))
  if (current !== tx.before && current !== tx.after)
    throw new Error('Ambiguous backup transaction')
  if (current === tx.after) {
    const refs = new Set(
      backupManifestEntries(dir)
        .filter((e) => e.backup)
        .map((e) => path.resolve(e.backup)),
    )
    for (const f of garbage) {
      if (refs.has(f))
        throw new Error('Recovery would delete referenced backup')
      try {
        fs.unlinkSync(f)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }
  }
  try {
    fs.unlinkSync(path.join(dir, tx.temp))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  backupSync(dir)
  fs.unlinkSync(journal)
  backupSync(dir)
}
// Bakery 竞争声明只由创建者移除，避免共享回收锁的比较后删除竞态。
// 死亡声明仅忽略，不由竞争者删除，因此暂停进程不能误删后继身份（ABA）。
// PID 被复用时保守阻断，不猜测身份。
function withBackupReaper(dir, action) {
  const reap = path.join(dir, '.backup-reap')
  try {
    fs.mkdirSync(reap)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  if (!fs.lstatSync(reap).isDirectory() || fs.lstatSync(reap).isSymbolicLink())
    throw new Error('Unknown backup reaper owner/type')
  const token = randomBytes(16).toString('hex')
  const claim = path.join(reap, `${process.pid}-${token}.json`)
  const owner = { pid: process.pid, token, ticket: 0 }
  const temp = path.join(dir, `.backup-reap-${token}.tmp`)
  const publish = () => {
    backupWrite(temp, JSON.stringify(owner), 'wx')
    retryOwnReaperOperation(() => fs.renameSync(temp, claim)) // 完整身份始终以原子方式可见。
  }
  const peers = () => {
    const live = []
    for (const name of fs.readdirSync(reap)) {
      const file = path.join(reap, name)
      let text
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
          throw new Error('Unknown backup reaper owner/type')
        text = fs.readFileSync(file, 'utf8')
      } catch (e) {
        if (e.code === 'ENOENT') continue
        throw e
      }
      let p
      try {
        p = JSON.parse(text)
      } catch {
        throw new Error('Unknown backup reaper owner')
      }
      if (
        !p ||
        typeof p !== 'object' ||
        !Number.isInteger(p.pid) ||
        p.pid <= 0 ||
        !/^[a-f0-9]{32}$/.test(p.token) ||
        name !== `${p.pid}-${p.token}.json` ||
        !Number.isSafeInteger(p.ticket) ||
        p.ticket < 0
      )
        throw new Error('Unknown backup reaper owner')
      try {
        process.kill(p.pid, 0)
      } catch (e) {
        if (e.code === 'ESRCH') continue
        throw e
      }
      if (file !== claim) live.push(p)
    }
    return live
  }
  try {
    publish()
    owner.ticket = Math.max(0, ...peers().map((p) => p.ticket)) + 1
    if (!Number.isSafeInteger(owner.ticket))
      throw new Error('Backup reaper ticket exhausted')
    publish()
    if (
      peers().some(
        (p) =>
          p.ticket === 0 ||
          p.ticket < owner.ticket ||
          (p.ticket === owner.ticket &&
            `${p.pid}-${p.token}` < `${owner.pid}-${owner.token}`),
      )
    )
      throw new Error('Backup reaper busy')
    return action()
  } finally {
    cleanupOwnReaperFiles([claim, temp])
  }
}
function releaseBackupOwner(lock, owner) {
  try {
    if (!fs.lstatSync(lock).isFile()) return
    if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}
function publishBackupOwner(dir, lock, owner) {
  const temp = path.join(
    dir,
    `.backup-lock-${randomBytes(16).toString('hex')}.tmp`,
  )
  try {
    // 先同步完整身份；硬链接发布不覆盖现有主锁，且不产生空身份窗口。
    backupWrite(temp, owner, 'wx')
    fs.linkSync(temp, lock)
    backupSync(dir)
  } catch (e) {
    // 即便发布调用已生效后抛错，也只撤销本次临时文件对应的主锁。
    try {
      const prepared = fs.lstatSync(temp),
        published = fs.lstatSync(lock)
      if (
        prepared.isFile() &&
        published.isFile() &&
        prepared.dev === published.dev &&
        prepared.ino === published.ino
      )
        fs.unlinkSync(lock)
    } catch (cleanup) {
      if (cleanup.code !== 'ENOENT') throw cleanup
    }
    throw e
  } finally {
    try {
      fs.unlinkSync(temp)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
}
export function withBackupTransaction(sid, action) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid), 'backup')
  fs.mkdirSync(dir, { recursive: true })
  if (
    fs.lstatSync(dir).isSymbolicLink() ||
    path.dirname(path.dirname(fs.realpathSync(dir))) !==
      fs.realpathSync(RUNS_DIR)
  )
    throw new Error('Unsafe backup directory')
  const lock = path.join(dir, '.backup-lock')
  const owner = JSON.stringify({
    pid: process.pid,
    token: randomBytes(16).toString('hex'),
  })
  try {
    try {
      publishBackupOwner(dir, lock, owner)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      withBackupReaper(dir, () => {
        const old = fs.readFileSync(lock, 'utf8')
        let previous
        try {
          previous = JSON.parse(old)
        } catch {
          throw new Error('Unknown backup lock owner')
        }
        if (!previous || typeof previous !== 'object')
          throw new Error('Unknown backup lock owner')
        const { pid, token } = previous
        if (!Number.isInteger(pid) || pid <= 0 || !/^[a-f0-9]{32}$/.test(token))
          throw new Error('Unknown backup lock owner')
        try {
          process.kill(pid, 0)
          throw new Error('Backup transaction busy')
        } catch (err) {
          if (err.code !== 'ESRCH') throw err
        }
        if (fs.readFileSync(lock, 'utf8') !== old)
          throw new Error('Backup lock changed')
        fs.unlinkSync(lock)
        publishBackupOwner(dir, lock, owner)
      })
    }
  } catch (e) {
    releaseBackupOwner(lock, owner)
    throw e
  }
  try {
    recoverBackup(dir)
    return action(dir)
  } finally {
    releaseBackupOwner(lock, owner)
  }
}
export function commitBackupManifest(dir, entries, garbage = []) {
  const before = backupText(dir)
  const after =
    entries.map((e) => JSON.stringify(e)).join('\n') +
    (entries.length ? '\n' : '')
  for (const e of entries)
    if (e.backup) {
      const bytes = fs.readFileSync(backupPath(dir, e.backup))
      if (e.sha && backupHash(bytes) !== e.sha)
        throw new Error('Prepared backup hash mismatch')
    }
  const temp = `manifest-${randomBytes(16).toString('hex')}.tmp`
  backupWrite(path.join(dir, temp), after, 'wx')
  const journalTemp = path.join(dir, temp + '.journal')
  backupWrite(
    journalTemp,
    JSON.stringify({
      version: 1,
      before: backupHash(before),
      after: backupHash(after),
      temp,
      garbage,
    }),
    'wx',
  )
  fs.renameSync(journalTemp, path.join(dir, '.backup-txn'))
  backupSync(dir)
  fs.renameSync(path.join(dir, temp), path.join(dir, 'manifest.jsonl'))
  backupSync(dir)
  recoverBackup(dir)
}

// 清理：每个 orig 只保留最近 maxVersions 条 manifest 记录，并删除不再被引用的 blob。
// 只在快照时调用（低频），不参与任何热路径。
function pruneSnapshotsLocked(dir, maxVersions) {
  if (!Number.isInteger(maxVersions) || maxVersions < 1)
    throw new Error('Invalid retention')
  const all = backupManifestEntries(dir)
  const byOrig = new Map()
  for (const e of all) {
    if (!e || !e.orig) continue
    if (!byOrig.has(e.orig)) byOrig.set(e.orig, [])
    byOrig.get(e.orig).push(e)
  }
  const kept = all.filter((e) => !e.orig)
  let dropped = 0
  for (const [, list] of byOrig) {
    // 稳定排序：时间戳相同（同一次快照）时按写入顺序
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    const keepFrom = Math.max(0, list.length - maxVersions)
    for (let i = 0; i < list.length; i++) {
      if (i >= keepFrom) kept.push(list[i])
      else dropped++
    }
  }
  const referenced = new Set()
  for (const e of kept) if (e.backup) referenced.add(path.resolve(e.backup))
  const garbage = [
    ...new Set(
      all
        .filter((e) => e.backup && !referenced.has(path.resolve(e.backup)))
        .map((e) => path.resolve(e.backup)),
    ),
  ]
  if (dropped > 0) commitBackupManifest(dir, kept, garbage)
  return { kept: kept.length, dropped, blobsRemoved: garbage.length }
}
export function pruneSnapshots(sid, maxVersions = SNAPSHOT_KEEP_VERSIONS) {
  return withBackupTransaction(sid, (dir) =>
    pruneSnapshotsLocked(dir, maxVersions),
  )
}

// 快照：存在→复制到 RUNS_DIR/<id>/backup/sha-<hash>_<name>（内容相同只存一份）；
// 不存在→created:true；复制失败→error 且不中断其余
export function snapshotFiles(sid, paths, cwd) {
  return withBackupTransaction(sid, (bdir) => {
    const previous = backupManifestEntries(bdir)
    const entries = []
    const list = Array.isArray(paths) ? paths : []
    for (const p of list) {
      const ts = new Date().toISOString()
      const orig = path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p)
      if (!fs.existsSync(orig)) {
        entries.push({ ts, orig, backup: null, created: true })
        continue
      }
      try {
        const buf = fs.readFileSync(orig)
        const sha = createHash('sha256').update(buf).digest('hex')
        const backup = path.join(bdir, backupFileNameFor(sha, orig))
        let deduped = false
        backupPath(bdir, backup)
        if (fs.existsSync(backup)) {
          if (backupHash(fs.readFileSync(backup)) !== sha)
            throw new Error('Existing backup hash mismatch')
          deduped = true
        } else {
          prepareBackupBlob(bdir, backup, buf)
        }
        entries.push({
          ts,
          orig,
          backup,
          created: false,
          sha,
          bytes: buf.length,
          deduped,
        })
      } catch (e) {
        entries.push({ ts, orig, error: String(e) })
      }
    }
    if (entries.some((e) => e.error))
      throw new Error('Snapshot preparation failed: ' + JSON.stringify(entries))
    commitBackupManifest(bdir, [...previous, ...entries])
    pruneSnapshotsLocked(bdir, SNAPSHOT_KEEP_VERSIONS)
    return entries
  })
}

export function readManifest(sid) {
  const file = path.join(RUNS_DIR, sanitizeId(sid), 'backup', 'manifest.jsonl')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const all = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        all.push(JSON.parse(t))
      } catch {}
    }
    // 只返回每个 orig 的最新条目（按 ts 去重）
    const latest = new Map()
    for (const e of all) {
      if (!e || !e.orig) continue
      const existing = latest.get(e.orig)
      if (!existing || e.ts > existing.ts) {
        latest.set(e.orig, e)
      }
    }
    return Array.from(latest.values())
  } catch {
    return []
  }
}

// 读取 manifest 所有条目（不去重），用于回滚计划
export function readManifestAll(sid) {
  const file = path.join(RUNS_DIR, sanitizeId(sid), 'backup', 'manifest.jsonl')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const all = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        all.push(JSON.parse(line))
      } catch {}
    }
    return all
  } catch {
    return []
  }
}

// 写入派发 prompt 到文件，供主 Agent（Cindy）读取后通过 subagent 工具派发。
// 返回 prompt 文件路径，主 Agent 读取后自行调用 subagent 工具。
export function writeDispatchPrompt(sid, role, message, cwd) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid), 'dispatch')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}_${role}.prompt.txt`)
    const content = message || ''
    fs.writeFileSync(file, content, 'utf8')
    return { file, content }
  } catch (e) {
    return {
      file: null,
      content: null,
      error: String(e && e.message ? e.message : e),
    }
  }
}

// 保存子 Agent 执行结果到会话目录
// ---------------------------------------------------------------------------
// 输出截断（子 Agent 结果落盘 / verify 命令输出共用）
// ---------------------------------------------------------------------------
//
// 为什么必须截断：flow_save_result 会把子 Agent 的**完整** stdout/stderr 落盘，
// flow_run_verify 会把命令输出原样回传。两条路都没有上限 —— 一次 50MB 的输出
// 足以把磁盘（落盘）或宿主进程内存（回传 JSON）一起打爆，而门禁信息量集中在
// 头尾（结论 + 报错尾部堆栈），中间多半是重复日志。
//
// 策略：头部 + 尾部 + 中间折叠，并**如实记录原始字节数**（截断不能静默）。
// 验证命令输出解码。
//
// 背景（Windows 实测）：cmd.exe 默认代码页是 936（GBK），npm / node / 编译器
// 的中文报错会以 GBK 字节写出。旧实现直接 d.toString()（UTF-8）解码，中文全成
// 乱码，既影响人看证据，也让失败分类拿到的是乱码文本。
//
// 做法（不改命令、不改 shell、不加 chcp —— 避免影响用户命令语义）：
//   1. 先按严格 UTF-8 解码：正常 UTF-8 输出行为完全不变；
//   2. 严格 UTF-8 失败时才按 GB18030（GBK 超集）解码；
//   3. 两者都不可用（Node 无 full-icu）时退回 UTF-8 容错解码。
// 可用 CARLOS_VERIFY_ENCODING=utf8|gb18030 强制指定。
export function decodeOutputBytes(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (buf.length === 0) return ''
  const forced = String(process.env.CARLOS_VERIFY_ENCODING || '').toLowerCase()
  const decodeUtf8 = (fatal) => new TextDecoder('utf-8', { fatal }).decode(buf)
  if (forced === 'utf8') return decodeUtf8(false)
  if (forced === 'gb18030') {
    try { return new TextDecoder('gb18030').decode(buf) } catch { return decodeUtf8(false) }
  }
  // BOM 优先
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return decodeUtf8(false).replace(/^﻿/, '')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try { return new TextDecoder('utf-16le').decode(buf) } catch { return decodeUtf8(false) }
  }
  try {
    return decodeUtf8(true)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return decodeUtf8(false)
    }
  }
}

export const OUTPUT_KEEP_BYTES = 256 * 1024 // 头尾各留 256KB

export function truncateOutput(text, keepBytes = OUTPUT_KEEP_BYTES) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text)
  const bytes = Buffer.byteLength(s, 'utf8')
  if (bytes <= keepBytes * 2) return { text: s, bytes, truncated: false }
  // 按字节切，避免把多字节字符截成半个（Buffer 切片后再 toString 会丢字符，
  // 用 toString("utf8") 的解码容错把末尾残缺字符丢掉即可）。
  const buf = Buffer.from(s, 'utf8')
  const head = buf.subarray(0, keepBytes).toString('utf8')
  const tail = buf.subarray(bytes - keepBytes).toString('utf8')
  const omitted = bytes - keepBytes * 2
  return {
    text:
      head +
      '\n' +
      `…[已截断 ${omitted} 字节，原始 ${bytes} 字节]…` +
      '\n' +
      tail,
    bytes,
    truncated: true,
    omitted_bytes: omitted,
  }
}

export function saveAgentResult(sid, role, stdout, stderr, code) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid), 'dispatch')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}_${role}.result.json`)
    const out = truncateOutput(stdout)
    const err = truncateOutput(stderr)
    const rec = {
      ts: new Date().toISOString(),
      role,
      code: code ?? -1,
      // 截断结果 + 原始字节数：审计时能看出「这里被折叠了多少」，
      // 而不是以为子 Agent 只说了这么点。
      stdout: out.text,
      stderr: err.text,
      stdout_bytes: out.bytes,
      stderr_bytes: err.bytes,
      truncated: out.truncated || err.truncated,
    }
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8')
    return file
  } catch {
    return null
  }
}

// Phase 1-1: 执行验证命令并返回结果
//
// 跨平台：原先硬编码 `spawn("cmd", ["/c", cmd], { shell: true })` —— cmd.exe 只存在于 Windows，
// 在 Linux/macOS 上 `cmd` 不是可执行文件 → 命令根本没跑起来，
// exitCode=127（command not found），记 PASS 的前置证据永远拿不到，
// ubuntu CI 的 e2e 会整片变红。
//
// 现在按平台选 shell：
//   · Windows：cmd.exe /c + shell:true（实测 shell:false 会把带引号的
//     `node -e "process.exit(3)"` 的引号吃掉，退出码变成 0 而不是 3 ——
//     那样「验证失败必须拦住 PASS」的门禁就形同虚设）；
//   · POSIX：/bin/sh -c + shell:false（明确指定解释器，不依赖 PATH 里的 sh）。
// 结束整棵进程树。
//
// Windows：taskkill /T /F 才是真的「连子进程一起杀」；child.kill 只结束 cmd.exe 外壳，
// 命令派生的 node.exe 会变孤儿（实测残留进程长期占着端口与文件句柄，下一次验证因此 EBUSY）。
// POSIX：进程组杀（detached 启动时 child.pid 就是组长），拿不到就退回 kill。
function killProcessTree(child) {
  try {
    if (!child || !child.pid) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
      })
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }
}

function validateVerifyOptions(options) {
  if (
    options.isolateHome !== undefined &&
    typeof options.isolateHome !== 'boolean'
  ) {
    throw new TypeError('isolateHome 必须是布尔值')
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1000 ||
      options.timeoutMs > 600000)
  ) {
    throw new TypeError('timeoutMs 必须是 1000..600000 的整数')
  }
}

export async function runVerifyCommand(cmd, cwd, options = {}) {
  validateVerifyOptions(options)
  if (options.isolateHome !== true)
    return executeVerifyCommand(cmd, cwd, options)
  // 只覆盖子进程环境；整个 shell 宏及其 && 后继继承同一隔离目录。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-verify-home-'))
  try {
    const cache = path.join(home, 'npm-cache')
    const env = { ...process.env }
    // Windows 环境名不区分大小写，先移除已有同名变体。
    for (const key of Object.keys(env)) {
      if (
        [
          'home',
          'userprofile',
          'carlos_flow_home',
          'npm_config_cache',
        ].includes(key.toLowerCase())
      )
        delete env[key]
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CARLOS_FLOW_HOME: home,
      npm_config_cache: cache,
    })
    return await executeVerifyCommand(cmd, cwd, options, env)
  } finally {
    try {
      fs.rmSync(home, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    } catch (e) {
      throw new Error(`验证隔离目录清理失败: ${e.message || e}`)
    }
  }
}

async function executeVerifyCommand(cmd, cwd, options, env) {
  if (options.signal?.aborted)
    return { ok: false, exitCode: -1, stdout: '', stderr: '验证命令已取消' }
  if (!cmd || !cmd.trim()) {
    return {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: formatError('验证命令为空'),
    }
  }
  // 可选：拦截高危命令模式。
  //
  // 威胁模型说明（重要，不要夸大）：
  //   · verify.cmd 本质上就是「执行用户指定的验证命令」—— 它的设计目标就是能跑任意命令
  //     （`npm test` / `pytest` / `cargo build` …），所以**默认不拦**。
  //   · 真正的风险来源是「verify.cmd 的来源可信度」：
  //     - 人工填写的任务卡 → 可信，是用户/Agent 的本意
  //     - 自动激活产生的占位卡 → activation 时 scope/acceptance 为空、**没有 verify.cmd**，
  //       必须人工补齐才能过闸门 → 自动触发路径已被 activation 闸门挡住
  //   · 因此默认不拦是对的；把黑名单默认打开会误伤合法脚本
  //     （比如 `rm -rf node_modules` 出现在清理步骤里是完全合法的）。
  //   · 需要更严的用户可以打开 CARLOS_FLOW_BLOCK_DANGEROUS=1。
  if (process.env.CARLOS_FLOW_BLOCK_DANGEROUS === '1') {
    const dangerous =
      /\b(rm\s+-[rRf]{1,2}[^\s]*\s+\/|sudo\s|curl\s+[^|]*\|\s*(ba)?sh|mkfs(\.|\s)|dd\s+if=|:\(\)\{|>\s*\/dev\/sd[a-z])/i
    if (dangerous.test(cmd)) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: formatError(`验证命令包含高危模式，已拒绝执行：${cmd}`),
      }
    }
  }
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh'
  const shellArgs = isWindows ? ['/c', cmd] : ['-c', cmd]
  // 安全修复：禁止 cwd = '.' 或空（这会在 Windows 上触发 %SystemDrive% 目录扩展，污染仓库）
  const safeCwd =
    typeof cwd === 'string' && cwd.length > 0 && cwd !== '.'
      ? cwd
      : process.cwd()
  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      env,
      cwd: safeCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: true,
      // POSIX：让 shell 自成进程组组长，超时时才能 kill(-pid) 把命令派生的
      // 孙子进程一起结束（只杀 shell 会留下孤儿，实测在 CI 上就是这条挂了）。
      detached: !isWindows,
    })
    // 输出上限：命令可能刷出几十 MB 日志。全量拼字符串会把本进程内存打爆，
    // 门禁最后给出的会是「插件崩了」而不是「验证没通过」。这里做**环形截断**：
    // 超过上限后只计数不再占用内存，头尾各留一份，并如实回传原始字节数。
    const chunks = { stdout: [], stderr: [] }
    const lengths = { stdout: 0, stderr: 0 }
    const CAP = OUTPUT_KEEP_BYTES * 4
    const collect = (which, d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d)
      lengths[which] += buf.length
      if (lengths[which] > CAP) return // 已远超上限：只计数，不再占内存
      // 存原始字节：跨 chunk 的多字节字符必须拼完再解码，逐块 toString 会切碎中文。
      chunks[which].push(buf)
    }
    child.stdout.on('data', (d) => collect('stdout', d))
    child.stderr.on('data', (d) => collect('stderr', d))

    // 回调入参：{ ok, exitCode, stderrText（可选）, appendStderr（可选）, formatStderr（可选） }
    let settled = false
    let timeout
    let progress
    const cancel = () => {
      killProcessTree(child)
      finish({ ok: false, exitCode: -1, stderrText: '验证命令已取消' })
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(progress)
      options.signal?.removeEventListener('abort', cancel)
      const out = truncateOutput(decodeOutputBytes(Buffer.concat(chunks.stdout)))
      const rawErr = decodeOutputBytes(Buffer.concat(chunks.stderr))
      let errText
      if (result.stderrText !== undefined) errText = result.stderrText
      else if (result.formatStderr) errText = formatError(String(rawErr))
      else errText = rawErr
      if (result.appendStderr)
        errText = errText
          ? errText + result.appendStderr
          : String(result.appendStderr).replace(/^\n+/g, '')
      const err = truncateOutput(errText)
      resolve({
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: out.text,
        stderr: err.text,
        stdout_bytes: lengths.stdout,
        stderr_bytes: lengths.stderr,
        output_truncated: out.truncated || err.truncated,
      })
    }

    // 超时上限可用 CARLOS_VERIFY_TIMEOUT_MS 覆盖（测试要能在秒级复现「超时必须整树回收」）
    const timeoutMs =
      options.timeoutMs ??
      (() => {
        const n = Number(process.env.CARLOS_VERIFY_TIMEOUT_MS)
        return Number.isFinite(n) && n >= 200 ? n : 120000
      })()
    const started = Date.now()
    progress = setInterval(() => {
      try {
        process.stderr.write(
          `[flow-verify] 验证仍在运行，已等待 ${Math.floor((Date.now() - started) / 1000)} 秒\n`,
        )
      } catch {}
    }, 30000)
    timeout = setTimeout(() => {
      // Windows 上 child.kill 只杀 cmd.exe 外壳，命令真正派生的 node 子进程会变成孤儿
      // （实测残留 node.exe 能活很久，还占着端口/文件）。必须整棵进程树一起结束。
      killProcessTree(child)
      finish({
        ok: false,
        exitCode: -1,
        appendStderr: `\n验证命令超时 (${Math.round(timeoutMs / 1000)}s)`,
      })
    }, timeoutMs)

    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) finish({ ok: true, exitCode: code })
      else finish({ ok: false, exitCode: code, formatStderr: true })
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      finish({ ok: false, exitCode: -1, stderrText: formatError(String(err)) })
    })
  })
}

// ---------------------------------------------------------------------------
// 输出指纹 + 负对照（negative control）
// ---------------------------------------------------------------------------

// 一次验证运行的输出指纹：exitCode + stdout + stderr。
//
// 为什么需要：裁定要绑定的是「一次可复现的运行」，而不是「我说测试过了」。
// 把输出哈希记进 last_verify，裁定时比对，就能发现「证据被换掉 / 命令不确定」。
export function computeOutputHash(exitCode, stdout, stderr) {
  try {
    const h = createHash('sha256')
    h.update(
      'exitCode=' +
        String(exitCode === undefined || exitCode === null ? -1 : exitCode),
    )
    h.update('\n')
    h.update(typeof stdout === 'string' ? stdout : '')
    h.update('\n')
    h.update(typeof stderr === 'string' ? stderr : '')
    return h.digest('hex')
  } catch {
    return ''
  }
}

// 用快照 manifest 还原「派发时（改动前）」的工作区状态。
//
// ---- 还原的口径：失败关闭 + 范围边界 + 事务记录 --------------------------
//
// 还原（把工作区恢复成派发时的状态）必须同时满足四条：
//   · **失败关闭**：任何一步删除/还原失败都被记账并如实报告；
//     不得吞错后继续、更不得对外宣称「已还原」——
//     半还原状态被当成「改动前态」去跑负对照，结论一律不成立；
//   · **范围边界**：只允许对任务卡登记项目（仓库根）内的路径执行还原，越界即拒；
//   · **只删普通文件**：目标是目录（含非空目录）或符号链接时拒绝，
//     不递归删除、不跟随符号链接去删别处内容；
//   · **事务记录**：每次动作与结果都写进 negative_control/<ts>/journal.json
//     （复用仓库既有的 journal 约定，不另造并行机制）。
//
// 边界判定、只删普通文件、失败记账、结果结构**只有一份实现**（restoreEntries），
// 四个调用点（manifest 还原 / 崩溃恢复 / 还原当前态 / 还原记录态）都调用它：
// 多份实现必然漂移 —— 写回分支一旦漏了符号链接防护，就会顺着符号链接把
// **仓库外**的文件改掉，而删除分支有；两份口径不一致 = 门禁有洞。

function isInsideRoot(root, target) {
  if (!root) return true
  const r = path.resolve(root)
  const t = path.resolve(target)
  if (r === t) return false
  const rel = path.relative(r, t)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// realpath（解析符号链接 / junction）；失败返回 null。
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

// 两个路径是否指向同一个位置（win32 下大小写不敏感）。
function samePath(a, b) {
  if (!a || !b) return false
  return path.relative(path.resolve(a), path.resolve(b)) === ''
}

// 还原前的安全判定：**返回 null 表示可以执行**，否则返回拒绝原因。
//
// 三道闸（写回分支与删除分支**同一套**）：
//   ① 范围边界：目标必须落在任务卡登记项目（仓库根）内 —— 按 **realpath 解析后的
//      真实路径**判定（路径里只要有符号链接/junction，真实路径就会落到别处）；
//   ② 目标本身不能是符号链接：lstat 不跟随链接，删链接 ≠ 删链接指向的文件；
//   ③ 目标路径沿途的**父目录**不能是符号链接 / junction：否则写回会顺着链接
//      把仓库外（或别处）的文件改掉 —— 写回分支同样必须过这道闸。
function restoreGuard(root, target) {
  const abs = path.resolve(target)
  // 边界根是**必填**：缺了就无法判定「是否在登记项目范围内」。
  // 缺省放行 = fail-open（会把仓库外的文件改掉/删掉），所以缺根即拒绝。
  if (!root) {
    return {
      result: 'rejected',
      error: '缺少还原范围根（无法判定边界），拒绝还原',
    }
  }
  const rootAbs = path.resolve(root)
  if (!isInsideRoot(rootAbs, abs))
    return {
      result: 'out_of_scope',
      error: '路径不在任务卡登记的项目范围内，拒绝还原',
    }
  // 真实路径判定：仓库根解析后的真实位置 vs 目标解析后的真实位置
  const rootReal = realpathOrNull(rootAbs) || rootAbs
  const rel = path.relative(rootAbs, abs)
  const expected = path.join(rootReal, rel)
  // 真实路径解析只有一份（src/card.js 的 realTargetPath）：
  // 解析不出来就证明不了目标落在仓库内 —— 按保守口径拒绝。
  const actual = realTargetPath(abs)
  if (actual.error) {
    return {
      result: 'rejected',
      error:
        '目标路径无法解析真实路径（按保守口径拒绝）：' +
        actual.error,
    }
  }
  if (!samePath(expected, actual.path)) {
    return {
      result: 'rejected',
      error:
        '目标路径经过符号链接或 junction（真实路径 ' +
        actual.path +
        '），拒绝还原',
    }
  }
  // 目标本身：lstat（不跟随链接）
  let st = null
  try {
    st = fs.lstatSync(abs)
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return {
        result: 'rejected',
        error: '目标路径无法读取：' + String((err && err.message) || err),
      }
    }
  }
  if (st && st.isSymbolicLink()) {
    return {
      result: 'rejected',
      error: '目标是符号链接，拒绝跟随链接还原',
    }
  }
  return null
}

// 还原条目：mode = 'delete'（删除普通文件）| 'write'（从备份写回）。
//
// options.root 是**必填**（边界根）：缺了时每一项都按「拒绝」记账，
// 返回 ok:false —— 绝不因为「没给根」就跳过边界判定（fail-open）。
//
// 导出理由：它是负对照还原的**唯一一份实现**，外部调用方（回归测试）需要
// 直接验证「缺根即拒绝」这个安全默认值。
export function restoreEntries(items, options = {}) {
  const root = options.root ? path.resolve(options.root) : null
  const actions = []
  const failures = []
  const record = (a) => {
    actions.push(a)
    if (typeof options.onAction === 'function') {
      try {
        options.onAction(a)
      } catch {
        /* 记账失败不覆盖原始动作结果 */
      }
    }
  }
  for (const item of items) {
    if (!item || typeof item.orig !== 'string' || !item.orig) continue
    const ts = new Date().toISOString()
    const orig = item.orig
    const mode = item.mode === 'write' ? 'write' : 'delete'
    // ① 边界与链接闸（两个分支同一套口径）
    const guard = restoreGuard(root, orig)
    if (guard) {
      const a = {
        ts,
        orig,
        action: mode,
        result: guard.result,
        error: guard.error,
      }
      record(a)
      failures.push(a)
      continue
    }
    if (mode === 'delete') {
      // ② 派发时该文件不存在 → 删除当前文件。
      let st = null
      try {
        st = fs.lstatSync(orig)
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          record({ ts, orig, action: 'delete', result: 'absent' })
          continue
        }
        const a = {
          ts,
          orig,
          action: 'delete',
          result: 'failed',
          error: String((err && err.message) || err),
        }
        record(a)
        failures.push(a)
        continue
      }
      // ③ 只删普通文件：目录 / 符号链接 / 其它一律失败关闭。
      //    lstat 不跟随符号链接 —— 不会顺着链接去删别处的内容。
      if (!st.isFile()) {
        const a = {
          ts,
          orig,
          action: 'delete',
          result: 'rejected',
          error: st.isDirectory()
            ? '目标是目录，拒绝递归删除'
            : '目标不是普通文件（可能是符号链接），拒绝删除',
        }
        record(a)
        failures.push(a)
        continue
      }
      try {
        fs.unlinkSync(orig)
        record({ ts, orig, action: 'delete', result: 'deleted' })
      } catch (err) {
        const a = {
          ts,
          orig,
          action: 'delete',
          result: 'failed',
          error: String((err && err.message) || err),
        }
        record(a)
        failures.push(a)
      }
      continue
    }
    // ④ 写回分支：从备份把内容写回原位。
    const source = item.source
    if (!source) {
      const a = {
        ts,
        orig,
        action: 'restore',
        result: 'failed',
        error: '缺少备份内容，无法还原',
      }
      record(a)
      failures.push(a)
      continue
    }
    try {
      fs.mkdirSync(path.dirname(orig), { recursive: true })
      fs.copyFileSync(source, orig)
      record({ ts, orig, action: 'restore', result: 'restored' })
    } catch (err) {
      const a = {
        ts,
        orig,
        action: 'restore',
        result: 'failed',
        error: String((err && err.message) || err),
      }
      record(a)
      failures.push(a)
    }
  }
  return { ok: failures.length === 0, actions, failures }
}

// 还原的边界根：优先取任务卡登记的项目目录，再取它的 git 仓库根；
// 都没有时用调用方给的 cwd。边界根取仓库根而不是项目子目录，
// 否则「cwd 是仓库子目录」的卡片会把 scope 里的文件误判成越界。
export function resolveRestoreRoot(sid, cwd) {
  let base = ''
  try {
    const st = loadState(sid)
    const project = st && st.card && st.card.env && st.card.env.project
    if (typeof project === 'string' && project.trim()) base = project
  } catch {
    /* 读不到卡片就用 cwd */
  }
  if (!base) base = cwd || process.cwd()
  let repo = ''
  try {
    const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: base,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: false,
    })
    if (proc.status === 0 && typeof proc.stdout === 'string')
      repo = proc.stdout.trim()
  } catch {
    /* git 不可用：退回项目目录本身 */
  }
  return repo || path.resolve(base)
}

// 派发快照（manifest）→ 还原条目。
// created:true = 派发时该文件不存在 → 还原时删除它；
// 有 backup    = 派发时该文件存在   → 还原时把备份写回原位。
function manifestRestoreItems(entries) {
  const items = []
  for (const e of entries || []) {
    if (!e || !e.orig) continue
    if (e.created === true) {
      items.push({ orig: e.orig, mode: 'delete' })
      continue
    }
    if (e.backup) {
      items.push({ orig: e.orig, mode: 'write', source: e.backup })
    }
  }
  return items
}

// 还原「派发时（改动前）」的工作区状态。
// 边界判定 / 只删普通文件 / 失败记账 / 结果结构都在 restoreEntries 里（**唯一一份**）。
function restoreFromManifest(entries, options = {}) {
  return restoreEntries(manifestRestoreItems(entries), options)
}

// ---------------------------------------------------------------------------
// 负对照的状态工具：把「改动前态」「改动后态」显式化、可证明
// ---------------------------------------------------------------------------

// 文件内容摘要：存在→sha256 十六进制；不存在→"ABSENT"；无法读取→"UNKNOWN"
function digestOf(file) {
  if (!file) return 'ABSENT'
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return 'ABSENT'
    return 'UNKNOWN'
  }
}

// 状态指纹：一组 {文件路径: 摘要} → 稳定 sha256。
// 用途：证明「改动前」「改动后」确实是**两个可区分的状态**，而不是同一份内容跑两遍。
function fingerprintOfState(digests) {
  const lines = Object.keys(digests)
    .sort()
    .map((k) => k + '=' + digests[k])
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

// 比较「改动前」态与某个候选「改动后」态。
//   changed：内容确实不同的文件（= 本次改动留下的痕迹）
//   unknown：状态不可还原/不可读的文件（无法证明）
function diffStates(pre, post) {
  const changed = []
  const unknown = []
  for (const k of Object.keys(pre)) {
    const a = pre[k]
    const b = Object.prototype.hasOwnProperty.call(post, k)
      ? post[k]
      : 'UNKNOWN'
    if (a === 'UNKNOWN' || b === 'UNKNOWN') {
      unknown.push(k)
      continue
    }
    if (a !== b) changed.push(k)
  }
  for (const k of Object.keys(post)) {
    if (Object.prototype.hasOwnProperty.call(pre, k)) continue
    const b = post[k]
    if (b === 'UNKNOWN') {
      unknown.push(k)
      continue
    }
    if (b !== 'ABSENT') changed.push(k)
  }
  return { changed, unknown }
}

// 「改动后」态的**显式记录**文件。
//
// 为什么要单独一个文件：manifest.jsonl 的语义是「派发时的改动前快照」，
// restoreFromManifest() 完全依赖这个语义。把改动后态写进 manifest 会污染它，
// 导致「还原改动前」还原成「改动后」——负对照直接失效。
// 因此改动后态单独落在 backup/after_state.jsonl + backup/after_state_<ts>/ 目录。
function afterStateFile(sid) {
  return path.join(RUNS_DIR, sanitizeId(sid), 'backup', 'after_state.jsonl')
}

// 读取本会话最近一次记录的「改动后」态（按追加顺序，后写的覆盖先写的）
function readAfterState(sid) {
  const latest = new Map()
  try {
    const raw = fs.readFileSync(afterStateFile(sid), 'utf8')
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        if (!e || !e.orig) continue
        latest.set(e.orig, e)
      } catch {}
    }
  } catch {}
  return Array.from(latest.values())
}

// 追加记录「改动后」态
function writeAfterState(sid, records) {
  try {
    const file = afterStateFile(sid)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    fs.appendFileSync(file, lines, 'utf8')
  } catch (e) {
    try {
      process.stderr.write(
        `[flow-falsify] 记录改动后态失败: ${e && e.message ? e.message : e}\n`,
      )
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// 负对照的安全边界：崩溃恢复日志 + 还原结果可核验
// ---------------------------------------------------------------------------
//
// 背景（为什么需要这两个函数）：负对照的本质是**在真实工作区里临时把文件改回旧内容**，
// 跑一次验证，再把文件写回来。只靠 try/finally 只能保证「意图」，不能保证结果：
//   · 进程被强杀 / 断电 → finally 不执行 → 工作区停在「改动前」状态，
//     用户的改动看起来凭空消失（最坏情况：把已修好的验证脚本回滚成坏的）；
//   · finally 里某次 copyFileSync 失败（文件被占用、权限不足）→ 只写一行 stderr，
//     调用方拿到的仍是 ok:true，没人知道工作区已经不干净了。
// 现在补两条机械保证：
//   ① **进入前写日志**（negative_control/<ts>/journal.json）：记录每个文件的原位、
//      进入时备份、是否需要删除。下次调用负对照时先把残留日志里的状态恢复回去，
//      所以「上一次被中断」不会把脏状态带到下一次；
//   ② **还原后核对摘要**：逐文件比对内容哈希与「进入时」是否一致，结果写回返回值
//      （restore.ok / restore.mismatched），失败时明确告警而不是静默放过。

function negativeControlRoot(sid) {
  return path.join(RUNS_DIR, sanitizeId(sid), 'negative_control')
}

// 扫描并恢复被中断的负对照。返回 { dirs, files, unresolved }。
// 只处理「日志还标着 pending」的目录：正常结束的目录在 finishJournal 里已被删除。
export function recoverInterruptedNegativeControl(sid) {
  const root = negativeControlRoot(sid)
  const out = { dirs: 0, files: 0, unresolved: [] }
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const name of names) {
    const dir = path.join(root, name)
    const journalFile = path.join(dir, 'journal.json')
    let journal = null
    try {
      journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
    } catch {
      continue
    } // 没有日志（或坏了）：不是本机制写的目录，不碰
    if (!journal || journal.status === 'restored') {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
      continue
    }
    out.dirs++
    // 还原边界：只允许恢复任务卡登记项目（仓库根）内的路径。
    const restoreBoundary = resolveRestoreRoot(sid, journal.cwd)
    // 还原条目 → 交给**唯一一份**的还原实现（边界判定 / 只删普通文件 / 失败记账）。
    const items = []
    for (const e of Array.isArray(journal.saved) ? journal.saved : []) {
      if (!e || typeof e.orig !== 'string') continue
      if (e.existed === true && e.savedPath) {
        items.push({ orig: e.orig, mode: 'write', source: e.savedPath })
        continue
      }
      if (e.existed !== true) {
        // 进入时不存在 → 现在应该不存在（只删普通文件）。
        items.push({ orig: e.orig, mode: 'delete' })
        continue
      }
      // 进入时有文件但备份丢了：无法还原，如实记账
      out.unresolved.push(e.orig)
    }
    const rec = restoreEntries(items, { root: restoreBoundary })
    for (const a of rec.actions) {
      if (
        a.result === 'restored' ||
        a.result === 'deleted' ||
        a.result === 'absent'
      ) {
        out.files++
        continue
      }
      out.unresolved.push(a.orig)
      try {
        process.stderr.write(
          `[flow-falsify] 恢复中断的负对照失败 ${a.orig}: ${a.error || a.result}\n`,
        )
      } catch {}
    }
    try {
      fs.writeFileSync(
        journalFile,
        JSON.stringify(
          {
            ...journal,
            status: out.unresolved.length ? 'restore_failed' : 'restored',
            unresolved: out.unresolved,
            recoveredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      )
      // 有未解决的条目 → **保留目录**（证据不删），让下一次还能接着恢复。
      if (!out.unresolved.length) fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return out
}

// 还原后核对：逐文件比对内容摘要与「进入负对照时」是否一致。
// UNKNOWN（读不到）不算失配 —— 无法证明 ≠ 证明坏了，如实归到 unreadable。
function verifyRestoredState(saved, expectedDigests) {
  let checked = 0
  const mismatched = []
  const unreadable = []
  for (const s of saved) {
    if (!s || typeof s.orig !== 'string') continue
    const want = Object.prototype.hasOwnProperty.call(expectedDigests, s.orig)
      ? expectedDigests[s.orig]
      : null
    if (want === null) continue
    checked++
    let got
    try {
      got = fs.existsSync(s.orig) ? digestOf(s.orig) : 'ABSENT'
    } catch {
      got = 'UNKNOWN'
    }
    if (got === 'UNKNOWN' || want === 'UNKNOWN') {
      unreadable.push(s.orig)
      continue
    }
    if (got !== want) mismatched.push(s.orig)
  }
  return { ok: mismatched.length === 0, checked, mismatched, unreadable }
}

// 负对照：证明 verify.cmd 真的在测「本次改动」。
//
// 层次：这是「证据门禁」的执行侧 —— 不是让 LLM 声称「我试图证伪但没成功」，
// 而是让 harness 真的把工作区还原到改动前，跑同一命令，看它是否失败。
// 一个改动前就退 0 的测试是**空测试**，不构成任何证据（`|| true` / `echo ok` 就是这么漏过去的）。
//
// 判定依据（本次修复的核心 —— 去掉隐含前提）：
//   before 与 after 必须是**两个可区分的状态**，否则「前失败/后通过」就没有归因意义。
//   本实现把两态都显式构造出来，并逐文件比对内容摘要：
//     · 改动前态 = 派发快照 manifest 的备份（restoreFromManifest）；
//     · 改动后态 = ①当前工作区（显式捕获后再显式还原），
//                  ②本会话上次负对照**显式记录**下来的改动后态（backup/after_state.jsonl）；
//       当①与改动前态逐字节一致（=工作区里根本没有改动后状态，例如主 Agent 手工改动后
//       未走标准派发窗口、或改动被回退）时，才启用②作为改动后态；
//       两者都没有可用时，如实标注「前后是同一状态」，并按保守口径判负对照，
//       绝不把「同一状态跑两遍」当成 meaningful。
//   改动后态在每次负对照后被显式落盘记录（after_state.jsonl + after_state_<ts>/），
//   于是「改动后应有的状态」不再依赖「调用时工作区恰好已经是改动后」这个隐含前提。
//
// 安全：先把进入时的 scope 文件备份到临时目录，finally 里一定还原成进入时的样子；
// 即使 verify 命令本身改动文件，也不会把工作区留在改动前状态。
//
// 局限（如实说明）：快照只覆盖卡片 scope 内的文件。如果 verify.cmd 依赖 scope 外的
// 文件、而执行者又改了它们，「改动前」状态只是近似。此时负对照结论仅供参考。
export async function runNegativeControl(sid, cmd, cwd, options = {}) {
  validateVerifyOptions(options)
  const entries = readManifest(sid)
  if (!entries.length) {
    return {
      ok: false,
      error: formatError('没有派发快照，无法做负对照（请先 flow_dispatch）'),
    }
  }
  // 先把上一次「被中断的负对照」恢复掉，否则脏状态会带进本次的 before/after 判定。
  const recovered = recoverInterruptedNegativeControl(sid)
  const tmpDir = path.join(negativeControlRoot(sid), String(Date.now()))
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      error: formatError(
        '无法创建负对照临时目录：' + (e && e.message ? e.message : e),
      ),
    }
  }

  // ---- 状态 A：改动前态（派发时的快照，来自 manifest 备份） ----
  const preDigests = {}
  for (const e of entries) {
    if (!e || !e.orig) continue
    if (e.created === true) preDigests[e.orig] = 'ABSENT'
    else if (e.backup) preDigests[e.orig] = digestOf(e.backup)
    else preDigests[e.orig] = 'UNKNOWN' // 备份缺失 → 改动前态无法完整还原
  }

  // ---- 状态 B：改动后候选① —— 当前工作区（显式捕获，之后显式还原） ----
  const saved = []
  for (const e of entries) {
    if (!e || !e.orig) continue
    const orig = e.orig
    const existed = fs.existsSync(orig)
    let savedPath = null
    if (existed) {
      try {
        savedPath = path.join(tmpDir, `${saved.length}_${path.basename(orig)}`)
        fs.copyFileSync(orig, savedPath)
      } catch (err) {
        try {
          process.stderr.write(
            `[flow-falsify] 备份当前文件失败 ${orig}: ${err && err.message ? err.message : err}\n`,
          )
        } catch {}
      }
    }
    saved.push({ orig, savedPath, existed })
  }
  const currentDigests = {}
  for (const s of saved) {
    if (!s.existed) currentDigests[s.orig] = 'ABSENT'
    else if (s.savedPath) currentDigests[s.orig] = digestOf(s.savedPath)
    else currentDigests[s.orig] = 'UNKNOWN'
  }

  // ---- 状态 C：改动后候选② —— 本会话显式记录过的改动后态 ----
  const recorded = readAfterState(sid)
  const recordedMap = new Map()
  const recordedDigests = {}
  for (const r of recorded) {
    if (!r || !r.orig) continue
    recordedMap.set(r.orig, r)
    recordedDigests[r.orig] = r.absent === true ? 'ABSENT' : digestOf(r.backup)
  }
  // 只有当记录覆盖了本次快照的全部文件时，才敢把它当作完整的「改动后态」
  const recordedCoversAll = entries.every(
    (e) => e && e.orig && recordedMap.has(e.orig),
  )

  // ---- 选定改动后态：优先当前工作区；当前工作区与改动前态完全一致时，退回显式记录 ----
  const curDiff = diffStates(preDigests, currentDigests)
  const recDiff = diffStates(preDigests, recordedDigests)
  let afterSource = 'workspace'
  let afterDigests = currentDigests
  let changedFiles = curDiff.changed
  let unknownFiles = curDiff.unknown
  if (
    curDiff.changed.length === 0 &&
    recordedCoversAll &&
    recDiff.changed.length > 0
  ) {
    afterSource = 'recorded'
    afterDigests = recordedDigests
    changedFiles = recDiff.changed
    unknownFiles = recDiff.unknown
  }

  // 还原「改动后」状态（无论后续发生什么）
  // 失败必须被记账并如实返回（不再 catch{} 吞掉后继续宣称还原成功）。
  const restoreCurrent = () => {
    const failures = []
    // 还原条目 → 交给**唯一一份**的还原实现（与删除分支同一套边界与链接闸）。
    const items = []
    for (const s of saved) {
      if (s.existed && s.savedPath) {
        items.push({ orig: s.orig, mode: 'write', source: s.savedPath })
        continue
      }
      if (!s.existed) {
        // 当前状态里该文件不存在（executor 删了它）→ 保持删除
        items.push({ orig: s.orig, mode: 'delete' })
        continue
      }
      // 进入时存在但备份没抓到：无法还原，如实记账（不静默跳过）
      failures.push({ orig: s.orig, error: '缺少进入负对照时的备份，无法还原' })
    }
    const rec = restoreEntries(items, { root: restoreRoot })
    for (const f of rec.failures) {
      failures.push({ orig: f.orig, error: f.error || f.result })
      try {
        process.stderr.write(
          `[flow-falsify] 还原当前文件失败 ${f.orig}: ${f.error || f.result}` + String.fromCharCode(10),
        )
      } catch {}
    }
    return failures
  }

  // 还原「显式记录的改动后态」
  const restoreRecorded = () => {
    // 与还原当前态走**同一份**实现（边界判定 / 只删普通文件 / 失败记账）。
    const items = []
    for (const r of recorded) {
      if (!r || !r.orig) continue
      if (r.absent === true) {
        items.push({ orig: r.orig, mode: 'delete' })
        continue
      }
      if (r.backup) {
        items.push({ orig: r.orig, mode: 'write', source: r.backup })
      }
    }
    const rec = restoreEntries(items, { root: restoreRoot })
    const failures = rec.failures.map((f) => ({
      orig: f.orig,
      error: f.error || f.result,
    }))
    for (const f of failures) {
      try {
        process.stderr.write(
          `[flow-falsify] 还原记录的改动后态失败 ${f.orig}: ${f.error}` + String.fromCharCode(10),
        )
      } catch {}
    }
    return failures
  }

  // ---- 进入「会改动工作区」的临界区之前，先把还原所需信息落盘 ----
  // 这一步是崩溃恢复的唯一依据：进程被强杀时，下次调用靠它把工作区还原回去。
  const journalFile = path.join(tmpDir, 'journal.json')
  // 还原事务记录：每次动作与结果都追加到这里（复用仓库既有的 journal 约定）。
  const restoreLog = []
  const writeJournal = (status, extra) => {
    try {
      fs.writeFileSync(
        journalFile,
        JSON.stringify(
          {
            sid,
            ts: new Date().toISOString(),
            cwd: cwd || null,
            status,
            saved: saved.map((x) => ({
              orig: x.orig,
              savedPath: x.savedPath,
              existed: x.existed,
            })),
            restore_log: restoreLog,
            ...(extra || {}),
          },
          null,
          2,
        ),
        'utf8',
      )
      return true
    } catch (e) {
      try {
        process.stderr.write(
          `[flow-falsify] 写还原日志失败: ${e && e.message ? e.message : e}\n`,
        )
      } catch {}
      return false
    }
  }
  // 事务记录写不下去 = 无法保证崩溃可恢复 → 失败关闭，不许静默继续。
  if (!writeJournal('pending'))
    return {
      ok: false,
      error: formatError(
        '无法写入负对照还原日志（journal.json），为保证崩溃可恢复，本次负对照拒绝执行。',
      ),
    }

  // ---- 把选定的「改动后态」显式落盘记录（让下次负对照能按记录还原，而不是靠隐含前提） ----
  try {
    const afterDir = path.join(
      RUNS_DIR,
      sanitizeId(sid),
      'backup',
      'after_state_' + Date.now(),
    )
    fs.mkdirSync(afterDir, { recursive: true })
    const ts = new Date().toISOString()
    const records = []
    for (const s of saved) {
      let backup = null
      let absent = false
      if (afterSource === 'recorded') {
        const r = recordedMap.get(s.orig)
        if (r) {
          absent = r.absent === true
          backup = r.absent === true ? null : r.backup
        }
      } else if (!s.existed) {
        absent = true
      } else if (s.savedPath) {
        backup = path.join(
          afterDir,
          `${records.length}_${path.basename(s.orig)}`,
        )
        fs.copyFileSync(s.savedPath, backup)
      }
      records.push({ ts, orig: s.orig, backup, absent })
    }
    writeAfterState(sid, records)
  } catch (e) {
    try {
      process.stderr.write(
        `[flow-falsify] 快照改动后态失败: ${e && e.message ? e.message : e}\n`,
      )
    } catch {}
  }

  let before = null
  let after = null
  let restoreReport = { ok: true, checked: 0, mismatched: [], unreadable: [] }
  let preRestore = null
  let restoreFailure = null
  // 还原边界：只允许动任务卡登记项目（仓库根）内的路径。
  const restoreRoot = resolveRestoreRoot(sid, cwd)
  try {
    // 1. 还原「改动前」（派发快照）—— 必须失败
    //    失败关闭：还原失败就如实报告，**不拿半还原状态去跑对照**。
    preRestore = restoreFromManifest(entries, {
      root: restoreRoot,
      onAction: (a) => {
        restoreLog.push(a)
        writeJournal('restoring', { restore_log: restoreLog })
      },
    })
    if (!preRestore.ok) {
      const detail = preRestore.failures
        .map((f) => f.orig + '（' + (f.error || f.result) + '）')
        .join('；')
      restoreFailure = new Error(
        '还原改动前态失败：' + detail + '。工作区未回到派发时的状态，' +
          '负对照结论不可信，本次负对照失败关闭。',
      )
      throw restoreFailure
    }
    before = await runVerifyCommand(cmd, cwd, options)
    // 2. 显式还原「改动后」态再跑第二次 —— 必须通过
    //    还原失败同样失败关闭：拿不到「改动后态」就跑第二次对照 = 结论不可信。
    const afterFailures =
      afterSource === 'recorded' ? restoreRecorded() : restoreCurrent()
    if (afterFailures && afterFailures.length) {
      restoreFailure = new Error(
        '还原改动后态失败：' +
          afterFailures
            .map((f) => f.orig + '（' + (f.error || '未知错误') + '）')
            .join('；'),
      )
      throw restoreFailure
    }
    after = await runVerifyCommand(cmd, cwd, options)
  } catch (err) {
    if (!restoreFailure) restoreFailure = err
    try {
      process.stderr.write(
        `[flow-falsify] 负对照中止: ${(err && err.message) || err}\n`,
      )
    } catch {
      /* ignore */
    }
  } finally {
    // 无论如何都把工作区还原成进入负对照时的样子。
    // 还原后必须**核对摘要**：只靠 try/finally 是意图保证，
    // 一次失败的文件写回会让用户改动静默消失，而调用方还以为一切正常。
    const finalFailures = restoreCurrent()
    restoreReport = verifyRestoredState(saved, currentDigests)
    if (finalFailures && finalFailures.length) {
      restoreReport.errors = finalFailures
      // 还原动作失败 = 工作区没能回到进入负对照时的状态：
      // restore.ok 必须置 false（否则调用方会以为还原干净了）。
      restoreReport.ok = false
    }
    // 最终 journal 写盘失败必须**如实报告**（不得静默忽略）：
    // journal.json 是崩溃恢复的唯一依据，写不下去 = 下次调用救不回工作区。
    const journalWritten = writeJournal(
      restoreReport.ok && !(preRestore && !preRestore.ok)
        ? 'restored'
        : 'restore_failed',
      {
        restore: restoreReport,
        restore_log: restoreLog,
        pre_restore: preRestore
          ? { ok: preRestore.ok, failures: preRestore.failures }
          : null,
        finishedAt: new Date().toISOString(),
      },
    )
    if (!journalWritten) {
      restoreReport.ok = false
      restoreReport.journal_write_failed = true
      restoreReport.journal_error = '最终还原日志（journal.json）写入失败'
      try {
        process.stderr.write(
          '[flow-falsify] ⚠️ 最终还原日志写入失败：崩溃恢复依据缺失，工作区状态无法核验\n',
        )
      } catch {
        /* ignore */
      }
    }
    if (!restoreReport.ok) {
      try {
        process.stderr.write(
          '[flow-falsify] ⚠️ 工作区还原不完整，以下文件与进入负对照前不一致：' +
            restoreReport.mismatched.join(', ') +
            '（备份保留在 ' +
            tmpDir +
            '，下次调用 flow_falsify 会先尝试恢复）\n',
        )
      } catch {
        /* ignore */
      }
    }
  }

  // 失败关闭：还原失败 → 如实报告失败，绝不宣称「已还原」。
  if (restoreFailure) {
    return {
      ok: false,
      verdict: 'restore_failed',
      error: formatError(
        '负对照失败（还原失败关闭）：' + (restoreFailure.message || restoreFailure),
      ),
      reason:
        '还原改动前态失败，负对照未执行 —— 工作区未回到派发时的状态，' +
        '不能拿它当「改动前态」跑对照。',
      restore: {
        ok: false,
        checked: restoreReport.checked,
        mismatched: restoreReport.mismatched,
        unreadable: restoreReport.unreadable,
        failures: preRestore ? preRestore.failures : [],
      },
      pre_restore: preRestore
        ? { ok: preRestore.ok, failures: preRestore.failures }
        : null,
      recovered: {
        dirs: recovered.dirs,
        files: recovered.files,
        unresolved: recovered.unresolved,
      },
    }
  }

  // 最终 journal 写盘失败 → 失败关闭：崩溃恢复依据缺失，结论不可信。
  if (restoreReport.journal_write_failed) {
    return {
      ok: false,
      verdict: 'restore_failed',
      error: formatError(
        '负对照失败（还原失败关闭）：' +
          (restoreReport.journal_error || '最终还原日志写入失败') +
          '。工作区已尝试还原，但崩溃恢复依据缺失，本次负对照结论不可信。',
      ),
      reason:
        '最终还原日志（journal.json）写入失败，负对照的崩溃恢复依据缺失 —— ' +
        '不能把它当成有效的判别力证据。',
      restore: restoreReport,
      pre_restore: preRestore
        ? { ok: preRestore.ok, failures: preRestore.failures }
        : null,
      recovered: {
        dirs: recovered.dirs,
        files: recovered.files,
        unresolved: recovered.unresolved,
      },
    }
  }

  const beforeHash = computeOutputHash(
    before.exitCode,
    before.stdout,
    before.stderr,
  )
  const afterHash = computeOutputHash(
    after.exitCode,
    after.stdout,
    after.stderr,
  )
  const beforeStateHash = fingerprintOfState(preDigests)
  const afterStateHash = fingerprintOfState(afterDigests)

  // 两态是否可区分 —— 判定的前提，必须写进 reason（不能靠隐含假设）
  const stateNote =
    changedFiles.length > 0
      ? '；改动后态来源=' +
        (afterSource === 'recorded'
          ? '上次负对照显式记录的改动后态'
          : '当前工作区') +
        '，检出改动文件 ' +
        changedFiles.length +
        ' 个：' +
        changedFiles.join(', ')
      : unknownFiles.length > 0
        ? '；无法确认改动后态：' +
          unknownFiles.length +
          ' 个文件状态不可还原/不可读（' +
          unknownFiles.join(', ') +
          '）'
        : '；未检出任何改动：工作区与派发快照逐字节一致，「改动前」「改动后」是同一状态'

  let verdict = ''
  let reason = ''
  if (before.ok === true) {
    // 改动前就通过 → 空测试
    verdict = 'vacuous'
    reason =
      'verify.cmd 在改动前就通过（exitCode=' +
      before.exitCode +
      '）—— 它没有测本次改动，是空测试' +
      stateNote
  } else if (after.ok !== true) {
    verdict = 'not_passing'
    reason =
      'verify.cmd 在改动后未通过（exitCode=' +
      after.exitCode +
      '）—— 改动本身有问题' +
      stateNote
  } else if (changedFiles.length > 0) {
    verdict = 'meaningful'
    reason =
      '改动前失败（exitCode=' +
      before.exitCode +
      '）+ 改动后通过（exitCode=' +
      after.exitCode +
      '）—— 测试有判别力' +
      stateNote
  } else {
    // 两次运行处于同一状态 → 结果差异不可能来自本次改动（只可能来自命令本身的不确定）
    verdict = 'vacuous'
    reason =
      '改动前失败（exitCode=' +
      before.exitCode +
      '）+ 改动后通过（exitCode=' +
      after.exitCode +
      '），' +
      '但两次运行处于同一状态（未检出任何改动文件）—— 结果差异无法归因于本次改动，' +
      '不能证明该命令在测本次改动，按保守口径记为空测试' +
      stateNote
  }

  // 还原不完整 → 结论不可信：不能记为 meaningful。
  //
  // 「改动前失败 + 改动后通过」只说明命令有区分度；如果工作区**没能完整回到**
  // 进入负对照时的状态（文件没写回 / 写回后摘要不一致），那「改动后」这一态
  // 根本不是我们以为的那一态，结论就不成立 —— 按保守口径降级。
  if (!restoreReport.ok) {
    verdict = 'restore_failed'
    reason =
      '工作区还原未通过核对（' +
      ((restoreReport.mismatched || []).join(', ') ||
        (restoreReport.errors || [])
          .map((e) => e.orig + '（' + (e.error || e.result) + '）')
          .join('；') ||
        '未知原因') +
      '）—— 结论不可信，不能记为 meaningful' +
      stateNote
  }

  // 清理临时目录：**只有还原被核对通过时才删**。
  // 还原失败时保留备份与日志 —— 下一次 flow_falsify 会先用它把工作区救回来，
  // 删掉就等于把用户改动的唯一副本扔了。
  if (restoreReport.ok && !(preRestore && !preRestore.ok)) {
    try {
      fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    } catch {}
  }

  return {
    ok: true,
    verdict,
    reason,
    before: {
      exitCode: before.exitCode,
      ok: before.ok,
      hash: beforeHash,
      stdout: before.stdout,
      stderr: before.stderr,
      state_hash: beforeStateHash,
    },
    after: {
      exitCode: after.exitCode,
      ok: after.ok,
      hash: afterHash,
      stdout: after.stdout,
      stderr: after.stderr,
      state_hash: afterStateHash,
    },
    // 还原结果可核验：ok=false 表示工作区没能完整回到进入负对照前的状态
    restore: restoreReport,
    // 本次调用开始时顺手恢复掉的「上一次被中断的负对照」残留
    recovered: {
      dirs: recovered.dirs,
      files: recovered.files,
      unresolved: recovered.unresolved,
    },
  }
}
// 辅助建议映射表
// 每条都回答三个问题：为什么被拦 / 依据什么规则 / 下一步怎么走
// 键是错误信息里的特征子串（按声明顺序匹配，先命中先用）
const ERROR_SUGGESTIONS = {
  '验证命令为空':
    ' Carlos 需要一个可执行的验证命令（如 `npm test` / `pytest -q`）来判断改动是否真的做对了。它写在任务卡的 verify.cmd 里。',
  '包含高危模式':
    ' 该命令里有删除系统路径、管道执行脚本、写块设备这类不可逆操作。默认不拦（因为清理命令本身合法），但开启 CARLOS_FLOW_BLOCK_DANGEROUS=1 后会拦。',
  '没有派发快照':
    ' 负对照要拿「派发时的文件备份」当对照物，没派发就没有备份。先把任务派出去（flow_dispatch）再回来做负对照。',
  '越界改动':
    ' 你改到了任务卡 scope 白名单之外的文件。这是机械门禁里最硬的一条 —— 防止 executor 顺手改了不该改的地方。',
  '卡片 scope 为空':
    ' 空 scope 按 fail-closed 处理：既然没声明允许改什么，就视为什么都不许改。',
  '验证未通过':
    ' verify.cmd 跑出了非 0 退出码，说明改动还没让验证通过。PASS 不能落，DIRTECTION/LOCAL 可以。',
  '验证结果已过期':
    ' 验证通过后代码又被改动了（diff 指纹变了），所以那次验证已经不能证明当前代码。重新跑一次 flow_run_verify 即可。',
  '验证命令与当前卡片不一致':
    ' 现有的验证结果对应的是另一个 verify.cmd（可能是旧卡的）。对当前卡重新跑一次验证。',
  '尚未执行验证': ' 还没有跑过 verify.cmd，没有可核验的凭据。',
  '尚未派发任何执行':
    ' 门禁要求改动必须经过派发窗口（有快照、有基线），跳过派发直接落 PASS 是不允许的。',
  '尚未做负对照':
    ' 负对照用来证明 verify.cmd 真的有判别力（改动前失败、改动后通过），防止 `|| true` 这种空测试混过去。',
  '负对照未通过':
    ' 验证命令没有判别力（例如改动前后都退出 0），不能拿它当「改动正确」的证据。',
  '缺少必填字段':
    ' 当前风险档要求的字段没填齐。低风险档只要求 goal/quote/scope，cross_module 还要 acceptance 和 files。',
  '类型错误':
    ' 参数类型与工具 schema 声明不符。常见于把数组写成字符串、或数组元素嵌套了一层。',
  '值非法': ' 该参数只接受枚举里的值。',
  '未 claim':
    ' 派发前要先 claim 领一个名额（executor 或 auditor），这是为了让审计知道是谁在做。',
  'quote 锚点': ' quote 必须能在你的原话里定位到，防止 Agent 替你编需求。',
  '路径在磁盘上不存在':
    ' scope 里的路径找不到。常见原因是没传 cwd，导致相对路径按 server 进程目录（而不是仓库根）解析。',
  '敏感路径':
    ' scope 里包含敏感路径，需要你显式确认（confirmed=true）才能提交。',
  '获取状态锁超时':
    ' 同一会话有另一个进程正在写状态，等它释放即可，不要绕过锁直接写。',
  '没有留痕':
    ' 门禁要求先有任务卡（留痕），否则 executor/auditor 不知道边界在哪、也无法事后追溯。',
  '留痕已过期':
    ' 卡片有 TTL（默认 4 小时），过期后再派发就不算同一张卡了，需重新提交。',
  '派发次数已达上限':
    ' 同一张卡可派发次数有上限，防止无限重试把同一张卡磨到绿灯。',
  '占位卡尚未补齐':
    ' 智能触发只开了一张占位卡，scope / acceptance / verify.cmd 还没填，填完才能派发。',
  '卡片未指定 verify': ' 没有 verify.cmd 就没有可核验的证据，PASS 无法成立。',
  '两轴': ' PASS 要求两轴（规范轴 + 验收轴）各自取证，单轴意见不足以放行。',
  '至少一轴': ' 至少一轴判了 FAIL，说明问题确实存在，修完重跑再提。',
  'auditor': ' PASS 只能由已领取 auditor 角色的会话落下，防止执行方自批。',
}

export function formatError(err) {
  const msg =
    typeof err === 'string' ? err : String((err && err.message) || err)
  let suggestion = ''
  for (const [key, val] of Object.entries(ERROR_SUGGESTIONS)) {
    if (msg.includes(key)) {
      suggestion = `\n💡 **为什么被拦**：${val}`
      break
    }
  }
  return `${msg}${suggestion}`
}
//   - scope: 卡片中的 scope 白名单
//   - cwd:   仓库根目录（用于跑 git diff）
//   - diffFiles?: 可选，外部传入的改动文件列表；不传则自动跑 `git diff --name-only`
// 返回：{ ok, violations[], message? }
//
// 设计：
//   · 空 scope = 白名单为空 = fail-closed（所有变更都算越界）
//   · 无变更（diffFiles 为空）= 直接 ok
//   · 自动跑 `git diff --name-only`：派发前快照 vs 当前工作区
//   · 精确匹配 + 父目录匹配：scope 内文件及其子目录均算通过
// 取 git 仓库根（拿不到就返回空串）。
function gitTopLevel(cwd) {
  try {
    const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: false,
    })
    if (proc.status === 0 && typeof proc.stdout === 'string')
      return proc.stdout.trim()
  } catch {
    /* git 不可用 */
  }
  return ''
}

// 未跟踪文件里要排除的「Carlos 自己的状态目录」（若它落在仓库内）。
// 不排除的话：状态/审计文件会被当成「未跟踪的新文件」→ 自我误报成越界。
// 只在它**严格位于仓库根之下**时排除（等于仓库根时不排除）。
function flowHomePrefix(cwd) {
  const home = process.env.CARLOS_FLOW_HOME
  if (!home) return ''
  const top = gitTopLevel(cwd)
  if (!top) return ''
  const rel = path.relative(top, path.resolve(home))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  // 路径键用**平台感知**的那一把（card.js 的 pathKey）：
  // win32 上大小写不敏感、其它平台敏感 —— 无条件小写会在 POSIX 上
  // 把大小写不同的路径当成同一个，从而漏掉真正的越界文件。
  return pathKey(path.resolve(top, rel))
}

// 返回：仓库根相对路径列表（去重）。
//   · 已跟踪文件的改动：`git diff --name-only`（既有语义，**不变**）；
//   · 未跟踪的新文件：`git ls-files --others --exclude-standard`
//     （尊重 .gitignore：被忽略的文件不算改动）。
// 只看 `git diff --name-only` 不够 —— 它**只含已跟踪文件**，
// 于是「新建一个没授权的文件」在越界检测里完全看不见（漏了最大的一类）。
export function enforceScope(scope, cwd, diffFiles) {
  // diffFiles 可选：外部传入的改动文件列表；不传则自动跑 `git diff --name-only`
  // cwd: 仓库根目录（用于跑 git diff）
  let autoCollected = false
  if (!diffFiles) {
    autoCollected = true
    diffFiles = []
    try {
      const proc = spawnSync('git', ['diff', '--name-only'], {
        cwd: cwd || process.cwd(),
        encoding: 'utf8',
        // git 不在 PATH / 不是仓库 / 超时 → 一律当作「无改动」而非抛错，
        // 避免把环境问题变成门禁误报（fail-closed 只针对 scope 语义，不针对环境）
        timeout: 10000,
        windowsHide: true,
      })
      if (proc.status === 0 && typeof proc.stdout === 'string') {
        diffFiles = proc.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      }
    } catch {
      diffFiles = []
    }
    // 未跟踪的新文件：同样属于「本次改动」，必须纳入越界判定。
    try {
      const proc = spawnSync(
        'git',
        ['ls-files', '--others', '--exclude-standard', '--full-name'],
        {
          cwd: cwd || process.cwd(),
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
          shell: false,
        },
      )
      if (proc.status === 0 && typeof proc.stdout === 'string') {
        const top = gitTopLevel(cwd)
        const homePrefix = flowHomePrefix(cwd)
        for (const line of proc.stdout.split('\n')) {
          const rel = line.trim()
          if (!rel) continue
          if (homePrefix && top) {
            const abs = pathKey(path.resolve(top, rel))
            const prefix = homePrefix.endsWith('/') ? homePrefix : homePrefix + '/'
            if (abs.startsWith(prefix)) continue
          }
          if (!diffFiles.includes(rel)) diffFiles.push(rel)
        }
      }
    } catch {
      /* 未跟踪扫描失败：不影响已跟踪改动的判定 */
    }
  }

  // 没有任何变更 → 无需判定
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) {
    return { ok: true, violations: [], checked: [] }
  }

  // 空 scope = 白名单为空 = **不允许改动任何文件**。
  // 早期实现直接 return { ok: true }，等于「白名单为空 → 随便改」，
  // 是 fail-open 漏洞；这里改为 fail-closed：所有变更都算越界。
  if (!Array.isArray(scope) || scope.length === 0) {
    return {
      ok: false,
      violations: diffFiles.slice(),
      checked: diffFiles.slice(),
      message: formatError(
        `越界改动（卡片 scope 为空，不允许修改任何文件）：${diffFiles.join(', ')}`,
      ),
    }
  }

  // 允许集比对用**与卡片层同一把路径键**（pathKey）：
  // 分隔符统一 + win32 折叠大小写 —— 授权写法与落盘写法大小写不同时
  // （授权 "Docs/Guide.md"、落盘 "docs/guide.md"）不得误判越界。
  const scopeSet = new Set(scope.map((p) => pathKey(p)))
  const violations = []

  for (const file of diffFiles) {
    const fileKey = pathKey(file)
    // 检查文件是否在 scope 内（精确匹配或父目录匹配）
    let allowed = false
    for (const scopePath of scopeSet) {
      const prefix = scopePath.endsWith('/') ? scopePath : scopePath + '/'
      if (fileKey === scopePath || fileKey.startsWith(prefix)) {
        allowed = true
        break
      }
    }
    if (!allowed) {
      violations.push(file)
    }
  }

  if (violations.length > 0) {
    const msg = `越界改动（超出 scope）：${violations.join(', ')}`
    return {
      ok: false,
      violations,
      checked: diffFiles.slice(),
      message: formatError(msg),
    }
  }
  return { ok: true, violations: [], checked: diffFiles.slice() }
}
