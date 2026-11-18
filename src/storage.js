// storage.js — 存储度量与清理（flow_stats / carlos prune / 测试共用同一套口径）
//
// 为什么单独一个模块：度量与清理必须用**同一份**口径。分散在 index.js 与 CLI 里各写一遍，
// 迟早出现「flow_stats 说 4MB、prune 删了 6MB」这种对不上账的情况，而磁盘清理最怕对不上账。
//
// 三条红线（本模块自身不越界，也不给调用方留越界口子）：
//   1. **绝不碰 gate-audit**：审计是逐日哈希链，删一天就断链，追溯能力永久丢失；
//   2. 「归档」= 移出 FLOW_HOME（不是删除），随时能搬回来；
//   3. 只归档**终态**会话（verdict 非 null）—— 没有结论的会话可能还有人要接着跑。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FLOW_HOME, AUDIT_DIR, RUNS_DIR, sanitizeId } from "./state.js";
import { pruneSnapshots } from "./dispatch.js";

// ---- 基础度量 -------------------------------------------------------------

export function dirUsage(dir, budget = { files: 20000 }) {
  const out = { bytes: 0, files: 0, truncated: false };
  const walk = (d, depth) => {
    if (depth > 6 || out.truncated) return;
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      if (out.files >= budget.files) { out.truncated = true; return; }
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full, depth + 1); continue; }
      try {
        const st = fs.statSync(full);
        out.bytes += st.size;
        out.files++;
      } catch { /* 并发删除：忽略 */ }
    }
  };
  walk(dir, 0);
  return out;
}

export function listSessions(limit = 300) {
  let names = [];
  try { names = fs.readdirSync(RUNS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    if (out.length >= limit) break;
    out.push(ent.name);
  }
  return out;
}

export function sessionSummary(dirName) {
  const dir = path.join(RUNS_DIR, dirName);
  const usage = dirUsage(dir);
  const stateFile = path.join(dir, "state.json");
  let state = null;
  let mtime = 0;
  try {
    mtime = fs.statSync(stateFile).mtimeMs;
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch { /* 没有状态或有坏文件：按未知处理 */ }
  const backup = dirUsage(path.join(dir, "backup"));
  return {
    session: dirName,
    bytes: usage.bytes,
    files: usage.files,
    backup_bytes: backup.bytes,
    last_active: mtime ? new Date(mtime).toISOString() : null,
    inactive_days: mtime ? Math.floor((Date.now() - mtime) / 86400000) : null,
    tier: state && state.tier ? state.tier : null,
    verdict: state && state.verdict ? state.verdict : null,
    completed_ok: !!(state && state.completed_ok),
    has_card: !!(state && state.card),
  };
}

/** 备份去重率：manifest 记录的总字节 vs 实际占用（内容寻址后同内容只存一份） */
export function backupDedup(sessions) {
  let referencedBytes = 0;
  let referencedEntries = 0;
  let uniqueBytes = 0;
  let uniqueBlobs = 0;
  for (const sid of sessions) {
    const dir = path.join(RUNS_DIR, sid, "backup");
    const blobs = new Map();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith("sha-")) continue;
        const st = fs.statSync(path.join(dir, name));
        blobs.set(name, st.size);
        uniqueBytes += st.size;
        uniqueBlobs++;
      }
    } catch { /* 无 backup 目录 */ }
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(dir, "manifest.jsonl"), "utf8").split("\n").filter((x) => x.trim());
    } catch { lines = []; }
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e && e.backup) {
          referencedEntries++;
          referencedBytes += Number(e.bytes) || blobs.get(path.basename(e.backup)) || 0;
        }
      } catch { /* 坏行跳过 */ }
    }
  }
  const saved = Math.max(0, referencedBytes - uniqueBytes);
  return {
    references: referencedEntries,
    referenced_bytes: referencedBytes,
    unique_blobs: uniqueBlobs,
    unique_bytes: uniqueBytes,
    saved_bytes: saved,
    dedup_ratio: referencedBytes > 0 ? Number((saved / referencedBytes).toFixed(4)) : 0,
  };
}

