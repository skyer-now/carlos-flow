#!/usr/bin/env node
// sync-readme.mjs — 保持多语言 README 集合一致
//
// 文件布局（方案 A —— 三份独立文件）：
//   README.md      ← 中文主文档（GitHub 首页 / npm 渲染页默认展示）
//   README.zh.md   ← 中文副本（保证 /README.zh.md 直链可用，与主文档一致）
//   README.en.md   ← 英文完整版（顶部语言栏切换目标）
//
// 用法：
//   node scripts/sync-readme.mjs          # 同步并校验（发现漂移时退出码 1）
//   node scripts/sync-readme.mjs --check  # 只校验，绝不写文件
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const ZH_MASTER = path.join(root, "README.md");     // 中文主文档（首页默认）
const ZH_MIRROR = path.join(root, "README.zh.md");  // 中文副本
const EN = path.join(root, "README.en.md");         // 英文完整版
const checkOnly = process.argv.includes("--check");
const NAV_EN = "(README.en.md)";
const NAV_ZH = "(README.zh.md)";

let failed = false;
const log = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

const hasNav = (text) => text.includes(NAV_EN) && text.includes(NAV_ZH);

// ---- 1. 中文主文档（首页默认）----
if (!existsSync(ZH_MASTER)) {
  log(false, "README.md (中文主文档) is missing");
} else {
  const master = readFileSync(ZH_MASTER, "utf8");
  log(hasNav(master), "README.md has the language-switch nav bar");

  // 中文主文档 → README.zh.md 副本
  if (existsSync(ZH_MIRROR)) {
    if (readFileSync(ZH_MIRROR, "utf8") === master) {
      log(true, "README.zh.md is in sync with README.md");
    } else if (checkOnly) {
      log(false, "README.zh.md differs from README.md — run `npm run sync:readme`");
    } else {
      writeFileSync(ZH_MIRROR, master, "utf8");
      log(true, "README.zh.md synced from README.md");
    }
  } else if (checkOnly) {
    log(false, "README.zh.md is missing — run `npm run sync:readme`");
  } else {
    writeFileSync(ZH_MIRROR, master, "utf8");
    log(true, "README.zh.md created from README.md");
  }
}

// ---- 2. 英文完整版 ----
if (!existsSync(EN)) {
  log(false, "README.en.md (English version) is missing");
} else {
  const en = readFileSync(EN, "utf8");
  log(hasNav(en), "README.en.md has the language-switch nav bar");
  if (/^#\s+.*(中文)/m.test(en.split("\n").slice(0, 12).join("\n"))) {
    log(false, "README.en.md looks like the Chinese version — check the copy");
  } else {
    log(true, "README.en.md is the English version");
  }
}

// ---- 3. TRIGGER_GUIDE.md ----
const TRIGGER_GUIDE = path.join(root, "TRIGGER_GUIDE.md");
if (!existsSync(TRIGGER_GUIDE)) {
  log(false, "TRIGGER_GUIDE.md is missing");
} else {
  const guide = readFileSync(TRIGGER_GUIDE, "utf8");
  log(true, "TRIGGER_GUIDE.md exists");

  // 3.1 检查版本号与 package.json 一致
  const pkgVersion = (() => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      return pkg.version;
    } catch (e) {
      return null;
    }
  })();
  // 尝试从末尾的 '**版本**:' 字段提取版本号，去掉可能的 'v' 前缀
  const versionMatch = guide.match(/\*\*版本\*\*\s*:\s *(v?\d+\.\d+\.\d+)/);
  const versionInGuide = versionMatch ? versionMatch[1].replace(/^v/, '') : null;
  if (pkgVersion && versionInGuide) {
    log(versionInGuide === pkgVersion, `TRIGGER_GUIDE.md version is ${versionInGuide} vs package.json ${pkgVersion}`);
  } else if (!pkgVersion || !versionInGuide) {
    log(false, "Could not extract version for comparison in TRIGGER_GUIDE.md or package.json");
  }
}

process.exit(failed ? 1 : 0);
