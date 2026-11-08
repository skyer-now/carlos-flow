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

const indexSrc = read("src/index.js") || "";
const stateSrc = read("src/state.js") || "";

/** 从 src 的第 idx 个字符开始（idx 指向 '{'），返回配对括号内的内容与结束位置 */
function matchBraces(src, idx) {
  if (src[idx] !== "{") return null;
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(idx + 1, i), end: i };
    }
  }
  return null;
}

/** 抽取 TOOLS 数组内容 */
function extractTools(src) {
  const arrStart = src.indexOf("const TOOLS = [");
  if (arrStart < 0) return [];
  const arrBody = src.slice(arrStart);
  const end = arrBody.indexOf("\n];");
  const list = arrBody.slice(0, end < 0 ? arrBody.length : end);

  const tools = [];
  const re = /name:\s*"(flow_[a-z_]+)"/g;
  const marks = [];
  let m;
  while ((m = re.exec(list)) !== null) marks.push({ name: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at;
    const stop = i + 1 < marks.length ? marks[i + 1].at : list.length;
    const block = list.slice(start, stop);

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
        const depthOf = (pos) => {
          let d = 0;
          for (let i = 0; i < pos; i++) {
            if (pBlock.body[i] === "{") d++;
            else if (pBlock.body[i] === "}") d--;
          }
          return d;
        };
        const keyRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g;
        let km;
        while ((km = keyRe.exec(pBlock.body)) !== null) {
          if (depthOf(km.index) === 0) props.push(km[1]);
        }
      }
    }
    // handler 体
    const hAt = block.indexOf("handler:");
    let handler = "";
    if (hAt >= 0) {
      const hOpen = block.indexOf("{", hAt);
      const hBlock = hOpen >= 0 ? matchBraces(block, hOpen) : null;
      handler = hBlock ? hBlock.body : block.slice(hAt);
    }
    tools.push({ name: marks[i].name, props, handler });
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
  const b = open >= 0 ? matchBraces(src, open) : null;
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
    let stmtEnd = src.indexOf(";", m.index);
    if (stmtEnd < 0) continue;
    const after = src.slice(stmtEnd + 1);
    if (!new RegExp(`\\b${name}\\b`).test(after)) deadVars.push(name);
  }
  if (deadVars.length) {
    fail(`${file}：存在「算出却从未使用」的死变量 → ${deadVars.join(", ")}`);
  }
}
if (!failed) pass("没有「算出却从未使用」的死变量");

// ---- 专项：opts.date 必须在下游真的用上 ----
section("date 参数贯通检查");
const readAuditBody = extractFunction(stateSrc, "readAudit");
const verifyBody = extractFunction(stateSrc, "verifyAuditChain");
const usesDate = (b) => b && /rawDate[}`]*\.jsonl/.test(b);
if (usesDate(readAuditBody)) pass("readAudit 用 rawDate 构造文件路径");
else fail("readAudit 没有用 rawDate 构造文件路径（date 参数静默失效）");
if (usesDate(verifyBody)) pass("verifyAuditChain 用 rawDate 构造文件路径");
else fail("verifyAuditChain 没有用 rawDate 构造文件路径（date 参数静默失效）");

console.log("\n" + "=".repeat(72));
if (failed) {
  console.log(`❌ 参数有效性检查失败：${failed} 项问题`);
  console.log("=".repeat(72));
  process.exit(1);
}
console.log("✅ 参数有效性检查全部通过");
console.log("=".repeat(72));
process.exit(0);