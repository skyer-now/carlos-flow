// Presentation only: callers must finish evidence/state work before calling this.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

export const VERIFY_SUMMARY_BYTES = 4096 // 单流摘要上限字节数（含折叠标记）
export const ARTIFACT_KEEP_MAX_COUNT = 30 // 最多保留最近 30 份 artifact
export const ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 最长保留 7 天

const sha = (text) => createHash('sha256').update(text).digest('hex')

function summary(text) {
  if (Buffer.byteLength(text, 'utf8') <= VERIFY_SUMMARY_BYTES) return text
  const marker = '\n…[输出已折叠；完整内容请查阅落盘工件]…\n'
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
      child.kill()
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

export function pruneArtifacts(baseDir, options = {}) {
  const keep = Number.isInteger(options.keep) ? options.keep : ARTIFACT_KEEP_MAX_COUNT
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : ARTIFACT_MAX_AGE_MS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  let removed = 0
  try {
    if (!fs.existsSync(baseDir)) return { removed: 0, kept: 0 }
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(baseDir, e.name)
        try {
          const st = fs.statSync(full)
          return { full, mtimeMs: st.mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    dirs.forEach((d, index) => {
      const tooOld = now - d.mtimeMs > maxAgeMs
      if (index < keep && !tooOld) return
      try {
        fs.rmSync(d.full, { recursive: true, force: true })
        removed++
      } catch {}
    })
    return { removed, kept: Math.max(0, dirs.length - removed) }
  } catch {
    return { removed: 0, kept: 0 }
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
  try {
    guard(flowHome)
    const base = path.join(flowHome, 'verify-output')
    try {
      fs.mkdirSync(base, { mode: 0o700 })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    guard(base)

    pruneArtifacts(base)

    const dir = path.join(base, `${sha(String(sessionId))}-${randomBytes(16).toString('hex')}`)
    fs.mkdirSync(dir, { mode: 0o700 })
    guard(dir)
    await privateDirectory(dir)
    guard(dir)

    file = path.join(dir, 'available-output.json')
    const available = JSON.stringify({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      output_hash: outputHash,
      source: 'runner-returned text; not complete original process output',
    })
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

    return {
      ...original,
      stdout: summary(result.stdout),
      stderr: summary(result.stderr),
      output_metadata: {
        ...baseMeta,
        truncated: true,
        artifact: {
          path: file,
          bytes: Buffer.byteLength(available, 'utf8'),
          sha256: sha(available),
          available: true,
        },
      },
    }
  } catch (e) {
    // 落盘失败：保持原文本回退，同时带上明确警告与基本元数据，不谎报落盘成功。
    return {
      ...original,
      output_metadata: {
        ...baseMeta,
        truncated: false,
        artifact: { available: false, error: e.message || String(e) },
      },
      output_warning: `验证输出工件保存失败，已保留原始返回输出：${e.message || e}`,
    }
  }
}
