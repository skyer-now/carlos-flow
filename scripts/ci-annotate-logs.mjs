// 发布流水线失败诊断：把失败套件的原始输出变成「运行注解」。
//
// 为什么需要：仓库所有者没有 admin 权限时，GitHub 不允许下载 Actions 日志
// （GET /actions/jobs/{id}/logs 返回 403），失败只显示「进程退出码 1」。
// 运行注解（::error::）是公开可读的，能把失败的断言直接贴到运行页面上。
//
// 用法：node scripts/ci-annotate-logs.mjs
// 读取 $RUNNER_TEMP/logs/*.log（由 release.yml 的 tee 写入），每个文件取尾部若干行。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'logs')
// 注解单条消息上限按 60KB 预留，避免被 GitHub 截断成不知所云
const MAX_CHARS = 60000
const TAIL_LINES = 120

/** GitHub 工作流命令转义：% 必须最先转义，否则会把后面的 %0A 二次解码 */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

let entries = []
try {
  entries = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()
} catch {
  console.log('没有找到测试日志目录，跳过诊断')
  process.exit(0)
}

let emitted = 0
for (const name of entries) {
  const full = path.join(dir, name)
  let text = ''
  try {
    text = fs.readFileSync(full, 'utf8')
  } catch {
    continue
  }
  const tail = text.split(/\r?\n/).slice(-TAIL_LINES).join('\n').trim()
  if (!tail) continue
  // 只贴失败迹象明显的日志，避免把通过套件的噪声也刷成注解
  const suspicious = /(^|\n)\s*(✗|not ok|\u274c|Error|AssertionError|EXIT=[1-9])/.test(text)
  if (!suspicious) continue
  const body = tail.length > MAX_CHARS ? tail.slice(-MAX_CHARS) : tail
  console.log(`::error title=${name}::${esc(body)}`)
  emitted += 1
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath && emitted === 0) {
  try {
    fs.appendFileSync(summaryPath, '失败诊断：日志里没有匹配到失败迹象，请检查具体步骤。\n')
  } catch {
    /* 摘要写不进去不影响主流程 */
  }
}
console.log(`已输出 ${emitted} 条失败注解`)