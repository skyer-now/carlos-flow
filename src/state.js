// state.js — Carlos 工作流：持久化 / 审计 / quote 数据源（Node ESM，零外部依赖）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const FLOW_HOME = path.normalize(process.env.CARLOS_FLOW_HOME || path.join(os.homedir(), ".carlos-flow"));
export const AUDIT_DIR = path.join(FLOW_HOME, "gate-audit");
export const RUNS_DIR = path.join(FLOW_HOME, "gate-state", "runs");

// OpenCode 会话库路径：环境变量优先，回落到跨平台默认
// OPENCODE_DB_PATH / OPENCODE_DB 与插件侧同一套约定
const OPENCODE_DB = path.normalize(
  process.env.OPENCODE_DB_PATH ||
    process.env.OPENCODE_DB ||
    process.env.CARLOS_OPENCODE_DB ||
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
);

function localDate() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function sanitizeId(s) {
  const v = String(s || "").replace(/[^A-Za-z0-9_.-]/g, "_");
  if (v === "") return "unknown";
  // 路径穿越防护：拒绝包含 .. 的 ID
  if (v.includes("..")) {
    throw new Error(`invalid session id (path traversal detected): ${s}`);
  }
  return v;
}

export function defaultState() {
  return {
    card: null,
    card_ts: 0,
    tier: "read_only",
    task_id: null,
    dispatch_count: 0,
    write_files: 0,
    last_user_ts: 0,
    bypass: false,
    bypass_ts: 0,
    verdict: null,
    completed_ok: false,
    stale: false,
  };
}

export function loadState(sid) {
  try {
    const file = path.join(RUNS_DIR, sanitizeId(sid), "state.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultState();
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

export function saveState(sid, state) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "state.json.tmp");
  const target = path.join(dir, "state.json");
  fs.writeFileSync(tmp, JSON.stringify(state ?? defaultState(), null, 2), "utf8");
  fs.renameSync(tmp, target);
  return target;
}

// 追加审计行；永不抛错，失败仅写 stderr；返回记录对象
// 读取审计文件最后一条记录的 hash（多进程安全：每次从磁盘尾部取，不依赖进程内变量）
// 旧格式记录没有 hash 字段 → 视为链起点（prev = 全 0）
function lastHashOf(file) {
  const ZERO = "0".repeat(64);
  try {
    const stat = fs.statSync(file);
    if (!stat || stat.size === 0) return ZERO;
    const len = Math.min(stat.size, 8192);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, stat.size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r && typeof r.hash === "string" && r.hash.length === 64) return r.hash;
      } catch {
        /* 坏行跳过 */
      }
    }
    return ZERO;
  } catch {
    return ZERO;
  }
}

// 哈希载荷：除链字段外的全部字段，保持写入/校验口径完全一致
function auditPayload(rec) {
  const SKIP = new Set(["ts", "type", "sessionID", "prevHash", "hash"]);
  const out = {};
  for (const k of Object.keys(rec)) {
    if (!SKIP.has(k)) out[k] = rec[k];
  }
  return JSON.stringify(out);
}

// 追加审计行；永不抛错，失败仅写 stderr；返回记录对象
export function audit(type, sid, fields = {}) {
  const rec = {
    ts: new Date().toISOString(),
    type,
    sessionID: sanitizeId(sid),
    ...(fields && typeof fields === "object" ? fields : {}),
  };
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const file = path.join(AUDIT_DIR, `${localDate()}.jsonl`);
    // 前驱 hash 取自目标文件尾部 → 与进程数无关，切换状态目录也不会断链
    const prev = lastHashOf(file);
    rec.prevHash = prev;
    rec.hash = createHash("sha256")
      .update(rec.ts + rec.type + rec.sessionID + auditPayload(rec) + prev)
      .digest("hex");
    // 单次 appendFileSync：O_APPEND 语义，多进程并发写不会互相截断
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    try {
      process.stderr.write(`[flow-audit] 写入失败: ${e && e.message ? e.message : e}\n`);
    } catch {}
  }
  return rec;
}

// 校验审计链完整性（可选：需完整文件，不能只看尾部）
export function verifyAuditChain(opts = {}) {
  const rawDate = typeof opts.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : localDate();
  const file = path.join(AUDIT_DIR, `${localDate()}.jsonl`);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, total: 0, broken: 0, legacy: 0, brokenAt: [], file };
  }
  let prev = "0".repeat(64);
  let total = 0;
  let broken = 0;
  let legacy = 0;
  const brokenAt = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      continue;
    }
    total++;
    if (typeof r.hash !== "string") {
      legacy++;
      prev = "0".repeat(64);
      continue;
    }
    const expect = createHash("sha256")
      .update(r.ts + r.type + r.sessionID + auditPayload(r) + prev)
      .digest("hex");
    if (expect !== r.hash || r.prevHash !== prev) {
      broken++;
      if (brokenAt.length < 10) brokenAt.push({ ts: r.ts, type: r.type, kind: r.kind });
    }
    prev = r.hash;
  }
  return { ok: broken === 0, total, broken, legacy, brokenAt, file };
}

