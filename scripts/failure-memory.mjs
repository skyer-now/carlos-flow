#!/usr/bin/env node
// 阶段二：项目隔离失败记忆与真实质检单导出的明确操作入口。
//
// 用法（所有写入都限定在 CARLOS_FLOW_HOME 或显式给出的输出目录）：
//   node scripts/failure-memory.mjs list   --cwd <项目目录>
//   node scripts/failure-memory.mjs confirm <候选ID> --cwd <项目目录> [--note <说明>]
//   node scripts/failure-memory.mjs qa-sheet --session <会话ID> --out <绝对输出目录> [--notes <说明>]
//
// 退出码：0 成功；1 失败（含「未指定输出目录」「未找到候选」「导出写入失败」）。
import path from 'node:path'
import { FLOW_HOME, loadState, isStale } from '../src/state.js'
import { redact } from '../src/redact.js'
import {
  loadProjectFailureMemory,
  listCandidates,
  confirmFailureExperience,
  resolveProjectIdentity,
} from '../src/failure-memory.js'
import { exportQASheet } from '../ui/narrator.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function emit(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd()

  if (command === 'list') {
    const mem = loadProjectFailureMemory({ flowHome: FLOW_HOME, cwd })
    const candidates = listCandidates({ flowHome: FLOW_HOME, cwd })
    const identity = resolveProjectIdentity(cwd)
    emit({
      ok: true,
      // 输出不露本机绝对目录：只给脱敏后的 home 与项目身份
      flowHome: redact(FLOW_HOME),
      identity: { key: identity.key, kind: identity.kind, name: identity.name, root: redact(identity.root) },
      degraded: mem.degraded,
      degraded_reason: mem.degraded_reason,
      trimmed: mem.trimmed === true,
      legacy: mem.legacy,
      rules: mem.rules,
      candidates: candidates.ok ? candidates.candidates : [],
      candidates_error: candidates.ok ? null : candidates.reason,
    })
    return 0
  }

  if (command === 'confirm') {
    const id = args._[1]
    if (!id) {
      emit({ ok: false, reason: '缺少候选ID' })
      return 1
    }
    const res = confirmFailureExperience(id, {
      flowHome: FLOW_HOME,
      cwd,
      note: typeof args.note === 'string' ? args.note : '',
    })
    emit(res)
    return res.ok ? 0 : 1
  }

  if (command === 'qa-sheet') {
    const sessionId = args.session
    if (typeof sessionId !== 'string' || !sessionId) {
      emit({ ok: false, reason: '缺少 --session' })
      return 1
    }
    if (typeof args.out !== 'string' || !args.out) {
      emit({ ok: false, reason: '缺少 --out（本次获授权的输出目录，必须是绝对路径）' })
      return 1
    }
    // 导出目录不得落在状态目录内：避免把交付物混进门禁状态/记忆分区。
    const outAbs = path.resolve(args.out)
    const flowAbs = path.resolve(FLOW_HOME)
    const rel = path.relative(flowAbs, outAbs)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      emit({ ok: false, reason: '输出目录不能位于 CARLOS_FLOW_HOME 内' })
      return 1
    }
    const state = await loadState(sessionId)
    const res = await exportQASheet(state, {
      outDir: outAbs,
      sessionId,
      // 真实过期判定由门禁同一口径的 isStale 给出，不靠调用方自报。
      stale: isStale(state),
      notes: typeof args.notes === 'string' ? args.notes : '',
    })
    emit(res)
    return res.ok ? 0 : 1
  }

  emit({
    ok: false,
    reason: '未知命令；可用：list | confirm | qa-sheet',
    usage: [
      'node scripts/failure-memory.mjs list --cwd <项目目录>',
      'node scripts/failure-memory.mjs confirm <候选ID> --cwd <项目目录> [--note <说明>]',
      'node scripts/failure-memory.mjs qa-sheet --session <会话ID> --out <绝对输出目录> [--notes <说明>]',
    ],
  })
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    emit({ ok: false, reason: e && e.message ? e.message : String(e) })
    process.exit(1)
  })