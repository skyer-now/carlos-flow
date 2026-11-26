// 仅用于协议展示层：调用方必须在调用本模块前完成证据与状态提交。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

export const VERIFY_SUMMARY_BYTES = 4096 // 单流摘要上限字节数（含折叠标记）
export const ARTIFACT_KEEP_MAX_COUNT = 30 // 最多保留最近 30 份 artifact
export const ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 最长保留 7 天

const activeArtifacts = new Set() // 跨 await 保护本进程正在写入的工件。
// 仅本进程确认的失败记录；不把不可信跨进程标记当作删除授权。
const failedArtifacts = new Map()
function directoryIdentity(dir) {
  const st = fs.lstatSync(dir, { bigint: true })
  if (!st.isDirectory() || st.isSymbolicLink() || st.ino === 0n || st.birthtimeNs === 0n) return null
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`
}
function requireDirectoryIdentity(dir, identity) {
  if (!identity || directoryIdentity(dir) !== identity) throw new Error('目录身份无法确认或路径已替换，保守保留')
}
function removeFailedDirectory(dir, identity) {
  requireDirectoryIdentity(dir, identity)
  // 最终检查与 rm 之间仍存在 TOCTOU；不承诺跨进程原子安全。
  fs.rmSync(dir, { recursive: true, force: true })
  failedArtifacts.delete(dir)
}
const sha = (text) => createHash('sha256').update(text).digest('hex')

// 诊断同样有界，防止巨大异常绕过保护。
function bounded(text, max = 1024) {
  let out = '', bytes = 0
  for (const char of String(text)) {
    const n = Buffer.byteLength(char, 'utf8')
    if (bytes + n > max) break
    out += char
    bytes += n
  }
  return out
}
const errorText = e => bounded(e?.message || String(e))

function summary(text = '', persisted = true) {
  if (Buffer.byteLength(text, 'utf8') <= VERIFY_SUMMARY_BYTES) return text
  const marker = persisted ? '\n…[输出已折叠；完整内容请查阅落盘工件]…\n'
    : '\n…[输出已折叠；可用 runner 文本未持久保存，摘要内容有损失]…\n'
  const budget = Math.floor((VERIFY_SUMMARY_BYTES - Buffer.byteLength(marker, 'utf8')) / 2)
  const prefix = (value) => {
    let bytes = 0
    let out = ''
    for (const char of value) {
      const n = Buffer.byteLength(char, 'utf8')
      if (bytes + n > budget) break
      out += char
      bytes += n
    }
    return out
  }
  return prefix(text) + marker + [...prefix([...text].reverse().join(''))].reverse().join('')
}

function guard(dir) {
  const absolute = path.resolve(dir)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const st = fs.lstatSync(current)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('工件目录路径不安全或包含符号链接')
  }
  if (path.relative(absolute, fs.realpathSync(absolute)) !== '') throw new Error('工件路径发生越界')
}

async function privateDirectory(dir) {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700)
    if ((fs.statSync(dir).mode & 0o077) !== 0) throw new Error('私有目录权限设置未生效')
    return
  }
  // 移除继承权限，仅授予当前用户完整控制权限。
  await new Promise((resolve, reject) => {
    const child = spawn(
      'icacls.exe',
      [dir, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`],
      { windowsHide: true, stdio: 'ignore' },
    )
    const timer = setTimeout(() => {
      try { child.kill() } catch (e) { reject(e) }
      reject(new Error('设置工件目录 ACL 超时'))
    }, 10000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`设置工件目录 ACL 失败 (${code})`))
    })
  })
}

