// 版本号同步脚本 —— 消除「版本号散落多处」这个根因
//
// 为什么需要它：
//   本项目的版本号同时出现在 4 个地方（package.json / package-lock.json /
//   ghost.json / TRIGGER_GUIDE.md / CHANGELOG.md）。人工改一处漏一处，
//   release.yml 的「单包一致性检查」就会红，发布流程直接中止。
//   本脚本以 package.json 为唯一真源，把其余位置批量对齐。
//
// 用法：
//   node scripts/sync-version.mjs                     仅同步并校验（不改 CHANGELOG）
//   node scripts/sync-version.mjs --changelog "标题"   同时在 CHANGELOG 顶部插入新条目
//   node scripts/sync-version.mjs --date 2026-11-13    指定条目日期（默认今天）
//   node scripts/sync-version.mjs --check             只读校验：有偏差则退出码 1 且**不写文件**
//
// --check 为什么需要：推 tag 前置钩子要判断「版本号是否已对齐且已提交」。
//   普通模式会写文件（退出码总是 0），没法用来做只读判定；
//   --check 不写任何文件，有偏差就退出 1。

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readText(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
}

let changedFiles = [];

function writeText(rel, text) {
  if (CHECK_ONLY) {
    // --check 模式只记录，不落盘
    if (!changedFiles.includes(rel)) changedFiles.push(rel);
    console.log("  ❌ " + rel + " 需同步");
    return;
  }
  writeFileSync(join(ROOT, rel), text, "utf8");
  console.log(`  ✏️  ${rel}`);
}

function readJson(rel) {
  try {
    return JSON.parse(readText(rel));
  } catch {
    return null;
  }
}

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const changelogTitle = argv.includes("--changelog")
  ? argv[argv.indexOf("--changelog") + 1]
  : null;
const dateArg = argv.includes("--date")
  ? argv[argv.indexOf("--date") + 1]
  : null;

const pkg = readJson("package.json");
if (!pkg || !pkg.version) {
  console.error("❌ 读不到 package.json 的 version");
  process.exit(1);
}
const ver = pkg.version;
console.log(`▶ 目标版本：${ver}\n`);

// ---- 1. package-lock.json ----
const lock = readJson("package-lock.json");
if (lock) {
  let changed = false;
  if (lock.version !== ver) {
    lock.version = ver;
    changed = true;
  }
  if (lock.packages && lock.packages[""] && lock.packages[""].version !== ver) {
    lock.packages[""].version = ver;
    changed = true;
  }
  if (changed) {
    writeText("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  } else {
    console.log("  ✅ package-lock.json 已是 " + ver);
  }
}

// ---- 2. ghost.json ----
const ghost = readJson("ghost.json");
if (ghost) {
  if (ghost.version !== ver) {
    ghost.version = ver;
    writeText("ghost.json", JSON.stringify(ghost, null, 2) + "\n");
  } else {
    console.log("  ✅ ghost.json 已是 " + ver);
  }
}

// ---- 3. TRIGGER_GUIDE.md（两处「版本」行）----
let guide = readText("TRIGGER_GUIDE.md");
if (guide) {
  const before = guide;
  guide = guide.replace(/v\d+\.\d+\.\d+/g, "v" + ver);
  if (guide !== before) {
    writeText("TRIGGER_GUIDE.md", guide);
  } else {
    console.log("  ✅ TRIGGER_GUIDE.md 已是 " + ver);
  }
}

// ---- 4. CHANGELOG.md ----
let changelog = readText("CHANGELOG.md");
if (changelog) {
  const topMatch = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  const topVer = topMatch ? topMatch[1] : null;

  if (topVer === ver) {
    console.log("  ✅ CHANGELOG.md 顶部已是 " + ver);
  } else if (changelogTitle) {
    const d = dateArg || new Date().toISOString().slice(0, 10);
    const entry = `## [${ver}] - ${d} — ${changelogTitle}\n\n### ✨ 新增 | Added\n\n- （待补充）\n\n`;
    // 插到「---」分隔线之后、首个版本段落之前
    const sepIdx = changelog.indexOf("\n---\n");
    const insertAt = sepIdx === -1 ? 0 : sepIdx + "\n---\n\n".length;
    changelog =
      changelog.slice(0, insertAt) + entry + changelog.slice(insertAt);
    writeText("CHANGELOG.md", changelog);
  } else if (CHECK_ONLY) {
    // --check 模式：只报告偏差，不退出（最后统一汇总）
    if (!changedFiles.includes("CHANGELOG.md")) changedFiles.push("CHANGELOG.md");
    console.log("  ❌ CHANGELOG.md 顶部需同步");
  } else {
    console.error(
      `❌ CHANGELOG.md 顶部是 ${topVer || "(无)"}，与 ${ver} 不一致。\n` +
        `   请先写好 ${ver} 的变更条目，再运行：\n` +
        `     node scripts/sync-version.mjs --changelog "本版标题"`,
    );
    process.exit(1);
  }
}

if (CHECK_ONLY) {
  if (changedFiles.length) {
    console.error(
      "\n❌ 版本号未对齐，需同步：" + changedFiles.join("、") +
        "\n   请运行：npm run sync:version（改完记得提交）",
    );
    process.exit(1);
  }
  console.log("\n✅ 版本号已全部对齐到 " + ver);
} else {
  console.log("\n✅ 版本号已全部对齐到 " + ver);
}
