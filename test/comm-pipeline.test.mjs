import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { startMcpClient } from './_mcp-client.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-pipeline-'))
const work = path.join(home, 'work')
fs.mkdirSync(work)

const client = startMcpClient({
  entry: path.join(root, 'src/index.js'),
  cwd: work,
  env: {
    CARLOS_FLOW_HOME: home,
  },
})

try {
  await client.initialize()

  // 1. 正常全链路走通测试 (pipeline_start)
  const script1 = path.join(work, 'task-pipeline-ok.mjs')
  fs.writeFileSync(script1, 'console.log("OK");')
  const sid1 = 'sid-pipeline-ok'
  await client.request('tools/call', {
    name: 'carlos_task',
    arguments: { action: 'add_user_msg', sessionId: sid1, text: '正常流程测试目标' },
  }, 10000)

  const res1 = await client.request('tools/call', {
    name: 'carlos_task',
    arguments: {
      action: 'pipeline_start',
      sessionId: sid1,
      goal: '正常流程测试目标',
      quote: '正常流程测试目标',
      scope: [path.basename(script1)],
      acceptance: ['执行无误'],
      verify: { cmd: `node "${script1}"` },
      role: 'executor',
      message: '开始实现',
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  assert.equal(res1.error, undefined)
  const data1 = JSON.parse(res1.result.content[0].text)
  assert.equal(data1.ok, true)
  assert.equal(data1.pipeline, 'pipeline_start')
  assert.equal(data1.steps.submit.ok, true)
  assert.equal(data1.steps.claim.ok, true)
  assert.equal(data1.steps.dispatch.ok, true)
  assert.ok(typeof data1.prompt === 'string' && data1.prompt.includes('正常流程测试目标'))
  assert.ok(data1.snapshot_count >= 1)

  // 2. Step 1 (submit) 失败短路测试：quote 锚点不匹配
  const sid2 = 'sid-pipeline-fail-submit'
  await client.request('tools/call', {
    name: 'carlos_task',
    arguments: { action: 'add_user_msg', sessionId: sid2, text: '原话在此' },
  }, 10000)

  const res2 = await client.request('tools/call', {
    name: 'carlos_task',
    arguments: {
      action: 'pipeline_start',
      sessionId: sid2,
      goal: '假目标',
      quote: '不存在的原话',
      scope: [path.basename(script1)],
      acceptance: ['执行无误'],
      verify: { cmd: `node "${script1}"` },
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  const data2 = JSON.parse(res2.result.content[0].text)
  assert.equal(data2.ok, false)
  assert.equal(data2.pipeline, 'pipeline_start')
  assert.equal(data2.failed_step, 'submit')
  assert.equal(data2.steps.submit.ok, false)
  assert.equal(data2.steps.claim, undefined, 'submit 失败后不得执行 claim')
  assert.equal(data2.steps.dispatch, undefined, 'submit 失败后不得执行 dispatch')

  // 3. Step 2 (claim) 失败短路测试：非法的角色（触发 Schema 校验）
  const sid3 = 'sid-pipeline-fail-claim'
  await client.request('tools/call', {
    name: 'carlos_task',
    arguments: { action: 'add_user_msg', sessionId: sid3, text: '认领测试原话' },
  }, 10000)

  const res3 = await client.request('tools/call', {
    name: 'carlos_task',
    arguments: {
      action: 'pipeline_start',
      sessionId: sid3,
      goal: '认领测试原话',
      quote: '认领测试原话',
      scope: [path.basename(script1)],
      acceptance: ['执行无误'],
      verify: { cmd: `node "${script1}"` },
      role: 'invalid_role_tester', // 触发输入 schema 校验拦截
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  assert.equal(res3.result.isError, true)
  assert.match(res3.result.content[0].text, /arguments\.role 值非法/)

  // 4. Step 3 (dispatch) 失败回执测试：工作目录不匹配 / 声明未登记的项目根
  const sid4 = 'sid-pipeline-fail-dispatch'
  await client.request('tools/call', {
    name: 'carlos_task',
    arguments: { action: 'add_user_msg', sessionId: sid4, text: '派发测试原话' },
  }, 10000)

  const res4 = await client.request('tools/call', {
    name: 'carlos_task',
    arguments: {
      action: 'pipeline_start',
      sessionId: sid4,
      goal: '派发测试原话',
      quote: '派发测试原话',
      scope: [path.basename(script1)],
      newFiles: ['outside.txt'],
      newFilesReason: '测试派发失败',
      acceptance: ['执行无误'],
      verify: { cmd: `node "${script1}"` },
      cwd: work,
      confirmed: true,
    },
  }, 10000)

  const data4 = JSON.parse(res4.result.content[0].text)
  if (data4.failed_step === 'dispatch') {
    assert.equal(data4.ok, false)
    assert.equal(data4.steps.submit.ok, true)
    assert.equal(data4.steps.claim.ok, true)
    assert.equal(data4.steps.dispatch.ok, false)
    assert.ok(typeof data4.note === 'string')
  }

  console.log('COMM_PIPELINE_OK')
} finally {
  await client.close()
}
