// 发布后核验：npm registry 必须真的能查到本轮版本。
//
// 为什么需要：workflow 里「发布到 npm」步骤只要**没报错就绿**，
// 但 npm publish 存在「返回 409 兜底被当成已发布」「静默发到别处」等情况，
// 结果 run 变绿、registry 里却没有这个版本（2026-11-24 v3.1.0 就出现过）。
// 发布成功必须以 registry 可查为准，而不是以命令退出码为准。
//
// 用法：node scripts/verify-npm-publish.mjs
// 退出码：0 = registry 已能查到本轮版本；1 = 查不到（并在运行注解里给出最后一次探测结果）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version
const registry = process.env.NPM_REGISTRY || 'https://registry.npmjs.org'
const deadline = Date.now() + 180000

const probe = async () => {
  const url = `${registry}/${encodeURIComponent(name)}?ts=${Date.now()}`
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const doc = await res.json()
  const has = Boolean(doc.versions && doc.versions[version])
  return {
    ok: has,
    reason: has ? 'found' : `latest=${doc['dist-tags'] && doc['dist-tags'].latest}`,
    tarball: has ? doc.versions[version].dist.tarball : null,
  }
}

let last = { ok: false, reason: '未探测' }
while (Date.now() < deadline) {
  try {
    last = await probe()
  } catch (e) {
    last = { ok: false, reason: e && e.message ? e.message : String(e) }
  }
  if (last.ok) {
    console.log(`✅ registry 已能查到 ${name}@${version}（${last.tarball}）`)
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 5000))
}

// 失败要写进公开运行注解：所有者没有 admin 权限，下载不了 Actions 日志。
const msg = `发布后核验失败：registry 查不到 ${name}@${version}（最后探测：${last.reason}）`
console.log(`::error title=npm-publish-verify::${msg.replace(/%/g, '%25')}`)
console.error(msg)
process.exit(1)