#!/usr/bin/env node
// check-repo-parity.mjs — 单包一致性守卫（v2.6.0+）
//
// 历史背景：v2.5.x 是「双仓架构」（carlos-flow-cindy + carlos-flow-opencode），
// 这个脚本负责防止跨仓同步时把某一版的文件整份覆盖到另一版，
// 导致两个适配版身份混淆（例如 opencode 仓的 README 变成「Cindy 适配版」）。
//
// v2.6.0 起合并为**单一包** carlos-flow，双仓比对已无意义 ——
// 跨版本漂移的根因（两份核心逻辑各自维护）已经消除。
// 但「身份一致性」这个诉求依然成立，且更重要：单一包对外宣称自己是
// 一个统一的六平台产品，任何一处版本号/文档/清单不一致都会直接暴露给用户。
//
// 所以本脚本从「双仓比对」重构为「单包身份与产物一致性守卫」：
//   1) 【身份】package.json.name 必须是 carlos-flow（不是旧的 -cindy / -opencode）
//   2) 【版本】package.json / package-lock.json / ghost.json / TRIGGER_GUIDE.md
//      四处版本号必须完全一致
//   3) 【文档】README.md 与 README.zh.md 必须逐字一致（双语不漂移）
//      README.en.md 必须是英文版（不是中文副本）
//   4) 【产物】npm 包内容必须包含 6 平台初始化所需的全部文件，
//      且不含敏感/临时文件（.npmrc / secret / .bak / fix_ / debug_）
//   5) 【模板】templates/ 下 4 套模板 + opencode.json.template + .mcprc.template
//      必须存在且是合法 JSON
//
// 用法：
//   node scripts/check-repo-parity.mjs            # 检查
//   node scripts/check-repo-parity.mjs --check    # 同上（默认即 check）
//
// 退出码：0 = 一致；1 = 发现不一致（逐条打印明细）。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let failed = 0;
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); failed++; };
const section = (title) => console.log(`\n▶ ${title}`);

console.log("=".repeat(64));
console.log("Carlos Flow 单包一致性守卫（身份 / 版本 / 文档 / 产物）");
console.log(`  仓库: ${ROOT}`);
console.log("=".repeat(64));

const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };

// ---- 1. 身份 ----
section("身份（package.json.name）");
const pkg = readJson(join(ROOT, "package.json"));
if (!pkg) {
  fail("package.json 读不到或不是合法 JSON");
} else if (pkg.name !== "carlos-flow") {
  fail(`package.json.name = "${pkg.name}"，期望 "carlos-flow"（v2.5.x 的 carlos-flow-cindy / carlos-flow-opencode 已废弃）`);
} else {
  pass(`package.json.name = carlos-flow`);
}

