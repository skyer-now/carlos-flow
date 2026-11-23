/**
 * AST 自动负对照：断言敏感性探测（阶段三）
 *
 * 作用：比较「基线测试文件」与「候选测试文件」的断言结构，识别
 * 关键断言被删除、被弱化、或整组被 skip/todo 的情况——这类问题通常
 * 让测试仍然退出 0，靠跑测试本身发现不了。
 *
 * 边界（不要夸大）：
 * - 只支持 JavaScript/ESM 测试断言：assert.*、t.assert.*、expect(...).toBe/toEqual 等链式断言；
 * - 不覆盖其它语言、也不声称能发现所有作弊；
 * - 解析失败、没有可比较断言、超出预算，一律按「无法判断」退出，绝不当作通过。
 *
 * 解析器：acorn 8.15.0（MIT，约 130KB tarball，纯 JS，无原生依赖）。
 * 取舍：acorn 以 `vendor/acorn.mjs` 随包携带，不声明 npm 依赖（Cindy 插件环境不保证 node_modules）；不用正则冒充 AST，也不用自带残缺解析器。
 *
 * 退出码：
 *   0 = 未发现断言退化
 *   1 = 发现断言退化（删除/弱化/跳过）
 *   2 = 无法判断（解析失败、无可比较断言、超预算、参数错误）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from '../vendor/acorn.mjs'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_NODES = 200000

const ASSERT_METHODS = new Set([
  'ok', 'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual',
  'notDeepEqual', 'notDeepStrictEqual', 'match', 'doesNotMatch', 'throws', 'doesNotThrow',
  'rejects', 'doesNotReject', 'fail', 'ifError', 'includes', 'notIncludes',
])

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

function readSource(file) {
  const st = fs.statSync(file)
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: `文件超过预算（${st.size} 字节）` }
  return { ok: true, source: fs.readFileSync(file, 'utf8'), bytes: st.size }
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function walk(node, visit, state = { count: 0 }) {
  if (!node || typeof node !== 'object') return state
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, state)
    return state
  }
  if (typeof node.type === 'string') {
    state.count++
    if (state.count > MAX_NODES) throw new Error(`AST 节点超过预算（${MAX_NODES}）`)
    visit(node)
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue
    const value = node[key]
    if (value && typeof value === 'object') walk(value, visit, state)
  }
  return state
}

function calleeText(callee, source) {
  if (!callee) return ''
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed) {
    const obj = calleeText(callee.object, source)
    const prop = callee.property && callee.property.name
    return obj ? `${obj}.${prop}` : String(prop || '')
  }
  if (callee.type === 'MemberExpression' && callee.computed) {
    return `${calleeText(callee.object, source)}[${source.slice(callee.property.start, callee.property.end)}]`
  }
  return source.slice(callee.start, callee.end)
}

function assertOwner(text) {
  const parts = text.split('.')
  const owner = parts.slice(0, -1).join('.')
  // assert.equal / t.assert.equal / ctx.assert.equal —— 只认“断言对象 + 断言方法”
  return /(?:^|\.)assert$/.test(owner)
}

function assertionMethod(text) {
  const parts = text.split('.')
  return parts[parts.length - 1]
}

function isExpectChain(text) {
  return /^expect\(/.test(text) || /^(?:expect|assert)\(/.test(text)
}

/**
 * 提取断言签名：只比较「方法名 + 字面量」。
 *
 * 为什么不比较标识符：重命名变量/提取常量是合法重构，用源码文本比较会误报。
 * 为什么必须比较字面量：把期望值 2 改成 3 恰好能让坏实现变绿，这是最该抓的一类。
 */
function literalTokens(node, source, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) literalTokens(child, source, out)
    return out
  }
  if (node.type === 'Literal') {
    out.push(node.regex ? 're:' + node.regex.pattern + '/' + node.regex.flags : String(node.value))
    return out
  }
  if (node.type === 'TemplateElement') {
    out.push(String(node.value.cooked))
    return out
  }
  if (node.type === 'Identifier' || node.type === 'ThisExpression') return out
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue
    const value = node[key]
    if (value && typeof value === 'object') literalTokens(value, source, out)
  }
  return out
}


// 断言消息参数不是"判别内容"：assert.ok(v, "消息") / assert.equal(a, b, "消息")。
// 把消息字面量排除在签名外，避免改文案被误判为断言退化。
function valueArgs(args, method) {
  const list = Array.isArray(args) ? args : []
  const messageFrom = (method === 'ok' || method === 'fail') ? 1 : 2
  // assert.throws(fn, error, message)：第 3 个参数才是消息
  const throwFamily = method === 'throws' || method === 'doesNotThrow' || method === 'rejects' || method === 'doesNotReject'
  const limit = throwFamily ? 2 : messageFrom
  return list.length > limit ? list.slice(0, limit) : list
}

