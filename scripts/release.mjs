#!/usr/bin/env node
// release.mjs — 一键发布 carlos-flow-cindy / carlos-flow-opencode 到 GitHub + npm
//
// 用法：
//   node scripts/release.mjs --version 2.5.5
//   node scripts/release.mjs --version 2.5.5 --dry-run
//
// 前置条件（需已具备）：
//   1. GitHub 凭据：gh CLI 已登录，或 .git-credentials / remote URL 内含有效 PAT
//   2. npm 凭据：~/.npmrc 或项目 .npmrc.local 含有效 _authToken
//   3. 工作区干净（无未提交改动）
//
// 脚本只做「构建 → 校验 → 提交 → 打 tag → 推送 → 发布」，不做任何凭据读取或打印。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const version = (() => {
  const i = process.argv.indexOf("--version");
  return i > 0 ? process.argv[i + 1] : null;
})();
const dryRun = process.argv.includes("--dry-run");

if (!version) {
  console.error("用法: node scripts/release.mjs --version <x.y.z> [--dry-run]");
  process.exit(1);
}

const run = (cmd, args, opts = {}) => {
  // Windows 下 npm/git 是 .cmd 包装器，必须经 shell 执行
  const isWin = process.platform === "win32";
  const needsShell = isWin && /^(npm|npx|git)$/i.test(cmd);
  const out = execFileSync(cmd, args, {
    cwd: opts.cwd || root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: needsShell,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return out.trim();
};

const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

step(`发布前检查 v${version}`);

// 1. package.json 版本一致
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`  ✗ package.json 版本是 ${pkg.version}，与 --version ${version} 不一致`);
  process.exit(1);
}
ok(`package.json version = ${pkg.version}`);

// 2. CHANGELOG 顶部版本一致
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const topVer = (changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
if (topVer !== version) {
  console.error(`  ✗ CHANGELOG.md 顶部版本是 ${topVer}，与 ${version} 不一致`);
  process.exit(1);
}
ok(`CHANGELOG.md top = ${topVer}`);

// 3. 工作区干净
const dirty = run("git", ["status", "--porcelain"]);
if (dirty) {
  console.error("  ✗ 工作区有未提交改动：");
  console.error(dirty);
  process.exit(1);
}
ok("工作区干净");

// 4. 全套测试
step("运行测试套件");
// 测试脚本依赖 CARLOS_FLOW_MCP_ROOT 定位仓库根目录
process.env.CARLOS_FLOW_MCP_ROOT = process.env.CARLOS_FLOW_MCP_ROOT || root;
run("npm", ["run", "test:all"], {
  cwd: root,
});
ok("test:all 通过（smoke + e2e-carlos + p0-gates + trigger-e2e）");

// 5. 双语 README 一致性（prepublishOnly 也会再查一次）
step("校验双语 README");
run("npm", ["run", "check:readme"]);
ok("README.md / README.zh.md / README.en.md 一致");

// 6. 打包内容检查
step("检查 npm 包内容");
const packOut = run("npm", ["pack", "--dry-run"]);
const suspicious = packOut
  .split("\n")
  .filter((l) => /\.npmrc|secret\.json|\.b64|fix_|debug_|\.bak|\.patch/.test(l));
if (suspicious.length) {
  console.error("  ✗ 包内含可疑文件：");
  suspicious.forEach((l) => console.error("    " + l));
  process.exit(1);
}
ok("包内无敏感/临时文件");

if (dryRun) {
  console.log("\n[dry-run] 以上检查全部通过，未执行推送与发布。");
  process.exit(0);
}

// 7. 提交 + tag + push
step("推送 GitHub");
try {
  run("git", ["push", "origin", "main"]);
  ok("main 已推送");
} catch (e) {
  console.error("  ✗ 推送失败：", e.stderr ? e.stderr.toString().trim() : e.message);
  console.error("    请检查 GitHub 凭据（gh auth login 或 .git-credentials）");
  process.exit(1);
}

const tag = `v${version}`;
try {
  run("git", ["tag", tag]);
  ok(`已打 tag ${tag}`);
} catch (e) {
  console.log(`  · tag ${tag} 已存在，跳过`);
}
run("git", ["push", "origin", tag]);
ok(`${tag} 已推送（release workflow 将自动创建 GitHub Release 并发布 npm）`);

step("完成");
console.log(`  GitHub Release + npm 发布由 .github/workflows/release.yml 在 tag 推送后自动执行。`);
console.log(`  关注 CI：https://github.com/${pkg.repository.url.split("github.com/")[1]?.replace(".git", "") || "skyer-now/carlos-flow-" + pkg.name.split("-").pop()}/actions`);
