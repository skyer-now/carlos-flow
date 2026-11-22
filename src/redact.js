/**
 * 统一脱敏（阶段二）。
 *
 * 只有一份实现：失败记忆写入、质检单导出、CLI 输出都调用它，
 * 避免两套正则各漏一半（独立审查发现的真实问题）。
 *
 * 原则：
 * - 保守：宁可多遮，不可漏遮；
 * - 保留可定位信息：绝对路径只保留最后一段文件名，文件名与行号仍可用于排查；
 * - 不处理换行结构，调用方负责裁剪长度。
 */
const CREDENTIAL_PATTERNS = [
  // 常见令牌形态
  [/\b(gh[pousr]_[A-Za-z0-9]{10,})\b/g, '<凭据>'],
  [/\b(github_pat_[A-Za-z0-9_]{10,})\b/g, '<凭据>'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '<凭据>'],
  [/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '<凭据>'],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, '<凭据>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <凭据>'],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic <凭据>'],
  // 私钥块整体遮掉，避免残留 base64 片段
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<私钥>'],
  // 键值形态：兼顾 JSON（"password": "x"）与命令行（password=x）
  [
    /((?:"|')?(?:password|passwd|pwd|token|secret|api[_-]?key|authorization|access[_-]?key)(?:"|')?\s*[:=]\s*)(?:"|')?[^\s"',;}]+/gi,
    '$1<凭据>',
  ],
]

function baseName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export function redact(text) {
  let s = String(text == null ? '' : text)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

  // 用户主目录：只保留最后一段文件名，不露目录结构
  // 用户主目录：保留最后一段文件名；路径恰好止于用户目录时不回填（否则会漏出用户名）
  s = s.replace(/([A-Za-z]:\\Users\\[^\\\s"'<>|]+)(\\[^\s"'<>|]+)?/gi, (m, base, rest) => (rest ? `<用户目录>/${baseName(rest)}` : '<用户目录>'))
  s = s.replace(/([A-Za-z]:\\Documents and Settings\\[^\\\s"'<>|]+)(\\[^\s"'<>|]+)?/gi, (m, base, rest) => (rest ? `<用户目录>/${baseName(rest)}` : '<用户目录>'))
  s = s.replace(/(\/(?:Users|home)\/[^/\s"'<>|]+)(\/[^\s"'<>|]+)?/g, (m, base, rest) => (rest ? `<用户目录>/${baseName(rest)}` : '<用户目录>'))

  // UNC（\\server\share\...）与盘符路径：只保留最后一段
  s = s.replace(/\\\\[^\s"'<>|]+/g, (m) => `<绝对路径>/${baseName(m)}`)
  s = s.replace(/[A-Za-z]:\\[^\s"'<>|]+/g, (m) => `<绝对路径>/${baseName(m)}`)

  // 其余 POSIX 绝对路径（至少两段且带文件名）：同样只留文件名
  s = s.replace(/(^|[\s"'(=:])\/(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8}/g, (m, lead) => {
    return `${lead}<绝对路径>/${baseName(String(m).slice(lead.length))}`
  })

  for (const [re, rep] of CREDENTIAL_PATTERNS) s = s.replace(re, rep)
  return s
}