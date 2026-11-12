// state.js — Carlos 工作流：持久化 / 审计 / quote 数据源（Node ESM，零外部依赖）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";


// 展开路径里的 `~`（家目录）。
// 背景：README 让用户把 CARLOS_FLOW_HOME 写成 `~/.carlos-flow`，但此前**没有展开** ——
// path.normalize("~/.carlos-flow") 只是把斜杠改成反斜杠，路径仍是**字面量**，
// 于是状态/审计链被写到「当前工作目录下的一个名叫 ~ 的目录」里（Windows 实测
// FLOW_HOME = ~\.carlos-flow），位置诡异、极易丢失。
// 现在统一展开：`~` → homedir，`~/x` 与 `~\x` → homedir/x。
export function expandHome(p) {
  if (typeof p !== "string" || p === "") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export const FLOW_HOME = path.normalize(
  expandHome(process.env.CARLOS_FLOW_HOME) || path.join(os.homedir(), ".carlos-flow")
);
export const AUDIT_DIR = path.join(FLOW_HOME, "gate-audit");
export const RUNS_DIR = path.join(FLOW_HOME, "gate-state", "runs");

// OpenCode 会话库路径：环境变量优先，回落到跨平台默认
// OPENCODE_DB_PATH / OPENCODE_DB 与插件侧同一套约定
// ~ 路径同样需要展开（Windows PowerShell 下 CARLOS_OPENCODE_DB=~/.opencode 会字面写入）
const OPENCODE_DB = path.normalize(
  expandHome(process.env.OPENCODE_DB_PATH) ||
    expandHome(process.env.OPENCODE_DB) ||
    expandHome(process.env.CARLOS_OPENCODE_DB) ||
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
);

// OpenCode 会话库的**候选路径**（按平台习惯不同，取第一个存在的）。
// 背景：原先只写死 XDG 路径 ~/.local/share/opencode/opencode.db —— 那是 Linux 的约定。
// macOS 上 OpenCode 实际落在 ~/Library/Application Support/opencode/，
// Windows 上落在 %APPDATA%\opencode\ —— 只探 XDG 路径的话，
// macOS/Windows 用户会**永远拿不到用户原话**，导致 quote 锚点校验直接失败、卡片无法提交。
// 环境变量优先（显式指定时不做任何猜测）。
const OPENCODE_DB_CANDIDATES = (() => {
  const envPath = process.env.OPENCODE_DB_PATH || process.env.OPENCODE_DB || process.env.CARLOS_OPENCODE_DB;
  if (envPath) return [path.normalize(envPath)];
  const home = os.homedir();
  const rel = ["opencode", "opencode.db"];
  const candidates = [];
  // XDG 约定（Linux，以及部分 macOS 配置）
  candidates.push(path.join(home, ".local", "share", ...rel));
  // macOS 原生
  candidates.push(path.join(home, "Library", "Application Support", ...rel));
  // Windows（APPDATA）
  const appData = process.env.APPDATA;
  if (appData) candidates.push(path.join(appData, ...rel));
  // Windows（无 APPDATA 时的兜底）
  candidates.push(path.join(home, "AppData", "Roaming", ...rel));
  // 去重（保持顺序）
  return [...new Set(candidates.map((p) => path.normalize(p)))];
})();

// 选出第一个真实存在的候选；都不存在则返回 null（不抛错，降级为“无历史消息”）。
function resolveOpenCodeDb() {
  for (const p of OPENCODE_DB_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

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

// 当前状态文件结构版本号。
// 改动 defaultState() 的**字段结构**时，必须 +1 并在 migrate() 里加一条迁移。
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * 迁移旧版本的状态文件。
 *
 * 逐版本迁移，每一步都只处理「从 vN 到 vN+1」的差异，
 * 保证任何历史版本都能一路迁到当前版本（不跳步）。
 *
 * v0 → v1：最早的版本没有 schemaVersion 字段（等于 v0）。
 *   · 补上 schemaVersion
 *   · dispatch_baseline 早期不存在 → 补空数组（无基线时裁定走全量判定，更保守）
 *
 * v1 → v2：新增 last_falsify（负对照记录）。
 *   · 旧状态没有这个字段 → 补 null（表示「还没做负对照」，裁定会拒绝 PASS）
 *
 * v2 → v3：新增 audit_axes / audit_axes_ts（双轴审查证据）。
 *   · 旧状态没有这两个字段 → 补默认结构（两轴均为 null = 尚未审查，裁定会拒绝 PASS）
 *   · audit_axes 存在但结构不全时也在此补齐，避免读到半初始化对象
 */
export function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  let v = Number(parsed.schemaVersion);
  if (!Number.isInteger(v) || v < 0) v = 0;   // 无版本号 → 当作 v0
  const out = { ...parsed };

  if (v < 1) {
    // v0 → v1
    if (!Array.isArray(out.dispatch_baseline)) out.dispatch_baseline = [];
    if (!Array.isArray(out.activation_pending)) out.activation_pending = [];
    if (typeof out.activation_activated !== "boolean") out.activation_activated = false;
    v = 1;
  }

  if (v < 2) {
    // v1 → v2
    if (out.last_falsify === undefined) out.last_falsify = null;
    v = 2;
  }

  if (v < 3) {
    // v2 → v3
    if (!out.audit_axes || typeof out.audit_axes !== "object") {
      out.audit_axes = { standards: null, spec: null };
    } else {
      out.audit_axes = {
        standards: out.audit_axes.standards || null,
        spec: out.audit_axes.spec || null,
      };
    }
    if (typeof out.audit_axes_ts !== "number") out.audit_axes_ts = 0;
    v = 3;
  }

  out.schemaVersion = CURRENT_SCHEMA_VERSION;
  return out;
}

export function defaultState() {
  return {
    // 状态文件结构版本号。
    // 为什么需要：早先靠 {...defaultState(), ...parsed} 做防御性合并，
    // 但**没有版本号** —— 将来改字段名（如 bypass_ts → bypass_at）时，
    // 老用户的 state.json 里那个旧字段会被当成「未知字段」静默丢弃，
    // 表现为「免检没清零」「待补项丢失」这类**很难定位**的退化。
    // 加了版本号 + migrate()，旧状态会被**显式迁移**而不是静默降级。
    schemaVersion: CURRENT_SCHEMA_VERSION,
    card: null,
    card_ts: 0,
    tier: "read_only",
    task_id: null,
    dispatch_count: 0,
    claimed: false,
    claimed_role: null,
    write_files: 0,
    last_user_ts: 0,
    bypass: false,
    bypass_ts: 0,
    verdict: null,
    completed_ok: false,
    stale: false,
    // 智能触发引擎激活占位卡时尚待补齐的字段。
    // 非空时 flow_claim / flow_dispatch 会拒绝派发，防止空卡片被直接派发。
    activation_pending: [],
    // 该会话是否曾被智能触发引擎激活过（单调，只增不减）。
    // 闸门状态由「卡片内容 + 此标记」幂等派生，不再依赖上一轮的 pending 传递，
    // 这样跨进程并发写入也不会出现「卡片为空却 pending=[]」的矛盾组合。
    activation_activated: false,
    // 派发时记录的工作区改动基线（文件路径数组）。
    // 用途：裁定前用「当前改动 - 基线」算出**本次执行引入的**改动，
    // 再与卡片 scope 比对 —— 这样既能拦住越界，又不会把用户自己原有的
    // 未提交改动误判为越界。没有基线时退化为全量判定（更保守，fail-closed）。
    dispatch_baseline: [],
    // 负对照记录（flow_falsify 写入）。
    // 为什么需要：只看 exitCode===0 时，`verify.cmd` 可以是 `|| true` / `echo ok`
    // 这类**空测试** —— 改动前后都退 0，门禁却以为「验证通过了」。
    // 负对照要求：改动前必须失败、改动后必须通过，才证明这个测试真的在测本次改动。
    // null = 还没做负对照（此时 flow_verdict 拒绝 PASS）。
    last_falsify: null,
    // 双轴审查证据（flow_audit_submit 写入）。
    // 结构：{ standards: {verdict,findings,evidence,card_ts,ts} | null, spec: {...} | null }
    //
    // 为什么按轴绑定 card_ts，而不是只用一个全局时间戳：
    // 两轴是**分两次**提交的。卡A提交 standards → 换新卡B → 只补 spec，
    // 此时全局时间戳已被刷新到卡B之后，单看时间戳会放行，而 standards
    // 仍是卡A的结论 —— 「两轴跨卡拼接」。绑定 card_ts 后，换卡即两轴全失效。
    audit_axes: { standards: null, spec: null },
    // 两轴最后提交时间（审计链留痕用；不参与冒充校验，校验看 card_ts）。
    audit_axes_ts: 0,
  };
}

export function loadState(sid) {
  try {
    const file = path.join(RUNS_DIR, sanitizeId(sid), "state.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultState();
    return { ...defaultState(), ...migrate(parsed) };
  } catch {
    return defaultState();
  }
}

export function saveState(sid, state) {
  // 落盘脱敏：`state.card` 可能携带密钥片段（verify.cmd/token/password），
  // 不能明文落盘。sanitizeFields 只脱敏 value，key 名保留。
  const safeState = sanitizeFields(state ?? defaultState());
  const dir = path.join(RUNS_DIR, sanitizeId(sid));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "state.json.tmp");
  const target = path.join(dir, "state.json");
  fs.writeFileSync(tmp, JSON.stringify(safeState, null, 2), "utf8");
  fs.renameSync(tmp, target);
  return target;
}

// 跨进程排他锁。
// 问题背景：flow_submit_requirement 是「读状态 → 算 pending → 写状态」的读-改-写，
// 多个 MCP server 进程共享同一个 CARLOS_FLOW_HOME 时会互相丢更新：
//   进程A 写（占位卡, pending=[三项]） 与 进程B 写（普通空卡, pending=[]）
// 若两者交错，后写入者可能用**过期的 prevState** 算出 pending=[]，
// 而它写入的卡片字段仍为空 —— 闸门就被绕过了（红队实测 40 轮复现 4 次）。
// 这里用 mkdir 的原子性做锁（open(..., "wx") 同理），把读-改-写包成临界区。
const sleepMs = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer 不可用时退化为自旋 */
  }
};

