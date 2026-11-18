// 审计日志按大小滚动 + 流式校验 —— 回归测试
//
// 背景：单日审计文件实测已到 2MB 量级，全年约 180MB。旧实现 verifyAuditChain
// 用 readFileSync 整份读入并按天切分，文件越大内存与耗时越线性增长。
// 现在：单文件超过 CARLOS_FLOW_AUDIT_MAX_BYTES 自动滚动成 <date>.N.jsonl，
// 校验逐行流式累加哈希（不整文件读入），且跨分片链路必须严格接上。
//
// 本测试钉死四件事：
//   1. 超过阈值真的滚动，单文件不越界；
//   2. 滚动后全链校验仍 ok（跨分片串联不能断）；
//   3. 篡改中间某个分片必须被抓到（不能因为分片而漏检）；
//   4. readAudit 能读回该日全部记录（含所有分片）。
//
// 跑法：node test/audit-roll.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-audit-roll-"));
process.env.CARLOS_FLOW_HOME = HOME;
const MAX = 64 * 1024; // 64KB 阈值：让滚动在测试里立刻发生
process.env.CARLOS_FLOW_AUDIT_MAX_BYTES = String(MAX);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const state = await import("../src/state.js");

const shards = () => fs.readdirSync(state.AUDIT_DIR)
  .filter((n) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(n))
  .sort((a, b) => {
    const ka = /\.(\d+)\.jsonl$/.exec(a);
    const kb = /\.(\d+)\.jsonl$/.exec(b);
    const da = a.slice(0, 10);
    const db = b.slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return (ka ? Number(ka[1]) : 0) - (kb ? Number(kb[1]) : 0);
  });

try {
  const N = 1500;
  for (let i = 0; i < N; i++) {
    state.audit("run", "roll-session", { kind: "k" + i, payload: "x".repeat(120) });
  }
  const files = shards();
  check("1a. 超过阈值后发生滚动（分片数 > 1）", files.length > 1, `${files.length} 个分片`);
  const oversized = files.filter((f) => fs.statSync(path.join(state.AUDIT_DIR, f)).size > MAX * 1.5);
  check("1b. 没有分片明显超过上限（滚动真的生效）", oversized.length === 0,
    oversized.length ? oversized.slice(0, 2).join(",") : `上限 ${Math.round(MAX / 1024)}KB`);

  const v = state.verifyAuditChain();
  check("2a. 滚动后全链校验通过", v.ok === true && v.broken === 0, `total=${v.total} broken=${v.broken}`);
  check("2b. 记录总数不缺（滚动不丢行）", v.total === N, `${v.total}/${N}`);
  check("2c. 分片数如实出现在 byDay 里", v.byDay[0] && v.byDay[0].shards === files.length,
    `shards=${v.byDay[0] && v.byDay[0].shards}`);

  const recs = state.readAudit({ sessionId: "roll-session" });
  check("3a. readAudit 能读回该日全部记录（含分片）", recs.length === N, `${recs.length}/${N}`);
  const single = state.verifyAuditChain({ date: files[0].slice(0, 10), fullChain: false });
  check("3b. 单日验证也覆盖全部分片", single.ok === true && single.total === N, `total=${single.total}`);

  // 3c. 历史日期：把今天的分片整体改名成过去日期，再按 date 查
  //     —— 这一步专门守「date 参数静默失效」（变异体 M17：内部改回 localDate()）
  {
    const today = files[0].slice(0, 10);
    const past = "2020-01-01";
    for (const f of files) {
      const seq = /\.(\d+)\.jsonl$/.exec(f);
      const target = seq ? `${past}.${seq[1]}.jsonl` : `${past}.jsonl`;
      fs.renameSync(path.join(state.AUDIT_DIR, f), path.join(state.AUDIT_DIR, target));
    }
    const pastVerify = state.verifyAuditChain({ date: past, fullChain: false });
    check("3c. 按历史 date 校验真的读那一天（date 参数不失效）",
      pastVerify.ok === true && pastVerify.total === N, `total=${pastVerify.total}/${N}（today=${today}）`);
    const pastRead = state.readAudit({ date: past, sessionId: "roll-session" });
    check("3d. readAudit 的 date 参数同样生效", pastRead.length === N, `${pastRead.length}/${N}`);
    // 改回今天，后面的篡改用例继续在「今天」这条链上做
    const renamed = fs.readdirSync(state.AUDIT_DIR).filter((n) => n.startsWith(past));
    for (const f of renamed) {
      const seq = /\.(\d+)\.jsonl$/.exec(f);
      const target = seq ? `${today}.${seq[1]}.jsonl` : `${today}.jsonl`;
      fs.renameSync(path.join(state.AUDIT_DIR, f), path.join(state.AUDIT_DIR, target));
    }
  }

  // 篡改「中间的分片」：跨分片链路必须抓到
  const mid = files[Math.floor(files.length / 2)];
  const midPath = path.join(state.AUDIT_DIR, mid);
  const lines = fs.readFileSync(midPath, "utf8").split("\n");
  const idx = lines.findIndex((l) => l.includes('"kind":"k7'));
  lines[idx] = lines[idx].replace('"k7', '"HACKED-7');
  fs.writeFileSync(midPath, lines.join("\n"), "utf8");
  const v2 = state.verifyAuditChain();
  check("4a. 篡改中间分片被抓到", v2.ok === false && v2.broken >= 1, `broken=${v2.broken}`);
  check("4b. 断链位置指向被改动的分片所在日期",
    (v2.brokenAt[0] || {}).date === mid.slice(0, 10), JSON.stringify(v2.brokenAt[0] || {}));
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("AUDIT_ROLL_OK");