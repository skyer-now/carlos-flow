// 阶段三专项：AST 断言敏感性探测（scripts/ast-negative-control.mjs）。
//
// 重点验证「删掉关键断言但测试仍退出 0」这类真实负例能被检出，
// 以及无法判断的情况（解析失败/无断言/超预算）绝不当作通过。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-ast-'))
const script = path.join(process.cwd(), 'scripts', 'ast-negative-control.mjs')
const node = process.execPath

function write(name, body) {
  const file = path.join(sandbox, name)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

function run(baseline, candidate) {
  const r = spawnSync(node, [script, '--baseline', baseline, '--candidate', candidate, '--json'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { code: r.status, json, stderr: r.stderr }
}

const BASELINE = `
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('adds', () => {
  const total = 1 + 1
  assert.equal(total, 2)
  assert.deepEqual([total], [2])
})
`

const WEAK = `
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('adds', () => {
  const total = 1 + 1
  assert.equal(total, 2)
})
`

after(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

describe('阶段三 · AST 断言敏感性探测', () => {
  it('未改动时判定为无退化（退出 0）', () => {
    const base = write('base-1.mjs', BASELINE)
    const cand = write('cand-1.mjs', BASELINE)
    const r = run(base, cand)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.json.verdict, 'no-regression')
    assert.equal(r.json.baseline_assertions, 2)
  })

  it('删掉一条关键断言但测试仍会退出 0：AST 必须检出（退出 1）', () => {
    // 真实负例：候选实现是坏的（排序没生效），但唯一能发现它的断言被删掉了，
    // 所以直接跑候选测试仍然全绿——只有结构比较能发现。
    const GOOD = `
import { test } from 'node:test'
import assert from 'node:assert/strict'
const sort = (a) => a.slice().sort((x, y) => x - y)
test('sorts', () => {
  const out = sort([2, 1])
  assert.equal(out.length, 2)
  assert.deepEqual(out, [1, 2])
})
`
    const BROKEN = `
import { test } from 'node:test'
import assert from 'node:assert/strict'
const sort = (a) => a.slice()
test('sorts', () => {
  const out = sort([2, 1])
  assert.equal(out.length, 2)
})
`
    const base = write('base-2.mjs', GOOD)
    const cand = write('cand-2.mjs', BROKEN)
    const live = spawnSync(node, [cand], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    assert.equal(live.status, 0, '负例本身必须仍然通过（否则测的不是断言敏感性）')

    const r = run(base, cand)
    assert.equal(r.code, 1, r.stderr)
    assert.equal(r.json.verdict, 'assertion-regression')
    assert.ok(r.json.removed.some((x) => x.method === 'deepEqual'))
  })

  it('新增 skip/todo 被判为退化', () => {
    const base = write('base-3.mjs', BASELINE)
    const skip = write('cand-3.mjs', BASELINE.replace("test('adds'", "test.skip('adds'"))
    const r = run(base, skip)
    assert.equal(r.code, 1)
    assert.equal(r.json.verdict, 'assertion-regression')
    assert.ok(r.json.added_skips.length >= 1)
  })

  it('断言被弱化（strictEqual → ok）会被识别为删除+新增', () => {
    const base = write('base-4.mjs', `
import assert from 'node:assert/strict'
assert.strictEqual(1 + 1, 2)
`)
    const cand = write('cand-4.mjs', `
import assert from 'node:assert/strict'
assert.ok(1 + 1 === 2)
`)
    const r = run(base, cand)
    assert.equal(r.code, 1)
    assert.ok(r.json.removed.some((x) => x.method === 'strictEqual'))
  })

  it('语法错误按无法判断处理（退出 2，不是通过）', () => {
    const base = write('base-5.mjs', BASELINE)
    const bad = write('cand-5.mjs', 'test( broken')
    const r = run(base, bad)
    assert.equal(r.code, 2)
    assert.equal(r.json.verdict, 'parse-error')
  })

  it('基线没有可比较断言时退出 2（不冒充已防护）', () => {
    const base = write('base-6.mjs', 'console.log(1)\n')
    const cand = write('cand-6.mjs', 'console.log(2)\n')
    const r = run(base, cand)
    assert.equal(r.code, 2)
    assert.equal(r.json.verdict, 'unsupported')
  })

  it('缺少参数时退出 2', () => {
    const r = spawnSync(node, [script], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    assert.equal(r.status, 2)
    assert.ok(r.stdout.includes('usage'))
  })
})