function collectSignatures(ast, source) {
  const signatures = []
  const skips = []
  walk(ast, (node) => {
    if (node.type === 'CallExpression') {
      const text = calleeText(node.callee, source)
      const method = assertionMethod(text)
      if (assertOwner(text) && ASSERT_METHODS.has(method)) {
        const literals = valueArgs(node.arguments, method).flatMap((arg) => literalTokens(arg, source))
        signatures.push({ kind: 'assert', method, sig: `${method}|${literals.join(',')}`, literals, line: node.loc?.start?.line || null })
        return
      }
      if (isExpectChain(text)) {
        const method = text.split('.').pop()
        const literals = valueArgs(node.arguments, method).flatMap((arg) => literalTokens(arg, source))
        signatures.push({ kind: 'expect', method, sig: `${method}|${literals.join(',')}`, literals, line: node.loc?.start?.line || null })
        return
      }
      if (/(?:^|\.)(?:skip|todo)$/.test(text) && node.arguments && node.arguments.length) {
        skips.push({ call: text, line: node.loc?.start?.line || null })
      }
    }
    if (node.type === 'MemberExpression' && node.property && (node.property.name === 'skip' || node.property.name === 'todo')) {
      // test.skip / it.todo 作为属性引用（未调用）也算跳过意图
      const text = calleeText(node, source)
      if (/^(?:test|it|describe|suite)\.(?:skip|todo)$/.test(text)) {
        skips.push({ call: text, line: node.loc?.start?.line || null })
      }
    }
  })
  return { signatures, skips }
}

function countMultiset(list) {
  const map = new Map()
  for (const item of list) map.set(item.sig, (map.get(item.sig) || 0) + 1)
  return map
}

function methodCounts(list) {
  const map = new Map()
  for (const item of list) map.set(item.method, (map.get(item.method) || 0) + 1)
  return map
}

function compare(baselineSigs, candidateSigs) {
  const before = countMultiset(baselineSigs)
  const after = countMultiset(candidateSigs)
  const beforeMethods = methodCounts(baselineSigs)
  const afterMethods = methodCounts(candidateSigs)
  const removed = []
  for (const [sig, n] of before) {
    const now = after.get(sig) || 0
    if (now >= n) continue
    const hit = baselineSigs.find((s) => s.sig === sig)
    const method = hit ? hit.method : null
    // 同一方法总数没有减少 → 是“期望值/参数被改”而非整条删除
    const kind = (afterMethods.get(method) || 0) >= (beforeMethods.get(method) || 0) ? 'changed' : 'removed'
    removed.push({ sig, kind, missing: n - now, line: hit ? hit.line : null, method })
  }
  return removed
}

export function analyzeFiles(baselineFile, candidateFile) {
  const b = readSource(baselineFile)
  if (!b.ok) return { ok: false, verdict: 'unsupported', reason: `基线不可用：${b.reason}` }
  const c = readSource(candidateFile)
  if (!c.ok) return { ok: false, verdict: 'unsupported', reason: `候选不可用：${c.reason}` }

  let baselineAst
  let candidateAst
  try {
    baselineAst = parse(b.source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true })
  } catch (e) {
    return { ok: false, verdict: 'parse-error', reason: `基线解析失败：${e.message}` }
  }
  try {
    candidateAst = parse(c.source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true })
  } catch (e) {
    return { ok: false, verdict: 'parse-error', reason: `候选解析失败：${e.message}` }
  }

  let baseline
  let candidate
  try {
    baseline = collectSignatures(baselineAst, b.source)
    candidate = collectSignatures(candidateAst, c.source)
  } catch (e) {
    return { ok: false, verdict: 'unsupported', reason: e.message }
  }

  if (baseline.signatures.length === 0) {
    return { ok: false, verdict: 'unsupported', reason: '基线中未找到可比较的断言（支持范围为 JS/ESM 断言调用）' }
  }

  const removed = compare(baseline.signatures, candidate.signatures)

  // skip/todo 按调用名做多重集比较，避免“删一个加一个”按序号切导致错位。
  const skipCount = (list) => {
    const map = new Map()
    for (const s of list) map.set(s.call, (map.get(s.call) || 0) + 1)
    return map
  }
  const beforeSkips = skipCount(baseline.skips)
  const afterSkips = skipCount(candidate.skips)
  const addedSkips = []
  for (const [call, n] of afterSkips) {
    const prev = beforeSkips.get(call) || 0
    if (n > prev) addedSkips.push({ call, added: n - prev })
  }

  return {
    ok: true,
    verdict: removed.length > 0 || addedSkips.length > 0 ? 'assertion-regression' : 'no-regression',
    baseline_assertions: baseline.signatures.length,
    candidate_assertions: candidate.signatures.length,
    removed,
    added_skips: addedSkips,
    limits: { max_file_bytes: MAX_FILE_BYTES, max_nodes: MAX_NODES },
  }
}

/** 直接比较两段源码（供 git 基线比对复用）。 */
export function analyzeSources(baselineSource, candidateSource) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-ast-pair-'))
  try {
    const b = path.join(tmp, 'baseline.mjs')
    const c = path.join(tmp, 'candidate.mjs')
    fs.writeFileSync(b, baselineSource, 'utf8')
    fs.writeFileSync(c, candidateSource, 'utf8')
    return analyzeFiles(b, c)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}
