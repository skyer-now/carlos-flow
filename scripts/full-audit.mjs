// full-audit.mjs — 对外产物全面体检（身份 / 版本 / 文档 / 产物 / 源码 / 死链 / 工具清单）
//
// 为什么需要：
// 2026-11-07 单包合并后，仓库里散落着大量**双仓时代**的遗留：
// 指向已删除仓库的链接、硬编码旧包名的插件路径、开发者本机路径、
// 死链、ghost.json 工具清单缺 3 个（导致 Cindy 用户看不到它们）。
// 这些问题**不会让任何测试变红**，但会直接让用户看到错误信息。
// 所以要有一道「产物面向用户是否正确」的独立体检。
//
// 检查项：
//   1. 旧仓库 / 旧包名残留引用（区分「迁移文档里的正当提及」与「真实残留」）
//   2. 个人路径 / 开发者机路径残留
//   3. 版本号一致性（package.json / lock / ghost.json / TRIGGER_GUIDE / CHANGELOG / 各文档）
//   4. 文档内部死链
//   5. npm 发布集合完整性与敏感文件
//   6. 模板占位符（__ROOT__）与合法性
//   7. package.json 关键字段（bin / exports / scripts / repository）
//   8. scripts 与 CI 不再残留双仓逻辑
//   9. ghost.json 工具清单 vs 服务端实际工具
//
// 退出码：0 = 全部通过；1 = 发现问题
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const problems = [];
const notes = [];
const P = (cat, msg) => problems.push(`[${cat}] ${msg}`);
const N = (cat, msg) => notes.push(`[${cat}] ${msg}`);

const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return null; } };
const readJson = (p) => { const t = read(p); if (!t) return null; try { return JSON.parse(t); } catch (e) { return { __error: e.message }; } };

const pkg = readJson("package.json");
const VERSION = pkg?.version;

// ---- 个人路径模式：用「拼接」表达，避免本脚本自己被扫出来 ----
const PERSONAL_PATTERNS = [
  // 描述文字里也不能出现完整字面量 —— 否则本脚本自己会被扫出来。
  ["D:" + "/cindy", "硬编码开发者机路径（盘符 + 项目目录）"],
  ["D:" + "/dev-env", "硬编码开发者机路径（盘符 + 工具链目录）"],
  ["C:" + "/Users/EDY", "硬编码开发者机路径（盘符 + 用户目录）"],
  ["/home/" + "edy", "硬编码开发者机路径（家目录 + 用户名）"],
  ["opencode-" + "backups", "硬编码开发者机目录（旧备份目录名）"],
];

// ---- 旧包名：迁移文档里提及是正当的 ----
const LEGACY_NAMES = ["carlos-flow-" + "cindy", "carlos-flow-" + "opencode"];
// 这些文件里出现旧包名是**正当的**（迁移指引 / 版本历史 / 弃用说明）
const LEGACY_ALLOWED_FILES = /^(MIGRATION\.md|CHANGELOG\.md|README(\.zh|\.en)?\.md|RELEASE_NOTES\.md)$/;
// 这些文件里出现旧包名是**正当的**（脚本在讲「旧包名已废弃」这件事本身）
const LEGACY_ALLOWED_SCRIPTS = /^(scripts\/check-repo-parity\.mjs|scripts\/full-audit\.mjs|scripts\/mutation-check\.mjs|plugins\/carlos-flow-trigger\.js)$/;

const scanFiles = [];
const walk = (dir, depth = 0) => {
  if (depth > 3) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "docs") continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, depth + 1);
    else if (/\.(md|json|js|mjs|cjs|sh|yml|yaml|html)$/.test(e)) scanFiles.push(full);
  }
};
walk(ROOT);

const relOf = (f) => f.slice(ROOT.length + 1).replace(/\\/g, "/");

