#!/usr/bin/env node
// check-params.mjs — 「工具参数不得静默失效」门禁
//
// 为什么要它：
// 2026-11-07 的第三方审查发现 flow_audit 的 inputSchema 里声明了 date 参数、
// 工具描述也写着「可按日期过滤」，但 handler 里算出了 rawDate 却**从未使用**
// —— 文件路径仍用 localDate()。
//
// 这个 bug 的隐蔽之处：它**不报错**、测试也全绿，只是安静地返回错误的数据
// （传 date=2020-01-01 拿到的是今天的数据）。属于典型的「静默失效」。
//
// 本门禁的判定：对每个工具的 inputSchema 声明的每个参数，
// 断言它在 handler（或该工具直接调用的下游函数）里**真的被读取**。
//
// 退出码：0 = 无静默失效；1 = 发现静默失效（逐条打印）
import { parseTools, objectAt, loadImplementationSource } from './check-no-dead-handler.mjs'
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return null; } };

let failed = 0;
const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const section = (t) => console.log(`\n▶ ${t}`);

console.log("=".repeat(72));
console.log("Carlos Flow · 参数有效性门禁（inputSchema 声明 ↔ handler 实际读取）");
console.log("=".repeat(72));

const indexSrc = loadImplementationSource(ROOT);
const stateSrc = read("src/state.js") || "";

/** 从 src 的第 idx 个字符开始（idx 指向 '{'），返回配对括号内的内容与结束位置 */
function matchBraces(src, idx) {
  if (src[idx] !== "{") return null;
  return objectAt(src, idx)
}

