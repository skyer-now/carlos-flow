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
import { createContext, Script } from 'node:vm'
import { parseTools } from './check-no-dead-handler.mjs'
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
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
    // .mutation-report.md 是 mutation-check 跑完写的**生成产物**（已 gitignore），
    // 它的表头本来就会讲「旧包名」这件事 —— 扫进来只会产生假红。
    if (e === "node_modules" || e === ".git" || e === "docs" || e === ".mutation-report.md") continue;
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
const lock = readJson("package-lock.json");
const lockVersions = [lock?.version, lock?.packages?.[""]?.version].filter(Boolean);
for (const v of new Set(lockVersions)) {
  if (v !== VERSION) P("版本", `package-lock.json 版本 = ${v}，package.json = ${VERSION}`);
}
const ghostVer = readJson("ghost.json")?.version;
const checks = [
  ["ghost.json", ghostVer],
];
for (const [f, v] of checks) {
  if (!v) P("版本", `${f} 读不到版本号`);
  else if (v !== VERSION) P("版本", `${f} = ${v}，package.json = ${VERSION}`);
}
// 版本号提取：冒号可能是半角 `:` 或全角 `：`（Markdown 里两种都常见）。
// 旧实现只认半角，于是「**版本**：v2.6.0」这种全角写法会被**漏检** ——
// 结果是升版本时只改了一半，文档里留下旧版本号。
const guideText = read("TRIGGER_GUIDE.md") || "";
const guideV = (guideText.match(/\*\*版本\*\*\s*[:：]\s*v?(\d+\.\d+\.\d+)/) || [])[1];
const guideVs = [...guideText.matchAll(/\*\*版本\*\*\s*[:：]\s*v?(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
if (guideV !== VERSION) P("版本", `TRIGGER_GUIDE.md = ${guideV}，package.json = ${VERSION}`);
if (new Set(guideVs).size > 1) {
  P("版本", `TRIGGER_GUIDE.md 出现多个版本号：${[...new Set(guideVs)].join(", ")}（升版本时漏改）`);
}
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
for (const tpl of ["opencode.json"]) {
  const t = read(tpl) || "";
  if (!t.includes("__ROOT__")) P("模板", `${tpl} 缺少 __ROOT__ 占位符（init 渲染不到实际路径）`);
}
// ghost.json 是**插件包清单**：chip 形态下 entry / node.entry 都是包内相对路径，
// 由 client/carlos.js 的 renderRelativeEntries 在 `init --target cindy` 时渲染成绝对路径。
// 因此它两种形态都合法，但必须自洽：
//   · 有 __ROOT__ → 渲染后必须是合法 JSON（老式绝对路径清单）
//   · 没有 __ROOT__ → 所有引用文件必须真实存在于仓库里（相对路径清单）
{
  const ghostRaw = read("ghost.json") || "";
  if (ghostRaw.includes("__ROOT__")) {
    const rendered = ghostRaw.replace(/__ROOT__/g, JSON.stringify(process.cwd()).slice(1, -1));
    if (!readJsonText(rendered)) P("模板", "ghost.json 含 __ROOT__，但渲染后不是合法 JSON");
  } else {
    const refs = [];
    const m = ghostRaw.match(/"entry"\s*:\s*"([^"]+)"/g) || [];
    for (const line of m) refs.push(line.replace(/^"entry"\s*:\s*"/, "").replace(/"$/, ""));
    if (ghostRaw.includes('"entry"') && refs.length === 0) P("模板", "ghost.json 的 entry 解析不出来");
    for (const ref of refs) {
      if (/^https?:/.test(ref)) continue;
      if (!read(ref)) P("模板", `ghost.json 引用的文件不存在：${ref}`);
    }
    if (/\.node\.entry|"node"/.test(ghostRaw) && !/"protocol"\s*:\s*"mcp-stdio"/.test(ghostRaw)) {
      N("模板", "ghost.json 的 node.protocol 不是 mcp-stdio（仅在随包 stdio MCP 场景下需要）");
    }
  }
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
const readJsonText = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};
const ghostJson = readJson("ghost.json");
const idx = read("src/index.js") || "";
const uniqueServer = parseTools(idx).map((tool) => tool.name)
const declaredPublic = Array.isArray(ghostJson?.tools) ? ghostJson.tools : [];
const ghostTools = declaredPublic.map((t) => t?.name);
if (!Array.isArray(ghostJson?.tools)) P('工具清单', 'public 工具清单不是数组');
if (new Set(ghostTools).size !== ghostTools.length) P('工具清单', 'public 工具重复');

// 两元工具可附带唯一已知启动器；不是任意额外工具的白名单。
const metaPresent = ghostTools.some((name) => ['list_tools', 'call_tool', 'start_wizard'].includes(name));
const allowedPublic = ['list_tools', 'call_tool', 'start_wizard'];
const TWO_LEVEL = metaPresent;
if (TWO_LEVEL && !(
  (ghostTools.length === 2 || ghostTools.length === 3) && new Set(ghostTools).size === ghostTools.length &&
  ghostTools.includes('list_tools') && ghostTools.includes('call_tool') && ghostTools.every((name) => allowedPublic.includes(name))
)) P('工具清单', '不允许的 public 工具集合；只允许两元工具或附加 start_wizard');

if (TWO_LEVEL) {
  const mainJs = read('main.js') || '';
  let members = [];
  // 编译真实逻辑页、读取真实类目并实调已注册分发器，注释/字符串不能冒充接线。
  // 宿主接口全为惰性桩；替换目标函数为哨兵，绝不启动 Node/Agent 或读配置。
  const sent = [];
  const sandbox = createContext({
    cindy: { onHostMessage(fn) { sandbox.__handler = fn; }, send(msg) { sent.push(msg); } },
    BroadcastChannel: class { postMessage() {} },
  });
  try {
    new Script(mainJs).runInContext(sandbox, { timeout: 1500 });
    if (!Array.isArray(sandbox.CATEGORIES) || sandbox.CATEGORIES.some((category) => !Array.isArray(category.members) || category.members.some((name) => typeof name !== 'string'))) {
      P('工具清单', 'main.js 类目表结构无效');
    } else members = sandbox.CATEGORIES.flatMap((category) => category.members);
    const routes = { list_tools: 'listTools', call_tool: 'callToolRequest', start_wizard: 'startWizard' };
    for (const name of ghostTools.filter((name) => allowedPublic.includes(name))) {
      const target = routes[name];
      if (typeof sandbox[target] !== 'function' || typeof sandbox.__handler !== 'function') {
        P('工具清单', `public 处理器缺失：${name}`);
        continue;
      }
      sandbox[target] = async (msg) => ({ type: 'tool-result', callId: msg.callId, ok: true, result: { auditRoute: name } });
      sent.length = 0;
      sandbox.__auditMessage = { type: 'tool-call', tool: name, args: {}, callId: 'audit-route' };
      await new Script('__handler(__auditMessage)').runInContext(sandbox, { timeout: 1500 });
      if (!sent.some((msg) => msg.type === 'tool-result' && msg.callId === 'audit-route' && msg.result?.auditRoute === name)) P('工具清单', `public 分发不匹配：${name}`);
    }
  } catch (error) {
    P('工具清单', `main.js 编译或分发失败：${error.message}`);
  }
  for (const tool of declaredPublic) {
    const schema = tool?.parameters;
    const props = schema?.properties;
    const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const required = schema?.required === undefined ? [] : schema.required;
    let valid = object(schema) && schema.type === 'object' && object(props) && Array.isArray(required) &&
      required.every((key) => typeof key === 'string' && Object.hasOwn(props, key)) && new Set(required).size === required.length;
    if (valid && tool.name === 'start_wizard') {
      const choices = (value, wanted) => value?.type === 'string' && Array.isArray(value.enum) && value.enum.length === wanted.length && wanted.every((name) => value.enum.includes(name));
      const expected = props.expected;
      valid = required.length === 0 && (Object.keys(props).length === 0 || (
        Object.keys(props).sort().join(',') === 'action,expected,intent' &&
        choices(props.action, ['open', 'prepare', 'resume']) && choices(props.intent, ['clarify', 'confirm-scope', 'execute', 'check', 'review', 'finish']) &&
        expected?.type === 'object' && object(expected.properties) && Object.keys(expected.properties).sort().join(',') === 'callId,generation,intent,nonce' &&
        Object.values(expected.properties).every((field) => field.type === 'string') && Array.isArray(expected.required) && expected.required.length === 4 && new Set(expected.required).size === 4 && expected.required.every((key) => Object.hasOwn(expected.properties, key)) && expected.additionalProperties === false
      ));
    }
    if (valid && tool.name === 'list_tools') valid = Object.keys(props).length === 1 && props.category?.type === 'string' && required.length === 0;
    if (valid && tool.name === 'call_tool') valid = Object.keys(props).length === 2 && props.name?.type === 'string' && props.args?.type === 'object' && required.length === 1 && required[0] === 'name';
    if (!valid) P('工具清单', `public 参数 schema 无效：${tool?.name}`);
  }
  const uniqMembers = [...new Set(members)];
  if (uniqMembers.length !== members.length) P('工具清单', 'main.js 类目成员重复');
  if (!mainJs) P("工具清单", "ghost.json 走两段式，但仓库里没有 main.js");
  if (uniqMembers.length !== uniqueServer.length) {
    P("工具清单", `main.js 类目表覆盖 ${uniqMembers.length} 个操作，服务端实际 ${uniqueServer.length} 个`);
  }
  for (const t of uniqueServer) if (!uniqMembers.includes(t)) P("工具清单", `main.js 类目表缺操作 ${t}（Cindy 里将无法调用）`);
  for (const t of uniqMembers) if (!uniqueServer.includes(t)) P("工具清单", `main.js 类目表声明了服务端不存在的操作 ${t}`);
  // 被声明的每个成员都必须落在工具名前缀上，防止把类目名当工具名写进去
  for (const t of uniqMembers) if (!/^flow_/.test(t)) P("工具清单", `main.js 类目表里的 ${t} 不是 flow_* 操作`);
  if (ghostJson?.kind !== "chip") P("工具清单", `两段式插件必须 kind=chip（当前 ${ghostJson?.kind}）`);
  if (ghostJson?.entry !== "main.js") P("工具清单", `两段式插件的 entry 必须是 main.js（当前 ${ghostJson?.entry}）`);
  const nodeEntry = ghostJson?.node?.entry;
  if (!nodeEntry || !read(nodeEntry)) P("工具清单", `ghost.json 的 node.entry 指向不存在的文件：${nodeEntry}`);
  if (ghostJson?.node?.protocol !== "mcp-stdio") P("工具清单", `两段式 + 随包 MCP 需要 node.protocol=mcp-stdio（当前 ${ghostJson?.node?.protocol}）`);
  if (/__ROOT__/.test(String(nodeEntry))) P("工具清单", "chip 的 node.entry 不能是 __ROOT__ 占位符（安装后不会渲染）");
  N("工具清单", `两段式目录：list_tools / call_tool + main.js 类目表覆盖全部 ${uniqueServer.length} 个操作`);
} else {
  if (ghostTools.length !== uniqueServer.length) {
    P("工具清单", `ghost.json 声明 ${ghostTools.length} 个，服务端实际 ${uniqueServer.length} 个`);
  }
  for (const t of uniqueServer) if (!ghostTools.includes(t)) P("工具清单", `ghost.json 缺工具 ${t}`);
  for (const t of ghostTools) if (!uniqueServer.includes(t)) P("工具清单", `ghost.json 声明了服务端不存在的工具 ${t}`);
  if (ghostTools.length > 16) P("工具清单", `直接声明的工具 ${ghostTools.length} 个，超过宿主上限 16 —— 必须改两段式目录`);
}

// ========== 9. 插件运行时契约（宿主怎么加载随包 Node） ==========
console.log("▶ 9. 插件运行时契约");
{
  const entrySrc = read("src/index.js") || "";
  // 顶层 await 会让宿主用 require() 加载入口时抛 ERR_REQUIRE_ASYNC_MODULE；
  // 2026-11-17 实测正是它让「插件一调就 Node 工作进程已退出」。
  if (/^await\s/m.test(entrySrc)) {
    P("运行时契约", "src/index.js 含顶层 await —— 宿主用 require() 加载会失败（改用 Promise.catch）");
  } else {
    N("运行时契约", "入口无顶层 await（require() 可加载 ESM 图）");
  }
  if (!/const TOOL_SCHEMAS\s*=/.test(entrySrc)) {
    P("运行时契约", "src/index.js 没有导出用的 TOOL_SCHEMAS 装配（tools/list 载荷可能把 handler 带出去）");
  }
  // 真跑一次 require：静态判断漏掉的（间接依赖里的 TLA）只有真加载才暴露
  const probe = execFileSync(process.execPath, ["-e", "require('./src/index.js');console.log('REQUIRE_OK')"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CARLOS_FLOW_HOME: join(ROOT, ".audit-require-home") },
  });
  if (/REQUIRE_OK/.test(probe)) N("运行时契约", "require() 真能加载随包入口");
  else P("运行时契约", "require() 加载随包入口失败（宿主就是这么加载的）");
  try { rmSync(join(ROOT, ".audit-require-home"), { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---- 输出 ----
console.log("\n" + "=".repeat(72));
console.log(problems.length === 0
  ? `✅ 产物全面体检通过（${notes.length} 条正当说明）`
  : `❌ 发现 ${problems.length} 个问题，${notes.length} 条正当说明`);
console.log("=".repeat(72));
for (const p of problems) console.log("❌ " + p);
if (process.env.SHOW_NOTES === "1") for (const n of notes) console.log("ℹ️  " + n);
process.exit(problems.length ? 1 : 0);