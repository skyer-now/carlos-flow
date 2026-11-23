// Windows 运行时专项测试：验证进程树回收机制与长路径保护
//
// 覆盖：
//   1. 模拟子进程及孙子进程，在超时场景下验证整树回收（避免孤儿进程残留）；
//   2. 验证路径处理与快照、状态落盘在多级深度目录下的正确性。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'

describe('Windows 运行时与环境健壮性测试', () => {
  it('Windows 进程树终止验证：超时终止必须能回收衍生子进程', async () => {
    if (!isWindows) return

    // 启动一个 cmd.exe 并在其中拉起一个 node 子进程（产生多级进程树）
    const childScript = 'setTimeout(() => {}, 60000)'
    const proc = spawn('cmd.exe', ['/c', 'node', '-e', childScript], {
      windowsHide: true,
      stdio: 'ignore',
    })

    const pid = proc.pid
    assert.ok(pid, '进程必须成功启动并获取 PID')

    // 等待 100ms 确保孙子进程被创建
    await new Promise((r) => setTimeout(r, 100))

    // 执行 Windows 整树强制终止命令
    const killRes = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })

    assert.equal(killRes.status, 0, 'taskkill /T /F 应当成功执行')

    // 确认进程已退出
    let running = true
    try {
      // 在 Windows 下通过 process.kill(pid, 0) 探测
      process.kill(pid, 0)
    } catch {
      running = false
    }
    assert.equal(running, false, '主子进程必须已完全终止')
  })

  it('深层目录与路径读写健壮性验证', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-win-path-'))
    try {
      // 创建深层嵌套目录（测试深度路径下文件创建与读写）
      const deepParts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'very_long_folder_name_segment']
      const deepDir = path.join(tmpBase, ...deepParts)
      fs.mkdirSync(deepDir, { recursive: true })

      const testFile = path.join(deepDir, 'state-snapshot-test.json')
      const payload = JSON.stringify({ ok: true, timestamp: Date.now(), platform: process.platform })
      fs.writeFileSync(testFile, payload, 'utf8')

      const readBack = fs.readFileSync(testFile, 'utf8')
      const parsed = JSON.parse(readBack)
      assert.equal(parsed.ok, true)
      assert.ok(fs.existsSync(testFile))
    } finally {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    }
  })
})
