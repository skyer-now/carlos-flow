#!/usr/bin/env node
import { existsSync } from "node:fs";
const artifacts = ["src/index.js", "package.json", "ghost.json"];
for (const a of artifacts) {
  if (!existsSync(a)) { console.error(`❌ ${a} 不存在`); process.exit(1); }
}
console.log("✅ 产物存在性检查通过");
