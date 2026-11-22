#!/usr/bin/env node
/**
 * 断言敏感性门禁（阶段三）：对**本次改动过的测试文件**做 AST 前后比对。
 *
 * 为什么需要独立门禁：`test:all` 只能证明“测试通过”。把关键断言删掉后
 * 测试往往仍然通过，所以需要比较 HEAD 与工作区的断言结构。
 *
 * 判定口径：
 * - 基线没有可比较断言（纯辅助文件）→ 跳过，不算失败；
 * - 解析失败/超预算 → 无法判断，退出 2（不当作通过）；
 * - 删除断言、改期望值、新增 skip/todo → 退出 1。
 *
 * 只比较已跟踪的 test/**\/*.{mjs,js} 改动；新增文件没有基线，跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { analyzeFiles } from '../src/ast-assertions.js'

const NL = String.fromCharCode(10)

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' }
}

function main() {
  const cwd = process.cwd()
  const root = git(['rev-parse', '--show-toplevel'], cwd)
  if (!root.ok) {
    process.stdout.write('SKIP: 不在 Git 仓库内，无法比较基线' + NL)
    return 0
  }
  const repo = root.out.trim()
  const changed = git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', 'test'], repo)
  if (!changed.ok) {
    process.stdout.write('ERROR: 无法读取 git diff' + NL)
    return 2
  }
  const files = changed.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .filter((f) => /\.(mjs|js)$/.test(f))
  if (files.length === 0) {
    process.stdout.write('OK: 本次没有改动测试文件，无需断言比对' + NL)
    return 0
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-ast-gate-'))
  let failures = 0
  let unknown = 0
  let skipped = 0
  const lines = []
  try {
    for (const rel of files) {
      const current = path.join(repo, rel)
      if (!fs.existsSync(current)) continue
      const show = git(['show', `HEAD:${rel}`], repo)
      if (!show.ok) continue // 新文件没有基线
      const base = path.join(tmp, rel.replace(/[\\/]/g, '__'))
      fs.writeFileSync(base, show.out, 'utf8')
      const res = analyzeFiles(base, current)
      if (!res.ok) {
        if (/未找到可比较的断言/.test(res.reason || '')) {
          skipped++
          continue
        }
        unknown++
        lines.push(`  ? ${rel}: 无法判断（${res.reason || res.verdict}）`)
        continue
      }
      if (res.verdict === 'assertion-regression') {
        failures++
        const detail = (res.removed || []).slice(0, 5).map((x) => `${x.kind}:${x.method}@${x.line}`).join(', ')
        lines.push(`  ✗ ${rel}: 断言退化 ${detail}`)
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  if (lines.length) process.stdout.write(lines.join(NL) + NL)
  process.stdout.write(`检查 ${files.length} 个改动测试文件：退化 ${failures}，无法判断 ${unknown}，跳过 ${skipped}` + NL)
  if (failures > 0) return 1
  if (unknown > 0) return 2
  return 0
}

process.exit(main())