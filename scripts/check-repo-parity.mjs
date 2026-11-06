#!/usr/bin/env node
// check-repo-parity.mjs — 双仓一致性守卫（cindy ↔ opencode）
//
// 目的：防止「跨仓同步」时把某一版的文件整份覆盖到另一版，
// 导致两个适配版身份混淆（例如 opencode 仓的 README 变成「Cindy 适配版」）。
//
// 判定规则（与 scripts/release.mjs 的双仓发布链路配套）：
//   1) 【必须逐字一致】核心逻辑 src/ + test/ + scripts/ + CI —— 任一不同即报错；
//   2) 【必须各自不同】版本专属文件 —— 出现在对方仓里即报错（交叉污染）；
//   3) 【必须指向自己】身份标识 —— README 标题 / package.json name / description
//      若指向对方版本，即报错；
//   4) 【允许不同】package.json 的 name/description/keywords/repository/files/scripts。
//
// 用法：
//   node scripts/check-repo-parity.mjs            # 检查（默认对方仓在 ../carlos-flow-<other>）
//   node scripts/check-repo-parity.mjs --check    # 同上（默认即 check）
//   node scripts/check-repo-parity.mjs <对方仓路径> --write
//
// 退出码：0 = 一致；1 = 发现不一致（并打印逐条明细）。
//
// 说明：比较时忽略行尾符（CRLF/LF）——两仓 .gitattributes / core.autocrlf 不同，
//       同一份内容在不同机器上落盘可能行尾不同，那不是实质差异。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, relative, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = resolve(HERE, "..");
const SELF_NAME = basename(SELF_ROOT).replace(/^carlos-flow-/, "");
const PEER_NAME = SELF_NAME === "cindy" ? "opencode" : "cindy";

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const peerArg = argv.find((a) => !a.startsWith("--"));
const PEER_ROOT = resolve(peerArg || join(SELF_ROOT, "..", `carlos-flow-${PEER_NAME}`));

// ---- 必须逐字一致的文件清单（核心逻辑，双仓同源） ----
const MUST_MATCH = [
  "src/index.js",
  "src/card.js",
  "src/state.js",
  "src/trigger.js",
  "src/dispatch.js",
  "src/protocol.js",
  "test/e2e-carlos.mjs",
  "test/p0-gates.mjs",
  "test/trigger-e2e.mjs",
  "test/concurrency-e2e.mjs",
  "test/smoke.js",
  "scripts/mutation-check.mjs",
  "scripts/release.mjs",
  "scripts/sync-readme.mjs",
  "scripts/clean-readme-noise.mjs",
  "scripts/verify-activation-e2e.sh",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "CHANGELOG.md",
  "TRIGGER_GUIDE.md",
  "docs/QA_REPORT_v2.5.5.md",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
];

// ---- 版本专属文件：只能出现在自己这一侧 ----
// 格式：[文件, 归属版本]  —— 归属版本出现在对方仓里 = 交叉污染
const OWNED_BY = [
  // Cindy 专属
  ["ghost.json", "cindy"],
  ["settings.html", "cindy"],
  ["settings.js", "cindy"],
  ["bridge", "cindy"],
  // OpenCode 专属
  [".mcprc.template", "opencode"],
  ["opencode.json.template", "opencode"],
  ["carlos.js", "opencode"],
];

// ---- 身份标识：README / package.json 必须指向自己 ----
// 两仓共用同一套正则，靠 SELF_NAME 动态选择「自己」与「对方」。
const labelZh = SELF_NAME === "cindy" ? "Cindy" : "OpenCode";
const labelEn = labelZh;
const peerLabelZh = PEER_NAME === "cindy" ? "Cindy" : "OpenCode";
const peerLabelEn = peerLabelZh;

