// check-mutant-anchors.mjs — 变异体锚点体检
//
// 作用：确认 scripts/mutation-check.mjs 里每个变异体的注入锚点**仍能命中当前源码**。
// 背景：锚点失效时 mutation-check 会记 SKIP（不假绿，但**失去了守护作用**），
// 而「13/13 全部被抓住」的报告仍可能因历史产物而看起来正常 —— 属于静默退化。
// 本脚本按 mutation-check 自己的解析方式求值 MUTANTS，并逐条比对（已做 CRLF→LF 归一化）。
//
// 用法：node scripts/check-mutant-anchors.mjs   （exit 0 = 全部命中）
// （复用脚本自己的解析，避免我的提取逻辑与脚本不一致）
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mutRaw = readFileSync(`${REPO}/scripts/mutation-check.mjs`, "utf8");

// 把 mutation-check.mjs 里的 MUTANTS 数组抠出来并求值
const arrStart = mutRaw.indexOf("const MUTANTS = [");
const arrEnd = mutRaw.indexOf("\n];", arrStart) + 3;
const arrSrc = mutRaw.slice(arrStart, arrEnd);
const MUTANTS = eval(arrSrc.replace("const MUTANTS =", "").trim());

const srcCache = new Map();
const readSrc = (f) => {
  if (!srcCache.has(f)) {
    try { srcCache.set(f, readFileSync(`${REPO}/${f}`, "utf8").replace(/\r\n/g, "\n")); }
    catch { srcCache.set(f, null); }
  }
  return srcCache.get(f);
};

let bad = 0;
const dup = new Map();
for (const m of MUTANTS) {
  const src = readSrc(m.file);
  let hit = false, kind = "";
  if (m.pattern) {
    kind = "正则";
    hit = !!src && m.pattern.test(src);
  } else {
    kind = "字符串";
    hit = !!src && src.includes(m.from);
  }
  if (!hit) bad++;
  if (m.from) {
    if (dup.has(m.from)) console.log(`  ⚠️ ${m.id} 与 ${dup.get(m.from)} 锚点完全相同`);
    else dup.set(m.from, m.id);
  }
  console.log(`  ${m.id.padEnd(26)}${hit ? "✅" : "❌"}  ${(m.file || "?").padEnd(16)}${kind}`);
}
console.log("");
console.log(bad ? `❌ ${bad}/${MUTANTS.length} 个锚点失效` : `✅ ${MUTANTS.length}/${MUTANTS.length} 锚点全部命中`);
process.exit(bad ? 1 : 0);