// ---- 2. 版本一致 ----
section("版本一致性（package.json / lock / ghost.json / TRIGGER_GUIDE.md）");
if (pkg) {
  const ver = pkg.version;
  const lock = readJson(join(ROOT, "package-lock.json"));
  const lockVer = lock && (lock.version || (lock.packages && lock.packages[""] && lock.packages[""].version));
  if (lockVer === ver) pass(`package-lock.json = ${lockVer}`);
  else fail(`package-lock.json = ${lockVer || "(读不到)"}，期望 ${ver}（release.yml 的 npm ci 会因此失败）`);

  const ghost = readJson(join(ROOT, "ghost.json"));
  if (ghost) {
    if (ghost.version === ver) pass(`ghost.json = ${ghost.version}`);
    else fail(`ghost.json = ${ghost.version}，期望 ${ver}（Cindy 插件市场会显示这个版本号）`);
  } else {
    fail("ghost.json 读不到或不是合法 JSON");
  }

  const guide = readText(join(ROOT, "TRIGGER_GUIDE.md")) || "";
  const m = guide.match(/\*\*版本\*\*\s*:\s*v?(\d+\.\d+\.\d+)/);
  if (m && m[1] === ver) pass(`TRIGGER_GUIDE.md = ${m[1]}`);
  else fail(`TRIGGER_GUIDE.md 版本 = ${m ? m[1] : "(提取不到)"}，期望 ${ver}`);

  const changelog = readText(join(ROOT, "CHANGELOG.md")) || "";
  const topVer = (changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
  if (topVer === ver) pass(`CHANGELOG.md 顶部 = ${topVer}`);
  else fail(`CHANGELOG.md 顶部 = ${topVer || "(提取不到)"}，期望 ${ver}`);
}

// ---- 3. 文档一致性 ----
section("文档一致性（中英双语零漂移）");
const readme = readText(join(ROOT, "README.md"));
const readmeZh = readText(join(ROOT, "README.zh.md"));
const readmeEn = readText(join(ROOT, "README.en.md"));

if (readme && readmeZh) {
  if (readme === readmeZh) pass("README.md == README.zh.md");
  else fail("README.md 与 README.zh.md 不一致（跑 npm run sync:readme）");
} else {
  fail("README.md 或 README.zh.md 缺失");
}

if (readme && readmeEn) {
  const navOk = readme.includes("(README.en.md)") && readme.includes("(README.zh.md)");
  if (navOk) pass("README.md 含语言切换导航栏");
  else fail("README.md 缺语言切换导航栏");
  const enLooksZh = /^#\s+.*(中文)/m.test(readmeEn.split("\n").slice(0, 12).join("\n"));
  if (enLooksZh) fail("README.en.md 看起来是中文版（复制错了）");
  else pass("README.en.md 是英文版");
} else {
  fail("README.en.md 缺失");
}

if (readme) {
  for (const link of ["./MIGRATION.md", "./TRIGGER_GUIDE.md", "./CHANGELOG.md"]) {
    if (readme.includes(link)) pass(`README.md 链接到 ${link}`);
    else fail(`README.md 未链接到 ${link}`);
  }
}

// ---- 4. 产物内容 ----
section("产物内容（npm 包必须包含的文件）");
const REQUIRED_FILES = [
  "client/carlos.js",
  "src/index.js",
  "src/trigger.js",
  "src/state.js",
  "bridge/mcp-bridge.js",
  "plugins/carlos-flow-trigger.js",
  "ghost.json",
  "opencode.json",
  "opencode.json.template",
  ".mcprc.template",
  "trigger-config.usable.json",
  "templates/cursor/mcp.json",
  "templates/cline/mcp.json",
  "templates/vscode/mcp.json",
  "templates/claude/claude_desktop_config.json",
  "README.md",
  "README.zh.md",
  "README.en.md",
  "TRIGGER_GUIDE.md",
  "MIGRATION.md",
  "CHANGELOG.md",
  "LICENSE",
];
for (const f of REQUIRED_FILES) {
  if (existsSync(join(ROOT, f))) pass(f);
  else fail(`缺少 ${f}`);
}

// ---- 5. 模板必须是合法 JSON ----
section("模板合法性（必须是合法 JSON，不能带注释）");
const JSON_FILES = [
  "ghost.json",
  "opencode.json",
  "templates/cursor/mcp.json",
  "templates/cline/mcp.json",
  "templates/vscode/mcp.json",
  "templates/claude/claude_desktop_config.json",
  "trigger-config.usable.json",
];
for (const f of JSON_FILES) {
  const j = readJson(join(ROOT, f));
  if (j) pass(`${f} 是合法 JSON`);
  else fail(`${f} 不是合法 JSON（含注释或语法错误）`);
}

// ---- 6. 敏感文件不得进包 ----
section("敏感 / 临时文件（不得随包分发）");
// 判定对象是「**实际会被发布的那批文件**」，而不是工作区里的所有文件 ——
// 工作区可以有 .npmrc.local 这类本机凭据文件（已被 .gitignore 排除），
// 但它们绝不能出现在 npm 包里。按 package.json 的 files 白名单推导发布集合。
const publishedSet = (() => {
  const out = [];
  const filesList = Array.isArray(pkg && pkg.files) ? pkg.files : [];
  const add = (rel) => {
    const full = join(ROOT, rel);
    if (!existsSync(full)) return;
    let st;
    try { st = statSync(full); } catch { return; }
    if (st.isDirectory()) {
      for (const e of readdirSync(full)) add(rel.replace(/\/$/, "") + "/" + e);
    } else {
      out.push(rel.replace(/\\/g, "/"));
    }
  };
  for (const f of filesList) add(f);
  return out;
})();

const FORBIDDEN = [/^\.npmrc$/, /^\.npmrc\.local$/, /secret\.json$/, /\.b64$/, /\.bak$/, /^fix_/, /^debug_/, /^\.mutation-report\.md$/, /\.pid$/];
let bad = 0;
for (const rel of publishedSet) {
  if (FORBIDDEN.some((re) => re.test(rel))) {
    fail(`发布集合里含敏感/临时文件：${rel}`);
    bad++;
  }
}
if (!bad) pass(`发布集合无敏感/临时文件（共 ${publishedSet.length} 个文件）`);

// .npmrc 模板本身允许入库，但必须确认里面**没有真 token**
const npmrcText = readText(join(ROOT, ".npmrc")) || "";
if (/^\s*\/\/registry\.npmjs\.org\/:_authToken=\s*\$\{[^}]+\}/m.test(npmrcText) ||
    (/^\s*#/m.test(npmrcText) && !/_authToken\s*=\s*npm_/m.test(npmrcText))) {
  pass(".npmrc 是模板（无真实凭据）");
} else {
  fail(".npmrc 里出现了真实 token —— 不得入库");
}

console.log("\n" + "=".repeat(64));
if (failed) {
  console.log(`❌ 单包一致性检查失败：${failed} 项不通过`);
  console.log("=".repeat(64));
  process.exit(1);
}
console.log("✅ 单包一致性检查全部通过");
console.log("=".repeat(64));
process.exit(0);