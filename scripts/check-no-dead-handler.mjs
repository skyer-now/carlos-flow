#!/usr/bin/env node
// check-no-dead-handler.mjs — 禁止重复注册同一 request schema
//
// 为什么要它：
// 2026-11-07 的第三方审查发现 src/index.js 里 CallToolRequestSchema
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };

console.log("=".repeat(72));
console.log("Carlos Flow · 重复注册门禁（同一 request schema 只能注册一次）");
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
  const toolsM = src.match(/const TOOLS = \[([\s\S]*?)\n\];/);
  const declared = toolsM
    ? [...toolsM[1].matchAll(/name:\s*"(flow_[a-z_]+)"/g)].map((x) => x[1])
    : [];
  const hasDispatchLookup = /TOOLS\.find\([\s\S]{0,80}?\.name\s*===/.test(src);
  if (hasDispatchLookup) pass("CallTool handler 通过 TOOLS.find 分发到工具实现");
  else fail("CallTool handler 找不到按 name 分发到工具实现的逻辑");
  const hasValidation = /validateToolArgs\(/.test(src);
  if (hasValidation) pass("CallTool handler 调用了 validateToolArgs（参数校验未丢失）");
  else fail("CallTool handler 没有调用 validateToolArgs —— 参数校验可能已丢失");
  if (declared.length === 15) pass(`TOOLS 声明 ${declared.length} 个工具`);
  else fail(`TOOLS 声明了 ${declared.length} 个工具（期望 15）`);
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