export function withStateLock(sid, fn, opts = {}) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid));
  const lockFile = path.join(dir, ".state.lock");
  const timeoutMs = Number(opts.timeoutMs) || 5000;
  const staleMs = Number(opts.staleMs) || 30000;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // wx = O_CREAT|O_EXCL，文件已存在则抛 EEXIST —— 原子排他
      const fd = fs.openSync(lockFile, "wx");
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 陈旧锁（持有者已崩溃）→ 回收
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue; // 锁刚好被释放，重试
      }
      if (Date.now() > deadline) {
        // 拿不到锁：fail-closed —— 宁可报错也不要在无锁下写状态
        throw new Error(`获取状态锁超时（session=${sanitizeId(sid)}），请稍后重试`);
      }
      sleepMs(15);
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try { fs.unlinkSync(lockFile); } catch { /* 已回收 */ }
    }
  }
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

// 审计文件按天分片（`${localDate()}.jsonl`）。
//
// 审计链是「分片链表」：前一天的最后一条记录的 hash 应当传给后一天的第一条
// 的 prevHash。**旧代码 `audit()` 只取当天文件的 tail**（当天文件不存在时退化成
// 全 0），于是链子每天都在午夜断开——攻击者篡改**任意历史天**的记录，今天
// 的 `verifyAuditChain()` 查不出来。
//
// 新增三个辅助：
//   · auditDayFiles()    → 按日期升序排列的审计文件清单
//   · lastHashOfDay(date)→ 某天文件最后一条记录的 hash（不存在那一天退化为 ZERO）
//   · nextPrevHash(date) → 取「当天 tail」，当天没有则往前找最近一天的 tail
//
// `audit()` 用 nextPrevHash 把每天的 tail 串成完整链，
// `verifyAuditChain()` 用同一套规则逐天串联验证。
function auditDayFiles() {
  try {
    return fs.readdirSync(AUDIT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
}

function lastHashOfDay(date) {
  return lastHashOf(path.join(AUDIT_DIR, `${date}.jsonl`));
}

// 取「当天 tail」，当天没有就往前找最近一天的 tail（修跨天断链）
function nextPrevHash(date) {
  const file = path.join(AUDIT_DIR, `${date}.jsonl`);
  const prev = lastHashOf(file);
  if (prev !== "0".repeat(64)) return prev; // 当天有链，正常运行
  // 当天还没有记录：**从 date 前一天起**按日期降序找最近已有 tail，绝不看 future。
  const today = localDate();
  const sorted = auditDayFiles().sort().filter((f) => f.slice(0, 10) < today);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].slice(0, 10) >= date) continue; // 只能找 date 之前的
    const h = lastHashOf(path.join(AUDIT_DIR, sorted[i]));
    if (h !== "0".repeat(64)) return h;
  }
  return "0".repeat(64);
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

