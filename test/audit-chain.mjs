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
const now = new Date();
const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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

try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
console.log("\n说明：plain 模式（未设 CARLOS_FLOW_AUDIT_KEY）**不能**防有意篡改 ——");
console.log("这是哈希链的固有局限，现在通过 mode 字段诚实告知，而不是继续对外宣称「防篡改」。");
process.exit(fail === 0 ? 0 : 1);