// ========== 1 + 2. 旧引用 / 个人路径 ==========
console.log("▶ 1. 旧引用与个人路径");
for (const f of scanFiles) {
  const rel = relOf(f);
  const text = readFileSync(f, "utf8");

  for (const name of LEGACY_NAMES) {
    const hits = text.match(new RegExp(name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"));
    if (!hits || !hits.length) continue;
    const legacyOk = LEGACY_ALLOWED_FILES.test(rel) || LEGACY_ALLOWED_SCRIPTS.test(rel);
    // package.json 的 bin 兼容别名是**刻意保留**的
    if (rel === "package.json" || rel === "package-lock.json") {
      N("旧引用", `${rel} 含兼容别名 ${name}（刻意保留）`);
      continue;
    }
    if (legacyOk) N("旧引用", `${rel} 提及旧包名 ${name}（迁移/弃用说明，正当）`);
    else P("旧引用", `${rel} 含旧包名 ${name}（需改为 carlos-flow）`);
  }

  for (const [pat, desc] of PERSONAL_PATTERNS) {
    const hits = text.split(pat).length - 1;
    if (!hits) continue;
    // CHANGELOG 是版本历史，刻意保留被修复路径的原样描述以便追溯
    if (rel === "CHANGELOG.md") { N("个人路径", `${rel} 含 ${hits} 处${desc}（版本历史，正当）`); continue; }
    P("个人路径", `${rel} 含 ${hits} 处${desc}`);
  }
}

// ========== 3. 版本号一致性 ==========
console.log("▶ 2. 版本号一致性");
const compareVer = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
const lockVer = readJson("package-lock.json")?.version;
const ghostVer = readJson("ghost.json")?.version;
const checks = [
  ["package-lock.json", lockVer],
  ["ghost.json", ghostVer],
];
for (const [f, v] of checks) {
  if (!v) P("版本", `${f} 读不到版本号`);
  else if (v !== VERSION) P("版本", `${f} = ${v}，package.json = ${VERSION}`);
}
const guideV = ((read("TRIGGER_GUIDE.md") || "").match(/\*\*版本\*\*\s*:\s*v?(\d+\.\d+\.\d+)/) || [])[1];
if (guideV !== VERSION) P("版本", `TRIGGER_GUIDE.md = ${guideV}，package.json = ${VERSION}`);
const changelogV = ((read("CHANGELOG.md") || "").match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
if (changelogV !== VERSION) P("版本", `CHANGELOG.md 顶部 = ${changelogV}，package.json = ${VERSION}`);
for (const f of ["README.md", "README.zh.md", "README.en.md", "MIGRATION.md", "RELEASE_NOTES.md"]) {
  const t = read(f);
  if (!t) { P("版本", `${f} 缺失`); continue; }
  const vers = [...new Set(t.match(/\b2\.\d+\.\d+\b/g) || [])];
  const future = vers.filter((v) => v !== VERSION && compareVer(v, VERSION) > 0);
  if (future.length) P("版本", `${f} 出现比当前版本更高的版本号：${future.join(", ")}`);
}

// ========== 4. 文档死链 ==========
console.log("▶ 3. 文档内部死链");
for (const f of ["README.md", "README.zh.md", "README.en.md", "MIGRATION.md", "TRIGGER_GUIDE.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
  const t = read(f);
  if (!t) continue;
  const links = [...t.matchAll(/\]\((\.[^)#]+)(#[^)]*)?\)/g)].map((m) => m[1]);
  for (const l of new Set(links)) {
    const target = resolve(dirname(join(ROOT, f)), l);
    if (!existsSync(target)) P("死链", `${f} → ${l}（目标不存在）`);
  }
}

// ========== 5. npm 发布集合 ==========
console.log("▶ 4. npm 发布集合");
const published = [];
const add = (rel) => {
  const full = join(ROOT, rel);
  if (!existsSync(full)) return;
  let st; try { st = statSync(full); } catch { return; }
  if (st.isDirectory()) for (const e of readdirSync(full)) add(rel.replace(/\/$/, "") + "/" + e);
  else published.push(rel.replace(/\\/g, "/"));
};
for (const f of pkg?.files || []) add(f);
const MUST_IN_PKG = [
  "client/carlos.js", "src/index.js", "src/trigger.js", "src/state.js", "src/protocol.js",
  "bridge/mcp-bridge.js", "plugins/carlos-flow-trigger.js", "ghost.json", "opencode.json",
  "opencode.json.template", ".mcprc.template", "trigger-config.usable.json",
  "templates/cursor/mcp.json", "templates/cline/mcp.json", "templates/vscode/mcp.json",
  "templates/claude/claude_desktop_config.json",
  "README.md", "README.zh.md", "README.en.md", "TRIGGER_GUIDE.md", "MIGRATION.md",
  "CHANGELOG.md", "LICENSE",
];
for (const f of MUST_IN_PKG) if (!published.includes(f)) P("包内容", `发布集合缺 ${f}`);
const FORBIDDEN = [/(^|\/)\.npmrc$/, /secret\.json$/, /\.b64$/, /\.bak$/, /\.pid$/, /^fix_/, /^debug_/];
for (const f of published) if (FORBIDDEN.some((re) => re.test(f))) P("包内容", `发布集合含敏感/临时文件 ${f}`);

// ========== 6. 模板 ==========
console.log("▶ 5. 模板占位符与合法性");
for (const tpl of ["ghost.json", "opencode.json", "templates/cursor/mcp.json", "templates/cline/mcp.json", "templates/vscode/mcp.json", "templates/claude/claude_desktop_config.json", "trigger-config.usable.json"]) {
  const j = readJson(tpl);
  if (!j) P("模板", `${tpl} 缺失`);
  else if (j.__error) P("模板", `${tpl} 不是合法 JSON：${j.__error}`);
}
// .mcprc.template 是 YAML（带注释），不能用 JSON 解析 —— 只检查关键字段存在
const mcprc = read(".mcprc.template") || "";
if (!mcprc.includes("carlos-flow")) P("模板", ".mcprc.template 未声明 carlos-flow");
if (!mcprc.includes("__ROOT__")) P("模板", ".mcprc.template 缺少 __ROOT__ 占位符");
for (const tpl of ["ghost.json", "opencode.json"]) {
  const t = read(tpl) || "";
  if (!t.includes("__ROOT__")) P("模板", `${tpl} 缺少 __ROOT__ 占位符（init 渲染不到实际路径）`);
}

// ========== 7. package.json 字段 ==========
console.log("▶ 6. package.json 字段");
if (pkg) {
  const bins = Object.keys(pkg.bin || {});
  for (const b of ["carlos-flow", "carlos-flow-cindy", "carlos-flow-opencode"]) {
    if (!bins.includes(b)) P("package.json", `bin 缺 ${b}`);
  }
  if (!pkg.repository?.url?.includes("carlos-flow.git")) P("package.json", "repository.url 不指向新仓库");
  if (!pkg.homepage?.includes("carlos-flow")) P("package.json", "homepage 不指向新仓库");
  if (!pkg.exports?.["./cindy"]) P("package.json", "exports 缺 ./cindy");
  if (!pkg.exports?.["./opencode"]) P("package.json", "exports 缺 ./opencode");
  for (const s of ["check:lang", "test:lang", "check:identity", "check:anchors", "test:all"]) {
    if (!pkg.scripts?.[s]) P("package.json", `scripts 缺 ${s}`);
  }
  if (!pkg.description || !/[一-鿿]/.test(pkg.description)) P("package.json", "description 非中文");
}

// ========== 8. 脚本与 CI 不残留双仓逻辑 ==========
console.log("▶ 7. 脚本与 CI");
const relScript = read("scripts/release.mjs") || "";
if (!relScript.includes('"carlos-flow"')) P("脚本", "release.mjs 未识别单包身份 carlos-flow");
if (/PEER_ID|PEER_PATH|repoPathOf/.test(relScript)) P("脚本", "release.mjs 仍残留双仓逻辑");
const ci = read(".github/workflows/ci.yml") || "";
if (/^\s*parity:/m.test(ci)) P("CI", "ci.yml 仍残留双仓 parity job");
if (/carlos-flow-cindy|carlos-flow-opencode/.test(ci)) P("CI", "ci.yml 仍残留旧仓库名");
const relWf = read(".github/workflows/release.yml") || "";
if (/carlos-flow-cindy|carlos-flow-opencode/.test(relWf)) P("CI", "release.yml 仍残留旧仓库名");

// ========== 9. ghost.json 工具清单 ==========
console.log("▶ 8. ghost.json 工具清单");
const ghostJson = readJson("ghost.json");
const idx = read("src/index.js") || "";
const uniqueServer = [...new Set([...idx.matchAll(/name:\s*"(flow_[a-z_]+)"/g)].map((m) => m[1]))];
const ghostTools = (ghostJson?.tools || []).map((t) => t.name);
if (ghostTools.length !== uniqueServer.length) {
  P("工具清单", `ghost.json 声明 ${ghostTools.length} 个，服务端实际 ${uniqueServer.length} 个`);
}
for (const t of uniqueServer) if (!ghostTools.includes(t)) P("工具清单", `ghost.json 缺工具 ${t}`);
for (const t of ghostTools) if (!uniqueServer.includes(t)) P("工具清单", `ghost.json 声明了服务端不存在的工具 ${t}`);

// ---- 输出 ----
console.log("\n" + "=".repeat(72));
console.log(problems.length === 0
  ? `✅ 产物全面体检通过（${notes.length} 条正当说明）`
  : `❌ 发现 ${problems.length} 个问题，${notes.length} 条正当说明`);
console.log("=".repeat(72));
for (const p of problems) console.log("❌ " + p);
if (process.env.SHOW_NOTES === "1") for (const n of notes) console.log("ℹ️  " + n);
process.exit(problems.length ? 1 : 0);