// 敏感信息脱敏
//
// 用户卡片里可能包含密钥/密码（`verify.cmd` 里的 `sk_live_xxx`、`token`、
// `password`），审计记录也接受任意 `fields`——如果原样落盘，**门禁本身成了泄露源**。
//
// 规则：
//   · key 命中 `secret/key/password/pwd/token/credential/auth` 之一（不区分大小写）
//   · 或 string value 里含有 `sk_|secret=|password=|token=|api_key=|sk_live|sk_test`
//   → 记为敏感 value，脱敏：长度 ≤ 8 → `[脱敏]`，否则头尾各保留 4 个字符中间 ***
//
// 任何异常都不可抛（`audit` 必须永不抛错），脱敏失败则原地返回原值。
function isSensitiveKey(k) {
  try {
    return typeof k === "string" && /[Ss]ecret|[Kk]ey|[Pp]assword|[Pp]wd|[Tt]oken|[Cc]redential|[Aa]uth/.test(k);
  } catch {
    return false;
  }
}
const SENSITIVE_VALUES_RE = /sk_|secret=|password=|token=|api_key=|sk_live|sk_test|secret:/i;
function isSensitiveValue(v) {
  try {
    return typeof v === "string" && v.length > 0 && SENSITIVE_VALUES_RE.test(v);
  } catch {
    return false;
  }
}
function maskValue(v) {
  try {
    if (typeof v === "string" && v.length > 0) {
      if (v.length <= 8) return "[脱敏]";
      return v.slice(0, 4) + "***" + v.slice(-4);
    }
    return v;
  } catch {
    return v;
  }
}
function sanitizeValue(v) {
  try {
    if (Array.isArray(v)) return v.map(sanitizeValue);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        const val = v[k];
        out[k] = isSensitiveKey(k) || isSensitiveValue(val) ? maskValue(val) : sanitizeValue(val);
      }
      return out;
    }
    return v;
  } catch {
    return v;
  }
}
export function sanitizeFields(o) {
  return sanitizeValue(o ?? {});
}


