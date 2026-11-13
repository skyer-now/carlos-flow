// 模板渲染合法性门禁
//
// 为什么需要（2026-11-13 实测事故）：
//   `carlos-flow init --target <platform>` 曾经用**裸字符串替换**把项目根路径塞进模板，
//   即不做任何转义地把路径原文替换进 JSON 字符串里。
//   Windows 路径的原始反斜杠因此进了 JSON，产出形如
//       "D:\dev-env\node-v22.23.4-win-x64\node_modules\carlos-flow/bridge/mcp-bridge.js"
//   其中 \d \n \v 都是**非法 JSON 转义序列** —— 配置文件根本解析不了，
//   表现为「安装成功但插件不出现」，而且任何解析器都报同一个位置。
//   现场文件 C:\Users\EDY\.cindy\ghosts\carlos-flow.json 就是这个状态。
//   正确写法见 client/carlos.js：JSON 目标用 JSON.stringify 转义，YAML 目标用正斜杠。
//
// 本门禁做的事：
//   用**真实的 Windows 路径**渲染全部模板，断言产物能被正确解析，
//   并且路径里的反斜杠没有丢失、没有变成非法转义。
//
// 运行：node scripts/check-templates.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;

function ok(msg) {
  pass++;
  console.log("  ✅ " + msg);
}
function bad(msg) {
  fail++;
  console.log("  ❌ " + msg);
}

// 真实的 Windows 路径（含反斜杠、大写、子目录），用来复现事故现场
const WIN_ROOT = "D:\\dev-env\\node-v22.23.4-win-x64\\node_modules\\carlos-flow";

// 与 client/carlos.js 中的渲染逻辑保持一致（这是本门禁的关键：两处必须同源）
const rootJson = JSON.stringify(WIN_ROOT).slice(1, -1);
const rootYaml = WIN_ROOT.replace(/\\/g, "/");

console.log("▶ JSON 模板：Windows 路径渲染后必须可解析且路径无损");

const jsonTemplates = [
  ["ghost.json", (t) => t.replace(/__ROOT__/g, rootJson)],
  ["opencode.json.template", (t) => t.replace(/__ROOT__/g, rootJson)],
  ["templates/cursor/mcp.json", (t) => t.replace(/__ROOT__/g, rootJson)],
  ["templates/cline/mcp.json", (t) => t.replace(/__ROOT__/g, rootJson)],
  ["templates/vscode/mcp.json", (t) => t.replace(/__ROOT__/g, rootJson)],
  ["templates/claude/claude_desktop_config.json", (t) => t.replace(/__ROOT__/g, rootJson)],
];

for (const [rel, render] of jsonTemplates) {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    bad(`${rel} 读不到`);
    continue;
  }
  if (!raw.includes("__ROOT__")) {
    bad(`${rel} 里没有 __ROOT__ 占位符 —— 渲染逻辑可能已失效，模板与代码脱节`);
    continue;
  }
  const out = render(raw);
  try {
    const parsed = JSON.parse(out);
    ok(`${rel} 渲染后可解析`);
    // 路径无损检查：反斜杠必须完好，不能变成 \\ 之外的任何形态
    const found = JSON.stringify(parsed).includes("dev-env");
    if (!found) bad(`${rel} 渲染后路径内容丢失`);
  } catch (e) {
    bad(`${rel} 渲染后无法解析：${e.message}`);
  }
}

console.log("▶ YAML 模板：.mcprc 必须用正斜杠（反斜杠在 YAML 双引号里同样非法）");

try {
  const raw = readFileSync(join(ROOT, ".mcprc.template"), "utf8");
  const out = raw.replace(/__ROOT__/g, rootYaml);
  if (out.includes("\\\\")) {
    bad(".mcprc.template 渲染后仍含双反斜杠 —— YAML 双引号标量里 \\d \\U 是非法转义");
  } else if (out.includes(rootYaml)) {
    ok(".mcprc.template 渲染后为正斜杠路径");
  } else {
    bad(".mcprc.template 渲染后未找到正斜杠路径");
  }
} catch (e) {
  bad(".mcprc.template 读不到：" + e.message);
}

console.log("▶ 反例确认：旧的裸替换写法必须确实产出非法 JSON");

{
  const raw = readFileSync(join(ROOT, "ghost.json"), "utf8");
  const oldOut = raw.replace(/__ROOT__/g, WIN_ROOT);
  try {
    JSON.parse(oldOut);
    bad("旧的裸替换写法竟然能解析 —— 前提假设已变，门禁需重新评估");
  } catch {
    ok("旧的裸替换写法确实产出非法 JSON（本门禁守的正是这个）");
  }
}

console.log("▶ 源码一致性：client/carlos.js 必须用同样的转义方式");

{
  const src = readFileSync(join(ROOT, "client", "carlos.js"), "utf8");
  const usesJsonEscape = /JSON\.stringify\(ROOT_ABS\)\.slice\(1,\s*-1\)/.test(src);
  const usesYamlSlash = /ROOT_ABS\.replace\(\/\\\\\/g,\s*"\/"\)/.test(src);
  if (usesJsonEscape) ok("client/carlos.js 使用 JSON 转义渲染 ROOT");
  else bad("client/carlos.js 未使用 JSON 转义渲染 ROOT —— 与本门禁不同源");

  if (usesYamlSlash) ok("client/carlos.js 对 YAML 目标使用正斜杠");
  else bad("client/carlos.js 未对 YAML 目标使用正斜杠 —— 与本门禁不同源");
}

console.log("");
if (fail) {
  console.log(`❌ 模板渲染门禁失败：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
console.log(`✅ 模板渲染门禁全部通过（${pass} 条）`);
