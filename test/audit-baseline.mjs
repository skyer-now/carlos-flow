// 审计基线守护测试 —— 钉住 Standards 轴 prompt 的基线清单与判定词表
//
// 为什么需要这个测试：
//   · 坏味道基线是内联在 prompt 里的**代码常量**。有人删条目、扩条目、
//     或把判定词表改回「通过/违规/坏味道」，都不会让任何现有用例变红 ——
//     改之前全仓没有一条断言 prompt 内容的测试（基线被静默删掉，CI 照样全绿）。
//   · 判定词表必须与 flow_audit_submit 的 enum（PASS / WARN / FAIL）一致：
//     不一致时 subagent 输出自然语言、由主 Agent 手工映射，而
//     FAIL（硬拦）与 WARN（不拦）的差别就在这一步 —— 映射错了硬拦就失效。
//
// 这是纯函数级测试（不拉 Bridge），所以跑得快、断点清楚；
// 与双轴门禁的端到端行为（test/e2e-carlos.mjs 第 29 组）互补。
import { buildContractPrompt, SMELL_BASELINE } from "../src/dispatch.js";

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
}

const stdPrompt = buildContractPrompt("auditor", {}, "", "standards");
const specPrompt = buildContractPrompt("auditor", {}, "", "spec");
const execPrompt = buildContractPrompt("executor", { goal: "改点东西", scope: ["a.js"] }, "", undefined);
const plainAuditor = buildContractPrompt("auditor", { goal: "复核" }, "", undefined);

// 1. 基线条目齐全（一条都不能少）
const missing = SMELL_BASELINE.filter((s) => !stdPrompt.includes(s.name));
check("1. standards prompt 含全部坏味道基线条目名", missing.length === 0,
  missing.length ? "缺: " + missing.map((m) => m.name).join(", ") : `共 ${SMELL_BASELINE.length} 条`);

// 2. 条目名唯一（复制粘贴导致重名会让「逐条检查」变成同一条查两遍）
const names = SMELL_BASELINE.map((s) => s.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
check("2. 基线条目名无重复", dup.length === 0, dup.length ? "重名: " + dup.join(", ") : "");

// 3. 规模守护：误删条目必须让测试变红
check("3. 基线条目数 >= 18（误删即红）", SMELL_BASELINE.length >= 18, `实际 ${SMELL_BASELINE.length} 条`);

// 4. 每条都要有名称与中文说明（说明空了等于没给判定依据）
const noDesc = SMELL_BASELINE.filter((s) => !s.name || !s.desc);
check("4. 每条基线都有名称与中文说明", noDesc.length === 0, noDesc.length ? `缺: ${noDesc.length} 条` : "");

// 5-6. 判定词表必须与 enum（PASS / WARN / FAIL）对齐 —— 两轴都要
const stdWordOk = /判定（PASS \/ WARN \/ FAIL）/.test(stdPrompt) && !stdPrompt.includes("通过/违规/坏味道");
check("5. standards 判定词表为 PASS / WARN / FAIL", stdWordOk,
  stdWordOk ? "" : "与 flow_audit_submit 的 enum 不一致");
const specWordOk = /判定（PASS \/ WARN \/ FAIL）/.test(specPrompt) && !specPrompt.includes("通过/未实现验收/越界");
check("6. spec 判定词表为 PASS / WARN / FAIL", specWordOk,
  specWordOk ? "" : "与 flow_audit_submit 的 enum 不一致");

// 7-8. 基线不得泄漏进执行合同（executor 不该看到审计清单，会稀释它的注意力）
const leaked = SMELL_BASELINE.filter((s) => execPrompt.includes(s.name));
check("7. executor 合同 prompt 不含坏味道基线（不污染执行合同）", leaked.length === 0,
  leaked.length ? "泄漏: " + leaked.map((s) => s.name).join(", ") : "");
check("8. 无轴 auditor 合同不含坏味道基线",
  !SMELL_BASELINE.some((s) => plainAuditor.includes(s.name)));

// 9. 长度上限：清单会随每次 flow_audit_axes 派发进入 prompt，膨胀要挡住
check("9. standards prompt 长度 < 6000 字符（防 token 膨胀）", stdPrompt.length < 6000,
  `实际 ${stdPrompt.length} 字符`);

// 10. 出处标注：既要说清对齐来源，也要说清不是原书全表（不冒充权威）
check("10. 基线标注出处且声明非原书全表",
  stdPrompt.includes("Fowler") && stdPrompt.includes("非原书全表"));

console.log(results.join("\n"));
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail > 0 ? 1 : 0);
