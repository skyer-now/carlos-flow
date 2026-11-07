#!/usr/bin/env node
// lang-audit.mjs — 产物语言体检（中文合规守卫）
//
// 为什么需要这个守卫：
// 2026-11-07 发生过一次真实事故 —— 同一会话里对话回复全是中文，
// 但**连续 5 个 git 提交信息写成了完整英文段落**，用户当场指为「非常严重的技术事故」。
//
// 根因不是「没看到用户要求」（要求早已写入记忆），而是：
//   · 对话语言是合规的，肉眼扫一遍「回复」完全看不出问题；
//   · 漏检的全部是**产物**（提交信息、注释、脚本文案、文档正文），
//     而产物会持久化并对外分发（进 GitHub、进 npm 包），影响面远大于一次对话。
//
// 所以「我说的是中文的」不能作为合规判据 —— 必须**单独检查产物**。
// 本脚本把这件事自动化，让它不依赖临场自觉。
//
// 检查范围：
//   1) git 提交信息（标题 + 正文，排除代码块与含中文的行）
//   2) 源码注释（.js/.mjs/.cjs/.sh/.yml/.yaml）
//
// 允许英文的例外（外部接口约束，不算违反）：
//   标识符、命令、路径、报错原文、API 字段名、日志原文、技术专有名词、
//   用户自己写的英文、以及被明确要求产出的英文材料（如 README.en.md）。
//
// 退出码：0 = 合规；1 = 发现英文叙述（逐条打印位置）
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 允许出现在中文语境里的英文词（标识符 / 专有名词 / 外部接口名）
// 允许出现在中文语境里的英文词（标识符 / 专有名词 / 外部接口名）。
// 注意：必须**按词排除**而不是整行排除 —— 否则
//   「fix(release): add missing shebang to bin entry」
// 里的 fix / release 会让整行被放行，英文叙述就漏检了。
const ALLOWED_WORDS = new Set([
  "npm", "mcp", "node", "json", "yaml", "yml", "github", "gitlab", "ci", "carlos",
  "readme", "changelog", "trigger", "guide", "migration", "error", "timeout",
  "ok", "verify", "scope", "acceptance", "sessionid", "init", "target", "git",
  "commit", "release", "docs", "fix", "feat", "chore", "test", "yarn", "npx",
  "shell", "stdin", "stdout", "stderr", "http", "https", "api", "url", "repo",
  "src", "lib", "bin", "tool", "tools", "service", "server", "client", "bridge",
  "plugin", "template", "templates", "license", "mit", "apache", "bsd", "utf",
  "linux", "windows", "macos", "opencode", "cursor", "cline", "claude", "copilot",
  "version", "semver", "keep", "monorepo", "shim", "shebang", "validatecard",
  "tier", "read", "goal", "quote", "cmd", "argv", "env", "pkg", "args",
  "opts", "params", "config", "keywordweights", "readonly", "intentwords",
  "mutatingactionwords", "flow", "user", "msgs", "state",
]);

const MIN_WORDS = 5;          // 连续 5 个以上英文词才判定为「英文叙述」
const MIN_COMMIT_WORDS = 3;   // 提交信息阈值低一点（正文段落更短）

// 判定规则：**一行里只要有中文字符就算合规**（标识符、报错原文、引用的英文术语
// 嵌在中文句子里是正常的）；只有**整行没有中文**、且英文词达到阈值时才算违规。
// 之前的写法用「英文词数」直接判，会把
//   「exitCode=127（command not found），记 PASS 的前置证据永远拿不到」
// 这类「中文句子 + 引用的英文报错」误判 —— 那是合规的中文注释。
const isEnglishNarration = (text, minWords) => {
  if (/[一-鿿]/.test(text)) return false;      // 有中文 → 合规

  // 剥离「引用的原文」：中文句子里的英文报错原文、代码块、标识符引用
  let s = text
    .replace(/[「」『』“”"'‘’`][^「」『』“”"'‘’`]*[「」『』“”"'‘’`]/g, " ")
    .replace(/`[^`]*`/g, " ");

  // 命令行 / 路径示例行：含 `--` 参数、以命令前缀开头、或形如 a/b/c
  if (/^\s*(\$|>)?\s*(node|npm|npx|yarn|git|bash|sh|python3?|curl|cd|echo|export|carlos-flow|carlos)\b/i.test(s)) return false;
  if (/\s--[a-z][\w-]*/i.test(s)) return false;
  if (/^[A-Za-z0-9_.\-/]+\s*[=:]/i.test(s.trim()) && !/\s/.test(s.trim())) return false;

  const words = (s.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []).map((w) => w.toLowerCase());
  if (words.length < minWords) return false;
  // 去掉允许词后仍需达到足够密度，否则整句都是专有名词/标识符
  const residual = words.filter((w) => !ALLOWED_WORDS.has(w));
  if (residual.length < Math.max(3, Math.ceil(words.length * 0.4))) return false;
  return true;
};

let problems = 0;
const report = (where, text) => {
  console.log(`  ❌ ${where}`);
  console.log(`     ${text.slice(0, 110)}`);
  problems++;
};

// ---- 1. 提交信息 ----
console.log("▶ 提交信息");
try {
  const raw = execFileSync("git", ["log", "--format=%H%x00%B%x00%x00", "-15"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const parts = raw.split("\u0000").filter((s) => s.trim());
  let commitProblems = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const sha = (parts[i] || "").trim();
    const body = parts[i + 1] || "";
    let inCode = false;
    for (const line of body.split("\n")) {
      if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
      if (inCode) continue;
      const t = line.trim();
      if (!t) continue;
      if (!isEnglishNarration(t, MIN_COMMIT_WORDS)) continue;
      report(`提交 ${sha.slice(0, 7)}`, t);
      commitProblems++;
    }
  }
  if (commitProblems === 0) console.log("  ✅ 提交信息均为中文");
} catch (e) {
  console.log("  ⏭  跳过（取不到 git 历史）");
}

// ---- 2. 源码注释 ----
console.log("\n▶ 源码注释");
const walk = (dir, depth = 0) => {
  if (depth > 4) return [];
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git") continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out = out.concat(walk(full, depth + 1));
    else if (/\.(js|mjs|cjs|sh|yml|yaml)$/.test(e)) out.push(full);
  }
  return out;
};

let codeProblems = 0;
for (const f of walk(ROOT)) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, "/");
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*(?:\/\/|#)\s*(.+)$/);
    if (!m) return;
    const t = m[1].trim();
    if (!isEnglishNarration(t, MIN_WORDS)) return;
    report(`${rel}:${i + 1}`, t);
    codeProblems++;
  });
}
if (codeProblems === 0) console.log("  ✅ 源码注释均为中文");

console.log("");
if (problems > 0) {
  console.log(`❌ 产物语言体检失败：发现 ${problems} 处英文叙述`);
  console.log("   修复方式：把对应内容改写为中文（标识符、命令、报错原文可保留原样）");
  process.exit(1);
}
console.log("✅ 产物语言体检通过");