export function auditDayStats() {
  let names = [];
  try { names = fs.readdirSync(AUDIT_DIR); } catch { return []; }
  const byDay = new Map();
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(name);
    if (!m) continue;
    let size = 0;
    try { size = fs.statSync(path.join(AUDIT_DIR, name)).size; } catch { continue; }
    const cur = byDay.get(m[1]) || { date: m[1], bytes: 0, shards: 0 };
    cur.bytes += size;
    cur.shards++;
    byDay.set(m[1], cur);
  }
  return Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 一次汇总（flow_stats 用），避免调用方各拼一遍。 */
export function storageOverview({ limit = 10, inactiveDays = 7 } = {}) {
  const sessions = listSessions(300);
  const summaries = sessions.map(sessionSummary);
  const totalBytes = summaries.reduce((n, x) => n + x.bytes, 0);
  const backupBytes = summaries.reduce((n, x) => n + x.backup_bytes, 0);
  const top = summaries.slice().sort((x, y) => y.bytes - x.bytes).slice(0, limit);
  const staleCandidates = summaries
    .filter((x) => x.inactive_days !== null && x.inactive_days >= inactiveDays)
    .sort((x, y) => y.inactive_days - x.inactive_days);
  const terminal = staleCandidates.filter((x) => x.verdict !== null);

  const auditDays = auditDayStats();
  const auditBytes = auditDays.reduce((n, x) => n + x.bytes, 0);
  const triggerUsage = dirUsage(path.join(FLOW_HOME, "trigger-state"));

  return {
    sessions,
    summaries,
    totalBytes,
    backupBytes,
    top,
    staleCandidates,
    terminal,
    auditDays,
    auditBytes,
    triggerUsage,
    dedup: backupDedup(sessions),
  };
}

// ---- 备份迁移（历史时间戳命名 → 内容寻址） ---------------------------------
//
// 老版本把备份按 `<ts>_<rand>_<name>` 命名，多轮返工就是 N 份同样的字节。
// 这里把它们原地迁移成 `sha-<hash>_<name>`：同内容只留一份，manifest 里的 backup 指针同步改写。
// 只动 backup/ 目录里**被 manifest 引用**的文件，其它文件（after_state_<ts>/ 等）一概不碰。
export function migrateSessionBackups(sid, { dryRun = true } = {}) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid), "backup");
  const manifest = path.join(dir, "manifest.jsonl");
  let lines = [];
  try {
    lines = fs.readFileSync(manifest, "utf8").split("\n").filter((x) => x.trim());
  } catch {
    return { session: sid, converted: 0, deduped: 0, savedBytes: 0, skipped: 0 };
  }
  let converted = 0;
  let deduped = 0;
  let savedBytes = 0;
  let skipped = 0;
  const out = [];
  const shaByFile = new Map();

  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      out.push(line); // 坏行原样保留（不要静默丢数据）
      continue;
    }
    if (!e || !e.backup || typeof e.backup !== "string") {
      out.push(JSON.stringify(e));
      continue;
    }
    const base = path.basename(e.backup);
    if (base.startsWith("sha-")) {
      out.push(JSON.stringify(e));
      continue;
    }
    const src = path.join(dir, base);
    let buf = null;
    try {
      buf = fs.readFileSync(src);
    } catch {
      skipped++;
      out.push(JSON.stringify(e));
      continue;
    }
    let sha = shaByFile.get(base);
    if (!sha) {
      sha = createHash("sha256").update(buf).digest("hex");
      shaByFile.set(base, sha);
    }
    const targetName = `sha-${sha.slice(0, 32)}${path.extname(e.orig || "").toLowerCase()}`;
    const target = path.join(dir, targetName);
    const exists = fs.existsSync(target);
    if (exists) {
      deduped++;
      savedBytes += buf.length;
      if (!dryRun) {
        try { fs.unlinkSync(src); } catch { /* 已被别人清掉 */ }
      }
    } else {
      converted++;
      if (!dryRun) {
        try {
          fs.renameSync(src, target);
        } catch {
          // 跨设备或占用：退化为复制 + 删源
          try {
            fs.writeFileSync(target, buf);
            fs.unlinkSync(src);
          } catch {
            skipped++;
            out.push(JSON.stringify(e));
            continue;
          }
        }
      }
    }
    out.push(JSON.stringify({
      ...e,
      backup: target,
      sha,
      bytes: buf.length,
      deduped: exists,
    }));
  }

  if (!dryRun) {
    try {
      fs.writeFileSync(manifest, out.join("\n") + (out.length ? "\n" : ""), "utf8");
      // 迁移完立刻按「每文件 3 版」裁剪一次（删除不再被引用的 sha- blob）
      pruneSnapshots(sid);
    } catch {
      /* 写不进去就保持原样，下次再迁 */
    }
  }
  return { session: sid, converted, deduped, savedBytes, skipped };
}

