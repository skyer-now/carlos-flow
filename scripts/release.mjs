#!/usr/bin/env node
// release.mjs — 一键发布 carlos-flow-cindy / carlos-flow-opencode 到 GitHub + npm
//
// 用法：
//   node scripts/release.mjs --version 2.5.5
//   node scripts/release.mjs --version 2.5.5 --include-opencode
//   node scripts/release.mjs --version 2.5.5 --dry-run
//   node scripts/release.mjs --version 2.5.5 --include-opencode --dry-run
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
const includeOpencode = process.argv.includes("--include-opencode");

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

/**
 * 跑一条命令；失败时打印**可读**的错误（命令名 + 失败输出末几行），
 * 而不是把 Node 原始堆栈糊到脸上。发布脚本的错误信息要能直接告诉人下一步做什么。
 */
const runOrFail = (cmd, args, opts = {}, label = "") => {
  try {
    return run(cmd, args, opts);
  } catch (e) {
    const name = label || `${cmd} ${(args || []).join(" ")}`;
    console.error(`  ✗ ${name} 失败`);
    const out = `${(e.stdout || "")}${e.stderr || ""}`.trim();
    const tail = out.split("\n").filter((l) => l.trim()).slice(-12);
    if (tail.length) {
      console.error("    ---- 失败输出末段 ----");
      for (const l of tail) console.error("    " + l);
      console.error("    ----------------------");
    }
    process.exit(1);
  }
};

/**
 * 校验一个仓库是否可发布：版本一致 / lock 文件版本一致 / CHANGELOG 顶部版本 / 工作区干净。
 * lock 文件版本不一致会让 release.yml 里的 `npm ci` 直接失败（npm 要求
 * package.json 与 package-lock.json 的 version 一致），所以必须在这里拦住。
 */
const verifyRepo = (repoRoot, label) => {
  const pkgPath = resolve(repoRoot, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(`  ✗ ${label}: 找不到 package.json (${pkgPath})`);
    process.exit(1);
  }
  const rPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (rPkg.version !== version) {
    console.error(`  ✗ ${label}: package.json 版本是 ${rPkg.version}，与 --version ${version} 不一致`);
    process.exit(1);
  }
  const lockPath = resolve(repoRoot, "package-lock.json");
  let lockVer = null;
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lockVer = lock.version || (lock.packages && lock.packages[""] && lock.packages[""].version);
    if (lockVer !== rPkg.version) {
      console.error(`  ✗ ${label}: package-lock.json 版本是 ${lockVer}，与 package.json ${rPkg.version} 不一致`);
      console.error(`    （release.yml 的 \`npm ci\` 会因此失败，请先同步 lock 文件版本）`);
      process.exit(1);
    }
  }
  const rChangelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  const rTopVer = (rChangelog.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
  if (rTopVer !== version) {
    console.error(`  ✗ ${label}: CHANGELOG.md 顶部版本是 ${rTopVer}，与 ${version} 不一致`);
    process.exit(1);
  }
  const rDirty = run("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (rDirty) {
    console.error(`  ✗ ${label}: 工作区有未提交改动：`);
    console.error(rDirty);
    process.exit(1);
  }
  ok(`${label}: version=${rPkg.version} / lock=${lockVer} / CHANGELOG=${rTopVer} / 工作区干净`);
  return rPkg;
};

step(`发布前检查 v${version}`);

// 1. package.json 版本一致
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`  ✗ package.json 版本是 ${pkg.version}，与 --version ${version} 不一致`);
  process.exit(1);
}
ok(`package.json version = ${pkg.version}`);

// 1b. 完整仓库校验（版本 / lock / CHANGELOG / 工作区干净）
verifyRepo(root, "carlos-flow-cindy");

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
runOrFail("npm", ["run", "test:all"], {
  cwd: root,
}, "test:all（smoke + e2e-carlos + p0-gates + trigger-e2e + concurrency）");
ok("test:all 通过（smoke + e2e-carlos + p0-gates + trigger-e2e + concurrency）");

// 5. 双语 README 一致性（prepublishOnly 也会再查一次）
step("校验双语 README");
runOrFail("npm", ["run", "check:readme"], {}, "check:readme");
ok("README.md / README.zh.md / README.en.md 一致 + TRIGGER_GUIDE.md 版本号一致");

// 6. 打包内容检查
step("检查 npm 包内容");
const packOut = runOrFail("npm", ["pack", "--dry-run"], {}, "npm pack --dry-run");
const suspicious = packOut
  .split("\n")
  .filter((l) => /\.npmrc|secret\.json|\.b64|fix_|debug_|\.bak|\.patch/.test(l));
if (suspicious.length) {
  console.error("  ✗ 包内含可疑文件：");
  suspicious.forEach((l) => console.error("    " + l));
  process.exit(1);
}
ok("包内无敏感/临时文件");

// 6b. opencode 仓校验（必须在**任何推送之前**完成，否则会出现半发布）
let opencodePath = null;
if (includeOpencode) {
  opencodePath = resolve(root, "..", "carlos-flow-opencode");
  if (!existsSync(opencodePath)) {
    console.error(`  ✗ 未找到 opencode 仓库: ${opencodePath}`);
    process.exit(1);
  }
  step(`校验 opencode 仓 v${version}`);
  verifyRepo(opencodePath, "carlos-flow-opencode");
  // opencode 也跑一遍自己的测试与文档校验
  process.env.CARLOS_FLOW_MCP_ROOT = opencodePath;
  runOrFail("npm", ["run", "test:all"], { cwd: opencodePath }, "opencode test:all");
  ok("opencode test:all 通过");
  runOrFail("npm", ["run", "check:readme"], { cwd: opencodePath }, "opencode check:readme");
  ok("opencode check:readme 通过");
  process.env.CARLOS_FLOW_MCP_ROOT = root;
}

if (dryRun) {
  console.log("\n[dry-run] 以上检查全部通过，未执行推送与发布。");
  process.exit(0);
}

// 7. 推送：先推 opencode，再推 cindy。
// 顺序很重要 —— 若 opencode 先失败，cindy 尚未打 tag，不会出现「cindy 已发布、
// opencode 未发布」的半发布状态。
if (includeOpencode) {
  step(`推送 opencode v${version}`);
  try {
    run("git", ["push", "origin", "main"], { cwd: opencodePath });
    ok("opencode main 已推送");
  } catch (e) {
    console.error("  ✗ opencode 推送失败：", e.stderr ? e.stderr.toString().trim() : e.message);
    console.error("    已中止：cindy 尚未打 tag，不存在半发布。");
    process.exit(1);
  }
  const ocTag = `v${version}`;
  try {
    run("git", ["tag", ocTag], { cwd: opencodePath });
    ok(`opencode 已打 tag ${ocTag}`);
  } catch (e) {
    console.log(`  · opencode tag ${ocTag} 已存在，跳过`);
  }
  run("git", ["push", "origin", ocTag], { cwd: opencodePath });
  ok(`opencode ${ocTag} 已推送`);
}

// 8. 提交 + tag + push（cindy）
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

