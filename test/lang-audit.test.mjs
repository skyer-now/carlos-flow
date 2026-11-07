// lang-audit 自检：验证体检脚本**真的能抓到英文叙述**，而不是假绿。
//
// 为什么需要自检：
// 2026-11-07 的事故里，提交信息全是英文却没人发现 —— 因为没有任何自动检查。
// 如果再引入一个「体检脚本」，但它实际上抓不到东西，那只是换了个地方假绿。
// 所以必须用**故意构造的英文样本**验证它会红。
//
// 跑法：node test/lang-audit.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCRIPT = join(ROOT, "scripts", "lang-audit.mjs");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
};

console.log("\n════ 产物语言体检 · 自检 ════\n");

// ---- 1. 真实仓库当前必须通过 ----
console.log("▶ 真实仓库当前状态");
let realOut = "";
let realCode = 0;
try {
  realOut = execFileSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
} catch (e) {
  realOut = `${e.stdout || ""}${e.stderr || ""}`;
  realCode = e.status ?? 1;
}
check("真实仓库体检通过（退出码 0）", realCode === 0, realCode !== 0 ? `退出码=${realCode}` : "");
check("输出含「提交信息均为中文」", realOut.includes("提交信息均为中文"));
check("输出含「源码注释均为中文」", realOut.includes("源码注释均为中文"));

// ---- 2. 构造英文样本，必须被抓出来 ----
console.log("\n▶ 故意放英文，必须被抓出来");
const tmp = mkdtempSync(join(tmpdir(), "lang-audit-test-"));
try {
  // 2a. 英文源码注释
  const enFile = join(tmp, "sample-en.js");
  writeFileSync(
    enFile,
    [
      "// This comment is entirely in English and must be detected by the audit",
      "// 这行是中文注释，含有 command not found 这样的英文报错引用，应当放行",
      "// TODO: fix this later",
      "",
    ].join("\n"),
    "utf8"
  );

  // 2b. 英文提交信息（用独立 git 仓库模拟）
  const gitDir = join(tmp, "repo");
  execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmp });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
  const repoScripts = join(gitDir, "scripts");
  execFileSync("node", ["-e", "require('fs').mkdirSync(process.argv[1],{recursive:true})", repoScripts], { stdio: "ignore" });
  writeFileSync(join(repoScripts, "lang-audit.mjs"), readFileSync(SCRIPT, "utf8"), "utf8");
  writeFileSync(join(gitDir, "sample-en.js"), readFileSync(enFile, "utf8"), "utf8");
  execFileSync("git", ["add", "-A"], { cwd: gitDir });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m",
      "fix(release): add missing shebang to bin entry\n\nThis commit body is entirely in English and should be flagged."],
    { cwd: gitDir }
  );

  let enOut = "";
  let enCode = 0;
  try {
    enOut = execFileSync("node", [join(repoScripts, "lang-audit.mjs")], { cwd: gitDir, encoding: "utf8" });
  } catch (e) {
    enOut = `${e.stdout || ""}${e.stderr || ""}`;
    enCode = e.status ?? 1;
  }
  check("英文提交信息被抓出（退出码非 0）", enCode !== 0, `退出码=${enCode}`);
  check("英文提交信息被点名", /❌ 提交 [0-9a-f]{7}/.test(enOut),
    enOut.split("\n").filter((l) => l.includes("❌")).slice(0, 2).join(" | "));
  check("英文源码注释被抓出", enOut.includes("sample-en.js"),
    enOut.split("\n").filter((l) => l.includes("❌")).slice(0, 2).join(" | "));

  // 2c. 中文句中夹英文报错引用，必须放行（不误报）
  const falsePositive = enOut.includes("command not found");
  check("中文句中的英文报错引用不误报", !falsePositive);

  // 2d. 短英文注释（TODO 之类）不误报
  check("简短英文注释不误报（阈值生效）", !enOut.includes("TODO"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- 3. 中文样本必须通过 ----
console.log("\n▶ 中文样本，必须通过");
const tmp2 = mkdtempSync(join(tmpdir(), "lang-audit-ok-"));
try {
  execFileSync("git", ["init", "-q"], { cwd: tmp2, stdio: "ignore" });
  const scriptsDir = join(tmp2, "scripts");
  execFileSync("node", ["-e", "require('fs').mkdirSync(process.argv[1],{recursive:true})", scriptsDir], { stdio: "ignore" });
  writeFileSync(join(scriptsDir, "lang-audit.mjs"), readFileSync(SCRIPT, "utf8"), "utf8");
  writeFileSync(
    join(tmp2, "sample-zh.js"),
    [
      "// 档位必填项已由 validateCard 按 tier 强制（read_only 只要 goal+quote）",
      "// exitCode=127（command not found），记 PASS 的前置证据永远拿不到",
      "// 工作目录优先级：显式 cwd > 卡片提交时的项目目录 > server 进程 cwd",
      "",
    ].join("\n"),
    "utf8"
  );
  let zhOut = "";
  let zhCode = 0;
  try {
    zhOut = execFileSync("node", [join(scriptsDir, "lang-audit.mjs")], { cwd: tmp2, encoding: "utf8" });
  } catch (e) {
    zhOut = `${e.stdout || ""}${e.stderr || ""}`;
    zhCode = e.status ?? 1;
  }
  check("纯中文注释仓库体检通过", zhCode === 0, `退出码=${zhCode}`);
  check("中文注释未被误报", !zhOut.includes("❌"));

  // 2e. CRLF 回归：Windows 下文件是 \r\n 行尾。
  //     JavaScript 正则的 `.` **不匹配 `\r`**（它算行终止符），
  //     所以「按 \n 拆分」会留下一行尾 \r，让 `(.+)$` 完全匹配不上 ——
  //     注释扫描会静默扫不到任何一行，体检变假绿。
  //     这正是 2026-11-07 实际发生的事：本地（CRLF）全绿，CI（LF）却报真问题。
  //     必须用 CRLF 文件验证：若扫描退化为空，这里会红。
  const crlfDir = join(tmp2, "crlf");
  execFileSync("node", ["-e", "require('fs').mkdirSync(process.argv[1],{recursive:true})", crlfDir], { stdio: "ignore" });
  writeFileSync(
    join(crlfDir, "sample-crlf.js"),
    "// This CRLF comment is entirely in English and must still be detected\r\n" +
      "// 这一行是中文注释，应当放行\r\n",
    "utf8"
  );
  let crlfOut = "";
  let crlfCode = 0;
  try {
    crlfOut = execFileSync("node", [join(scriptsDir, "lang-audit.mjs")], { cwd: tmp2, encoding: "utf8" });
  } catch (e) {
    crlfOut = `${e.stdout || ""}${e.stderr || ""}`;
    crlfCode = e.status ?? 1;
  }
  check("CRLF 文件里的英文注释仍被抓出（不因 \\r 漏检）",
    crlfCode !== 0 && crlfOut.includes("sample-crlf.js"),
    `退出码=${crlfCode}`);
  check("CRLF 文件里的中文注释不误报", !crlfOut.includes("这一行是中文注释，应当放行"));
} finally {
  rmSync(tmp2, { recursive: true, force: true });
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════\n`);
process.exit(fail === 0 ? 0 : 1);