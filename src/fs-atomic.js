/**
 * 原子写（Windows 友好）。
 *
 * 为什么单独一层：Windows 上 rename 被 Defender、索引器、编辑器或另一进程短暂
 * 持有句柄时会返回 EBUSY/EPERM/EACCES —— 这不是数据错误，等几十毫秒重试即可。
 * 状态层（src/state.js）早已有这套重试，但失败记忆、质检单导出、worktree 登记
 * 各自又写了一遍 rename，没有重试，属于同一类问题在不同模块复发。
 *
 * 语义：
 * - 临时文件与目标同目录，`open(..., 'wx')` 保证不覆盖他人临时文件；
 * - 写入 + fsync 后 rename；rename 失败按 EBUSY/EPERM/EACCES 有界重试；
 * - 失败清理临时文件；
 * - rename 成功后尽力 fsync 目录；EINVAL/ENOTSUP/ENOSYS 视为平台不支持（Darwin 常见），
 *   其它错误不改变“已提交”的事实，只作为 warning 返回。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES'])
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])
const RETRY_ATTEMPTS = 6
const RETRY_BASE_MS = 15

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renameWithRetry(from, to) {
  let lastError = null
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(from, to)
      return { ok: true, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      if (!RETRYABLE.has(error && error.code)) return { ok: false, error }
      sleepSync(RETRY_BASE_MS * (attempt + 1))
    }
  }
  return { ok: false, error: lastError }
}

function syncDirBestEffort(dir) {
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
      return null
    } catch (error) {
      if (DIR_SYNC_UNSUPPORTED.has(error && error.code)) return null
      return error
    } finally {
      try { fs.closeSync(fd) } catch { /* 已尽力 */ }
    }
  } catch (error) {
    if (DIR_SYNC_UNSUPPORTED.has(error && error.code)) return null
    return error
  }
}

export function writeFileAtomic(file, data, options = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx')
    fs.writeFileSync(fd, data, options.encoding || 'utf8')
    if (options.fsync !== false) fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    const renamed = renameWithRetry(tmp, file)
    if (!renamed.ok) throw renamed.error
    const dirWarning = syncDirBestEffort(dir)
    return { ok: true, attempts: renamed.attempts, dirWarning }
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2), options)
}

export const ATOMIC_RETRYABLE_CODES = Object.freeze([...RETRYABLE])