export function readAudit(opts = {}) {
  const { sessionId, type, limit } = opts;
  const rawDate = typeof opts.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : localDate();
  try {
    const file = path.join(AUDIT_DIR, `${localDate()}.jsonl`);
    const raw = fs.readFileSync(file, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try {
        rec = JSON.parse(t);
      } catch {
        continue; // 坏行跳过
      }
      if (sessionId != null && rec.sessionID !== sanitizeId(sessionId)) continue;
      if (type != null && rec.type !== type) continue;
      out.push(rec);
    }
    if (typeof limit === "number" && limit >= 0) return out.slice(-limit); // 取最近 N 条
    return out;
  } catch {
    return [];
  }
}

// 从用户消息源读取原文（quote 锚点数据源）。
// 三个来源按优先级合并：
//   1. $CARLOS_USER_MSGS          —— 启动时注入的 JSON 数组（最直接）
//   2. RUNS_DIR/<sid>/user_msgs.jsonl —— 本会话写入的用户原话（Cindy 路径）
//   3. OpenCode SQLite            —— 宿主是 OpenCode 时直接读它的会话库
// 任何异常 → 返回 null，绝不抛错。
export async function getUserMessages(sid, limit = 20) {
  const out = [];

  // 1. 环境变量注入
  try {
    const envMsgs = process.env.CARLOS_USER_MSGS;
    if (envMsgs) {
      const arr = JSON.parse(envMsgs);
      if (Array.isArray(arr)) {
        for (const m of arr) if (typeof m === "string" && m !== "") out.push(m);
      }
    }
  } catch {}

  // 2. 会话目录里的 user_msgs.jsonl
  try {
    const file = path.join(RUNS_DIR, sanitizeId(sid), "user_msgs.jsonl");
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          if (rec && typeof rec.text === "string" && rec.text !== "") out.push(rec.text);
        } catch {}
      }
    }
  } catch {}

  // 3. OpenCode 会话库（宿主是 OpenCode 时的权威来源）
  const fromOpenCode = await getOpenCodeUserMessages(sid, limit);
  if (fromOpenCode && fromOpenCode.length) out.push(...fromOpenCode);

  if (!out.length) return null;
  return out.slice(-limit);
}

// 从 OpenCode 的 SQLite 会话库读用户原话。
// 路径可用 OPENCODE_DB_PATH / OPENCODE_DB 覆盖，默认 ~/.local/share/opencode/opencode.db。
// 任何异常（node:sqlite 不可用 / 库不存在 / 表结构变化）→ 返回 null，绝不抛错。
export async function getOpenCodeUserMessages(sid, limit = 20) {
  let db = null;
  try {
    const mod = await import("node:sqlite");
    const DatabaseSync = mod && mod.DatabaseSync;
    if (typeof DatabaseSync !== "function") return null;
    if (!OPENCODE_DB || !fs.existsSync(OPENCODE_DB)) return null;
    try {
      db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    } catch {
      db = new DatabaseSync(OPENCODE_DB, { readonly: true }); // 选项名兜底
    }
    let sql =
      "SELECT p.data AS d FROM part p JOIN message m ON p.message_id=m.id" +
      " WHERE json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text'";
    const params = [];
    if (sid) {
      sql += " AND m.session_id=?";
      params.push(sid);
    }
    sql += " ORDER BY p.time_created DESC LIMIT ?";
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    const out = [];
    for (const row of rows) {
      let parsed;
      try {
        parsed = JSON.parse(row.d);
      } catch {
        continue;
      }
      const text = parsed && parsed.text;
      if (typeof text === "string" && text !== "") out.push(text);
    }
    return out;
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

// 写入用户消息到会话目录（供 quote 锚点校验使用）
export function writeUserMessage(sid, text) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "user_msgs.jsonl");
    const rec = JSON.stringify({ ts: new Date().toISOString(), text }) + "\n";
    fs.appendFileSync(file, rec, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function pathExists(cwd, p) {
  const abs = path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p);
  return fs.existsSync(abs);
}

export function gitHead(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    return r.status === 0 ? String(r.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

// card_ts 距今超过 ttlSec → true；无卡（card_ts 缺失/0）不视为过期
export function isStale(state, ttlSec = 14400) {
  const ts = state ? Number(state.card_ts) : 0;
  if (!ts) return false;
  return Date.now() - ts > ttlSec * 1000;
}

// Phase 1-1: 检查 bypass 是否启用
export function isBypassed(state) {
  return state && state.bypass === true;
}