/**
 * 互审的两件长期可用性支撑：
 *   1. prompt 文件清理（只清互审 prompt，不动 T2 审计 prompt）；
 *   2. 证据引用核验（离线可判定的 path:line / URL / 自由文本）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ADVISORY_MARKER = 'kind: advisory（调研/方案互审）'

/**
 * 按内容标记识别互审 prompt，保留最近 keep 份，删除超过 maxAgeMs 的。
 * 没有该标记的文件（T2 审计 prompt 等）一律不碰。
 */
export function pruneAdvisoryPrompts(dir, options = {}) {
  const keep = Number.isInteger(options.keep) ? options.keep : 20
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 7 * 24 * 60 * 60 * 1000
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  let removed = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { removed, kept: 0 }
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.prompt.txt'))
    .map((entry) => {
      const full = path.join(dir, entry.name)
      try {
        const stat = fs.statSync(full)
        const head = fs.readFileSync(full, 'utf8').slice(0, 4096)
        return head.includes(ADVISORY_MARKER) ? { full, mtimeMs: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  files.forEach((file, index) => {
    const tooOld = now - file.mtimeMs > maxAgeMs
    if (index < keep && !tooOld) return
    try {
      fs.unlinkSync(file.full)
      removed++
    } catch {
      /* 清理失败不影响主流程 */
    }
  })
  return { removed, kept: Math.min(files.length, keep) }
}

/**
 * 核验证据引用（离线）：
 * - path:line / path:start-end：文件存在且行号在范围内 → verified；
 * - http(s) URL：无法离线访问 → external（可用，但不算 verified）；
 * - 其它自由文本 → unverified（不能作为“已核实”的证据）。
 */
export function verifyEvidenceRef(ref, options = {}) {
  const text = String(ref || '').trim()
  if (!text) return { status: 'unverified', reason: '空引用' }
  if (/^https?:\/\//i.test(text)) return { status: 'external', reason: '外部链接，未离线核验' }
  const m = /^(.+?):(\d+)(?:-\d+)?$/.exec(text)
  if (!m) return { status: 'unverified', reason: '不是可核验的 path:line 或 URL' }
  const file = path.isAbsolute(m[1]) ? m[1] : path.resolve(options.cwd || process.cwd(), m[1])
  const line = Number(m[2])
  let body
  try {
    body = fs.readFileSync(file, 'utf8')
  } catch {
    return { status: 'unverified', reason: '文件不存在或不可读', file, line }
  }
  const total = body.split(/\r?\n/).length
  if (line >= 1 && line <= total) return { status: 'verified', reason: '文件与行号存在', file, line }
  return { status: 'unverified', reason: '行号超出文件范围', file, line }
}