import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startMcpClient } from './_mcp-client.mjs'
import { presentVerifyOutput, pruneArtifacts, VERIFY_SUMMARY_BYTES } from '../src/verify-output.js'
import childProcess from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
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
const runnerSamples = new Map()
const failureMeasurements = []
const faultMatrix = []

const tool = async (name, args) => {
  const rpc = await client.request('tools/call', { name, arguments: args }, 60000)
  assert.equal(rpc.error, undefined)
  return { rpc, data: JSON.parse(rpc.result.content[0].text) }
}

try {
  // 真正的子进程按单字节分片输出协议行，强制跨 UTF8 chunk。
  const fragmentEntry = path.join(work, 'unicode-fragments.mjs')
  fs.writeFileSync(fragmentEntry, `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', async line => {
 const req=JSON.parse(line); const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:req.id,result:'中文😀\\\\引号"'})+'\\n');
 for(const byte of bytes){process.stdout.write(Buffer.from([byte])); await new Promise(r=>setTimeout(r,2));}
});`)
  const fragmented = startMcpClient({ entry: fragmentEntry, cwd: work })
  try { assert.equal((await fragmented.request('分片')).result, '中文😀\\引号"'); assert.deepEqual(fragmented.noise, []) }
  finally { await fragmented.close() }
  await client.initialize()

  // 1. 小输出与超大输出样本测试
  for (const [name, out, err] of [
    ['small', 'ok中文😀\n', 'warning\n'],
    ['boundary-4096', 'A'.repeat(4096), 'E'.repeat(4096)],
    ['boundary-4097', 'A'.repeat(4097), 'E'.repeat(4097)],
    ['escape-controls', '\u0000\u0001\n\r\t"\\'.repeat(3000), '\u0000\u0002"\\'.repeat(3000)],
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

    if (name.startsWith('boundary-')) {
      assert.equal(data.output_metadata.presentation_ok, true)
      assert.equal(data.output_metadata.truncated, name === 'boundary-4097')
      if (name === 'boundary-4097') {
        assert.equal(data.output_metadata.available_runner_text_persisted, true)
        assert.equal(data.output_metadata.artifact.available, true)
      }
    }
    if (name === 'small' || name === 'boundary-4096') {
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
    if (name.startsWith('boundary-') || name === 'escape-controls') {
      assert.equal(available.stdout, out)
      assert.equal(available.stderr, err)
    }
    runnerSamples.set(name, available)
    assert.equal(meta.original_complete, false)
    assert.equal(meta.upstream_truncated, !name.startsWith('boundary-') && name !== 'escape-controls')
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
    if (!name.startsWith('boundary-')) assert.ok(newBytes < oldBytes)
    measurements.push({
      name,
      old_rpc_json_bytes: oldBytes,
      new_rpc_json_bytes: newBytes,
      evidence_hash: state.last_verify.output_hash,
      artifact_sha256: meta.artifact.sha256,
    })
  }

  // 2. 存储故障仍有界，证据绑定 runner 原文而不是展示摘要
  const base = path.join(home, 'verify-output')
  const moved = base + '-saved'
  fs.renameSync(base, moved)
  fs.writeFileSync(base, 'blocked')
  const failedCall = await tool('flow_run_verify', { sessionId: 'large-synthetic', cwd: work })
  const failed = failedCall.data
  assert.match(failed.output_warning, /未持久保存/)
  assert.equal(failed.output_metadata.truncated, true)
  assert.equal(failed.output_metadata.artifact.available, false)
  assert.equal(failed.output_metadata.presentation_ok, false)
  assert.equal(failed.exitCode, 0)
  assert.ok(Buffer.byteLength(failed.stdout, 'utf8') <= VERIFY_SUMMARY_BYTES)
  assert.ok(Buffer.byteLength(failed.stderr, 'utf8') <= VERIFY_SUMMARY_BYTES)
  // 转义膨胀只测真实 RPC，不把单流 4096 推导为总包 20k。
  const escapedFailure = await tool('flow_run_verify', { sessionId: 'escape-controls', cwd: work })
  assert.equal(escapedFailure.data.output_metadata.presentation_ok, false)
  assert.equal(escapedFailure.data.output_metadata.artifact.available, false)
  for (const key of ['stdout', 'stderr']) assert.ok(Buffer.byteLength(escapedFailure.data[key]) <= 4096)
  failureMeasurements.push({ name: '真实RPC：控制字符/NUL/引号/反斜杠保存失败', stdout_utf8_bytes: Buffer.byteLength(escapedFailure.data.stdout), stderr_utf8_bytes: Buffer.byteLength(escapedFailure.data.stderr), rpc_json_utf8_bytes: Buffer.byteLength(JSON.stringify(escapedFailure.rpc)) })
  assert.doesNotMatch(failed.stdout, /查阅|落盘工件/)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'gate-state', 'runs', 'large-synthetic', 'state.json')))
  assert.equal(saved.last_verify.output_hash, failed.output_metadata.evidence_output_hash)
  const runnerSample = runnerSamples.get('large-synthetic')
  assert.equal(failed.output_metadata.stdout.sha256, hash(runnerSample.stdout))
  assert.equal(failed.output_metadata.stderr.sha256, hash(runnerSample.stderr))
  assert.equal(saved.last_verify.output_hash, computeOutputHash(0, runnerSample.stdout, runnerSample.stderr))
  failureMeasurements.push({
    name: '真实RPC：工件基础目录被占用',
    stdout_utf8_bytes: Buffer.byteLength(failed.stdout),
    stderr_utf8_bytes: Buffer.byteLength(failed.stderr),
    rpc_json_utf8_bytes: Buffer.byteLength(JSON.stringify(failedCall.rpc)),
    artifact_error_utf8_bytes: Buffer.byteLength(failed.output_metadata.artifact.error),
    output_warning_utf8_bytes: Buffer.byteLength(failed.output_warning),
    evidence_hash_unchanged: failed.output_metadata.evidence_output_hash === computeOutputHash(0, runnerSample.stdout, runnerSample.stderr),
    stdout_sha_unchanged: failed.output_metadata.stdout.sha256 === hash(runnerSample.stdout),
    stderr_sha_unchanged: failed.output_metadata.stderr.sha256 === hash(runnerSample.stderr),
  })
  fs.unlinkSync(base)
  fs.renameSync(moved, base)

  // 3. 越界路径防御：符号链接/Junction 基础目录必须被拦截
  const unsafe = path.join(home, 'unsafe')
  fs.mkdirSync(unsafe)
  fs.symlinkSync(work, path.join(unsafe, 'verify-output'), process.platform === 'win32' ? 'junction' : 'dir')
  const sentinel = path.join(work, '并行目录')
  fs.mkdirSync(sentinel)
  fs.writeFileSync(path.join(sentinel, '保留.txt'), '并行工件')
  const input = { ok: true, exitCode: 0, stdout: 'a'.repeat(10000), stderr: '' }
  const refused = await presentVerifyOutput(input, {
    flowHome: unsafe,
    sessionId: '../../escape',
    outputHash: 'test',
  })
  assert.ok(Buffer.byteLength(refused.stdout, 'utf8') <= VERIFY_SUMMARY_BYTES)
  assert.match(refused.output_warning, /不安全/)
  assert.equal(fs.existsSync(path.join(work, 'available-output.json')), false)
  assert.equal(pruneArtifacts(path.join(unsafe, 'verify-output'), { keep: 0 }).kept, null)
  assert.equal(fs.readFileSync(path.join(sentinel, '保留.txt'), 'utf8'), '并行工件')

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

  // 31 次真实生成：当前工件可回读，最终严格保留 30 份。
  const retentionHome = path.join(home, 'retention')
  fs.mkdirSync(retentionHome)
  for (let i = 0; i < 31; i++) {
    const generated = await presentVerifyOutput(input, { flowHome: retentionHome, sessionId: 'retention', outputHash: 'test' })
    assert.equal(generated.output_metadata.artifact.available, true)
    assert.equal(JSON.parse(fs.readFileSync(generated.output_metadata.artifact.path, 'utf8')).stdout, input.stdout)
  }
  assert.equal(fs.readdirSync(path.join(retentionHome, 'verify-output')).length, 30, '31 次生成后不得残留 31 份')

  // 并发生成跨过 await ACL：任何正在写入的工件都不能被 prune 删除。
  const concurrent = await Promise.all(Array.from({ length: 31 }, (_, i) =>
    presentVerifyOutput(input, { flowHome: retentionHome, sessionId: `parallel-${i}`, outputHash: 'test' })))
  assert.ok(concurrent.every(r => r.output_metadata.artifact.available === true))
  assert.equal(fs.readdirSync(path.join(retentionHome, 'verify-output')).length, 30)

  // 首次清理失败后必须记住本进程确认失败的物理目录，恢复后不受活 PID 保护。
  for (const replace of [false, true]) {
    const retryHome = path.join(home, `cleanup-retry-${replace}`)
    fs.mkdirSync(retryHome)
    const rmBefore = fs.rmSync
    const fsyncBefore = fs.fsyncSync
    let leftover
    try {
      fs.fsyncSync = () => { throw new Error('写入失败') }
      fs.rmSync = () => { throw new Error('首次清理失败') }
      const failed = await presentVerifyOutput(input, { flowHome: retryHome, sessionId: 'retry', outputHash: 'test' })
      assert.ok(failed.output_metadata.cleanup_warning)
      const retryBase = path.join(retryHome, 'verify-output')
      leftover = path.join(retryBase, fs.readdirSync(retryBase)[0])
      const pending = pruneArtifacts(retryBase)
      assert.match(pending.warning, /失败|清理/)
      assert.ok(Buffer.byteLength(pending.warning) <= 1024)
    } finally { fs.rmSync = rmBefore; fs.fsyncSync = fsyncBefore }
    if (replace) {
      fs.renameSync(leftover, path.join(retryHome, '原目录'))
      fs.mkdirSync(leftover)
      fs.writeFileSync(path.join(leftover, '并行.txt'), '替换目录不得删除')
    }
    const retried = pruneArtifacts(path.join(retryHome, 'verify-output'), { keep: 0 })
    if (replace) {
      assert.equal(retried.removed, 0)
      assert.match(retried.warning, /身份|替换/)
      assert.equal(fs.readFileSync(path.join(leftover, '并行.txt'), 'utf8'), '替换目录不得删除')
    } else {
      assert.equal(retried.removed, 1)
      assert.equal(fs.existsSync(leftover), false)
      assert.equal(retried.kept, 0)
      assert.equal(retried.warning, undefined)
      assert.deepEqual(pruneArtifacts(path.join(retryHome, 'verify-output')), { removed: 0, kept: 0, unknown: 0, scan_failures: 0, cleanup_failures: 0 })
    }
    faultMatrix.push({ operation: replace ? '清理失败后路径替换：保守保留' : '首次清理失败→恢复→回收', passed: true })
  }

  assert.ok(concurrent.every(r => r.output_metadata.artifact.availability_scope === 'at_publication'))
  assert.ok(concurrent.every(r => r.output_metadata.artifact.retention_may_remove === true))
  const readableAfterRetention = concurrent.filter(r => fs.existsSync(r.output_metadata.artifact.path)).length
  assert.ok(readableAfterRetention <= 30, '发布时 available:true 不承诺 31 个结果在清理后仍同时可读')
  assert.ok(readableAfterRetention < concurrent.length)
  measurements.push({ name: '31并发发布的时点可用性', published_available: concurrent.length, exists_after_retention: readableAfterRetention, availability_scope: 'at_publication', retention_may_remove: true })

  // 持续 ACL 故障仍输出有界摘要，并回收本次确认失败的自有目录。
  const aclHome = path.join(home, 'acl-failures')
  fs.mkdirSync(aclHome)
  const originalSpawn = childProcess.spawn
  const originalChmod = fs.chmodSync
  try {
    if (process.platform === 'win32') {
      childProcess.spawn = () => {
        const child = new EventEmitter()
        child.kill = () => {}
        queueMicrotask(() => child.emit('close', 1))
        return child
      }
      syncBuiltinESMExports()
    } else {
      fs.chmodSync = () => { throw new Error('注入 ACL 失败') }
    }
    for (let i = 0; i < 35; i++) {
      const failedAcl = await presentVerifyOutput(input, { flowHome: aclHome, sessionId: 'acl', outputHash: 'test' })
      assert.equal(failedAcl.output_metadata.artifact.available, false)
      assert.ok(Buffer.byteLength(failedAcl.stdout, 'utf8') <= VERIFY_SUMMARY_BYTES)
      assert.match(failedAcl.output_warning, /ACL/)
      assert.equal(fs.readdirSync(path.join(aclHome, 'verify-output')).length, 0, 'ACL 失败不得积累空目录')
    }
  } finally {
    childProcess.spawn = originalSpawn
    fs.chmodSync = originalChmod
    syncBuiltinESMExports()
  }

  // 所有权随 mkdir 原子登记在目录名中；文件已 open 但未发布也必须保护。
  const ownersBase = path.join(home, 'owners')
  fs.mkdirSync(ownersBase)
  const liveOwner = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const liveExit = once(liveOwner, 'exit')
  const ownedDir = pid => path.join(ownersBase, `${'a'.repeat(64)}-${'b'.repeat(32)}-p${pid}`)
  try {
    const writing = ownedDir(liveOwner.pid)
    fs.mkdirSync(writing)
    assert.equal(pruneArtifacts(ownersBase, { keep: 0, maxAgeMs: 0, now: Date.now() + 1e12 }).removed, 0, '活进程空目录不可仅按年龄回收')
    const fd = fs.openSync(path.join(writing, 'available-output.json'), 'wx')
    try {
      fs.writeSync(fd, '{未写完')
      const protectedResult = pruneArtifacts(ownersBase, { keep: 0, maxAgeMs: 0, now: Date.now() + 1e12 })
      assert.equal(fs.existsSync(writing), true, '不能仅凭年龄或文件存在删除活进程未发布工件')
      assert.equal(protectedResult.removed, 0)
    } finally { fs.closeSync(fd) }
    liveOwner.kill()
    await liveExit
    assert.equal(pruneArtifacts(ownersBase).removed, 1, '确认死亡的未发布工件须立即回收')
    assert.equal(fs.existsSync(writing), false)
    fs.mkdirSync(writing)
    assert.equal(pruneArtifacts(ownersBase).removed, 1, '确认死亡的空目录也须回收')
    const unknown = path.join(ownersBase, `${'c'.repeat(64)}-${'d'.repeat(32)}`)
    fs.mkdirSync(unknown)
    const retained = pruneArtifacts(ownersBase, { keep: 0, maxAgeMs: 0, now: Date.now() + 1e12 })
    assert.equal(fs.existsSync(unknown), true)
    assert.equal(retained.unknown, 1, '未知归属必须报告保留风险')
    assert.match(retained.warning, /归属未知/)
    const riskHome = path.join(home, 'unknown-risk')
    fs.mkdirSync(path.join(riskHome, 'verify-output'), { recursive: true })
    fs.mkdirSync(path.join(riskHome, 'verify-output', path.basename(unknown)))
    const withRisk = await presentVerifyOutput(input, { flowHome: riskHome, sessionId: 'risk', outputHash: 'test' })
    assert.equal(withRisk.output_metadata.artifact.available, true)
    assert.equal(withRisk.output_metadata.retention.unknown, 1)
    assert.match(withRisk.output_warning, /归属未知/)
  } finally {
    if (liveOwner.exitCode === null && liveOwner.signalCode === null) { liveOwner.kill(); await liveExit }
  }

  // 无生产注入接口：临时 patch 内建 fs/spawn，验证异常不会突破展示边界。
  const hugeError = new Error('故障😀'.repeat(20000))
  for (const operation of ['openSync', 'writeFileSync', 'fsyncSync', 'readFileSync', 'readback-mismatch', 'closeSync', 'publish', 'cleanup', 'scan', 'stat', 'spawn', 'spawn-error']) {
    if (operation.startsWith('spawn') && process.platform !== 'win32') continue
    const faultHome = path.join(home, `fault-${operation}`)
    fs.mkdirSync(faultHome)
    const fault = new Error(hugeError.message)
    fault.code = 'ENOSPC'
    const savedFs = Object.fromEntries(['openSync', 'writeFileSync', 'fsyncSync', 'readFileSync', 'closeSync', 'rmSync', 'readdirSync', 'statSync'].map(k => [k, fs[k]]))
    const spawnBefore = childProcess.spawn
    try {
      const key = { publish: 'writeFileSync', 'readback-mismatch': 'readFileSync', cleanup: 'rmSync', scan: 'readdirSync', stat: 'statSync' }[operation] || operation
      if (operation === 'spawn') childProcess.spawn = () => { throw hugeError }
      else if (operation === 'spawn-error') childProcess.spawn = () => {
        const child = new EventEmitter()
        child.kill = () => {}
        queueMicrotask(() => child.emit('error', hugeError))
        return child
      }
      else fs[key] = (...args) => {
        if (operation === 'stat' && process.platform === 'win32' && path.dirname(String(args[0])) !== path.join(faultHome, 'verify-output')) return savedFs[key](...args)
        if (operation === 'readback-mismatch') return '校验不一致'
        if (operation === 'publish' && !String(args[0]).endsWith('.published')) return savedFs[key](...args)
        if (operation === 'closeSync') savedFs[key](...args)
        throw fault
      }
      if (operation === 'cleanup') fs.fsyncSync = () => { throw hugeError }
      syncBuiltinESMExports()
      const original = { ok: true, exitCode: 0, stdout: '中文😀'.repeat(10000), stderr: '短输出' }
      const evidence = computeOutputHash(0, original.stdout, original.stderr)
      const shown = await presentVerifyOutput(original, { flowHome: faultHome, sessionId: operation, outputHash: evidence })
      assert.equal(shown.ok, true)
      assert.equal(shown.exitCode, 0)
      assert.equal(shown.output_metadata.evidence_output_hash, evidence)
      for (const stream of ['stdout', 'stderr']) {
        assert.ok(Buffer.byteLength(shown[stream]) <= 4096, operation)
        assert.equal(shown.output_metadata[stream].sha256, hash(original[stream]))
      }
      assert.ok(Buffer.byteLength(shown.output_warning || '') <= 1024, operation)
      const retentionFault = operation === 'scan' || (operation === 'stat' && process.platform === 'win32')
      if (!retentionFault) {
        assert.equal(shown.output_metadata.presentation_ok, false, operation)
        assert.equal(shown.output_metadata.artifact.available, false)
        assert.ok(Buffer.byteLength(shown.output_metadata.artifact.error) <= 1024)
        assert.doesNotMatch(shown.stdout, /查阅|落盘工件/)
        assert.equal(shown.output_metadata.available_runner_text_persisted, false)
        assert.equal(shown.output_metadata.summary_content_loss, true)
      } else {
        assert.equal(shown.output_metadata.presentation_ok, true, operation)
        assert.equal(shown.output_metadata.artifact.available, true, operation)
        assert.equal(shown.output_metadata.available_runner_text_persisted, true, operation)
        const reread = JSON.parse(savedFs.readFileSync(shown.output_metadata.artifact.path, 'utf8'))
        assert.equal(reread.stdout, original.stdout)
        assert.equal(reread.stderr, original.stderr)
        if (operation === 'scan') {
          assert.equal(shown.output_metadata.retention.kept, null)
          assert.ok(shown.output_metadata.retention.error)
        } else {
          assert.equal(shown.output_metadata.retention.scan_failures, 1)
          assert.equal(shown.output_metadata.retention.kept, 1)
        }
        assert.ok(shown.output_metadata.retention.warning)
      }
      if (operation === 'cleanup') {
        assert.ok(shown.output_metadata.cleanup_warning)
        assert.ok(Buffer.byteLength(shown.output_metadata.cleanup_warning) <= 1024)
      }
      faultMatrix.push({
        operation, passed: true,
        stdout_utf8_bytes: Buffer.byteLength(shown.stdout),
        stderr_utf8_bytes: Buffer.byteLength(shown.stderr),
        result_json_utf8_bytes: Buffer.byteLength(JSON.stringify(shown)),
        artifact_error_utf8_bytes: Buffer.byteLength(shown.output_metadata.artifact.error || ''),
        output_warning_utf8_bytes: Buffer.byteLength(shown.output_warning || ''),
        cleanup_warning_utf8_bytes: Buffer.byteLength(shown.output_metadata.cleanup_warning || ''),
        retention_warning_utf8_bytes: Buffer.byteLength(shown.output_metadata.retention?.warning || ''),
        evidence_hash_unchanged: shown.output_metadata.evidence_output_hash === evidence,
        stdout_sha_unchanged: shown.output_metadata.stdout.sha256 === hash(original.stdout),
        stderr_sha_unchanged: shown.output_metadata.stderr.sha256 === hash(original.stderr),
      })
    } finally {
      Object.assign(fs, savedFs)
      childProcess.spawn = spawnBefore
      syncBuiltinESMExports()
    }
  }
  // 确定性替换：ACL 跨 await 与回读后发布前；普通目录也不能冒用身份。
  for (const stage of ['acl', 'publish', 'identity-error']) {
    const raceHome = path.join(home, `race-${stage}`)
    fs.mkdirSync(raceHome)
    const saved = { chmod: fs.chmodSync, read: fs.readFileSync, lstat: fs.lstatSync, spawn: childProcess.spawn }
    let replaced
    const replace = dir => {
      fs.renameSync(dir, path.join(raceHome, '原目录'))
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, '保留.txt'), '并行内容')
      replaced = dir
    }
    try {
      if (stage === 'acl') {
        if (process.platform === 'win32') childProcess.spawn = (...args) => {
          if (args[0] !== 'icacls.exe') return saved.spawn(...args)
          const child = new EventEmitter(); child.kill = () => {}
          queueMicrotask(() => { replace(args[1][0]); child.emit('close', 0) })
          return child
        }
        else fs.chmodSync = (...args) => { saved.chmod(...args); queueMicrotask(() => replace(args[0])) }
      } else if (stage === 'publish') fs.readFileSync = (...args) => {
        const value = saved.read(...args)
        if (String(args[0]).endsWith('available-output.json')) replace(path.dirname(args[0]))
        return value
      }
      else fs.lstatSync = (...args) => {
        if (args[1]?.bigint && path.dirname(String(args[0])) === path.join(raceHome, 'verify-output')) throw new Error('身份读取注入失败')
        return saved.lstat(...args)
      }
      syncBuiltinESMExports()
      const shown = await presentVerifyOutput(input, { flowHome: raceHome, sessionId: stage, outputHash: 'test' })
      assert.equal(shown.output_metadata.presentation_ok, false, stage)
      assert.equal(shown.output_metadata.artifact.available, false, stage)
      assert.equal(shown.output_metadata.available_runner_text_persisted, false, stage)
      if (replaced) {
        assert.equal(saved.read(path.join(replaced, '保留.txt'), 'utf8'), '并行内容')
        assert.equal(fs.existsSync(path.join(replaced, 'available-output.json')), false)
        assert.equal(fs.existsSync(path.join(replaced, '.published')), false)
      }
      faultMatrix.push({ operation: `身份门禁-${stage}`, passed: true })
    } finally { fs.chmodSync = saved.chmod; fs.readFileSync = saved.read; fs.lstatSync = saved.lstat; childProcess.spawn = saved.spawn; syncBuiltinESMExports() }
  }
  for (const stage of ['replace', 'identity-error', 'scan-identity-error']) {
    const raceBase = path.join(home, `prune-race-${stage}`)
    fs.mkdirSync(raceBase)
    const target = path.join(raceBase, '普通目录'); fs.mkdirSync(target)
    const savedStat = fs.statSync, savedLstat = fs.lstatSync
    let identities = 0
    try {
      fs.lstatSync = (...args) => {
        if (args[0] === target && args[1]?.bigint) {
          identities++
          if (stage === 'scan-identity-error') throw new Error('扫描身份读取失败')
        }
        if (args[0] === target && args[1]?.bigint && identities === 2) {
          if (stage === 'identity-error') throw new Error('删除前身份读取失败')
          fs.renameSync(target, path.join(home, `prune-original-${stage}`)); fs.mkdirSync(target)
          fs.writeFileSync(path.join(target, '保留.txt'), '替换目录')
        }
        return savedLstat(...args)
      }
      // stat 在扫描时发生；旧实现没有物理身份复核，仍会错误删除。
      const result = pruneArtifacts(raceBase, { keep: 0 })
      assert.equal(result.removed, 0, stage)
      assert.equal(result.cleanup_failures, stage === 'scan-identity-error' ? 0 : 1, stage)
      assert.equal(result.scan_failures, stage === 'scan-identity-error' ? 1 : 0, stage)
      assert.ok(fs.existsSync(target))
      if (stage === 'replace') assert.equal(fs.readFileSync(path.join(target, '保留.txt'), 'utf8'), '替换目录')
      faultMatrix.push({ operation: `普通prune-${stage}`, passed: true })
    } finally { fs.statSync = savedStat; fs.lstatSync = savedLstat }
  }
  // 4096 边界与单流超限：成功/失败均按 UTF8 字节计数。
  for (const out of ['a'.repeat(4096), 'a'.repeat(4097), '😀'.repeat(1024), '😀'.repeat(1025)]) {
    const shown = await presentVerifyOutput({ ok: false, exitCode: 7, stdout: out, stderr: '' }, { flowHome: unsafe, sessionId: 'boundary', outputHash: hash(out) })
    assert.equal(shown.ok, false)
    assert.equal(shown.exitCode, 7)
    assert.ok(Buffer.byteLength(shown.stdout) <= 4096)
    assert.ok(!shown.stdout.includes('\ufffd'))
    assert.equal(shown.stderr, '')
    if (Buffer.byteLength(out) <= 4096) assert.equal(shown.stdout, out)
  }
  const removeBefore = fs.rmSync
  const scanBefore = fs.readdirSync
  try {
    fs.rmSync = () => { throw hugeError }
    const risk = pruneArtifacts(cleanBase, { keep: 0 })
    assert.equal(risk.kept, 30)
    assert.ok(risk.warning)
    assert.ok(Buffer.byteLength(risk.warning) <= 1024)
    fs.readdirSync = () => { throw hugeError }
    const unknown = pruneArtifacts(cleanBase)
    assert.equal(unknown.kept, null)
    assert.ok(unknown.error)
    assert.ok(Buffer.byteLength(unknown.error) <= 1024)
  } finally { fs.rmSync = removeBefore; fs.readdirSync = scanBefore }

  console.log(
    JSON.stringify(
      { measurements, failureMeasurements, fault_matrix_statistics: { tested: faultMatrix.length, passed: faultMatrix.filter(row => row.passed).length, platform: process.platform }, faultMatrix, scope: '合成压测样本（仅作输出保护与摘要测量）；RPC字节为真实RPC，其余矩阵字节为直接返回结果JSON' },
      null,
      2,
    ),
  )
  console.log('COMM_OUTPUT_OK')
} finally {
  await client.close()
}
