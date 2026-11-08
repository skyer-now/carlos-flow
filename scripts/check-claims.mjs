#!/usr/bin/env node
// check-claims.mjs — 「承诺兑现度」门禁
//
// 为什么要它：
// 现有的门禁（check:full / check:identity）查的是**静态一致性**
// ——「文档里写的版本号 == package.json 的版本号」「文档链接的文件存在」。
// 但 2026-11-07 的第三方审查发现的三个真问题，静态检查**一个都查不到**：
//
//   · enforceScope 从不自己跑 git diff，且 flow_dispatch 里零 scope 校验
//     → README 承诺的「越界直接阻断派发」根本不成立
//   · flow_audit 的 date 参数算出来了却没用 → 承诺的「按日期过滤」不成立
//   · CallTool handler 注册了两次 → 参数校验靠注册顺序维持，是死代码
//
// 共同点：**文档/描述承诺了 A，代码里实际做的是 B**。
// 所以本门禁直接检查「承诺 ↔ 代码路径」：
//
//   1. 工具描述里声明的能力，必须在 handler 里有对应实现
//   2. README 里点名的关键能力，必须在代码里有对应调用
//   3. 关键不变量（fail-closed / 真实验证 / 链式审计）必须在源码里出现
//
// 退出码：0 = 承诺全部兑现；1 = 有承诺未兑现（逐条打印）
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return null; } };

let failed = 0;
const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const section = (t) => console.log(`\n▶ ${t}`);

console.log("=".repeat(72));
console.log("Carlos Flow · 承诺兑现度门禁（文档/描述 ↔ 代码路径）");
console.log("=".repeat(72));

const indexSrc = read("src/index.js") || "";
const dispatchSrc = read("src/dispatch.js") || "";
const stateSrc = read("src/state.js") || "";
const readme = read("README.md") || "";

// ---- 1. README 承诺的关键能力必须在代码里有对应实现 ----
section("README 承诺 ↔ 代码实现");

