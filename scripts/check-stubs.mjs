#!/usr/bin/env node
// 门禁三：空壳检测。
// 逐个解析 TOOLS 数组中的完整 handler，再判断体内是否存在真实副作用动作。
// 表达式箭头归一为 return，不跳过常量表达式空壳。
import { parseTools, loadImplementationSource } from './check-no-dead-handler.mjs'
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = loadImplementationSource(ROOT);

// 白名单：确实应返回常量的纯文档型工具
const PURE_DOC_TOOLS = new Set(["flow_protocol"]);

// 真实副作用词表（含本项目实际使用的封装函数与 fs 操作）
const REAL_WORK =
  /\b(callTool|await|async|loadState|saveState|writeUserMessage|getUserMessages|readManifest|saveAgentResult|buildRevertPlan|revertPlan|audit|spawn|spawnSync|execFileSync|execSync|readFileSync|writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|renameSync|copyFileSync|withStateLock|gitHead|verifyAuditChain|computeFingerprint|checkScope|enforceScope|parseCard|validateCard|sanitizeSid)\b/;

// 常量返回特征：整段函数体只有一个 return ok({...}) / return {...}，无任何其它语句
function isConstantReturn(body) {
  // 去掉空白后，若仅由单个 return 构成，视为常量返回
  const stripped = body.replace(/\s+/g, " ").trim();
  const m = /^return\s+(ok\()?\{[^]*\}\)?;?$/.test(stripped);
  // 进一步要求体内不含 await / 赋值 / 控制流 / 函数调用等实质语句
  const hasRealStatement = /[;{]\s*[A-Za-z_$]/.test(stripped) || /\.\w+\(/.test(stripped);
  return m && !hasRealStatement;
}

let failed = 0;
let checked = 0;
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); failed++; };

// 解析每个工具的完整处理器，沿用原副作用及常量返回判定。
for (const { name: toolName, handler: body } of parseTools(src)) {
  checked++;

  if (PURE_DOC_TOOLS.has(toolName)) { pass(`${toolName} 白名单（纯文档工具）`); continue; }

  const hasWork = REAL_WORK.test(body);
  if (!hasWork && isConstantReturn(body)) {
    fail(`STUB: ${toolName} handler 是常量返回，不执行任何逻辑`);
  } else if (!hasWork) {
    fail(`SUSPECT: ${toolName} handler 无可识别的真实副作用动作`);
  } else {
    pass(`${toolName} 有真实逻辑`);
  }
}

console.log(`\n共检查 ${checked} 个工具 handler`);
if (failed) {
  console.log(`❌ 空壳检测失败：${failed} 项可疑`);
  process.exit(1);
} else {
  console.log("✅ 空壳检测全部通过");
  process.exit(0);
}
