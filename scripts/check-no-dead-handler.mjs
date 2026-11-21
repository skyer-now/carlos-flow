#!/usr/bin/env node
// check-no-dead-handler.mjs — 禁止重复注册同一 request schema
//
// 为什么要它：
// 2226-11-07 的第三方审查发现 src/index.js 里 CallToolRequestSchema
// **注册了两次**（1132 行与 1213 行）。
//
// MCP SDK 的 setRequestHandler 内部是 Map.set → 后注册的覆盖先注册的，
// 于是先注册的那个（含约 17 行）**永远不会执行** —— 是一段死代码。
//
// 当前行为之所以正确，只是因为「带参数校验的那个恰好注册在后面」：
//   · 谁先谁后是一种**隐式约定**，没有任何东西守着它；
//   · 任何一次重排、插入、合并都会静默丢掉参数校验
//     （required 字段 / 类型 / enum 全部失效）—— 而且测试**不会**变红。
//
// 所以本门禁把「同一 schema 只能注册一次」变成硬约束。
//
// 退出码：0 = 无重复注册；1 = 发现重复（打印位置）
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Script } from 'node:vm'
import { pathToFileURL } from 'node:url'

// 只编译而不执行片段，由语言解析器识别引号、注释及嵌套括号。
export function objectAt(src, start, functionBody = false) {
  for (let end = src.indexOf('}', start); end >= 0; end = src.indexOf('}', end + 1)) {
    try {
      const fragment = src.slice(start, end + 1)
      new Script(functionBody ? `(async function()${fragment})` : `(${fragment})`)
      return { body: src.slice(start + 1, end), end }
    } catch {}
  }
  throw new Error('无法解析对象边界')
}

// 按可独立编译的完整成员切分，逗号即使出现在字符串、注释或正则里也不会截断。
function members(body, object = false) {
  const result = []
  let start = 0
  for (let end = 0; end <= body.length; end++) {
    if (end < body.length && body[end] !== ',') continue
    const fragment = body.slice(start, end)
    try { new Script(object ? `({${fragment}\n})` : `([${fragment}\n])`) } catch { continue }
    const text = fragment.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim()
    if (text) result.push(text)
    start = end + 1
  }
  if (body.slice(start).replace(/\s/g, '')) throw new Error('成员边界解析失败')
  return result
}

