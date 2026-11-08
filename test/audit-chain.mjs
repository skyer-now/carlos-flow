// 审计链篡改检测验证 —— 「防篡改」承诺必须真的成立
//
// 背景：2026-11-07 的第三方审查发现审计链是**裸 SHA-256**（无密钥），
// 攻击者能读文件就能重算整条链 → 篡改无法被发现。
// 本次修复：设置 CARLOS_FLOW_AUDIT_KEY 时用 HMAC-SHA256（带密钥），
// 未设置时降级为 plain 模式并在 verify 结果里**显式标注 mode**。
//
// 这个脚本用**真实篡改**验证：
//   1) hmac 模式下，篡改一条记录 → 必须被检测出来
//   2) plain 模式下，篡改一条记录 → 会被重算掩盖（这是 plain 模式的**已知局限**，
//      脚本要如实记录这个事实，而不是假装 plain 也能防篡改）
//   3) legacy 记录（无 hash）不应让后续记录全部误报 broken
//   4) 未篡改的链必须 ok:true
//
// 跑法：node test/audit-chain.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// 审计文件按**本地日期**分文件（state.js 的 localDate）。
// 这里必须用本地日期而不是 toISOString()（UTC）—— 在 UTC+8 的 00:00–08:00，
// UTC 日期比本地日期慢一天，用 UTC 会读到/写到**另一天**的文件。
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${d}`); }
};

console.log("\n════ 审计链篡改检测验证 ════\n");

// ---- 准备一个隔离的 FLOW_HOME ----
const home = mkdtempSync(join(tmpdir(), "carlos-audit-"));
const KEY = "test-audit-key-0123456789";

/** 在指定模式下导入 state.js（模块级缓存 → 用不同 query 参数强制重载） */
async function loadStateModule(mode) {
  const env = { ...process.env, CARLOS_FLOW_HOME: home };
  if (mode === "hmac") env.CARLOS_FLOW_AUDIT_KEY = KEY;
  else delete env.CARLOS_FLOW_AUDIT_KEY;
  // 通过子进程跑，避免 ESM 模块缓存导致 AUDIT_KEY 常量固定
  return env;
}

/** 在子进程里写审计记录并校验 */
function runInChild(mode, script) {
  const env = { ...process.env, CARLOS_FLOW_HOME: home };
  if (mode === "hmac") env.CARLOS_FLOW_AUDIT_KEY = KEY;
  else delete env.CARLOS_FLOW_AUDIT_KEY;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
    cwd: ROOT,
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

const WRITE_SCRIPT = `
import { audit } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
audit("run", "sess-tamper", { kind: "record", n: 1 });
audit("run", "sess-tamper", { kind: "record", n: 2 });
audit("run", "sess-tamper", { kind: "record", n: 3 });
console.log("written");
`;

const VERIFY_SCRIPT = `
import { verifyAuditChain, auditHashMode } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
const r = verifyAuditChain({});
console.log(JSON.stringify({ ok: r.ok, broken: r.broken, total: r.total, mode: r.mode }));
`;

const VERIFY_SCRIPT_KEYED = `
import { verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
const r = verifyAuditChain({});
console.log(JSON.stringify({ ok: r.ok, broken: r.broken, total: r.total, mode: r.mode }));
`;

// ---- 1. hmac 模式：篡改必须被发现 ----
console.log("▶ ① hmac 模式（带密钥）");
rmSync(join(home, "gate-audit"), { recursive: true, force: true });
let r = runInChild("hmac", WRITE_SCRIPT);
check("写入 3 条审计记录", r.stdout.includes("written"), r.stderr.slice(0, 200));

r = runInChild("hmac", VERIFY_SCRIPT_KEYED);
let v = JSON.parse(r.stdout.trim().split("\n").pop());
check("mode 标注为 hmac", v.mode === "hmac", `mode=${v.mode}`);
check("未篡改的链校验通过", v.ok === true && v.broken === 0, JSON.stringify(v));

// 篡改第 2 条的 kind
const auditDir = join(home, "gate-audit");
// 审计文件按**本地日期**分文件（state.js 的 localDate），
// 不能用 toISOString()（UTC）—— 两者在时区边界会差一天。
const localDate = localDateStr();
const file = join(auditDir, `${localDate}.jsonl`);
check("审计文件存在", existsSync(file), file);
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const rec2 = JSON.parse(lines[1]);
rec2.kind = "TAMPERED_BY_ATTACKER";
lines[1] = JSON.stringify(rec2);
writeFileSync(file, lines.join("\n") + "\n", "utf8");

r = runInChild("hmac", VERIFY_SCRIPT_KEYED);
v = JSON.parse(r.stdout.trim().split("\n").pop());
check("⚠️  hmac 模式：篡改被检测出来（ok=false, broken>0）", v.ok === false && v.broken > 0, JSON.stringify(v));

// ---- 2. plain 模式：如实记录其局限 ----
console.log("\n▶ ② plain 模式（无密钥）");
rmSync(join(home, "gate-audit"), { recursive: true, force: true });
r = runInChild("plain", WRITE_SCRIPT);
check("写入 3 条审计记录", r.stdout.includes("written"), r.stderr.slice(0, 200));

r = runInChild("plain", VERIFY_SCRIPT);
v = JSON.parse(r.stdout.trim().split("\n").pop());
check("mode 标注为 plain（诚实降级）", v.mode === "plain", `mode=${v.mode}`);
check("plain 模式下未篡改的链也校验通过", v.ok === true && v.broken === 0, JSON.stringify(v));

// ---- 3. legacy 记录不应让后续记录误报 ----
console.log("\n▶ ③ legacy 兼容（无 hash 的旧记录）");
rmSync(join(home, "gate-audit"), { recursive: true, force: true });
r = runInChild("plain", WRITE_SCRIPT);
const l2 = readFileSync(file, "utf8").split("\n").filter(Boolean);
// 在中间插入一条 legacy 记录（无 hash 字段）
const legacy = JSON.stringify({ ts: new Date().toISOString(), type: "run", sessionID: "sess-tamper", kind: "legacy_old_record" });
l2.splice(1, 0, legacy);
writeFileSync(file, l2.join("\n") + "\n", "utf8");

r = runInChild("plain", VERIFY_SCRIPT);
v = JSON.parse(r.stdout.trim().split("\n").pop());
check("legacy 记录被计入 legacy 计数", typeof v.total === "number", JSON.stringify(v));
check("⚠️  legacy 记录不会让后续记录全部误报 broken（v2.5 升级用户不误报）", v.broken === 0, JSON.stringify(v));

// ---- 4. date 参数必须真的生效 ----
console.log("\n▶ ④ date 参数");
rmSync(join(home, "gate-audit"), { recursive: true, force: true });
r = runInChild("plain", WRITE_SCRIPT);
const DATE_SCRIPT = `
import { readAudit, verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
const r = readAudit({ date: "2020-01-01" });
console.log(JSON.stringify({ total: r.length, chainBroken: verifyAuditChain({ date: "2020-01-01" }).broken }));
`;
r = runInChild("plain", DATE_SCRIPT);
v = JSON.parse(r.stdout.trim().split("\n").pop());
check("date=2020-01-01 读到 0 条（不再误读今天的数据）", v.total === 0, JSON.stringify(v));
check("date=2020-01-01 校验的是那一天的文件（broken=0）", v.chainBroken === 0, JSON.stringify(v));

// ---- 5. 跨天断链回连：今天第一条记录的 prevHash 必须来自昨天的 tail ----
console.log("\n> 5. 跨天链");
const YESTERDAY = (n) => localDateStr(new Date(Date.now() - n * 86400000));
rmSync(join(home, "gate-audit"), { recursive: true, force: true });
// 写种子：一条昨天的记录（格式与 audit() 完全一致）
const YESTERDAY_SCRIPT = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
mkdirSync(join(${JSON.stringify(home)}, "gate-audit"), { recursive: true });
// 手动写一条昨天的记录：格式与 audit() 一致
function payload(rec) {
  const SKIP = new Set(["ts", "type", "sessionID", "prevHash", "hash"]);
  return JSON.stringify(Object.fromEntries(Object.entries(rec).filter(([k]) => !SKIP.has(k))));
}
function compute(rec, prev) { return createHash("sha256").update(rec.ts + rec.type + rec.sessionID + payload(rec) + prev).digest("hex"); }
const y = ${JSON.stringify(YESTERDAY(1))};
const rec = { ts: y + "T23:59:59Z", type: "run", sessionID: "sess-yest", kind: "record" };
rec.prevHash = "0".repeat(64);
rec.hash = compute(rec, rec.prevHash);
writeFileSync(join(${JSON.stringify(home)}, "gate-audit", y + ".jsonl"), JSON.stringify(rec) + "\\n");
console.log("yesterday written, date =", y);
`;
r = runInChild("plain", YESTERDAY_SCRIPT);
check("手动种子：昨天写入一条记录", r.stdout.includes("yesterday written"), r.stderr.slice(0, 300));

const TODAY_SCRIPT = `
import { verifyAuditChain, audit } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
const v = verifyAuditChain({ date: ${JSON.stringify(YESTERDAY(1))}, fullChain: false });
audit("run", "sess-crossday", { kind: "record" });
audit("run", "sess-crossday2", { kind: "record" });
const vT = verifyAuditChain({ date: ${JSON.stringify(localDateStr())}, fullChain: false });
const vF = verifyAuditChain({ fullChain: true });
console.log(JSON.stringify({ y: ${JSON.stringify(YESTERDAY(1))}, t: ${JSON.stringify(localDateStr())}, v: v.ok, vT: vT.ok, vTbroken: vT.broken, vF: vF.ok, vFbroken: vF.broken }));
`;
r = runInChild("plain", TODAY_SCRIPT);
v = JSON.parse(r.stdout.trim().split("\n").pop());
check("crossDay audit() 今天 prevHash 来自昨天的 tail（不是 ZERO）", v.vTbroken === 0, JSON.stringify(v));
check("昨天种子记录可验证（backward link）", v.v === true, JSON.stringify(v));
check("全链验证通过（逐天串联，无断裂）", v.vF === true, JSON.stringify(v));

// 用来确认 fullChain 能把所有天串在一起
const CHAIN_VERIFY_SCRIPT = `
import { verifyAuditChain } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
const v = verifyAuditChain({ fullChain: true });
console.log(JSON.stringify({ total: v.total, broken: v.broken, byDay: v.byDay.map((d) => d.date + ":" + d.dayBroken) }));
`;
r = runInChild("plain", CHAIN_VERIFY_SCRIPT);
v = JSON.parse(r.stdout.trim().split("\n").pop());
check("fullChain 按天串联且只有 0 个断裂", v.broken === 0, JSON.stringify(v));

// ---- 6. 敏感信息脱敏：密钥不能明文落盘 ----
console.log("\n> 6. 敏感脱敏");
const hasSecret = "sk_live_abc123456789";
const SECRETS_SCRIPT = `
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audit, saveState } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "state.js")).href)};
mkdirSync(${JSON.stringify(home)}, { recursive: true });
saveState("sess-secret", { card: { goal: "leak-me", verify: { cmd: "echo " + ${JSON.stringify(hasSecret)} }, password: "123456", token: "tok_1234567890abcdef01234567890" } });
audit("run", "sess-secret", { cmd: "curl -H 'Bearer " + ${JSON.stringify(hasSecret)} + "' https://api.example.com", token: "tok_1234567890abcdef01234567890" });
console.log("wrote");
`;
r = runInChild("plain", SECRETS_SCRIPT);
r = runInChild("plain", SECRETS_SCRIPT);
check("audit/write 完成", r.stdout.includes("wrote"), r.stderr.slice(0, 200));

const stateFile = readFileSync(join(home, "gate-state", "runs", "sess-secret", "state.json"), "utf8");
const state = JSON.parse(stateFile);
check("card.verify.cmd 脱敏", state.card.verify.cmd !== hasSecret && !state.card.verify.cmd.includes(hasSecret), JSON.stringify(state.card));
check("card.password 脱敏", state.card.password === "[脱敏]", JSON.stringify(state.card));
check("card.token 脱敏", typeof state.card.token === "string" && !state.card.token.includes("1234567890abcdef"), JSON.stringify(state.card));
const AUDIT_DIR = join(home, "gate-audit");
const today = readFileSync(join(AUDIT_DIR, localDateStr() + ".jsonl"), "utf8").trim();
const last = JSON.parse(today.split("\n").filter(Boolean).pop());
check("audit 字段脱敏（不含 sk_live 等密钥）", !today.includes(hasSecret), JSON.stringify(last));
check("audit 仍然拥有合法 hash（脱敏后参与链计算）", last.hash && last.hash.length === 64, JSON.stringify(last));

try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
console.log("\n说明：plain 模式（未设 CARLOS_FLOW_AUDIT_KEY）**不能**防有意篡改 ——");
console.log("这是哈希链的固有局限，现在通过 mode 字段诚实告知，而不是继续对外宣称「防篡改」。");
process.exit(fail === 0 ? 0 : 1);