// ---- 审计链哈希模式 ----
//
// 裸 SHA-256 哈希链能防的是「**意外**损坏」（截断、位翻转、误删），
// **防不了有意篡改**：攻击者能读文件，就能重算整条链。
//
// 因此提供两种模式：
//   · hmac  —— 设置了 CARLOS_FLOW_AUDIT_KEY 时使用带密钥的 HMAC-SHA256。
//              攻击者没有密钥 → 重算不出正确 hash → 篡改必被发现。
//   · plain —— 未设置密钥时的降级模式（裸 SHA-256），**在 verify 结果里
//              显式标注 mode**，让调用方知道自己拿到的是哪种保证。
//
// 不做「默认启用 HMAC」：没有密钥就签不了名，用户第一次用就会报错。
// 也不做「假装 HMAC」：plain 模式必须诚实地说自己只是弱保证。
const AUDIT_KEY = (() => {
  const k = process.env.CARLOS_FLOW_AUDIT_KEY;
  return typeof k === "string" && k.length >= 16 ? k : null;
})();

export function auditHashMode() {
  return AUDIT_KEY ? "hmac" : "plain";
}

// 计算一条记录的 hash（写入与校验必须用同一套函数，否则永远对不上）
function computeAuditHash(rec, prev) {
  const payload = rec.ts + rec.type + rec.sessionID + auditPayload(rec) + prev;
  if (AUDIT_KEY) {
    return createHmac("sha256", AUDIT_KEY).update(payload).digest("hex");
  }
  return createHash("sha256").update(payload).digest("hex");
}

