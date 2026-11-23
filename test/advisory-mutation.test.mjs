// 互审机制变异测试（P1 质量门禁）
//
// 目的：验证测试套件对互审核心逻辑（证据绑定、过期拦截、轴完整性、预算降级）具备真实判别力，
// 任何关键安全检查被静默移除/放宽时，测试必须能够捕获（变异体被消灭，即跑单测返回失败 exitCode !== 0）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const cwd = path.resolve(import.meta.dirname, '..')

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src)
  const stats = exists && fs.statSync(src)
  const isDirectory = exists && stats.isDirectory()
  if (isDirectory) {
    fs.mkdirSync(dest, { recursive: true })
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName))
    })
  } else {
    fs.copyFileSync(src, dest)
  }
}

function runTestWithMutatedFile(relativePath, mutatedContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-adv-mut-'))
  try {
    // 复制整个项目核心目录与文件，避免 ESM 解析缺少依赖目录（如 ui/）
    copyRecursiveSync(path.join(cwd, 'src'), path.join(tmpDir, 'src'))
    copyRecursiveSync(path.join(cwd, 'test'), path.join(tmpDir, 'test'))
    if (fs.existsSync(path.join(cwd, 'ui'))) {
      copyRecursiveSync(path.join(cwd, 'ui'), path.join(tmpDir, 'ui'))
    }
    fs.copyFileSync(path.join(cwd, 'package.json'), path.join(tmpDir, 'package.json'))

    // 覆盖变异目标文件
    fs.writeFileSync(path.join(tmpDir, relativePath), mutatedContent, 'utf8')

    const res = spawnSync(process.execPath, ['--test', 'test/advisory.test.mjs'], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, CARLOS_FLOW_HOME: path.join(tmpDir, 'cf-home') },
      timeout: 30000,
    })

    return {
      passed: res.status === 0,
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

describe('互审机制变异测试（Mutation Testing）', () => {
  const originalAdvisory = fs.readFileSync(path.join(cwd, 'src', 'advisory.js'), 'utf8')
  const originalHandler = fs.readFileSync(path.join(cwd, 'src', 'handlers', 'advisory.js'), 'utf8')

  it('基线：未修改的源码必须通过全部单测', () => {
    const res = runTestWithMutatedFile('src/advisory.js', originalAdvisory)
    assert.equal(res.passed, true, '基线测试应该通过: ' + res.stderr + '\n' + res.stdout)
  })

  it('变异体 1：移除未绑定证据的声明拦截 -> 必须被测试抓出 (变异体被消灭)', () => {
    const mutated = originalHandler.replace(
      /if \(unbound\.length\) problems\.push\('声明没有证据引用：' \+ unbound\.join\('；'\)\)/g,
      '/* bypass unbound check */'
    )
    assert.notEqual(mutated, originalHandler, '必须成功注入变异')
    const res = runTestWithMutatedFile('src/handlers/advisory.js', mutated)
    assert.equal(res.passed, false, '变异体 1 必须导致测试套件失败')
  })

  it('变异体 2：移除 guard 中的过期拦截 -> 必须被测试抓出 (变异体被消灭)', () => {
    const mutated = originalHandler.replace(
      /if \(advisoryIsExpired\(advisory\)\) \{[\s\S]*?return fail\('advisory 已过期[\s\S]*?'\)\s*\}/g,
      '/* bypass expiry check */'
    )
    assert.notEqual(mutated, originalHandler, '必须成功注入变异')
    const res = runTestWithMutatedFile('src/handlers/advisory.js', mutated)
    assert.equal(res.passed, false, '变异体 2 必须导致测试套件失败')
  })

  it('变异体 3：移除 guard 中的缺失轴拦截 -> 必须被测试抓出 (变异体被消灭)', () => {
    const mutated = originalHandler.replace(
      /if \(missing\.length\) problems\.push\('缺少轴结论：' \+ missing\.join\(', '\)\)/g,
      '/* bypass missing check */'
    )
    assert.notEqual(mutated, originalHandler, '必须成功注入变异')
    const res = runTestWithMutatedFile('src/handlers/advisory.js', mutated)
    assert.equal(res.passed, false, '变异体 3 必须导致测试套件失败')
  })

  it('变异体 4：移除双审预算超限降级逻辑 -> 必须被测试抓出 (变异体被消灭)', () => {
    const mutated = originalAdvisory.replace(
      /countDual\(log, now - DUAL_BUDGET_WINDOW_MS\) >= DUAL_BUDGET_MAX/g,
      'false'
    )
    assert.notEqual(mutated, originalAdvisory, '必须成功注入变异')
    const res = runTestWithMutatedFile('src/advisory.js', mutated)
    assert.equal(res.passed, false, '变异体 4 必须导致测试套件失败')
  })
})
