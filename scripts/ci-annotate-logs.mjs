// 发布流水线失败诊断：把失败套件的关键输出变成「运行注解」。
//
// 为什么需要：仓库所有者没有 admin 权限时，GitHub 不允许下载 Actions 日志
// （GET /actions/jobs/{id}/logs 返回 403），失败只显示「进程退出码 1」。
// 运行注解（::error::）是公开可读的，能把失败的断言直接贴到运行页面上。
//
// 为什么分两条：注解单条消息会被截断（约 64KB / 显示截断），
// 把「失败行」和「末尾几行」分成两条小消息，才能保证关键信息不被截掉。
//
// 用法：node scripts/ci-annotate-logs.mjs
// 读取 $RUNNER_TEMP/logs/*.log（由 release.yml 的 tee 写入）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'logs')
const TAIL_LINES = 8
const MAX_CHARS = 20000

/** GitHub 工作流命令转义：% 必须最先转义，否则会把后面的 %0A 二次解码 */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const clip = (s) => (s.length > MAX_CHARS ? s.slice(-MAX_CHARS) : s)

let entries = []
try {
  entries = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()
} catch {
  console.log('没有找到测试日志目录，跳过诊断')
  process.exit(0)
}

const FAIL_LINE = /^\s*(✗|not ok \d+|AssertionError|Error:|TypeError|ReferenceError|EXIT=[1-9]|\[flow-)/
let emitted = 0

for (const name of entries) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  const failLines = lines.filter((l) => FAIL_LINE.test(l)).slice(-6)
  const suspicious = failLines.length > 0
  if (!suspicious) continue

  // 第一条：失败行（最有用，且通常很短，不会被截断）
  console.log(`::error title=${name}·失败行::${esc(clip(failLines.join('\n')))}`)
  // 第二条：日志末尾（异常栈、进程退出原因通常在这里）
  const tail = lines.filter((l) => l.trim()).slice(-TAIL_LINES).join('\n')
  console.log(`::error title=${name}·末尾::${esc(clip(tail))}`)
  emitted += 2
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  try {
    fs.appendFileSync(summaryPath, `失败诊断：共输出 ${emitted} 条注解。\n`)
  } catch {
    /* 摘要写不进去不影响主流程 */
  }
}
console.log(`已输出 ${emitted} 条失败注解`)