// ---- 清理计划与执行 -------------------------------------------------------

/**
 * 生成清理计划（**只读，不改任何文件**）。
 *
 * - stale：超过 inactiveDays 天没有活动的会话
 * - archivable：其中已是终态（verdict 非 null）的 —— 只有这些会被真正归档
 * - backups：可迁移去重的备份（历史时间戳命名）
 */
export function planPrune({ inactiveDays = 30, limit = 500 } = {}) {
  const sessions = listSessions(limit);
  const summaries = sessions.map(sessionSummary);
  const stale = summaries
    .filter((x) => x.inactive_days !== null && x.inactive_days >= inactiveDays)
    .sort((x, y) => y.bytes - x.bytes);
  const archivable = stale.filter((x) => x.verdict !== null);

  // 待迁移的备份 = **manifest 里被当作 backup 指针引用**、且还不是内容寻址命名的文件。
  //
  // 不能简单「目录里所有带扩展名的文件」：manifest.jsonl、after_state.jsonl 也都带扩展名，
  // 会被算成「30 个历史文件待迁移」，实际一个都迁不了（它们不是备份指针）——
  // 这种假数字会让使用者以为清理器没干活。
  const backupConversion = [];
  for (const s of summaries) {
    const dir = path.join(RUNS_DIR, s.session, "backup");
    let legacy = 0;
    let bytes = 0;
    try {
      const lines = fs.readFileSync(path.join(dir, "manifest.jsonl"), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || typeof e.backup !== "string" || e.backup === "") continue;
        if (path.basename(e.backup).startsWith("sha-")) continue;
        legacy++;
        try { bytes += fs.statSync(e.backup).size; } catch { /* 指针悬空：不计字节 */ }
      }
    } catch { /* 无 manifest：没有可迁移的备份指针 */ }
    if (legacy > 0) backupConversion.push({ session: s.session, legacy_files: legacy, legacy_bytes: bytes });
  }

  return {
    inactiveDays,
    sessions: summaries.length,
    archivable,
    archivableBytes: archivable.reduce((n, x) => n + x.bytes, 0),
    staleBytes: stale.reduce((n, x) => n + x.bytes, 0),
    keepActive: summaries.filter((x) => x.verdict === null).length,
    backupConversion,
    backupLegacyBytes: backupConversion.reduce((n, x) => n + x.legacy_bytes, 0),
  };
}

function moveDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
    return true;
  } catch {
    // 跨盘：退化为复制 + 删源
    try {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 执行清理计划：归档陈旧终态会话 + 迁移备份去重。
 *
 * @param {object} plan planPrune() 的返回值
 * @param {{ apply?: boolean, archiveRoot?: string }} opts
 */
export function applyPrune(plan, { apply = false, archiveRoot } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const root = archiveRoot || path.join(path.dirname(FLOW_HOME), path.basename(FLOW_HOME) + "-archive");
  const archiveDir = path.join(root, stamp);
  const result = {
    apply,
    archiveDir: apply ? archiveDir : null,
    archived: [],
    archiveFailed: [],
    archiveBytes: 0,
    backup: [],
    backupSavedBytes: 0,
  };

  // ① 归档陈旧终态会话（移动，不删除；审计目录绝不参与）
  for (const s of plan.archivable) {
    const src = path.join(RUNS_DIR, s.session);
    const dest = path.join(archiveDir, "runs", s.session);
    if (!apply) {
      result.archived.push({ session: s.session, bytes: s.bytes });
      result.archiveBytes += s.bytes;
      continue;
    }
    if (moveDir(src, dest)) {
      result.archived.push({ session: s.session, bytes: s.bytes });
      result.archiveBytes += s.bytes;
    } else {
      result.archiveFailed.push(s.session);
    }
  }

  // ② 备份去重迁移（只处理历史时间戳命名；已在 manifest 里的指针同步改写）
  for (const b of plan.backupConversion) {
    const r = migrateSessionBackups(b.session, { dryRun: !apply });
    if (r.converted > 0 || r.deduped > 0) {
      result.backup.push(r);
      result.backupSavedBytes += r.savedBytes;
    }
  }

  return result;
}