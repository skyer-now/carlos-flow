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

function writeText(rel, text) {
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
  } else {
    console.error(
      `❌ CHANGELOG.md 顶部是 ${topVer || "(无)"}，与 ${ver} 不一致。\n` +
        `   请先写好 ${ver} 的变更条目，再运行：\n` +
        `     node scripts/sync-version.mjs --changelog "本版标题"`,
    );
    process.exit(1);
  }
}

console.log("\n✅ 版本号已全部对齐到 " + ver);
