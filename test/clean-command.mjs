// carlos clean 命令回归测试
//
// 为什么需要：清理命令是**删除**操作，写错一个前缀就会删掉用户真实会话。
// 本测试用完全隔离的临时 FLOW_HOME，固化四件事：
//   1. 默认是预览（--apply 之前一个都不删）
//   2. 只删测试前缀会话，真实会话（root-/maint-/mydata）必须保留
//   3. 永不删除 gate-audit（哈希链断一天就查不回去了）
//   4. --older-than 生效：新的测试会话不删
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLIENT = join(ROOT, "client", "carlos.js");
const HOME = mkdtempSync(join(tmpdir(), "carlos-clean-home-"));
const RUNS = join(HOME, "gate-state", "runs");
const AUDIT = join(HOME, "gate-audit");
mkdirSync(RUNS, { recursive: true });
mkdirSync(AUDIT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

// 造样本：4 个测试残留 + 3 个真实会话 + 1 个审计文件
for (const n of ["e2e-111", "p0-222", "probe-333", "guide-444", "root-real1", "maint-real2", "mydata"]) {
  mkdirSync(join(RUNS, n), { recursive: true });
  writeFileSync(join(RUNS, n, "state.json"), JSON.stringify({ pad: "x".repeat(200) }));
}
writeFileSync(join(AUDIT, "2026-11-17.jsonl"), '{"hash":"abc"}\n');

const run = (args) => spawnSync(process.execPath, [CLIENT, "clean", ...args], {
  env: { ...process.env, CARLOS_FLOW_HOME: HOME },
  encoding: "utf8",
  windowsHide: true,
});

console.log("════ carlos clean 验证 ════\n");

// 1. 预览：不删
let r = run([]);
const before = readdirSync(RUNS).length;
check("1. 默认预览模式（一个都不删）", before === 7, `现存 ${before} 个`);
check("2. 预览提示了 --apply", /--apply/.test(r.stdout || ""), "");

// 2. 执行：只删测试前缀
r = run(["--apply"]);
const left = readdirSync(RUNS).sort();
const realKept = ["maint-real2", "mydata", "root-real1"].every((n) => left.includes(n));
const testGone = ["e2e-111", "p0-222", "probe-333", "guide-444"].every((n) => !left.includes(n));
check("3. --apply 后测试残留被清掉", testGone, "剩 " + left.join(","));
check("4. 真实会话一个不少", realKept, "");
check("5. 审计流水未被删除", existsSync(join(AUDIT, "2026-11-17.jsonl")), "");

// 3. --older-than 保护新会话
mkdirSync(join(RUNS, "e2e-fresh"), { recursive: true });
writeFileSync(join(RUNS, "e2e-fresh", "state.json"), "{}");
r = run(["--apply", "--older-than", "7"]);
check("6. --older-than 保护刚生成的测试会话", existsSync(join(RUNS, "e2e-fresh")), "");

// 4. --prefix 精确限定
mkdirSync(join(RUNS, "e2e-keepme"), { recursive: true });
r = run(["--apply", "--prefix", "p0-"]);
check("7. --prefix 只清指定前缀（e2e 不受影响）", existsSync(join(RUNS, "e2e-keepme")), "");

try { rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail > 0 ? 1 : 0);