const CLAIMS = [
  {
    claim: "越界改动会阻断（README：「越界直接阻断派发」）",
    // 判定：enforceScope 必须自己跑 git diff（不能只信调用方传的 paths），
    // 且 flow_verdict 必须调用它 —— 没有这一步，承诺就是空的。
    ok: () => /git["'\s,]+diff|--name-only/.test(dispatchSrc) &&
            /enforceScope/.test(dispatchSrc) &&
            /enforceScope/.test(indexSrc),
    hint: "enforceScope 需自己跑 git diff，且 flow_verdict 需调用它做增量比对",
  },
  {
    claim: "真实验证（README：真实 spawn 执行 verify.cmd）",
    ok: () => /runVerifyCommand/.test(indexSrc) && /spawn/.test(dispatchSrc),
    hint: "flow_run_verify 必须调用真实 spawn 的 runVerifyCommand",
  },
  {
    claim: "链式审计（README：SHA-256 链式哈希）",
    ok: () => /prevHash/.test(stateSrc) && /createHash|createHmac/.test(stateSrc),
    hint: "state.js 需实现 prevHash → hash 的链式结构",
  },
  {
    claim: "审计链防篡改（README：改一条全链断裂）",
    // 诚实要求：要么有密钥（HMAC，能发现有意篡改），
    // 要么 verify 结果里显式标注 mode（plain 只是弱保证，不能继续宣称防篡改）。
    ok: () => /createHmac/.test(stateSrc) && /mode/.test(stateSrc),
    hint: "需支持 HMAC（CARLOS_FLOW_AUDIT_KEY），并在 verify 结果里标注 mode",
  },
  {
    claim: "智能触发（README：flow_trigger_check 可实际激活）",
    ok: () => /flow_trigger_check/.test(indexSrc) && /activated/.test(indexSrc),
    hint: "flow_trigger_check 需真实执行激活步骤",
  },
  {
    claim: "独立复核角色（README：auditor 角色）",
    ok: () => /auditor/.test(indexSrc) && /auditor/.test(dispatchSrc),
    hint: "需存在 auditor 角色与对应合同",
  },
  {
    claim: "快照 + 还原（README：flow_revert_plan 生成原子还原计划）",
    ok: () => /snapshotFiles/.test(indexSrc) && /flow_revert_plan/.test(indexSrc),
    hint: "需实现快照与还原计划",
  },
  {
    claim: "派发配额（README：dispatch_count 只在派发时 +1）",
    ok: () => /dispatch_count/.test(indexSrc) && /MAX_DISPATCH/.test(indexSrc),
    hint: "需有 dispatch_count 与 MAX_DISPATCH 约束",
  },
  {
    claim: "免检自动清零（README：每次派发自动清零）",
    ok: () => /bypass_auto_reset/.test(indexSrc),
    hint: "派发后需清零 bypass 并记 bypass_auto_reset 审计",
  },
  {
    claim: "跨平台验证（README：Linux/macOS 也能跑）",
    ok: () => /\/bin\/sh/.test(dispatchSrc) || /COMSPEC/.test(dispatchSrc),
    hint: "runVerifyCommand 需按平台选 shell，不能硬编码 cmd.exe",
  },
];

for (const c of CLAIMS) {
  const ok = c.ok();
  if (ok) pass(c.claim);
  else fail(`${c.claim}\n     → ${c.hint}`);
}

// ---- 2. 工具描述里声明的参数必须真的被 handler 读取 ----
section("工具描述 ↔ handler 实现");

// 抽取每个工具的 description 与 handler 体
const toolBlocks = indexSrc.split(/\n  \{\n/).slice(1);
let paramIssues = 0;
for (const block of toolBlocks) {
  const nameM = block.match(/name:\s*"(flow_[a-z_]+)"/);
  if (!nameM) continue;
  const name = nameM[1];
  // 描述里点名的参数（中文或英文）→ 必须在 handler 里出现
  const descM = block.match(/description:\s*([\s\S]*?),\s*\n\s*inputSchema:/);
  const desc = descM ? descM[1] : "";
  const handlerM = block.match(/handler:\s*async\s*\(args\)\s*=>\s*\{([\s\S]*?)\n    \},\n  \},/);
  const handler = handlerM ? handlerM[1] : block;

  // 描述里提到「按日期过滤」→ handler/下游必须真的用 date
  if (/日期|date/i.test(desc) && /按.*date|date.*过滤/i.test(desc)) {
    if (!/a\.date|opts\.date|\bdate\b/.test(handler)) {
      fail(`工具 ${name} 的描述承诺支持 date 参数，但 handler 里没用到`);
      paramIssues++;
    }
  }
  // 描述里提到 scope 检查 → 必须调用 enforceScope
  if (/scope/.test(desc) && /检查|越界|范围/.test(desc)) {
    if (!/enforceScope/.test(handler) && !/enforceScope/.test(indexSrc.split(`name: "${name}"`)[1]?.slice(0, 4000) || "")) {
      fail(`工具 ${name} 的描述承诺做 scope 检查，但实现里没调用 enforceScope`);
      paramIssues++;
    }
  }
}
if (!paramIssues) pass("所有工具描述承诺的能力都有对应实现");

// ---- 3. 关键不变量必须在源码里出现 ----
section("关键不变量");

const INVARIANTS = [
  {
    name: "空 scope 必须 fail-closed（不能「白名单为空=随便改」）",
    ok: () => /scope\.length === 0[\s\S]{0,400}ok:\s*false/.test(dispatchSrc) ||
            /不允许修改任何文件/.test(dispatchSrc),
  },
  {
    name: "记 PASS 必须要求验证通过",
    ok: () => /lv\.ok !== true/.test(indexSrc) && /尚未执行验证/.test(indexSrc),
  },
  {
    name: "记 PASS 必须要求确实派发过",
    ok: () => /dispatch_count\) > 0/.test(indexSrc),
  },
  {
    name: "激活占位卡未补齐时不得派发/裁定",
    ok: () => /activation_pending/.test(indexSrc) &&
            /activation_pending/.test(indexSrc.split("flow_dispatch")[1]?.slice(0, 4000) || ""),
  },
  {
    name: "审计链必须含 prevHash 链接",
    ok: () => /rec\.prevHash = prev/.test(stateSrc),
  },
  {
    name: "状态目录不得写到仓库里（必须走 CARLOS_FLOW_HOME）",
    ok: () => /CARLOS_FLOW_HOME/.test(stateSrc) && !/FLOW_HOME\s*=\s*["']\.\//.test(stateSrc),
  },
];
for (const inv of INVARIANTS) {
  if (inv.ok()) pass(inv.name);
  else fail(inv.name);
}

console.log("\n" + "=".repeat(72));
if (failed) {
  console.log(`❌ 承诺兑现度检查失败：${failed} 项未兑现`);
  console.log("=".repeat(72));
  process.exit(1);
}
console.log("✅ 承诺兑现度检查全部通过");
console.log("=".repeat(72));
process.exit(0);