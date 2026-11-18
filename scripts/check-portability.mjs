#!/usr/bin/env node
// check-portability.mjs — 跨平台可移植性门禁
//
// 为什么需要它：v2.15.0 在本地全绿、在 ubuntu CI 上挂了两处，都是**只有另一个
// 平台才会暴露**的写法：
//   1. `new URL(import.meta.url).pathname` —— POSIX 上 pathname 是 `/home/runner/...`，
//      去掉前导斜杠就成了相对路径，spawn 能"成功"但永远连不上（表现为超时，不报错）。
//   2. 超时只 `child.kill()` —— Windows 只杀 cmd.exe 外壳、POSIX 只杀 sh，
//      命令派生的进程变孤儿。要么 taskkill /T /F，要么 detached + kill(-pid)。
//
// 这两类错误的共同点：静态读代码看不出来，本地也跑不出来。所以用门禁把它们
// 变成「写下去就红」。
//
// 用法：node scripts/check-portability.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "_archive", ".qa-logs", ".mutant-check"]);
const EXTS = /\.(js|mjs|cjs)$/;

const files = [];
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (EXTS.test(e.name)) files.push(full);
  }
};
walk(ROOT);

let problems = 0;
const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); problems++; };

// 允许豁免：本文件自己在讲这些坑的写法
const ALLOW = new Set(["scripts/check-portability.mjs"]);

console.log("════ 跨平台可移植性门禁 ════\n");
console.log("▶ 1. 路径 URL → 文件路径");
{
  let hits = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (ALLOW.has(rel)) continue;
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/import\.meta\.url\s*\)\s*\.pathname/.test(line)) continue;
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) continue; // 注释里讲这个坑是允许的
      fail(`${rel}:${i + 1} 用 URL.pathname 取文件路径 —— POSIX 上会得到相对路径，必须用 fileURLToPath()`);
      hits++;
    }
  }
  if (hits === 0) pass("没有用 URL.pathname 拼文件路径");
}

console.log("\n▶ 2. 结束子进程要连整棵树");
{
  const rel = "src/dispatch.js";
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const lines = src.split(/\r?\n/);

  if (/taskkill/.test(src) && /kill\(-child\.pid/.test(src)) {
    pass("超时回收走 taskkill /T /F（Windows）与进程组 kill（POSIX）");
  } else {
    fail("dispatch.js 缺少整树回收（Windows 会留下 cmd.exe 派生的孤儿进程）");
  }

  if (/detached:\s*!isWindows/.test(src)) {
    pass("POSIX 的 shell 以 detached 启动（进程组组长）");
  } else {
    fail("POSIX 未设置 detached：kill(-pid) 打不到进程组，孤儿仍会残留");
  }

  // 反向守护：killProcessTree 之外不允许出现裸 child.kill（那就是留孤儿的写法）。
  // 用行号 + 花括号计数定位函数体，避免字符串偏移换算踩转义坑。
  let fnStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/function\s+killProcessTree\s*\(/.test(lines[i])) { fnStart = i; break; }
  }
  let fnEnd = -1;
  if (fnStart >= 0) {
    let depth = 0;
    let seen = false;
    for (let i = fnStart; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; seen = true; }
        else if (ch === "}") { depth--; if (seen && depth === 0) { fnEnd = i; break; } }
      }
      if (fnEnd >= 0) break;
    }
  }

  const strayKills = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/child\.kill\("SIGKILL"\)/.test(lines[i])) continue;
    if (lines[i].trim().startsWith("//")) continue;
    const insideTreeFn = fnStart >= 0 && fnEnd > fnStart && i >= fnStart && i <= fnEnd;
    if (!insideTreeFn) strayKills.push(i + 1);
  }
  if (fnStart < 0) fail("找不到 killProcessTree()：整树回收的入口没了");
  else if (strayKills.length === 0) pass("整树回收之外没有裸 child.kill（不会留孤儿）");
  else fail(`第 ${strayKills.join("/")} 行在 killProcessTree 之外直接 child.kill —— 会留孤儿`);
}

console.log("\n▶ 3. 路径归一");
{
  const stateSrc = fs.readFileSync(path.join(ROOT, "src", "state.js"), "utf8");
  if (/path\.normalize/.test(stateSrc)) pass("状态/审计路径经 path.normalize 归一");
  else fail("state.js 未对路径做 path.normalize（Windows 下会混出 / 与 \\）");
}

console.log("\n" + "═".repeat(70));
if (problems) {
  console.log(`❌ 可移植性检查失败：${problems} 项`);
  console.log("═".repeat(70));
  process.exit(1);
}
console.log("✅ 可移植性检查全部通过");
console.log("═".repeat(70));
process.exit(0);