// PID 只用于保守存活检查：仅 ESRCH 可确认死亡，权限不足/PID 复用均保留。
function ownerState(pid) {
  const value = Number(pid)
  if (!Number.isSafeInteger(value) || value <= 0) return 'unknown'
  try { process.kill(value, 0); return 'alive' } catch (e) {
    return e.code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

export function pruneArtifacts(baseDir, options = {}) {
  const keep = Number.isInteger(options.keep) ? options.keep : ARTIFACT_KEEP_MAX_COUNT
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : ARTIFACT_MAX_AGE_MS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  let removed = 0
  let scanFailures = 0
  let cleanupFailures = 0
  let warning = ''
  const warn = text => { warning = bounded(warning ? `${warning}；${text}` : text) }
  try {
    // existsSync 会吞掉访问错误，必须区分不存在与扫描失败。
    try { fs.lstatSync(baseDir) } catch (e) {
      if (e.code === 'ENOENT') return { removed: 0, kept: 0 }
      throw e
    }
    guard(baseDir)
    const confirmedFailed = new Set()
    // 即使目录被替换成非目录，也要持续报告风险，不能悄悄丢失失败记录。
    for (const [full, identity] of failedArtifacts) {
      if (path.dirname(full) !== path.resolve(baseDir)) continue
      try {
        if (identity && directoryIdentity(full) === identity) {
          confirmedFailed.add(full)
        } else warn('失败目录身份无法确认或路径已替换，保守保留')
      } catch (e) {
        if (e.code === 'ENOENT') failedArtifacts.delete(full)
        else warn(`失败目录身份检查失败，保守保留：${errorText(e)}`)
      }
    }
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.resolve(baseDir, e.name)
        try {
          const identity = directoryIdentity(full)
          if (!identity) throw new Error('扫描目录身份无法确认，保守保留')
          const st = fs.statSync(full)
          // 所有权随目录创建原子登记，不能拿文件已 open 当作发布完成。
          const artifact = /^[a-f0-9]{64}-[a-f0-9]{32}(?:-p(\d+))?$/.exec(e.name)
          let published = false
          if (artifact?.[1]) {
            try { fs.lstatSync(path.join(full, '.published')); published = true } catch (e) {
              if (e.code !== 'ENOENT') throw e
            }
          }
          const owner = artifact && !published ? ownerState(artifact[1]) : null
          const failed = confirmedFailed.has(full)
          const failedUnverified = failedArtifacts.has(full) && !failed
          const protectedDir = activeArtifacts.has(full) || full === options.protect || failedUnverified ||
            (!failed && artifact && !published && owner !== 'dead')
          return { full, identity, mtimeMs: st.mtimeMs, protectedDir, failed, abandoned: failed || owner === 'dead', unknown: owner === 'unknown' }
        } catch (e) {
          scanFailures++
          warn(`工件扫描失败，保守保留：${errorText(e)}`)
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.protectedDir) - Number(a.protectedDir) || b.mtimeMs - a.mtimeMs)

    dirs.forEach((d, index) => {
      const tooOld = now - d.mtimeMs > maxAgeMs
      if (d.protectedDir || (!d.abandoned && index < keep && !tooOld)) {
        if (d.failed) warn('本进程已确认失败工件尚待清理，将在活动调用结束后重试回收')
        return
      }
      try {
        // 扫描后再次核对身份；旧路径记录不能授权删除替换目录。
        if (d.failed) removeFailedDirectory(d.full, failedArtifacts.get(d.full))
        else removeFailedDirectory(d.full, d.identity)
        removed++
      } catch (e) {
        cleanupFailures++
        warn(`工件清理失败：${errorText(e)}`)
      }
    })
    const unknown = dirs.filter(d => d.unknown).length
    if (unknown) warn(`保留 ${unknown} 个归属未知的未发布工件；无法安全回收，存储可能超出数量/年龄限制。`)
    return {
      removed, kept: Math.max(0, dirs.length + scanFailures - removed), unknown,
      scan_failures: scanFailures, cleanup_failures: cleanupFailures,
      ...(warning ? { warning } : {}),
    }
  } catch (e) {
    const error = errorText(e)
    return { removed, kept: null, error, warning: bounded(`工件扫描/清理失败，保留数量未知：${error}`) }
  }
}

export async function presentVerifyOutput(result, { flowHome, sessionId, outputHash }) {
  const original = { ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  const stdoutBytes = Buffer.byteLength(result.stdout || '', 'utf8')
  const stderrBytes = Buffer.byteLength(result.stderr || '', 'utf8')
  const streamInfo = (key) => ({
    available_bytes: Buffer.byteLength(result[key] || '', 'utf8'),
    runner_reported_bytes: result[`${key}_bytes`] ?? null,
    sha256: sha(result[key] || ''),
  })
  const baseMeta = {
    truncated: false,
    presentation_ok: true,
    available_runner_text_persisted: false,
    summary_content_loss: false,
    summary_max_bytes_per_stream: VERIFY_SUMMARY_BYTES,
    upstream_truncated:
      result.output_truncated === true ||
      ['stdout', 'stderr'].some((k) => (result[`${k}_bytes`] ?? 0) > Buffer.byteLength(result[k] || '', 'utf8')),
    original_complete: false,
    source: 'runner返回文本（不保证原进程绝对完整性）',
    evidence_output_hash: outputHash,
    stdout: streamInfo('stdout'),
    stderr: streamInfo('stderr'),
    artifact: null,
  }

  // 小输出路径：统一带上上游截断与流信息，保持结构一致。
  if (stdoutBytes <= VERIFY_SUMMARY_BYTES && stderrBytes <= VERIFY_SUMMARY_BYTES) {
    return {
      ...original,
      output_metadata: baseMeta,
    }
  }

  // 超限大输出路径：进行摘要折叠并尝试落盘。
  let file
  let dir
  let base
  let owned = false
  let ownedIdentity = null
  try {
    guard(flowHome)
    base = path.resolve(flowHome, 'verify-output')
    try {
      fs.mkdirSync(base, { mode: 0o700 })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    guard(base)

    dir = path.join(base, `${sha(String(sessionId))}-${randomBytes(16).toString('hex')}-p${process.pid}`)
    fs.mkdirSync(dir, { mode: 0o700 })
    owned = true
    activeArtifacts.add(dir)
    ownedIdentity = directoryIdentity(dir)
    guard(dir)
    await privateDirectory(dir)
    guard(dir)
    requireDirectoryIdentity(dir, ownedIdentity)

    file = path.join(dir, 'available-output.json')
    const available = JSON.stringify({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      output_hash: outputHash,
      source: 'runner-returned text; not complete original process output',
    })
    requireDirectoryIdentity(dir, ownedIdentity)
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, available, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) {
      throw new Error('私有文件权限设置未生效')
    }
    if (fs.readFileSync(file, 'utf8') !== available) throw new Error('工件回读内容校验不一致')
    // 回读校验后才发布；其他进程看到空/部分文件时仍按 owner PID 保护。
    requireDirectoryIdentity(dir, ownedIdentity)
    fs.writeFileSync(path.join(dir, '.published'), '', { flag: 'wx', mode: 0o600 })
    activeArtifacts.delete(dir)
    const retention = pruneArtifacts(base, { protect: dir })

    return {
      ...original,
      ...(retention.warning ? { output_warning: retention.warning } : {}),
      stdout: summary(result.stdout),
      stderr: summary(result.stderr),
      output_metadata: {
        ...baseMeta,
        truncated: true,
        available_runner_text_persisted: true,
        summary_content_loss: true,
        retention,
        artifact: {
          path: file,
          bytes: Buffer.byteLength(available, 'utf8'),
          sha256: sha(available),
          available: true,
          availability_scope: 'at_publication',
          retention_may_remove: true,
          availability_note: 'available 仅表示发布时可用；后续数量/年龄保留策略或并行清理可能使工件失效',
        },
      },
    }
  } catch (e) {
    // 本次 mkdir 成功且已确认失败：可直接回收自有目录，不能留给永久保护。
    let cleanupWarning = ''
    if (owned) {
      failedArtifacts.set(dir, ownedIdentity)
      try { removeFailedDirectory(dir, ownedIdentity) } catch (cleanupError) {
        cleanupWarning = bounded(`失败工件回收失败，可能残留自有目录：${errorText(cleanupError)}`)
      }
    }
    // 展示降级不改变业务结论与证据；清理风险必须随结果返回。
    const retention = base ? pruneArtifacts(base, { protect: dir }) : null
    return {
      ...original,
      stdout: summary(result.stdout, false),
      stderr: summary(result.stderr, false),
      output_metadata: {
        ...baseMeta,
        truncated: true,
        presentation_ok: false,
        available_runner_text_persisted: false,
        summary_content_loss: true,
        retention,
        ...(cleanupWarning ? { cleanup_warning: cleanupWarning } : {}),
        artifact: { available: false, error: errorText(e) },
      },
      output_warning: bounded(`验证输出工件保存失败，可用 runner 文本未持久保存，摘要内容有损失：${errorText(e)}${cleanupWarning ? `；${cleanupWarning}` : ''}${retention?.warning ? `；${retention.warning}` : ''}`),
    }
  } finally {
    // 正常路径已在发布后清理；失败路径只移除本进程的活动登记。
    if (owned) activeArtifacts.delete(dir)
  }
}
