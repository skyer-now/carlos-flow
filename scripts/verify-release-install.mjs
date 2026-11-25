// 发布后实测安装：从 registry 真装本轮版本，并用真实 MCP 握手验证可用性。
//
// 为什么需要：`npm publish` 成功、registry 可查，都不代表「用户装上就能用」。
// 历史事故：包能装但 tools/list 拿不到工具、serverInfo 版本对不上、入口缺 shebang。
// 这一步是发布基线的「实测安装」，必须是流水线里真的一步，而不是纸上承诺。
//
// 用法：node scripts/verify-release-install.mjs
// 退出码：0 = 安装成功且握手回对版本与工具面；1 = 任一项不成立（附公开运行注解）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
const spec = `${pkg.name}@${pkg.version}`
const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-release-install-'))

/** 失败要能被公开看到：所有者没有 admin 权限，下载不了 Actions 日志。 */
const die = (msg) => {
  const line = String(msg).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')
  console.log(`::error title=release-install-verify::${line.slice(0, 20000)}`)
  console.error(msg)
  try { fs.rmSync(prefix, { recursive: true, force: true }) } catch {}
  process.exit(1)
}

console.log(`真实安装 ${spec} 到临时前缀：${prefix}`)

// 带指数退避的安装重试机制：防止 npm CDN 全球节点同步延迟导致 404 误杀
let installStatus = -1
let installErr = ''
const maxAttempts = 6
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  console.log(`[安装尝试 ${attempt}/${maxAttempts}] npm install -g ${spec}...`)
  const install = spawnSync('npm', ['install', '-g', spec, '--prefix', prefix, '--no-audit', '--no-fund', '--prefer-online'], {
    encoding: 'utf8',
    windowsHide: true,
    spawn: false,
    shell: process.platform === 'win32',
    timeout: 180000,
  })
  installStatus = install.status
  installErr = (install.stderr || install.stdout || '').slice(-1500)
  if (installStatus === 0) {
    console.log(`✓ 尝试 ${attempt} 安装成功`)
    break
  }
  if (attempt < maxAttempts) {
    const delay = attempt * 8000
    console.log(`  · 遇到 registry 节点同步延迟，等待 ${delay / 1000}s 后重试...`)
    const waitTill = Date.now() + delay
    while (Date.now() < waitTill) {}
  }
}

if (installStatus !== 0) {
  die(`npm install 重试 ${maxAttempts} 次后仍然失败（退出码 ${installStatus}）：${installErr}`)
}

// npm 全局前缀在不同平台/版本的目录形态不同，两种都试
const candidates = [
  path.join(prefix, 'node_modules', pkg.name),
  path.join(prefix, 'lib', 'node_modules', pkg.name),
]
const pkgDir = candidates.find((p) => fs.existsSync(path.join(p, 'package.json')))
if (!pkgDir) die(`安装后找不到包目录，试过：${candidates.join(' / ')}`)

const installed = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
if (installed.version !== pkg.version) die(`安装到的版本是 ${installed.version}，期望 ${pkg.version}`)
console.log(`安装版本 = ${installed.version}`)

// 真实 MCP 握手：initialize + tools/list
const entry = path.join(pkgDir, 'src', 'index.js')
if (!fs.existsSync(entry)) die(`入口不存在：${entry}`)
const input = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-verify', version: '1' } } }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
].join('\n') + '\n'

const hs = spawnSync(process.execPath, [entry], {
  input,
  encoding: 'utf8',
  timeout: 60000,
  windowsHide: true,
  env: { ...process.env, CARLOS_FLOW_HOME: path.join(prefix, 'flowhome') },
})
if (hs.status !== 0) die(`MCP 进程退出码 ${hs.status}：${(hs.stderr || '').slice(-1200)}`)

const messages = String(hs.stdout || '')
  .split('\n')
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)
const init = messages.find((m) => m.id === 1)
const list = messages.find((m) => m.id === 2)
const serverVersion = init?.result?.serverInfo?.version
const toolNames = (list?.result?.tools || []).map((t) => t.name)

if (serverVersion !== pkg.version) die(`握手版本 ${serverVersion} 与 package.json ${pkg.version} 不一致`)
if (toolNames.length < 4) die(`tools/list 只拿到 ${toolNames.length} 个工具：${toolNames.join(',') || '空'}`)
console.log(`握手版本 = ${serverVersion}｜工具面 = ${toolNames.join(',')}`)

// ---- 校验 npm latest 标签与 Git Tag 一致性 ----
try {
  const latestOut = spawnSync('npm', ['view', pkg.name, 'dist-tags.latest'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    timeout: 30000,
  })
  const latestVer = String(latestOut.stdout || '').trim()
  if (latestVer && latestVer !== pkg.version) {
    console.log(`⚠️  npm latest (${latestVer}) 尚未指向当前发布版本 (${pkg.version})，可能存在发布传播延迟`)
  } else if (latestVer) {
    console.log(`✅ npm latest 已正确指向 ${latestVer}`)
  }
} catch {
  /* 仅作一致性提醒，网络探测异常不阻塞安装验证主流程 */
}

// 产物合法性：tarball 里不能混进本机运维产物
if (fs.existsSync(path.join(pkgDir, '.syncd.lock'))) die('安装产物里含 .syncd.lock（本机运维锁不该进包）')

try { fs.rmSync(prefix, { recursive: true, force: true }) } catch {}
console.log('✅ 发布后实测安装通过（版本、握手、工具面、产物洁净度）')