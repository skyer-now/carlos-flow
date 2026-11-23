// Windows 原子写回归：rename 被 Defender/索引器短暂占用（EBUSY/EPERM/EACCES）
// 时必须重试而不是直接失败；不可重试错误必须立刻上抛；失败不留临时文件。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-atomic-'))
const { writeFileAtomic, writeJsonAtomic } = await import('../src/fs-atomic.js')

after(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

function withRenameFault(faults, fn) {
  const real = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => {
    calls++
    if (calls <= faults) {
      const error = Object.assign(new Error('模拟占用'), { code: calls === 1 ? 'EBUSY' : 'EPERM' })
      throw error
    }
    return real(from, to)
  }
  try {
    return fn()
  } finally {
    fs.renameSync = real
  }
}

describe('Windows · 原子写重试', () => {
  it('rename 前两次 EBUSY/EPERM 后成功', () => {
    const file = path.join(sandbox, 'retry', 'a.json')
    const res = withRenameFault(2, () => writeJsonAtomic(file, { ok: true }))
    assert.equal(res.ok, true)
    assert.equal(res.attempts, 3, '应重试到第 3 次')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true })
  })

  it('不可重试错误立即上抛，且不留临时文件', () => {
    const dir = path.join(sandbox, 'fatal')
    const file = path.join(dir, 'b.json')
    const real = fs.renameSync
    fs.renameSync = () => { throw Object.assign(new Error('磁盘错误'), { code: 'EIO' }) }
    let error
    try { writeJsonAtomic(file, { a: 1 }) } catch (e) { error = e } finally { fs.renameSync = real }
    assert.equal(error && error.code, 'EIO')
    const left = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    assert.deepEqual(left, [], '失败后不得留下临时文件')
  })

  it('目标目录不存在时自动创建', () => {
    const file = path.join(sandbox, 'nested', 'deep', 'c.txt')
    writeFileAtomic(file, 'hello')
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello')
  })

  it('覆盖已有文件是原子替换，不产生半写内容', () => {
    const file = path.join(sandbox, 'replace.txt')
    fs.writeFileSync(file, 'old')
    writeFileAtomic(file, 'new-content')
    assert.equal(fs.readFileSync(file, 'utf8'), 'new-content')
    const leftovers = fs.readdirSync(sandbox).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})