#!/usr/bin/env node
/**
 * AST 断言敏感性探测 CLI（阶段三）。
 *
 * 逻辑在 src/ast-assertions.js；本文件只负责参数与退出码：
 *   0 = 未发现断言退化；1 = 发现退化；2 = 无法判断（不当作通过）。
 */
import path from 'node:path'
import { analyzeFiles } from '../src/ast-assertions.js'

const NL = String.fromCharCode(10)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--baseline') out.baseline = argv[++i]
    else if (a === '--candidate') out.candidate = argv[++i]
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.baseline || !args.candidate) {
    const reason = '用法：node scripts/ast-negative-control.mjs --baseline <测试文件> --candidate <测试文件> [--json]'
    process.stdout.write(JSON.stringify({ ok: false, verdict: 'usage', reason }, null, 2) + NL)
    return 2
  }
  let result
  try {
    result = analyzeFiles(path.resolve(args.baseline), path.resolve(args.candidate))
  } catch (e) {
    result = { ok: false, verdict: 'unsupported', reason: e && e.message ? e.message : String(e) }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + NL)
  if (!result.ok) return 2
  return result.verdict === 'assertion-regression' ? 1 : 0
}

process.exit(main())