#!/usr/bin/env node
// 门禁三：空壳检测。
// 逐个定位 TOOLS 数组中每个 handler，用「括号深度计数」精确切出函数体，
// 再判断体内是否存在真实副作用动作。避免旧版正则跨工具错位导致的假阳性。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(ROOT, "src/index.js"), "utf8");
const lines = src.split("\n");

// 白名单：确实应返回常量的纯文档型工具
const PURE_DOC_TOOLS = new Set(["flow_protocol"]);

// 真实副作用词表（含本项目实际使用的封装函数与 fs 操作）
const REAL_WORK =
  /\b(await|async|loadState|saveState|readManifest|saveAgentResult|buildRevertPlan|revertPlan|audit|spawn|spawnSync|execFileSync|execSync|readFileSync|writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|renameSync|copyFileSync|withStateLock|gitHead|verifyAuditChain|computeFingerprint|checkScope|enforceScope|parseCard|validateCard|sanitizeSid)\b/;

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

// 扫描每个 name:"flow_xxx" 之后最近的 handler: async (...) => { ，用括号深度切体
for (let i = 0; i < lines.length; i++) {
  const nm = /name:\s*"(flow_[a-z_]+)"/.exec(lines[i]);
  if (!nm) continue;
  const toolName = nm[1];

  // 向后找该工具的 handler 起点
  let hIdx = -1;
  for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
    if (/handler:\s*(async\s*)?\([^)]*\)\s*=>\s*\{/.test(lines[j])) { hIdx = j; break; }
    // 遇到下一个 name: 说明本工具没有独立 handler（异常），停止
    if (/name:\s*"flow_/.test(lines[j]) && j !== i) break;
  }
  if (hIdx === -1) continue;

  // 从 handler 的 { 开始做括号深度平衡扫描
  const startLine = lines[hIdx];
  const bracePos = startLine.indexOf("{");
  let depth = 0;
  let bodyLines = [];
  let closed = false;
  for (let k = hIdx; k < lines.length; k++) {
    const line = k === hIdx ? startLine.slice(bracePos) : lines[k];
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { bodyLines.push(line.slice(0, line.lastIndexOf("}"))); closed = true; break; }
      }
    }
    if (closed) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n");
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
