#!/usr/bin/env node
// sync-readme.mjs — keep README.en.md identical to README.md (English master)
// and verify README.zh.md exists with the language-switch nav bar.
//
// Usage:
//   node scripts/sync-readme.mjs          # sync + verify (exit 1 on drift)
//   node scripts/sync-readme.mjs --check  # verify only, never writes
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const MASTER = path.join(root, "README.md");       // English master
const MIRROR = path.join(root, "README.en.md");    // English mirror (badge target)
const ZH = path.join(root, "README.zh.md");        // Chinese version

const checkOnly = process.argv.includes("--check");
const NAV_EN = "(README.en.md)";
const NAV_ZH = "(README.zh.md)";

let failed = false;
const log = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

// 1. English mirror
if (!existsSync(MASTER)) {
  log(false, "README.md (English master) is missing");
} else {
  const master = readFileSync(MASTER, "utf8");
  if (!master.includes(NAV_EN) || !master.includes(NAV_ZH)) {
    log(false, "README.md is missing the language-switch nav bar");
  } else {
    log(true, "README.md has the language-switch nav bar");
  }

  if (existsSync(MIRROR)) {
    const mirror = readFileSync(MIRROR, "utf8");
    if (mirror === master) {
      log(true, "README.en.md is in sync with README.md");
    } else {
      if (checkOnly) {
        log(false, "README.en.md differs from README.md — run `npm run sync:readme`");
      } else {
        writeFileSync(MIRROR, master, "utf8");
        log(true, "README.en.md synced from README.md");
      }
    }
  } else if (checkOnly) {
    log(false, "README.en.md is missing — run `npm run sync:readme`");
  } else {
    writeFileSync(MIRROR, master, "utf8");
    log(true, "README.en.md created from README.md");
  }
}

// 2. Chinese version
if (!existsSync(ZH)) {
  log(false, "README.zh.md is missing");
} else {
  const zh = readFileSync(ZH, "utf8");
  if (zh.includes(NAV_EN) && zh.includes(NAV_ZH)) {
    log(true, "README.zh.md has the language-switch nav bar");
  } else {
    log(false, "README.zh.md is missing the language-switch nav bar");
  }
}

process.exit(failed ? 1 : 0);
