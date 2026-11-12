// 协议一致性守护 —— 防止 STATE_FIELDS 与 defaultState() 漂移
//
// 为什么需要这个测试：
// protocol.js 的 STATE_FIELDS 早先是一段**手写常量**，而 state.js 的 defaultState()
// 才是状态结构的唯一真源。两者各自演化，手写那份很快漏掉了 9 个字段
// （claimed、claimed_role、activation_pending、dispatch_baseline 等等，
// 连最近的 audit_axes、verdict_role、schemaVersion 也没跟上）。
// Agent 通过 flow_protocol 读到的是那份过期的字段表，于是按错误的字段名做决策 ——
// 这类漂移不会让任何现有用例变红，只能靠专门的一致性检查拦住。
//
// 现在 STATE_FIELDS 直接从 defaultState() 生成，本测试再钉一道：
// 字段名集合必须完全一致，手工改回常量、或只改一边，都会红。
import { strict as assert } from "node:assert";
import { PROTOCOL } from "../src/protocol.js";
import { defaultState } from "../src/state.js";

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    results.push(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    results.push(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
}

// ---- 1. STATE_FIELDS 必须是合法 JSON 对象 ----
let parsed = null;
let parseOk = true;
try {
  parsed = JSON.parse(PROTOCOL.STATE_FIELDS);
} catch (e) {
  parseOk = false;
}
check("1. STATE_FIELDS 是合法 JSON", parseOk, parseOk ? "" : String(e));

if (parseOk) {
  const declared = Object.keys(parsed).sort();
  const actual = Object.keys(defaultState()).sort();

  // ---- 2. 字段集合完全一致（双向） ----
  const missing = actual.filter((k) => !declared.includes(k));
  const extra = declared.filter((k) => !actual.includes(k));
  check(
    "2. STATE_FIELDS 字段集合与 defaultState() 完全一致",
    missing.length === 0 && extra.length === 0,
    missing.length ? `漏: ${missing.join(",")}` : (extra.length ? `多: ${extra.join(",")}` : `共 ${actual.length} 个字段`),
  );

  // ---- 3. 每个字段的默认值也要一致（不只是字段名） ----
  const valueDiff = [];
  for (const k of actual) {
    if (JSON.stringify(parsed[k]) !== JSON.stringify(defaultState()[k])) {
      valueDiff.push(`${k}: 协议=${JSON.stringify(parsed[k])} 实际=${JSON.stringify(defaultState()[k])}`);
    }
  }
  check(
    "3. 各字段默认值与 defaultState() 一致",
    valueDiff.length === 0,
    valueDiff.length ? valueDiff.join(" | ") : "",
  );
}

// ---- 4. ERROR_LAYERS 必须包含「门禁拒绝」层 ----
// 这一层是给 Agent 的关键指引：门禁拒绝不是工具坏了，不要重试同一调用。
check(
  "4. ERROR_LAYERS 含「门禁拒绝」层（避免 Agent 把门禁拒绝当工具故障而重试）",
  /门禁拒绝/.test(PROTOCOL.ERROR_LAYERS) && /不要重试同一调用/.test(PROTOCOL.ERROR_LAYERS),
  "",
);

// ---- 5. protocol.js 不得再出现手写 STATE_FIELDS 常量 ----
// 直接从源码文本层面钉住实现方式，防止有人图省事改回硬编码。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "protocol.js"), "utf8");
check(
  "5. protocol.js 从 defaultState() 生成 STATE_FIELDS（未回退为手写常量）",
  /STATE_FIELDS:\s*JSON\.stringify\(defaultState\(\)\)/.test(src),
  "",
);

console.log(results.join("\n"));
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail > 0 ? 1 : 0);
