#!/usr/bin/env node
// release.mjs — 一键发布 carlos-flow-cindy / carlos-flow-opencode 到 GitHub + npm
//
// 用法：
//   node scripts/release.mjs --version 2.5.5
//   node scripts/release.mjs --version 2.5.5 --dry-run
//   node scripts/release.mjs --version 2.5.5 --include-peer            # 连对方仓一起发布
//   node scripts/release.mjs --version 2.5.5 --include-peer --dry-run
//
// 说明：
//   · 本脚本可在**任意一仓**里跑（两仓 release.mjs 逐字相同）；
//     它会读本仓 package.json.name 判定身份，并把本仓**始终**发布；
//   · --include-peer 控制**对方仓**是否一起发布（语义与本仓位置无关）；
//     --include-opencode 是历史别名，保留兼容；
//   · 推送顺序固定为 opencode → cindy（先推失败则尚未给任何仓打 tag，不会半发布）。
//
// 前置条件（需已具备）：
//   1. GitHub 凭据：gh CLI 已登录，或 .git-credentials / remote URL 内含有效 PAT
//   2. npm 凭据：~/.npmrc 或项目 .npmrc.local 含有效 _authToken
//   3. 工作区干净（无未提交改动）
//
// 脚本只做「构建 → 校验 → 提交 → 打 tag → 推送 → 发布」，不做任何凭据读取或打印。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// 本脚本是**双仓**发布器，但可能在任意一仓里运行（两仓 release.mjs 被 parity 守卫
// 要求逐字相同）。早期版本把身份写死：
//   verifyRepo(root, "carlos-flow-cindy")
//   opencodePath = resolve(root, "..", "carlos-flow-opencode")
// → 在 opencode 仓里运行时，opencodePath 会解析成**自己**：对方仓校验成自校验、
//   日志标签互换、PUSH_SEQUENCE 的 cindy 步（未指定 cwd）仍推 opencode，
//   结果是 **cindy 永不发布、opencode 被重复发布**。
// 现在改为**自适应身份**：从本仓 package.json.name 读出自己是谁，
// 对方仓路径由 sibling 目录推导，标签用真实身份。
const SELF_REPO_NAME = (() => {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name || "";
  } catch {
    return "";
  }
})();
const SELF_ID = SELF_REPO_NAME === "carlos-flow-opencode" ? "opencode" : "cindy";
const PEER_ID = SELF_ID === "cindy" ? "opencode" : "cindy";
const PEER_REPO_NAME = `carlos-flow-${PEER_ID}`;
const PEER_PATH = resolve(root, "..", PEER_REPO_NAME);

// 身份自检：package.json.name 必须是两个已知仓之一。
// 之前直接默认成 cindy —— 仓被改名/复制时会把身份搞错，进而推送错仓。
if (SELF_REPO_NAME !== "carlos-flow-cindy" && SELF_REPO_NAME !== "carlos-flow-opencode") {
  console.error(`  ✗ 无法识别本仓身份：package.json.name = "${SELF_REPO_NAME || "(空)"}"`);
  console.error("    期望 carlos-flow-cindy 或 carlos-flow-opencode（发布脚本按仓名定位双方仓）");
  process.exit(1);
}

// 按**仓名**解析该仓的本地路径。
// PUSH_SEQUENCE 是按仓名（opencode / cindy）索引的，不能直接拿 peerPath 当 cwd ——
// peerPath 恒等于「对方仓」：在 opencode 仓跑时它是 cindy 仓，
// 会把 cindy 当成 opencode 推 → **推送顺序反转**，破坏「先 opencode 后 cindy 防半发布」的保证。
const repoPathOf = (id) => (id === SELF_ID ? root : PEER_PATH);
const version = (() => {
  const i = process.argv.indexOf("--version");
  return i > 0 ? process.argv[i + 1] : null;
})();
const dryRun = process.argv.includes("--dry-run");
const printPushSequence = process.argv.includes("--print-push-sequence");

// 推送顺序（**执行顺序 = 数组顺序**）：必须先 opencode、再 cindy。
// 若 opencode 先失败，cindy 尚未打 tag → 不会出现「cindy 已发布、opencode 未发布」的半发布。
// 这个顺序是本轮防半发布的核心，因此由测试守护：test/e2e-carlos.mjs 的 25b 断言本数组顺序。
const PUSH_SEQUENCE = [
  { repo: "opencode", desc: "先推 opencode（main + tag）" },
  { repo: "cindy", desc: "再推 cindy（main + tag）" },
];

// 仅打印推送顺序（JSON）后退出，不做任何发布动作 —— 供测试断言与人工核对。
if (printPushSequence) {
  console.log(JSON.stringify(PUSH_SEQUENCE, null, 2));
  process.exit(0);
}
// 「连对方仓一起发布」的开关。
// 参数名统一为 --include-peer（语义与本仓位置无关）；--include-opencode 保留为兼容别名。
const includePeer = process.argv.includes("--include-peer") || process.argv.includes("--include-opencode");

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
  // ghost.json（Cindy 插件市场清单）的 version 也必须与 package.json 一致 ——
  // 否则插件市场里显示的还是旧版本号（实测曾落后 4 个版本：2.5.1 vs 2.5.5）。
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

// 1. package.json 版本一致
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`  ✗ package.json 版本是 ${pkg.version}，与 --version ${version} 不一致`);
  process.exit(1);
}
ok(`package.json version = ${pkg.version}`);

// 1b. 完整仓库校验（版本 / lock / CHANGELOG / 工作区干净 / ghost.json 版本）
verifyRepo(root, SELF_REPO_NAME);