/** 抽取 TOOLS 数组内容 */
function extractTools(src) {
  const tools = []
  for (const parsed of parseTools(src)) {
    const { block, handler } = parsed

    // inputSchema.properties
    const schemaAt = block.indexOf("inputSchema:");
    const schemaOpen = block.indexOf("{", schemaAt);
    const schema = schemaOpen >= 0 ? matchBraces(block, schemaOpen) : null;
    let props = [];
    if (schema) {
      const pAt = schema.body.indexOf("properties:");
      const pOpen = schema.body.indexOf("{", pAt);
      const pBlock = pOpen >= 0 ? matchBraces(schema.body, pOpen) : null;
      if (pBlock) {
        // 只取**顶层**直接子键 —— 嵌套 schema 里的 items / properties / path / line
        // 不是工具参数，误当参数会报一堆假问题。
        props = [];
        let pos = 0
        while (pos < pBlock.body.length) {
          const key = /^\s*,?\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(['"])([A-Za-z_][A-Za-z0-9_]*)\2)\s*:\s*\{/.exec(pBlock.body.slice(pos))
          if (!key) {
            if (pBlock.body.slice(pos).replace(/[\s,]/g, '')) throw new Error('无法解析参数字段')
            break
          }
          props.push(key[1] || key[3])
          const open = pos + key[0].lastIndexOf('{')
          pos = objectAt(pBlock.body, open).end + 1
        }
      }
    }
    tools.push({ name: parsed.name, props, handler })
  }
  return tools;
}

/** 抽取具名函数的函数体 */
function extractFunction(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  // 跳过参数列表（`opts = {}` 里也有花括号，不能当函数体起点）
  let i = src.indexOf("(", at);
  let depth = 0;
  let open = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  while (i < src.length && src[i] !== "{") i++;
  open = i;
  const b = open >= 0 ? objectAt(src, open, true) : null;
  return b ? b.body : null;
}

const tools = extractTools(indexSrc);
section(`共解析到 ${tools.length} 个工具`);

// ---- 逐工具逐参数检查 ----
const IGNORE = new Set(["sessionId", "cwd"]);   // 有明确通用处理，但仍确认被读
for (const t of tools) {
  if (!t.props.length) continue;
  const unused = [];
  for (const p of t.props) {
    const used = new RegExp(`\\b${p}\\b`).test(t.handler);
    if (!used) unused.push(p);
  }
  if (unused.length) {
    fail(`工具 ${t.name}：inputSchema 声明了但 handler 从未读取 → ${unused.join(", ")}`);
  }
}
if (!failed) pass("所有工具的 inputSchema 参数都在 handler 里被真实读取");

// ---- 专项：state.js 里「算出来却没用」的死变量 ----
section("死变量检测（算出却从未使用）");
for (const [file, src] of [["src/state.js", stateSrc], ["src/index.js", indexSrc]]) {
  const deadVars = [];
  const re = /^[ \t]*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (["i", "j", "k", "n", "r", "t", "e", "a", "b", "c", "d", "f", "s", "v", "x", "y"].includes(name)) continue;
    // 取该变量所在语句的结束位置
    const after = src.slice(m.index + m[0].length)
    if (!new RegExp(`\\b${name}\\b`).test(after)) deadVars.push(name);
  }
  if (deadVars.length) {
    fail(`${file}：存在「算出却从未使用」的死变量 → ${deadVars.join(", ")}`);
  }
}
if (!failed) pass("没有「算出却从未使用」的死变量");

// ---- 专项：opts.date 必须在下游真的用上 ----
section("date 参数贯通检查");
// 仅沿两个已知委托边追踪，调用点必须原样传递 opts；不能合并无关函数体。
function dateReachesPath(src, name) {
  const clean = (body) => (body || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const body = clean(extractFunction(src, name))
  if (!body || !new RegExp(`function\\s+${name}\\s*\\(\\s*opts\\s*(?:=|,|\\))`).test(src)) return false
  if (/\bopts\s*=(?!=|>)|\bopts\.date\s*=(?!=|>)|delete\s+opts\.date/.test(body)) return false
  const validatedDate = /\bconst\s+rawDate\s*=\s*typeof\s+opts\.date\s*===\s*(['"])string\1\s*&&\s*\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(\s*opts\.date\s*\)\s*\?\s*opts\.date\s*:\s*localDate\(\s*\)/.test(body)
  const selectsDate = /\bauditDayFilesOf\(\s*rawDate\s*\)/.test(body) || /`[^`]*\$\{rawDate\}\.jsonl`/.test(body)
  if (validatedDate && selectsDate) return true
  const delegates = {
    readAudit: ['readAuditDetailed', /\breadAuditDetailed\(\s*opts\s*\)/],
    verifyAuditChain: ['verifyAuditChainInternal', /\bverifyAuditChainInternal\(\s*opts\s*,\s*coverage\s*\)/],
  }
  const edge = delegates[name]
  return !!edge && edge[1].test(body) && dateReachesPath(src, edge[0])
}

// 正负回归共用真实判定器，丢参和下游不再按日期选文件都必须被拒。
function verifyDateFormats() {
  let checked = 0
  for (const quote of ['\'', '"']) {
    for (const newline of ['\n', '\r\n']) {
      for (const semicolon of ['', ';']) {
        for (const [name, target, extra] of [['readAudit', 'readAuditDetailed', ''], ['verifyAuditChain', 'verifyAuditChainInternal', ', coverage']]) {
          const binding = 'const rawDate = typeof opts.date === ' + quote + 'string' + quote + ' && /^\\d{4}-\\d{2}-\\d{2}$/.test(opts.date) ? opts.date : localDate()' + semicolon
          const direct = (selection) => ['function ' + target + '(opts' + extra + ') {', binding, 'return ' + selection + semicolon, '}'].join(newline)
          const wrapper = (argument) => 'function ' + name + '(opts = {}) { return ' + target + '(' + argument + extra + ')' + semicolon + ' }'
          const delegated = wrapper('opts') + newline + direct('auditDayFilesOf(rawDate)')
          const cases = [
            [direct('auditDayFilesOf(rawDate)').replace('function ' + target + '(', 'function ' + name + '('), true],
            [direct('`${rawDate}.jsonl`').replace('function ' + target + '(', 'function ' + name + '('), true],
            [delegated, true],
            [wrapper('{}') + newline + direct('auditDayFilesOf(rawDate)'), false],
            [wrapper('opts') + newline + direct('auditDayFilesOf(localDate())'), false],
          ]
          for (const [source, expected] of cases) {
            if (dateReachesPath(source, name) !== expected) throw new Error(`日期贯通回归失败：${name}，期望 ${expected}`)
            checked++
          }
        }
      }
    }
  }
  return checked
}
pass(`日期贯通正负格式回归 ${verifyDateFormats()} 项`)
for (const name of ['readAudit', 'verifyAuditChain']) {
  if (dateReachesPath(stateSrc, name)) pass(`${name} 的 opts.date 经校验后用于文件选择（含明确委托）`)
  else fail(`${name} 的 opts.date 未贯通到文件选择（date 参数可能静默失效）`)
}

console.log("\n" + "=".repeat(72));
if (failed) {
  console.log(`❌ 参数有效性检查失败：${failed} 项问题`);
  console.log("=".repeat(72));
  process.exit(1);
}
console.log("✅ 参数有效性检查全部通过");
console.log("=".repeat(72));
process.exit(0);