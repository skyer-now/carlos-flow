import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { startMcpClient } from './_mcp-client.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-progress-'))
const work = path.join(home, 'work')
fs.mkdirSync(work)

const client = startMcpClient({
  entry: path.join(root, 'src/index.js'),
  cwd: work,
  env: {
    CARLOS_FLOW_HOME: home,
    CARLOS_PROGRESS_INTERVAL_MS: '200', // 缩短心跳周期用于快速精确断言
  },
})

// 监听客户端底层接收到的所有 jsonrpc 消息（含通知）
const receivedNotifications = []
client.onMessage = (msg) => {
  if (msg && msg.method === 'notifications/progress') {
    receivedNotifications.push(msg)
  }
}

try {
  await client.initialize()

  // 1. 无 Token 测试：常规请求不发任何 notifications/progress
  const script1 = path.join(work, 'task-no-token.mjs')
  fs.writeFileSync(script1, 'setTimeout(() => { console.log("OK_NO_TOKEN"); }, 500);')
  const sid1 = 'sid-no-token'
  await client.request('tools/call', { name: 'flow_add_user_msg', arguments: { sessionId: sid1, text: '无token测试' } }, 10000)
  await client.request('tools/call', {
    name: 'flow_submit_requirement',
    arguments: {
      sessionId: sid1,
      goal: '无token测试',
      quote: '无token测试',
      scope: [path.basename(script1)],
      acceptance: ['完成'],
      verify: { cmd: `node "${script1}"` },
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  receivedNotifications.length = 0
  const res1 = await client.request('tools/call', {
    name: 'flow_run_verify',
    arguments: { sessionId: sid1, cwd: work },
  }, 10000)
  assert.equal(res1.error, undefined)
  assert.equal(receivedNotifications.length, 0, '无 Token 时不应产生任何 progress 通知')

  // 2. 字符串 Token 测试：成功捕获 progress 通知
  const script2 = path.join(work, 'task-string-token.mjs')
  fs.writeFileSync(script2, 'setTimeout(() => { console.log("OK_STR_TOKEN"); }, 600);')
  const sid2 = 'sid-str-token'
  await client.request('tools/call', { name: 'flow_add_user_msg', arguments: { sessionId: sid2, text: '字符串token测试' } }, 10000)
  await client.request('tools/call', {
    name: 'flow_submit_requirement',
    arguments: {
      sessionId: sid2,
      goal: '字符串token测试',
      quote: '字符串token测试',
      scope: [path.basename(script2)],
      acceptance: ['完成'],
      verify: { cmd: `node "${script2}"` },
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  receivedNotifications.length = 0
  const res2 = await client.request('tools/call', {
    name: 'flow_run_verify',
    arguments: { sessionId: sid2, cwd: work },
    _meta: { progressToken: 'tok-abc-123' },
  }, 10000)
  assert.equal(res2.error, undefined)
  assert.ok(receivedNotifications.length >= 1, '带字符串 Token 应该收到至少 1 次 progress 通知')
  assert.equal(receivedNotifications[0].params.progressToken, 'tok-abc-123')
  assert.match(receivedNotifications[0].params.message, /验证命令运行中/)

  // 3. 数字 Token 0 边界测试：0 不被视作 falsy 丢弃
  const script3 = path.join(work, 'task-zero-token.mjs')
  fs.writeFileSync(script3, 'setTimeout(() => { console.log("OK_ZERO_TOKEN"); }, 600);')
  const sid3 = 'sid-zero-token'
  await client.request('tools/call', { name: 'flow_add_user_msg', arguments: { sessionId: sid3, text: '0token测试' } }, 10000)
  await client.request('tools/call', {
    name: 'flow_submit_requirement',
    arguments: {
      sessionId: sid3,
      goal: '0token测试',
      quote: '0token测试',
      scope: [path.basename(script3)],
      acceptance: ['完成'],
      verify: { cmd: `node "${script3}"` },
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  receivedNotifications.length = 0
  const res3 = await client.request('tools/call', {
    name: 'flow_run_verify',
    arguments: { sessionId: sid3, cwd: work },
    _meta: { progressToken: 0 },
  }, 10000)
  assert.equal(res3.error, undefined)
  assert.ok(receivedNotifications.length >= 1, 'Token 为 0 时应该收到至少 1 次 progress 通知')
  assert.equal(receivedNotifications[0].params.progressToken, 0)

  // 4. 定时器即时清理测试（成功完成 vs 失败报错）
  // 4.1 成功完成后不再产生后续通知
  const countAfterSuccess = receivedNotifications.length
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(receivedNotifications.length, countAfterSuccess, '命令成功完成后定时器应立即销毁，不产生后续通知')

  // 4.2 命令执行失败后立即停止定时器
  const script4 = path.join(work, 'task-fail-token.mjs')
  fs.writeFileSync(script4, 'setTimeout(() => { process.exit(2); }, 500);')
  const sid4 = 'sid-fail-token'
  await client.request('tools/call', { name: 'flow_add_user_msg', arguments: { sessionId: sid4, text: '失败token测试' } }, 10000)
  await client.request('tools/call', {
    name: 'flow_submit_requirement',
    arguments: {
      sessionId: sid4,
      goal: '失败token测试',
      quote: '失败token测试',
      scope: [path.basename(script4)],
      acceptance: ['完成'],
      verify: { cmd: `node "${script4}"` },
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  receivedNotifications.length = 0
  const res4 = await client.request('tools/call', {
    name: 'flow_run_verify',
    arguments: { sessionId: sid4, cwd: work },
    _meta: { progressToken: 'tok-fail-test' },
  }, 10000)
  assert.equal(res4.error, undefined)
  assert.ok(receivedNotifications.length >= 1, '执行失败命令期间仍能收到心跳')
  const countAfterFail = receivedNotifications.length
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(receivedNotifications.length, countAfterFail, '命令失败退出后定时器应立即销毁，不产生后续通知')

  // 5. 门面入口 carlos_verify 同样支持 _meta 透传
  receivedNotifications.length = 0
  const res5 = await client.request('tools/call', {
    name: 'carlos_verify',
    arguments: { action: 'run', sessionId: sid2, cwd: work },
    _meta: { progressToken: 'facade-token' },
  }, 10000)
  assert.equal(res5.error, undefined)
  assert.ok(receivedNotifications.length >= 1, '经门面 carlos_verify 同样能正常触发 progress 通知')
  assert.equal(receivedNotifications[0].params.progressToken, 'facade-token')

  console.log('COMM_PROGRESS_OK')
} finally {
  await client.close()
}
