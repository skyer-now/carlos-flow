#!/usr/bin/env node
/**
 * 断言敏感性门禁（阶段三）：对**本次改动过的测试文件**做 AST 前后比对。
 *
 * 为什么需要独立门禁：`test:all` 只能证明“测试通过”。把关键断言删掉后
 * 测试往往仍然通过，所以需要比较 HEAD 与工作区的断言结构。
 *
 * 判定口径：
 * - 新增文件没有基线 → 跳过；
 * - 测试文件被整体删除 → 判为退化（断言全部消失）；
 * - 重命名/修改 → 与 HEAD 的旧内容比较；
 * - 基线没有可比较断言（纯辅助文件）→ 跳过；
 * - 解析失败/超预算/找不到基线 → 无法判断，退出 2（不当作通过）；
 * - 删除断言、改期望值、新增 skip/todo → 退出 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { analyzeFiles } from '../src/ast-assertions.js'

const NL = String.fromCharCode(10)
const EOL = new RegExp('\\r?\\n')

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' }
}

function isTestFile(p) {
  return typeof p === 'string' && /\.(mjs|js)$/.test(p)
}

function main() {
  const cwd = process.cwd()
  const root = git(['rev-parse', '--show-toplevel'], cwd)
  if (!root.ok) {
    // 不是 Git 仓库（例如解包后的插件目录）：没有基线可比，明确说明而不是假装通过。
    process.stdout.write('SKIP: 不在 Git 仓库内，没有基线可比（未验证，不算通过）' + NL)
    return 0
  }
  const repo = root.out.trim()
  const changed = git(['diff', '--name-status', '-M', 'HEAD', '--', 'test'], repo)
  if (!changed.ok) {
    process.stdout.write('ERROR: 无法读取 git diff' + NL)
    return 2
  }
  const entries = changed.out.split(EOL).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('\t')
    return { status: parts[0], from: parts[1], to: parts[2] || parts[1] }
  }).filter((e) => isTestFile(e.to) || isTestFile(e.from))

  if (entries.length === 0) {
    process.stdout.write('OK: 本次没有改动测试文件，无需断言比对' + NL)
    return 0
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-ast-gate-'))
  let failures = 0
  let unknown = 0
  let skipped = 0
  const lines = []
  try {
    for (const entry of entries) {
      const kind = entry.status[0]
      if (kind === 'A') { skipped++; continue }
      if (kind === 'D') {
        failures++
        lines.push(`  ✗ ${entry.from}: 测试文件被整体删除（断言全部消失）`)
        continue
      }
      const basePath = (kind === 'R' || kind === 'C') ? entry.from : entry.to
      const show = git(['show', `HEAD:${basePath}`], repo)
      const current = path.join(repo, entry.to)
      if (!show.ok || !fs.existsSync(current)) {
        unknown++
        lines.push(`  ? ${entry.to}: 没有可用基线（${show.ok ? '当前文件缺失' : 'HEAD 中找不到'}），无法判断`)
        continue
      }
      const base = path.join(tmp, `${basePath.replace(/[\\/]/g, '__')}.baseline`)
      fs.writeFileSync(base, show.out, 'utf8')
      const res = analyzeFiles(base, current)
      if (!res.ok) {
        if (/未找到可比较的断言/.test(res.reason || '')) { skipped++; continue }
        unknown++
        lines.push(`  ? ${entry.to}: 无法判断（${res.reason || res.verdict}）`)
        continue
      }
      if (res.verdict === 'assertion-regression') {
        failures++
        const detail = (res.removed || []).slice(0, 5).map((x) => `${x.kind}:${x.method}@${x.line}`).join(', ')
        lines.push(`  ✗ ${entry.to}: 断言退化 ${detail}`)
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  if (lines.length) process.stdout.write(lines.join(NL) + NL)
  process.stdout.write(`检查 ${entries.length} 个改动测试文件：退化 ${failures}，无法判断 ${unknown}，跳过 ${skipped}` + NL)
  if (failures > 0) return 1
  if (unknown > 0) return 2
  return 0
}

process.exit(main())