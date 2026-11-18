// 存储清理（归档 + 备份去重）—— 回归测试
//
// 这套清理逻辑最危险的三种错法，逐条钉死：
//   1. 把「还在跑」的会话当陈旧清掉（没有 verdict 的会话一律不准动）；
//   2. 「清理」变成真删除（必须是归档：移出 FLOW_HOME，能搬回来）；
//   3. 动了审计目录（哈希链，删一天就断，追溯能力永久丢失）。
// 另外还要验证：迁移后的备份仍能还原（manifest 指针正确、内容可读）。
//
// 跑法：node test/prune.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-prune-home-"));
process.env.CARLOS_FLOW_HOME = HOME;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const state = await import("../src/state.js");
const dispatch = await import("../src/dispatch.js");
const storage = await import("../src/storage.js");

const RUNS = path.join(HOME, "gate-state", "runs");
const RUNS_DIR = RUNS;
const AUDIT = path.join(HOME, "gate-audit");
const day = (n) => new Date(Date.now() - n * 86400000);

/** 造一个会话目录；terminal=true 表示已落裁定（终态） */
function makeSession(sid, { terminal = true, daysAgo = 10, content = "content-a" } = {}) {
  const st = {
    ...state.defaultState(),
    tier: "single_file",
    card: { goal: sid },
    card_ts: Date.now(),
    verdict: terminal ? "PASS" : null,
    completed_ok: terminal,
  };
  state.saveState(sid, st);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-prune-work-"));
  fs.writeFileSync(path.join(work, "a.txt"), content, "utf8");
  // 造两次快照（内容相同 → 去重后应只剩一个 blob）
  dispatch.snapshotFiles(sid, ["a.txt"], work);
  dispatch.snapshotFiles(sid, ["a.txt"], work);
  // 再塞一个「历史时间戳命名」的旧备份 + manifest 指针，模拟老版本数据
  const bdir = path.join(RUNS, sid, "backup");
  const legacyName = `${Date.now()}_deadbeef_legacy_${sid}.txt`;
  fs.writeFileSync(path.join(bdir, legacyName), content, "utf8");
  fs.appendFileSync(
    path.join(bdir, "manifest.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), orig: path.join(work, "legacy.txt"), backup: path.join(bdir, legacyName), created: false }) + "\n",
    "utf8",
  );
  // 把目录时间推到 N 天前（statSync 的 mtime 用目录时间 + state.json 时间都改）
  const old = day(daysAgo);
  try {
    fs.utimesSync(path.join(RUNS, sid, "state.json"), old, old);
    fs.utimesSync(path.join(RUNS, sid), old, old);
  } catch { /* ignore */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  return { sid, bdir, legacyName };
}

try {
  const terminalOld = makeSession("stale-terminal", { terminal: true, daysAgo: 20, content: "same-bytes" });
  const activeOld = makeSession("stale-open", { terminal: false, daysAgo: 20, content: "same-bytes" });
  const fresh = makeSession("fresh-terminal", { terminal: true, daysAgo: 0, content: "same-bytes" });

  // 审计：造一条记录，用来验证「清理不碰审计」
  state.audit("run", "prune-probe", { kind: "keep-me" });
  const auditBefore = fs.readdirSync(AUDIT).map((n) => n + ":" + fs.statSync(path.join(AUDIT, n)).size).sort().join("|");

  // ---- 1. 计划（只读）----
  const plan = storage.planPrune({ inactiveDays: 7 });
  const names = plan.archivable.map((x) => x.session);
  check("1a. 计划里只含陈旧终态会话", names.includes("stale-terminal") && !names.includes("stale-open") && !names.includes("fresh-terminal"),
    names.join(","));
  check("1b. 没有结论的会话被明确保护", !names.includes("stale-open"));
  // 回归：manifest.jsonl / after_state.jsonl 不是备份指针，不能被算成「待迁移」
  {
    const bad = plan.backupConversion.filter((x) => {
      const dir = path.join(RUNS_DIR, x.session, "backup");
      try {
        return !fs.readdirSync(dir).some((n) => n.startsWith("sha-") || !n.endsWith(".jsonl") && n !== "manifest.jsonl");
      } catch { return true; }
    });
    check("1c0. 计划不把 manifest/after_state 误算成待迁移备份",
      bad.length === 0, bad.map((x) => x.session).join(",") || "无假阳性");
  }
  check("1c. 计划识别出可迁移的历史备份", plan.backupConversion.length >= 3,
    `${plan.backupConversion.reduce((n, x) => n + x.legacy_files, 0)} 个历史文件`);
  const before = fs.readdirSync(RUNS).sort().join(",");
  check("1d. 计划阶段不改任何文件", fs.readdirSync(RUNS).sort().join(",") === before);

  // ---- 2. dry-run 不执行 ----
  storage.applyPrune(plan, { apply: false });
  check("2a. dry-run 不移动会话目录", fs.existsSync(path.join(RUNS, "stale-terminal")));
  check("2b. dry-run 不改备份文件名",
    fs.existsSync(path.join(terminalOld.bdir, terminalOld.legacyName)));

  // ---- 3. 真执行 ----
  const archiveRoot = path.join(HOME, "..", "carlos-prune-archive-" + Date.now());
  const res = storage.applyPrune(plan, { apply: true, archiveRoot });
  check("3a. 陈旧终态会话被移出 FLOW_HOME", !fs.existsSync(path.join(RUNS, "stale-terminal")));
  check("3b. 归档副本存在（可搬回，不是删除）",
    fs.existsSync(path.join(res.archiveDir, "runs", "stale-terminal")));
  check("3c. 没有结论的会话原封不动", fs.existsSync(path.join(RUNS, "stale-open")));
  check("3d. 新鲜会话原封不动", fs.existsSync(path.join(RUNS, "fresh-terminal")));

  // ---- 4. 备份迁移：历史命名 → 内容寻址，且仍能还原 ----
  const bdir = activeOld.bdir;
  const names2 = fs.readdirSync(bdir);
  check("4a. 历史时间戳命名的备份已迁移", !names2.includes(activeOld.legacyName), names2.join(","));
  check("4b. 迁移后是内容寻址命名", names2.some((n) => n.startsWith("sha-")));
  const lines = fs.readFileSync(path.join(bdir, "manifest.jsonl"), "utf8").split("\n").filter((x) => x.trim());
  const legacyEntry = lines.map((l) => JSON.parse(l)).find((e) => String(e.orig).includes("legacy.txt"));
  check("4c. manifest 指针已改写且带 sha", !!(legacyEntry && legacyEntry.sha && /sha-/.test(legacyEntry.backup)));
  const content = legacyEntry ? fs.readFileSync(legacyEntry.backup, "utf8") : "";
  check("4d. 迁移后内容仍可还原（不是只改指针）", content === "same-bytes", JSON.stringify(content));
  const dupBlobs = names2.filter((n) => n.startsWith("sha-")).length;
  // 三个会话写的是同一份内容（same-bytes），且这里同一会话里两个不同文件名的内容也相同
  check("4e. 同内容只留一份 blob（跨文件名也去重）", dupBlobs === 1, `${dupBlobs} 个 blob`);

  // ---- 5. 审计目录必须一字节不动 ----
  const auditAfter = fs.readdirSync(AUDIT).map((n) => n + ":" + fs.statSync(path.join(AUDIT, n)).size).sort().join("|");
  check("5a. 审计目录完全未被触碰", auditAfter === auditBefore && auditBefore.length > 0);
  check("5b. 审计链仍然可校验", state.verifyAuditChain().ok === true);

  try { fs.rmSync(archiveRoot, { recursive: true, force: true }); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("PRUNE_OK");