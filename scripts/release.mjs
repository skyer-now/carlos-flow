#!/usr/bin/env node
// release.mjs — 一键发布 carlos-flow 到 GitHub + npm
//
// 用法：
//   node scripts/release.mjs --version 2.5.9
//   node scripts/release.mjs --version 2.5.9 --dry-run
//   node scripts/release.mjs --version 2.5.9 --print-push-sequence
//
// 说明：
//   · 单包统一发布：carlos-flow（包含 Cindy / OpenCode / Cursor / Cline / VS Code / Claude Desktop 适配）
//   · 读取 package.json.name 确认身份，必须为 "carlos-flow"
//   · 推送 main + tag，GitHub Actions 自动创建 Release 并发布 npm

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const EXPECTED_REPO_NAME = "carlos-flow";
const SELF_REPO_NAME = (() => {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name || "";
  } catch {
    return "";
  }
})();

if (SELF_REPO_NAME !== EXPECTED_REPO_NAME) {
  console.error(`  ✗ 无法识别本仓身份：package.json.name = "${SELF_REPO_NAME || "(空)"}"`);
  console.error(`    期望 ${EXPECTED_REPO_NAME}（统一分发包）`);
  process.exit(1);
}

const version = (() => {
  const i = process.argv.indexOf("--version");
  return i > 0 ? process.argv[i + 1] : null;
})();
const dryRun = process.argv.includes("--dry-run");
const printPushSequence = process.argv.includes("--print-push-sequence");


// --print-push-sequence 仅打印推送顺序后退出，不做任何校验（供测试断言）
if (printPushSequence) {
  const PUSH_SEQUENCE = [
    { repo: "carlos-flow", desc: "推送 main + tag" },
  ];
  console.log(JSON.stringify(PUSH_SEQUENCE, null, 2));
  process.exit(0);
}
const run = (cmd, args, opts = {}) => {
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
  // ghost.json 版本一致性
  const ghostPath = resolve(repoRoot, "ghost.json");
  if (existsSync(ghostPath)) {
    const ghost = JSON.parse(readFileSync(ghostPath, "utf8"));
    if (ghost.version !== rPkg.version) {
      console.error(`  ✗ ${label}: ghost.json 版本是 ${ghost.version}，与 package.json ${rPkg.version} 不一致`);
      console.error("    （Cindy 插件市场会显示这个版本号，bump 时必须同步改）");
      process.exit(1);
    }
  }
  ok(`${label}: version=${rPkg.version} / lock=${lockVer} / CHANGELOG=${rTopVer} / 工作区干净`);
  return rPkg;
};

step(`发布前检查 v${version}`);

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`  ✗ package.json 版本是 ${pkg.version}，与 --version ${version} 不一致`);
  process.exit(1);
}
ok(`package.json version = ${pkg.version}`);

step("本仓校验");
verifyRepo(root, SELF_REPO_NAME);

step("校验双语 README");
runOrFail("npm", ["run", "check:readme"], {}, "check:readme");
ok("README.md / README.zh.md / README.en.md 一致 + TRIGGER_GUIDE.md 版本号一致");

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

if (printPushSequence) {
  console.log(JSON.stringify([{ repo: SELF_REPO_NAME, desc: "推送 main + tag" }], null, 2));
  process.exit(0);
}

if (dryRun) {
  console.log("\n[dry-run] 推送顺序：");
  console.log(`  ${SELF_REPO_NAME.padEnd(15)} —— 推送 main + tag`);
  console.log("\n[dry-run] 以上检查全部通过，未执行推送与发布。");
  process.exit(0);
}

step("运行测试套件（隔离状态目录）");
process.env.CARLOS_FLOW_MCP_ROOT = process.env.CARLOS_FLOW_MCP_ROOT || root;
const releaseHome = join(tmpdir(), "carlos-flow-release-home");
rmSync(releaseHome, { recursive: true, force: true });
process.env.CARLOS_FLOW_HOME = releaseHome;
runOrFail("npm", ["run", "test:all"], { cwd: root }, "test:all");
ok("test:all 通过");
rmSync(releaseHome, { recursive: true, force: true });

step(`推送 ${SELF_REPO_NAME} v${version}`);
try {
  run("git", ["push", "origin", "main"], { cwd: root });
  ok(`${SELF_REPO_NAME} main 已推送`);
} catch (e) {
  console.error(`  ✗ ${SELF_REPO_NAME} 推送失败：`, e.stderr ? e.stderr.toString().trim() : e.message);
  process.exit(1);
}

const tag = `v${version}`;
try {
  run("git", ["tag", tag], { cwd: root });
  ok(`${SELF_REPO_NAME} 已打 tag ${tag}`);
} catch (e) {
  console.log(`  · ${SELF_REPO_NAME} tag ${tag} 已存在，跳过`);
}
run("git", ["push", "origin", tag], { cwd: root });
ok(`${SELF_REPO_NAME} ${tag} 已推送（GitHub Actions 将自动创建 Release 并发布 npm）`);

step("完成");
console.log(`  关注 CI：https://github.com/${pkg.repository.url.split("github.com/")[1]?.replace(".git", "") || "skyer-now/carlos-flow"}/actions`);