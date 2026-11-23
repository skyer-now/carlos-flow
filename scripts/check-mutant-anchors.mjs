#!/usr/bin/env node
// 共用真实注入函数：锚点必须唯一，临时副本必须通过 Node 语法检查。
// 不用 eval，不执行注入源码，不读取宿主部署配置；证据保留在独占目录。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MUTANTS, REPO_ROOT, inject, checkSyntax, freshWorkspace } from './mutation-check.mjs'

const work = freshWorkspace('anchors-')
const results = []
for (const [i, m] of MUTANTS.entries()) {
  try {
    const mutated = inject(m, readFileSync(join(REPO_ROOT, m.file), 'utf8'))
    const target = join(work, `mutant-${i + 1}.mjs`)
    writeFileSync(target, mutated)
    checkSyntax(target)
    results.push({ id: m.id, unique: true, syntax: true })
    console.log(`✅ ${m.id} 唯一锚点 / 注入语法有效`)
  } catch (error) {
    results.push({ id: m.id, error: error.message })
    console.error(`❌ ${m.id}：${error.message}`)
  }
}
writeFileSync(join(work, 'anchors.json'), JSON.stringify(results, null, 2))
const good = results.filter((r) => r.unique && r.syntax).length
console.log(`${good}/${MUTANTS.length} 唯一锚点及语法有效；证据：${work}`)
process.exitCode = good === MUTANTS.length ? 0 : 1
