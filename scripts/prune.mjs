#!/usr/bin/env node
// prune.mjs — 存储清理（归档陈旧终态会话 + 备份去重迁移）
//
// 为什么要它：flow_stats 能告诉你「占了多少、谁占的」，但真正的清理需要一个
// **有明确安全边界**的执行入口。这个入口的三条红线：
//   1. 默认 dry-run，只打印计划，不动任何文件；
//   2. 「清理」= **归档**（移动出 FLOW_HOME），不是删除 —— 随时能搬回来；
//   3. 只归档**终态**会话（verdict 非 null）。没有结论的会话可能还有人要接着跑；
//      审计目录（gate-audit）**永不参与**：它是逐日哈希链，断一天就查不回去了。
//
// 用法：
//   node scripts/prune.mjs                         # 预览
//   node scripts/prune.mjs --apply                 # 执行（默认阈值 30 天）
//   node scripts/prune.mjs --apply --older-than 7  # 阈值改成 7 天
//   node scripts/prune.mjs --apply --backups-only  # 只做备份去重，不动会话
//   node scripts/prune.mjs --apply --sessions-only # 只归档会话，不动备份
//   node scripts/prune.mjs --apply --archive-root D:/somewhere
import fs from "node:fs";
import path from "node:path";
import { planPrune, applyPrune } from "../src/storage.js";
import { FLOW_HOME, AUDIT_DIR } from "../src/state.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (f, d) => {
  const i = argv.indexOf(f);
  if (i < 0) return d;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const apply = has("--apply");
const olderThan = num("--older-than", 30);
const backupsOnly = has("--backups-only");
const sessionsOnly = has("--sessions-only");
const archiveRoot = (() => {
  const i = argv.indexOf("--archive-root");
  return i >= 0 ? argv[i + 1] : undefined;
})();

const mb = (n) => (n / 1048576).toFixed(2) + " MB";

const auditBefore = (() => {
  let bytes = 0;
  let files = 0;
  try {
    for (const n of fs.readdirSync(AUDIT_DIR)) {
      if (!/\.jsonl$/.test(n)) continue;
      files++;
      bytes += fs.statSync(path.join(AUDIT_DIR, n)).size;
    }
  } catch { /* 没有审计目录 */ }
  return { bytes, files };
})();

const plan = planPrune({ inactiveDays: olderThan });
// --backups-only / --sessions-only：把不需要做的那一半从计划里摘掉
const wanted = {
  ...plan,
  archivable: backupsOnly ? [] : plan.archivable,
  backupConversion: sessionsOnly ? [] : plan.backupConversion,
};

console.log("════ 存储清理" + (apply ? "（执行模式）" : "（预览模式，不会动任何文件）") + " ════");
console.log("  FLOW_HOME   : " + FLOW_HOME);
console.log("  会话总数    : " + plan.sessions + "（其中 " + plan.keepActive + " 个没有结论，永不动）");
console.log("  阈值        : 超过 " + olderThan + " 天未活动");
console.log("  可归档      : " + plan.archivable.length + " 个终态会话，共 " + mb(plan.archivableBytes));
if (plan.archivable.length) {
  console.log("  样例        : " + plan.archivable.slice(0, 5).map((x) => x.session + "(" + x.inactive_days + "d)").join(", "));
}
console.log("  备份待迁移  : " + plan.backupConversion.length + " 个会话、" +
  plan.backupConversion.reduce((n, x) => n + x.legacy_files, 0) + " 个历史文件，共 " + mb(plan.backupLegacyBytes));
console.log("  审计目录    : 不参与（哈希链，删一天就断），当前 " + auditBefore.files + " 个文件 / " + mb(auditBefore.bytes));

if (apply) {
  const filtered = applyPrune(wanted, { apply: true, archiveRoot });
  console.log("");
  console.log("  已归档      : " + filtered.archived.length + " 个会话，移出 " + mb(filtered.archiveBytes));
  if (filtered.archiveDir) console.log("  归档位置    : " + filtered.archiveDir + "（随时可搬回）");
  if (filtered.archiveFailed.length) console.log("  ⚠ 归档失败  : " + filtered.archiveFailed.join(", ") + "（可能被占用，重跑即可）");
  const saved = filtered.backup.reduce((n, x) => n + x.savedBytes, 0);
  const converted = filtered.backup.reduce((n, x) => n + x.converted, 0);
  const deduped = filtered.backup.reduce((n, x) => n + x.deduped, 0);
  console.log("  备份迁移    : 改写 " + converted + " 个指针、去重 " + deduped + " 个重复文件，省下 " + mb(saved));
} else {
  console.log("");
  console.log("确认无误后加 --apply 真正执行：");
  console.log("  node scripts/prune.mjs --apply --older-than " + olderThan);
}

const auditAfter = (() => {
  let bytes = 0;
  let files = 0;
  try {
    for (const n of fs.readdirSync(AUDIT_DIR)) {
      if (!/\.jsonl$/.test(n)) continue;
      files++;
      bytes += fs.statSync(path.join(AUDIT_DIR, n)).size;
    }
  } catch { /* ignore */ }
  return { bytes, files };
})();
const auditIntact = auditAfter.files === auditBefore.files && auditAfter.bytes === auditBefore.bytes;
console.log("  审计完整性  : " + (auditIntact ? "✅ 未受影响（" + auditAfter.files + " 个文件）" : "❌ 发生变化！请立即检查"));
if (!auditIntact) process.exitCode = 1;