// 1c. 双仓一致性守卫（必须在任何推送之前）
// 防止跨仓同步时把某一版的文件整份覆盖到另一版（如把 Cindy 版 README
// 覆盖到 opencode 仓，导致该仓对外宣称自己是「Cindy 适配版」）。
step("双仓一致性检查");
runOrFail("node", ["scripts/check-repo-parity.mjs"], { cwd: root }, "check:parity");
ok("双仓一致：核心逻辑逐字相同 / 专属文件无交叉 / 身份标识各自正确");

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
// 隔离状态目录：发布演练**绝不能**写用户的 ~/.carlos-flow
// （否则会把发布者的真实会话/审计流水污染掉）
const releaseHome = join(tmpdir(), "carlos-flow-release-home", "cindy");
rmSync(releaseHome, { recursive: true, force: true });
process.env.CARLOS_FLOW_HOME = releaseHome;
runOrFail("npm", ["run", "test:all"], {
  cwd: root,
}, "test:all（smoke + e2e-carlos + p0-gates + trigger-e2e + concurrency）");
ok("test:all 通过（smoke + e2e-carlos + p0-gates + trigger-e2e + concurrency）");
rmSync(releaseHome, { recursive: true, force: true });

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

// 6b. 对方仓校验（必须在**任何推送之前**完成，否则会出现半发布）
// 对方仓路径由 sibling 目录推导（见文件头的 SELF_ID / PEER_ID），
// 不再写死「carlos-flow-opencode」—— 否则在 opencode 仓跑会指向自己。
let peerPath = null;
if (includePeer) {
  peerPath = PEER_PATH;
  if (!existsSync(peerPath)) {
    console.error(`  ✗ 未找到对方仓库 ${PEER_REPO_NAME}: ${peerPath}`);
    process.exit(1);
  }
  step(`校验对方仓 ${PEER_REPO_NAME} v${version}`);
  verifyRepo(peerPath, PEER_REPO_NAME);
  // 对方仓也跑一遍自己的测试与文档校验（同样隔离状态目录）
  process.env.CARLOS_FLOW_MCP_ROOT = peerPath;
  const peerHome = join(tmpdir(), "carlos-flow-release-home", PEER_ID);
  rmSync(peerHome, { recursive: true, force: true });
  process.env.CARLOS_FLOW_HOME = peerHome;
  runOrFail("npm", ["run", "test:all"], { cwd: peerPath }, `${PEER_ID} test:all`);
  ok(`${PEER_ID} test:all 通过`);
  rmSync(peerHome, { recursive: true, force: true });
  runOrFail("npm", ["run", "check:readme"], { cwd: peerPath }, `${PEER_ID} check:readme`);
  ok("opencode check:readme 通过");
  process.env.CARLOS_FLOW_MCP_ROOT = root;
  process.env.CARLOS_FLOW_HOME = releaseHome;
}

if (dryRun) {
  console.log("\n[dry-run] 推送顺序（opencode 必须先于 cindy，否则会出现半发布）：");
  for (const t of PUSH_SEQUENCE) {
    console.log(`  ${t.repo.padEnd(9)} —— ${t.desc}`);
  }
  console.log("\n[dry-run] 以上检查全部通过，未执行推送与发布。");
  process.exit(0);
}

// 7. 按 PUSH_SEQUENCE 顺序推送：先 opencode，再 cindy。
// 顺序很重要 —— 若 opencode 先失败，cindy 尚未打 tag，不会出现「cindy 已发布、
// opencode 未发布」的半发布状态。
for (const target of PUSH_SEQUENCE) {
  // 跳过逻辑与路径解析**同源于身份**（R1 修复）：
  //   · 本仓（SELF_ID）→ 始终发布（发自己的包是本脚本的默认职责）
  //   · 对方仓（PEER_ID）→ 受 --include-peer 开关约束
  // 旧代码把跳过条件写在「opencode」分支里（按标签），而路径按身份解析，
  // 在 opencode 仓不带 --include-peer 时会「跳过自己、推了对方」。
  const isSelf = target.repo === SELF_ID;
  if (!isSelf && !includePeer) {
    console.log(`  · 跳过对方仓 ${target.repo}（未指定 --include-peer）`);
    continue;
  }

  // 路径按**仓名**解析：不能直接用 peerPath（在 opencode 仓跑时它指向 cindy）。
  const targetPath = repoPathOf(target.repo);
  const label = `${target.repo} (${isSelf ? "本仓" : "对方仓"})`;

  step(`推送 ${label} v${version}`);
  try {
    run("git", ["push", "origin", "main"], { cwd: targetPath });
    ok(`${label} main 已推送`);
  } catch (e) {
    console.error(`  ✗ ${label} 推送失败：`, e.stderr ? e.stderr.toString().trim() : e.message);
    console.error("    已中止：尚未给任何仓打 tag，不存在半发布。");
    process.exit(1);
  }

  const tag = `v${version}`;
  try {
    run("git", ["tag", tag], { cwd: targetPath });
    ok(`${label} 已打 tag ${tag}`);
  } catch (e) {
    console.log(`  · ${label} tag ${tag} 已存在，跳过`);
  }
  run("git", ["push", "origin", tag], { cwd: targetPath });
  ok(`${label} ${tag} 已推送（release workflow 将自动创建 GitHub Release 并发布 npm）`);
}

step("完成");
console.log(`  GitHub Release + npm 发布由 .github/workflows/release.yml 在 tag 推送后自动执行。`);
console.log(`  关注 CI：https://github.com/${pkg.repository.url.split("github.com/")[1]?.replace(".git", "") || "skyer-now/carlos-flow-" + pkg.name.split("-").pop()}/actions`);

