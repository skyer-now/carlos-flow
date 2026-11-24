import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startMcpClient } from './_mcp-client.mjs'
import { presentVerifyOutput, pruneArtifacts, VERIFY_SUMMARY_BYTES } from '../src/verify-output.js'
import { computeOutputHash } from '../src/dispatch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-output-'))
const work = path.join(home, 'work')
fs.mkdirSync(work)
const client = startMcpClient({
  entry: path.join(root, 'src/index.js'),
  cwd: work,
  env: { CARLOS_FLOW_HOME: home },
})
const hash = (s) => createHash('sha256').update(s).digest('hex')
const measurements = []

const tool = async (name, args) => {
  const rpc = await client.request('tools/call', { name, arguments: args }, 60000)
  assert.equal(rpc.error, undefined)
  return { rpc, data: JSON.parse(rpc.result.content[0].text) }
}

try {
  await client.initialize()

  // 1. 小输出与超大输出样本测试
  for (const [name, out, err] of [
    ['small', 'ok中文😀\n', 'warning\n'],
    ['large-synthetic', 'A'.repeat(600000), 'E'.repeat(600000)],
    ['unicode-single-line-synthetic', '中文😀'.repeat(80000), '错误😀'.repeat(80000)],
    ['upstream-cap-synthetic', 'X'.repeat(2000000), 'Z'.repeat(2000000)],
  ]) {
    const script = path.join(work, `${name}.mjs`)
    fs.writeFileSync(
      script,
      `process.stdout.write(${JSON.stringify(out)});process.stderr.write(${JSON.stringify(err)});`,
    )
    const sid = name
    assert.equal((await tool('flow_add_user_msg', { sessionId: sid, text: '通信测试' })).data.ok, true)
    assert.equal(
      (
        await tool('flow_submit_requirement', {
          sessionId: sid,
          goal: '通信测试',
          quote: '通信测试',
          scope: [path.basename(script)],
          acceptance: ['运行'],
          verify: { cmd: `node "${script}"` },
          cwd: work,
          confirmed: true,
        })
      ).data.ok,
      true,
    )
    const { rpc, data } = await tool('flow_run_verify', { sessionId: sid, cwd: work })
    assert.equal(data.exitCode, 0)
    const state = JSON.parse(fs.readFileSync(path.join(home, 'gate-state', 'runs', sid, 'state.json')))

    if (name === 'small') {
      assert.equal(data.stdout, out)
      assert.equal(data.stderr, err)
      assert.equal(data.output_metadata.truncated, false)
      assert.equal(data.output_metadata.artifact, null)
      assert.equal(state.last_verify.output_hash, computeOutputHash(0, out, err))
      continue
    }

    assert.equal(data.output_metadata.truncated, true)
    for (const key of ['stdout', 'stderr']) {
      assert.ok(Buffer.byteLength(data[key], 'utf8') <= VERIFY_SUMMARY_BYTES)
    }
    assert.ok(!data.stdout.includes('\ufffd'))
    const meta = data.output_metadata
    const artifact = fs.readFileSync(meta.artifact.path, 'utf8')
    assert.equal(hash(artifact), meta.artifact.sha256)
    const available = JSON.parse(artifact)
    assert.equal(meta.original_complete, false)
    assert.equal(meta.upstream_truncated, true)
    assert.equal(state.last_verify.output_hash, computeOutputHash(0, available.stdout, available.stderr))
    assert.equal(meta.evidence_output_hash, state.last_verify.output_hash)

    const old = {
      ok: data.ok,
      exitCode: data.exitCode,
      stdout: available.stdout,
      stderr: available.stderr,
      cwd: data.cwd,
    }
    const oldRpc = { ...rpc, result: { content: [{ type: 'text', text: JSON.stringify(old, null, 2) }] } }
    const oldBytes = Buffer.byteLength(JSON.stringify(oldRpc))
    const newBytes = Buffer.byteLength(JSON.stringify(rpc))
    assert.ok(newBytes < oldBytes)
    measurements.push({
      name,
      old_rpc_json_bytes: oldBytes,
      new_rpc_json_bytes: newBytes,
      evidence_hash: state.last_verify.output_hash,
      artifact_sha256: meta.artifact.sha256,
    })
  }

  // 2. 存储故障回退测试：基础目录被占用，状态仍正常提交且回退原输出
  const base = path.join(home, 'verify-output')
  const moved = base + '-saved'
  fs.renameSync(base, moved)
  fs.writeFileSync(base, 'blocked')
  const failed = (await tool('flow_run_verify', { sessionId: 'large-synthetic', cwd: work })).data
  assert.match(failed.output_warning, /保留原始返回输出/)
  assert.equal(failed.output_metadata.truncated, false)
  assert.equal(failed.output_metadata.artifact.available, false)
  assert.ok(Buffer.byteLength(failed.stdout, 'utf8') > VERIFY_SUMMARY_BYTES)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'gate-state', 'runs', 'large-synthetic', 'state.json')))
  assert.equal(saved.last_verify.output_hash, computeOutputHash(0, failed.stdout, failed.stderr))
  fs.unlinkSync(base)
  fs.renameSync(moved, base)

  // 3. 越界路径防御：符号链接/Junction 基础目录必须被拦截
  const unsafe = path.join(home, 'unsafe')
  fs.mkdirSync(unsafe)
  fs.symlinkSync(work, path.join(unsafe, 'verify-output'), process.platform === 'win32' ? 'junction' : 'dir')
  const input = { ok: true, exitCode: 0, stdout: 'a'.repeat(10000), stderr: '' }
  const refused = await presentVerifyOutput(input, {
    flowHome: unsafe,
    sessionId: '../../escape',
    outputHash: 'test',
  })
  assert.equal(refused.stdout, input.stdout)
  assert.match(refused.output_warning, /不安全/)
  assert.equal(fs.existsSync(path.join(work, 'available-output.json')), false)

  // 4. 清理逻辑专项测试：超过保留数量或过期目录自动清理
  const cleanBase = path.join(home, 'clean-test-base')
  fs.mkdirSync(cleanBase)
  for (let i = 0; i < 35; i++) {
    const sub = path.join(cleanBase, `dir-${i}`)
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'test.txt'), 'data')
  }
  const cleanRes = pruneArtifacts(cleanBase, { keep: 30 })
  assert.equal(cleanRes.removed, 5)
  assert.equal(cleanRes.kept, 30)

  console.log(
    JSON.stringify(
      { measurements, scope: '合成压测样本（仅作输出保护与摘要测量）' },
      null,
      2,
    ),
  )
  console.log('COMM_OUTPUT_OK')
} finally {
  await client.close()
}