// 追加审计行；永不抛错，失败仅写 stderr；返回记录对象
export function audit(type, sid, fields = {}) {
  // 落盘脱敏：用户卡片/审计字段里的密钥片段（verify.cmd 等）不能明文入盘。
  const sanitized = sanitizeFields(fields);
  const rec = {
    ts: new Date().toISOString(),
    type,
    sessionID: sanitizeId(sid),
    ...sanitized,
  };
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const file = path.join(AUDIT_DIR, `${localDate()}.jsonl`);
    // 前驱 hash 取自当天文件 tail；当天没有记录时退成分片链上一天的 tail
    //（nextPrevHash），这样审计链在午夜也不断开。
    const prev = nextPrevHash(localDate());
    rec.prevHash = prev;
    rec.hash = computeAuditHash(rec, prev);
    // 单次 appendFileSync：O_APPEND 语义，多进程并发写不会互相截断
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    try {
      process.stderr.write(`[flow-audit] 写入失败: ${e && e.message ? e.message : e}\n`);
    } catch {}
  }
  return rec;
}

// 校验审计链完整性（可选：需完整文件，不能只看尾部）。
//
// 审计文件按天分片（`localDate().jsonl`），审计链是「分片链表」：
// 前一天最后一条记录的 hash 是后一天第一条记录的 prevHash（nextPrevHash）。
// 所以默认 `verifyAuditChain()` **逐天串联所有记录** 验证整条链——
// 攻击者篡改任意一天的任意记录，整链检测都会 break（配合 CARLOS_FLOW_AUDIT_KEY
// 为 HMAC 时做得到；plain 模式可在推荐结果里看到 mode 降级声明）。
//
// `opts.date` 给定的一天 → 只验证那一天（验证起点是前一天 tail，跨天）。
// `opts.fullChain` 默认 true → 验证全部天的完整链。
export function verifyAuditChain(opts = {}) {
  const rawDate = typeof opts.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : localDate();
  // ⚠️ 必须用 rawDate（而不是 localDate()）—— 否则 opts.date 完全失效：
  // 传 date='2020-01-01' 读的仍是**今天**的文件，调用方以为在查历史、
  // 实际拿到今天的数据（错而不报，最难发现）。
  const fullChain = typeof opts.fullChain === "boolean" ? opts.fullChain : true;
  if (fullChain && !opts.date) {
    // 全链验证：逐天（按文件名升序 == 升时）串联，每天的 tail 是下一天的 prevHash。
    const files = auditDayFiles();
    const byDay = [];
    let total = 0, broken = 0, legacy = 0;
    const brokenAt = [];
    let prev = "0".repeat(64); // 链起点
    for (const f of files) {
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(AUDIT_DIR, f), "utf8");
      } catch {
        continue;
      }
      let dayBroken = 0, dayLegacy = 0;
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
          // 旧格式记录（无 hash）→ 计入 legacy 计数，但**不重置链起点**
          legacy++;
          dayLegacy++;
          continue;
        }
        const expect = computeAuditHash(r, prev);
        if (expect !== r.hash || r.prevHash !== prev) {
          broken++;
          dayBroken++;
          if (brokenAt.length < 10) brokenAt.push({ date: f.slice(0, 10), ts: r.ts, type: r.type, kind: r.kind });
        }
        prev = r.hash;
      }
      byDay.push({ date: f.slice(0, 10), dayBroken, dayLegacy, tailHash: prev });
    }
    return {
      ok: broken === 0, total, broken, legacy, brokenAt, byDay, mode: auditHashMode(),
      note: "全链验证：逐天串联，每天的 tail 是下一天的前驱。",
    };
  }

  // 单日验证：按 date 读一天文件，链起点用前一天 tail（跨天联动）或全 0（新链第一天）。
  const file = path.join(AUDIT_DIR, `${rawDate}.jsonl`);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, total: 0, broken: 0, legacy: 0, brokenAt: [], file, mode: auditHashMode() };
  }
  // 单日的链起点：前一个 tail hash（跨天）或全 0（新链第一天）。
  const files = auditDayFiles();
  let prev = "0".repeat(64);
  for (const f of files) {
    if (f === `${rawDate}.jsonl`) break;
    prev = lastHashOf(path.join(AUDIT_DIR, f));
  }
  let total = 0, broken = 0, legacy = 0;
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
      // 旧格式记录（无 hash）→ 计入 legacy 计数，但**不重置链起点**。
      //
      // 早先这里写的是 prev = "0".repeat(64)，于是**一条**旧记录就会让
      // 它之后所有记录的 prevHash 全部对不上 → 全判 broken。
      // 后果：v2.5 升级上来的用户，审计链校验会长期报红，
      // 而 README 把「可验证审计链」列为核心能力 —— 用户会以为自己的
      // 审计记录被篡改了。**漏报比误报可接受，误报更伤信任。**
      legacy++;
      continue;
    }
    const expect = computeAuditHash(r, prev);
    if (expect !== r.hash || r.prevHash !== prev) {
      broken++;
      if (brokenAt.length < 10) brokenAt.push({ ts: r.ts, type: r.type, kind: r.kind });
    }
    prev = r.hash;
  }
  // mode 字段说明本次校验的**保证强度**：
  //   hmac → 带密钥（CARLOS_FLOW_AUDIT_KEY），能发现有意篡改
  //   plain → 裸 SHA-256，只能发现意外损坏（攻击者能重算整条链）
  return { ok: broken === 0, total, broken, legacy, brokenAt, file, mode: auditHashMode() };
}


export function readAudit(opts = {}) {
  const { sessionId, type, limit } = opts;
  const rawDate = typeof opts.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : localDate();
  try {
    // ⚠️ 必须用 rawDate（而不是 localDate()）—— 否则 opts.date 完全失效。
    const file = path.join(AUDIT_DIR, `${rawDate}.jsonl`);
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
    const dbPath = resolveOpenCodeDb();
    if (!dbPath) return null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      db = new DatabaseSync(dbPath, { readonly: true }); // 选项名兜底
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
  if (!state || state.bypass !== true) return false;
  // 免检必须显式开启（bypass_ts 有值）且发生在当前卡片之后，
  // 否则旧卡片的免检状态会错误地作用于新卡片
  if (!state.bypass_ts) return false;
  if (state.card_ts && state.bypass_ts < state.card_ts) return false;
  return true;
}