// 阶段三专项：断言敏感性门禁（scripts/check-ast-assertions.mjs）。
//
// 验证：改动测试文件并删除关键断言 → 退出 1；未改动/纯重命名 → 退出 0；
// 新增文件无基线 → 跳过；不在 Git 仓库 → 明确 SKIP 而不是失败。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-ast-gate-'))
const repo = path.join(sandbox, 'repo')
fs.mkdirSync(path.join(repo, 'test'), { recursive: true })
const script = path.join(process.cwd(), 'scripts', 'check-ast-assertions.mjs')
const node = process.execPath

const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
git(['init', '-q'])
git(['config', 'user.email', 'gate@example.invalid'])
git(['config', 'user.name', 'gate'])

const TEST_FILE = [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "test('sorts', () => {",
  '  const out = [2, 1].sort()',
  '  assert.equal(out.length, 2)',
  '  assert.deepEqual(out, [1, 2])',
  '})',
  '',
].join('\n')

fs.writeFileSync(path.join(repo, 'test', 'a.test.mjs'), TEST_FILE)
git(['add', '.'])
git(['commit', '-q', '-m', 'init'])

function run(cwd = repo) {
  const r = spawnSync(node, [script], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

after(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

describe('阶段三 · 断言敏感性门禁', () => {
  it('没有改动时通过', () => {
    const r = run()
    assert.equal(r.code, 0, r.out + r.err)
    assert.ok(r.out.includes('无需断言比对'))
  })

  it('改动中删除关键断言：退出 1', () => {
    fs.writeFileSync(path.join(repo, 'test', 'a.test.mjs'), TEST_FILE.replace("  assert.deepEqual(out, [1, 2])\n", ''))
    const r = run()
    assert.equal(r.code, 1, r.out + r.err)
    assert.ok(r.out.includes('断言退化'))
    git(['checkout', '--', 'test/a.test.mjs'])
  })

  it('改动中修改期望值：退出 1', () => {
    fs.writeFileSync(path.join(repo, 'test', 'a.test.mjs'), TEST_FILE.replace('[1, 2]', '[2, 1]'))
    const r = run()
    assert.equal(r.code, 1, r.out + r.err)
    git(['checkout', '--', 'test/a.test.mjs'])
  })

  it('仅重命名变量：不误报', () => {
    fs.writeFileSync(
      path.join(repo, 'test', 'a.test.mjs'),
      TEST_FILE.replace('const out =', 'const sorted =').replace(/out/g, 'sorted'),
    )
    const r = run()
    assert.equal(r.code, 0, r.out + r.err)
    git(['checkout', '--', 'test/a.test.mjs'])
  })

  it('新增测试文件没有基线时跳过，不当作失败', () => {
    fs.writeFileSync(path.join(repo, 'test', 'b.test.mjs'), TEST_FILE)
    const r = run()
    assert.equal(r.code, 0, r.out + r.err)
    fs.rmSync(path.join(repo, 'test', 'b.test.mjs'))
  })

  it('整体删除测试文件：判为退化（退出 1）', () => {
    fs.rmSync(path.join(repo, 'test', 'a.test.mjs'))
    const r = run()
    assert.equal(r.code, 1, r.out + r.err)
    assert.ok(r.out.includes('整体删除'))
    git(['checkout', '--', 'test/a.test.mjs'])
  })

  it('重命名并删除断言：仍能检出（退出 1）', () => {
    fs.renameSync(path.join(repo, 'test', 'a.test.mjs'), path.join(repo, 'test', 'a2.test.mjs'))
    fs.writeFileSync(path.join(repo, 'test', 'a2.test.mjs'), TEST_FILE.replace(["  assert.deepEqual(out, [1, 2])", ""].join(String.fromCharCode(10)), ''))
    git(['add', '-A'])
    const r = run()
    assert.equal(r.code, 1, r.out + r.err)
    git(['reset', '-q'])
    fs.rmSync(path.join(repo, 'test', 'a2.test.mjs'))
    git(['checkout', '--', 'test/a.test.mjs'])
  })

  it('不在 Git 仓库时明确 SKIP', () => {
    const plain = path.join(sandbox, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    const r = run(plain)
    assert.equal(r.code, 0)
    assert.ok(r.out.includes('SKIP'))
  })
})