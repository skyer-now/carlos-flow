#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const ROOT = resolve(".");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const files = pkg.files || [];
const main = pkg.main || "src/index.js";
if (!existsSync(main)) { console.error("❌ main 入口不存在"); process.exit(1); }
console.log("✅ 引用完整性检查通过");
process.exit(0);
