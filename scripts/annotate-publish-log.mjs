// 把 npm publish 的失败日志尾部转成公开运行注解。
//
// 为什么需要：仓库所有者没有 admin 权限，下载不了 Actions 日志（403），
// 失败只显示「进程退出码 1」。注解（::error::）是公开可读的。
//
// 用法：node scripts/annotate-publish-log.mjs <日志文件>
import fs from 'node:fs'

const file = process.argv[2]
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch {
  console.log('::error title=npm-publish::读不到 publish 日志')
  process.exit(0)
}

// npm 的错误行通常在末尾；同时把错误码行单独拎出来，便于一眼定位
const lines = text.split(/\r?\n/)
const errLines = lines.filter((l) => /(npm (ERR|error)|E40[0-9]|EOTP|403|401|OTP)/i.test(l)).slice(-8)
const tail = lines.filter((l) => l.trim()).slice(-12).join('\n')

if (errLines.length) console.log(`::error title=npm-publish·错误行::${esc(errLines.join('\n').slice(-20000))}`)
console.log(`::error title=npm-publish·末尾::${esc(tail.slice(-20000))}`)