export function parseTools(src) {
  const marker = /\bconst\s+TOOLS\s*=\s*\[/.exec(src)
  if (!marker) throw new Error('未找到工具数组')
  const start = marker.index + marker[0].length
  let end = start
  for (;;) {
    end = src.indexOf(']', end)
    if (end < 0) throw new Error('无法解析工具数组边界')
    try { new Script(`([${src.slice(start, end)}])`); break } catch { end++ }
  }
  const tools = []
  for (const text of members(src.slice(start, end))) {
    const object = objectAt(text, 0)
    const block = object.body
    const fields = new Map(members(block, true).map((field) => {
      const key = /^(?:([A-Za-z_$][\w$]*)|(['"])([^'"]+)\2)\s*:\s*/.exec(field)
      if (!key) throw new Error('工具字段解析失败')
      return [key[1] || key[3], field.slice(key[0].length)]
    }))
    const name = /^(['"])([a-z0-9_]+)\1$/.exec(fields.get('name') || '')?.[2]
    if (!name) throw new Error('工具对象缺少可解析名称')
    const desc = fields.get('description') || ''
    const handlerValue = fields.get('handler') || ''
    const arrow = /^(?:async\s*)?(?:\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(handlerValue)
    if (!arrow) throw new Error(`工具缺少处理器：${name}`)
    const value = handlerValue.slice(arrow[0].length)
    const handler = value.startsWith('{') ? objectAt(value, 0, true).body : `return ${value}`
    tools.push({ name, block, desc, handler })
  }
  if (!tools.length) throw new Error('工具数组为空')
  return tools
}

export function verifyParserFormats() {
  let checked = 0
  for (const quote of ['\'', '"']) {
    for (const newline of ['\n', '\r\n']) {
      for (const terminator of ['', ';']) {
        const literal = (text) => quote + text.replace(/\\/g, '\\\\').replaceAll(quote, '\\' + quote) + quote
        const source = [
          'const TOOLS = [',
          '// 工具间注释包含干扰括号 { ] 和逗号 ,',
          '{',
          '/* 字段注释包含 } , */ name: ' + literal('flow_protocol') + ',',
          'description: ' + literal('说明含括号 { } [ ] ( ) 和逗号 ,') + ',',
          'inputSchema: { type: ' + literal('object') + ', properties: {} },',
          'handler: async () => ok({ protocol: PROTOCOL }),',
          '},',
          '{ name: ' + literal('flow_status') + ',',
          'description: ' + literal('读取参数 date') + ',',
          'inputSchema: { properties: { date: { type: ' + literal('string') + ' } } },',
          'handler: async (args) => {',
          '// 处理器注释包含 } ] ,',
          'const pattern = /[},\\]]+/',
          'const text = ' + literal('字符串 } ] ,') + terminator,
          'return ok({ state: loadState(args.date), match: pattern.test(text) })',
          '} },',
          ']' + terminator,
        ].join(newline)
        const tools = parseTools(source)
        if (tools.length !== 2 || tools[0].name !== 'flow_protocol' || tools[1].name !== 'flow_status' ||
            !tools[0].handler.startsWith('return ok(') || !tools[0].desc.includes('说明含括号') ||
            !tools[1].handler.includes('loadState(args.date)') || !tools[1].handler.includes('/[},\\]]+/')) {
          throw new Error('工具格式兼容回归失败')
        }
        // 表达式常量必须仍能被空壳规则识别，不能被当成缺失处理器跳过。
        const stub = parseTools('const TOOLS = [{ name: ' + literal('flow_status') + ', description: ' + literal('常量') + ', inputSchema: {}, handler: () => ok({}) }]')[0]
        if (!/^return\s+ok\(\{\}\)/.test(stub.handler)) throw new Error('表达式空壳识别回归失败')
        checked++
      }
    }
  }
  return checked
}

function main() {
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };

console.log("=".repeat(72));
console.log("Carlos Flow · 重复注册门禁（同一 request schema 只能注册一次）");
pass(`工具格式解析回归 ${verifyParserFormats()} 组`)
console.log("=".repeat(72));

const files = ["src/index.js"];
for (const f of files) {
  let src = "";
  try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }

  // 统计 setRequestHandler(X, ...) 的出现，按 schema 分组
  const bySchema = new Map();
  const re = /setRequestHandler\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const schema = m[1];
    const line = src.slice(0, m.index).split("\n").length;
    if (!bySchema.has(schema)) bySchema.set(schema, []);
    bySchema.get(schema).push(line);
  }

  console.log(`\n▶ ${f}`);
  for (const [schema, lines] of bySchema) {
    if (lines.length > 1) {
      fail(`${schema} 被注册了 ${lines.length} 次（第 ${lines.join(", ")} 行）—— ` +
        `后注册的会覆盖先注册的，先注册的是永不执行的死代码`);
    } else {
      pass(`${schema} 只注册一次（第 ${lines[0]} 行）`);
    }
  }
}

// ---- 额外：MCP server 装配段的 handler 与工具实现必须对得上 ----
console.log("\n▶ 工具实现 ↔ handler 装配");
try {
  const src = readFileSync(join(ROOT, "src/index.js"), "utf8");
  const declared = parseTools(src).map((tool) => tool.name)
  const hasDispatchLookup = /TOOLS\.find\([\s\S]{0,80}?\.name\s*===/.test(src);
  if (hasDispatchLookup) pass("CallTool handler 通过 TOOLS.find 分发到工具实现");
  else fail("CallTool handler 找不到按 name 分发到工具实现的逻辑");
  const hasValidation = /validateToolArgs\(/.test(src);
  if (hasValidation) pass("CallTool handler 调用了 validateToolArgs（参数校验未丢失）");
  else fail("CallTool handler 没有调用 validateToolArgs —— 参数校验可能已丢失");
  // 数量下限而不是精确值：加工具不该因为「门禁里写死了 20」而变红，
  // 但**大批删除**必须被抓住（低于 20 说明有工具被静默摘掉了）。
  if (declared.length >= 20) pass(`TOOLS 声明 ${declared.length} 个工具`);
  else fail(`TOOLS 只声明了 ${declared.length} 个工具（应 ≥20，可能有工具被静默删掉）`);
} catch (e) {
  fail(`读取 src/index.js 失败：${e.message}`);
}

console.log("\n" + "=".repeat(72));
if (failed) {
  console.log(`❌ 重复注册检查失败：${failed} 项问题`);
  console.log("=".repeat(72));
  process.exit(1);
}
console.log("✅ 重复注册检查全部通过");
console.log("=".repeat(72));
process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()