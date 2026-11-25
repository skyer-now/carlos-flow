// 会话身份（session_context）回归测试。
//
// 背景：插件 ghost.json 声明 "sessionContext": true，宿主会在 tool-call 时把
// 宿主铸造的上下文注入 args.session_context；main.js 已把它转成 carlosContext 交给
// 随包 Node 服务。但 Node 侧只读 args.sessionId，于是调用方不手填 sessionId 时，
// 所有门禁状态都落到 'unknown' 名下：卡片、审计流水、验证回执互相看不见，
// quote 锚点也找不到原话，留痕直接被拒。
//
// 覆盖：
//   · 只给 carlosContext → 采用上下文的 session_id；
//   · 显式 sessionId 与上下文冲突 → 显式优先，不被覆盖；
//   · 两者都没有 → 仍是 'unknown'（保持向后兼容的默认语义）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMcpClient } from './_mcp-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'src', 'index.js')
const workdir = path.join(here, '..')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-session-context-'))
const flowHome = path.join(home, 'flow')

let client

before(async () => {
  client = startMcpClient({
    entry,
    cwd: workdir,
    surface: 'legacy',
    env: { CARLOS_FLOW_HOME: flowHome },
  })
  await client.initialize()
})

after(async () => {
  try { await client.close() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const sessionIdOf = (res) => {
  const text = res?.result?.content?.[0]?.text || ''
  const parsed = JSON.parse(text)
  return parsed.sessionId
}

const status = (args, carlosContext) =>
  client.request('tools/call', {
    name: 'flow_status',
    arguments: args,
    carlosContext,
  })

describe('会话身份 · session_context 补位', () => {
  it('只给宿主上下文时采用上下文的 session_id', async () => {
    const res = await status(
      { cwd: workdir },
      { session_id: 'ctx-from-host', workdir, workdir_is_local: true, workdir_is_read_only: false },
    )
    assert.equal(sessionIdOf(res), 'ctx-from-host')
  })

  it('显式 sessionId 优先，不被上下文覆盖', async () => {
    const res = await status(
      { cwd: workdir, sessionId: 'explicit-sid' },
      { session_id: 'ctx-from-host', workdir, workdir_is_local: true, workdir_is_read_only: false },
    )
    assert.equal(sessionIdOf(res), 'explicit-sid')
  })

  it('两者都没有时仍为 unknown（默认语义不变）', async () => {
    const res = await status({ cwd: workdir }, undefined)
    assert.equal(sessionIdOf(res), 'unknown')
  })

  it('空字符串上下文不补位（避免伪造空身份）', async () => {
    const res = await status(
      { cwd: workdir },
      { session_id: '', workdir, workdir_is_local: true, workdir_is_read_only: false },
    )
    assert.equal(sessionIdOf(res), 'unknown')
  })
})