const IDENTITY_CHECKS = [
  {
    file: "README.md",
    selfMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${labelZh}\\s*适配版`),
    peerMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${peerLabelZh}\\s*适配版`),
    label: "README.md 标题",
  },
  {
    file: "README.zh.md",
    selfMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${labelZh}\\s*适配版`),
    peerMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${peerLabelZh}\\s*适配版`),
    label: "README.zh.md 标题",
  },
  {
    file: "README.en.md",
    selfMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${labelEn}\\s*Edition`),
    peerMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${peerLabelEn}\\s*Edition`),
    label: "README.en.md 标题",
  },
];

// ---- 工具 ----
const readText = (root, rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
};
// 归一化：去掉行尾符差异（CRLF → LF），其余原样保留
const norm = (s) => (s === null ? null : s.replace(/\r\n/g, "\n"));

const problems = [];
const notes = [];
const okCount = { match: 0, owned: 0, identity: 0 };

// ---- 1) 核心逻辑必须逐字一致 ----
for (const rel of MUST_MATCH) {
  const a = norm(readText(SELF_ROOT, rel));
  const b = norm(readText(PEER_ROOT, rel));
  if (a === null && b === null) {
    notes.push(`SKIP  ${rel}（两仓都不存在）`);
    continue;
  }
  if (a === null || b === null) {
    problems.push(`MISSING  ${rel}：只存在于 ${a === null ? PEER_NAME : SELF_NAME} 一侧 —— 核心逻辑文件必须两仓同时存在`);
    continue;
  }
  if (a === b) {
    okCount.match++;
  } else {
    problems.push(`DIFF    ${rel}：核心逻辑与 ${PEER_NAME} 不一致 —— 必须逐字相同（跨仓同步时只做定向补丁，禁止整份覆盖）`);
  }
}

// ---- 2) 版本专属文件不得交叉 ----
for (const [rel, owner] of OWNED_BY) {
  const inSelf = existsSync(join(SELF_ROOT, rel));
  const inPeer = existsSync(join(PEER_ROOT, rel));
  if (owner === SELF_NAME) {
    if (!inSelf) {
      notes.push(`NOTE    ${rel}：${SELF_NAME} 版应有此文件但缺失`);
    } else if (inPeer) {
      problems.push(`POLLUTE ${rel}：属于 ${owner} 版，却出现在 ${PEER_NAME} 仓 —— 版本专属文件交叉污染`);
    } else {
      okCount.owned++;
    }
  } else {
    if (inSelf) {
      problems.push(`POLLUTE ${rel}：属于 ${owner} 版，却出现在 ${SELF_NAME} 仓 —— 版本专属文件交叉污染`);
    } else if (!inPeer) {
      notes.push(`NOTE    ${rel}：${owner} 版应有此文件但缺失`);
    } else {
      okCount.owned++;
    }
  }
}

// ---- 3) 身份标识必须指向自己 ----
const pkg = JSON.parse(readText(SELF_ROOT, "package.json") || "{}");
const peerPkg = JSON.parse(readText(PEER_ROOT, "package.json") || "{}");

if (pkg.name && !pkg.name.endsWith(`-${SELF_NAME}`)) {
  problems.push(`IDENT   package.json name="${pkg.name}" 与本仓身份（-${SELF_NAME}）不符`);
} else {
  okCount.identity++;
}
if (peerPkg.name && peerPkg.name.endsWith(`-${SELF_NAME}`)) {
  problems.push(`IDENT   对方 package.json name="${peerPkg.name}" 与 ${PEER_NAME} 身份不符`);
}

for (const chk of IDENTITY_CHECKS) {
  const txt = readText(SELF_ROOT, chk.file);
  if (txt === null) {
    problems.push(`MISSING ${chk.file}：本仓缺少该文件`);
    continue;
  }
  if (chk.peerMust.test(txt)) {
    problems.push(`IDENT   ${chk.label} 写成了对方版本（${PEER_NAME}）—— 本仓必须声明自己是 ${SELF_NAME} 版`);
    continue;
  }
  if (!chk.selfMust.test(txt)) {
    problems.push(`IDENT   ${chk.label} 未声明本仓身份（${SELF_NAME}）—— 期望匹配 ${chk.selfMust}`);
    continue;
  }
  okCount.identity++;
}

