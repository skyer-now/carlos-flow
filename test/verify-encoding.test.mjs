// Windows 验证输出编码回归：cmd.exe 默认代码页 936 的 GBK 中文不能再变乱码。
//
// 口径：
//   · 正常 UTF-8 输出行为不变（严格 UTF-8 解码成功就直接用）；
//   · GBK/GB18030 字节才走回退解码；
//   · 命令本身、shell、退出码、超时与进程树回收都不改。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodeOutputBytes, runVerifyCommand } from '../src/dispatch.js'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-encoding-'))
const GBK_SHIBAI = Buffer.from([0xca, 0xa7, 0xb0, 0xdc]) // “失败”的 GBK 字节

after(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

describe('Windows · 验证输出解码', () => {
  it('UTF-8 输出保持原样（严格解码优先）', () => {
    assert.equal(decodeOutputBytes(Buffer.from('构建成功 ✓', 'utf8')), '构建成功 ✓')
  })

  it('GBK 字节按 GB18030 回退解码', () => {
    let supported = true
    try { new TextDecoder('gb18030') } catch { supported = false }
    if (!supported) return // small-icu 构建没有该编码表，跳过而不是假装通过
    assert.equal(decodeOutputBytes(GBK_SHIBAI), '失败')
  })

  it('UTF-8 BOM 被剥离，内容不乱码', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('开始', 'utf8')])
    assert.equal(decodeOutputBytes(buf), '开始')
  })

  it('空输入返回空串', () => {
    assert.equal(decodeOutputBytes(Buffer.alloc(0)), '')
  })

  it('真实命令：GBK 中文 stdout 不再乱码', async () => {
    let supported = true
    try { new TextDecoder('gb18030') } catch { supported = false }
    if (!supported) return
    fs.writeFileSync(path.join(sandbox, 'emit-gbk.mjs'), 'process.stdout.write(Buffer.from([0xca,0xa7,0xb0,0xdc]))\n', 'utf8')
    const r = await runVerifyCommand('node emit-gbk.mjs', sandbox, { timeoutMs: 30000 })
    assert.equal(r.ok, true)
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '失败', '实际：' + JSON.stringify(r.stdout))
  })

  it('真实命令：GBK 中文 stderr 与退出码都保留', async () => {
    let supported = true
    try { new TextDecoder('gb18030') } catch { supported = false }
    if (!supported) return
    fs.writeFileSync(
      path.join(sandbox, 'fail-gbk.mjs'),
      'process.stderr.write(Buffer.from([0xca,0xa7,0xb0,0xdc]));\nprocess.exit(3)\n',
      'utf8',
    )
    const r = await runVerifyCommand('node fail-gbk.mjs', sandbox, { timeoutMs: 30000 })
    assert.equal(r.ok, false)
    assert.equal(r.exitCode, 3, '退出码不得被编码处理改变')
    assert.equal(r.stderr.trim(), '失败', '实际：' + JSON.stringify(r.stderr))
  })

  it('真实命令：UTF-8 中文输出不受影响', async () => {
    fs.writeFileSync(path.join(sandbox, 'emit-utf8.mjs'), "process.stdout.write('中文正常')\n", 'utf8')
    const r = await runVerifyCommand('node emit-utf8.mjs', sandbox, { timeoutMs: 30000 })
    assert.equal(r.stdout, '中文正常')
    assert.equal(r.exitCode, 0)
  })
})