// ---- 3b) 对方仓的身份也要检查（双向）----
// 只查本仓是不够的：事故往往是「某一版被污染」，而从另一个方向跑守卫时
// 同样必须能发现。否则 cindy 仓的 CI 看不到 opencode 仓被覆盖成 Cindy 版。
const PEER_IDENTITY_CHECKS = [
  {
    file: "README.md",
    peerSelfMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${peerLabelZh}\\s*适配版`),
    peerPeerMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${labelZh}\\s*适配版`),
    label: "README.md 标题",
  },
  {
    file: "README.zh.md",
    peerSelfMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${peerLabelZh}\\s*适配版`),
    peerPeerMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${labelZh}\\s*适配版`),
    label: "README.zh.md 标题",
  },
  {
    file: "README.en.md",
    peerSelfMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${peerLabelEn}\\s*Edition`),
    peerPeerMust: new RegExp(`#\\s*Carlos Flow\\s*—\\s*${labelEn}\\s*Edition`),
    label: "README.en.md 标题",
  },
];

for (const chk of PEER_IDENTITY_CHECKS) {
  const peerTxt = readText(PEER_ROOT, chk.file);
  if (peerTxt === null) {
    problems.push(`MISSING 对方仓 ${chk.file}：${PEER_NAME} 仓缺少该文件`);
    continue;
  }
  if (chk.peerPeerMust.test(peerTxt)) {
    problems.push(`IDENT   对方仓 ${chk.label} 写成了本仓版本（${SELF_NAME}）—— ${PEER_NAME} 仓的身份被污染了`);
    continue;
  }
  if (!chk.peerSelfMust.test(peerTxt)) {
    problems.push(`IDENT   对方仓 ${chk.label} 未声明自己是 ${PEER_NAME} 版 —— ${PEER_NAME} 仓的身份被污染了`);
    continue;
  }
  okCount.identity++;
}

// ---- 4) package.json 描述不得指向对方 ----
if (typeof pkg.description === "string") {
  const otherLabel = SELF_NAME === "cindy" ? "OpenCode" : "Cindy";
  const selfLabel = SELF_NAME === "cindy" ? "Cindy" : "OpenCode";
  if (pkg.description.includes(otherLabel + " 适配版")) {
    problems.push(`IDENT   package.json description 指向了 ${otherLabel} 版：「${pkg.description}」`);
  } else if (!pkg.description.includes(selfLabel + " 适配版")) {
    problems.push(`IDENT   package.json description 未声明 ${selfLabel} 版：「${pkg.description}」`);
  }
}

// ---- 输出 ----
console.log("=".repeat(64));
console.log("Carlos Flow 双仓一致性守卫");
console.log(`  本仓: ${SELF_NAME.padEnd(8)} ${SELF_ROOT}`);
console.log(`  对方: ${PEER_NAME.padEnd(8)} ${PEER_ROOT}`);
console.log("=".repeat(64));
console.log(`核心逻辑一致: ${okCount.match}/${MUST_MATCH.length}`);
console.log(`专属文件归属: ${okCount.owned}/${OWNED_BY.length}`);
console.log(`身份标识:     ${okCount.identity}`);
console.log("");

if (notes.length) {
  console.log("提示：");
  for (const n of notes) console.log("  " + n);
  console.log("");
}

if (problems.length === 0) {
  console.log("✅ 两仓一致：核心逻辑逐字相同、版本专属文件无交叉、身份标识各自正确。");
  process.exit(0);
}

console.log(`❌ 发现 ${problems.length} 处不一致：`);
for (const p of problems) console.log("  " + p);
console.log("");
console.log("修复原则：");
console.log("  · 核心逻辑（src/ test/ scripts/ CI）—— 以一版为准，逐字同步到另一版；");
console.log("  · 身份与文档（README / SECURITY / CONTRIBUTING）—— 各自保留本版表述，禁止整份覆盖；");
console.log("  · 版本专属文件—— 只留在属于自己的那一仓。");
process.exit(1);
