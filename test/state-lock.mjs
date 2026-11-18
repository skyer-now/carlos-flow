// 跨进程状态锁 —— 退避 / 陈旧回收 —— 回归测试
//
// 背景：`withStateLock` 是门禁状态「读-改-写」的临界区保护。它一旦退化成
// 「谁都能进」或「进不去就死等」，都会出真实事故：
//   · 排他性失效 → 激活闸门被并发绕过（历史上红队 40 轮复现 4 次）；
//   · 死等不回收 → 持有者崩溃后同一会话永久卡死（用户只看到「请稍后重试」）。
//
// 本测试钉死四条行为：
//   1. 正常路径：拿到锁 → 执行 → 释放（锁文件不残留）；
//   2. 锁被活进程持有时：fail-closed，超时报错（绝不无锁写状态）；
//   3. 持有者 pid 已死：立即回收，不用干等满 staleMs；
//   4. 老式锁文件（无内容）+ 超过 staleMs：按时间判定回收。
//
// 跑法：node test/state-lock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-lock-home-"));
process.env.CARLOS_FLOW_HOME = HOME;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
};

const { withStateLock, RUNS_DIR, sanitizeId } = await import("../src/state.js");

const sid = "lock-test-" + Date.now();
const dir = path.join(RUNS_DIR, sanitizeId(sid));
const lockFile = path.join(dir, ".state.lock");
fs.mkdirSync(dir, { recursive: true });

// 1. 正常路径
let ran = 0;
await withStateLock(sid, () => { ran++; });
check("1a. 正常加锁后临界区执行", ran === 1);
check("1b. 退出后不残留锁文件", !fs.existsSync(lockFile));

// 1c. 锁文件里写的是持有者 pid（诊断用）
let sawPid = 0;
await withStateLock(sid, () => {
  try { sawPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10); } catch { sawPid = 0; }
});
check("1c. 锁文件记录持有者 pid", sawPid === process.pid, `pid=${sawPid}`);

// 2. 被活进程持有 → 超时报错（fail-closed）
fs.writeFileSync(lockFile, String(process.pid), "utf8");
let blocked = false;
let blockedMsg = "";
const t2 = Date.now();
try {
  await withStateLock(sid, () => {}, { timeoutMs: 250 });
} catch (e) {
  blocked = true;
  blockedMsg = String(e && e.message ? e.message : e);
}
const wait2 = Date.now() - t2;
check("2a. 锁被占用时不放行（fail-closed）", blocked === true);
check("2b. 超时错误里点明持有者", /获取状态锁超时/.test(blockedMsg) && blockedMsg.includes("pid="), blockedMsg.slice(0, 80));
check("2c. 按 timeoutMs 及时退出（没有死等）", wait2 < 3000, `${wait2}ms`);
fs.rmSync(lockFile, { force: true });

// 3. 持有者 pid 已死 → 立即回收（不必等满 staleMs）
const dead = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
const deadPid = dead.pid;
fs.writeFileSync(lockFile, String(deadPid), "utf8");
const t3 = Date.now();
let reclaimed = false;
try {
  await withStateLock(sid, () => { reclaimed = true; }, { timeoutMs: 3000, staleMs: 60000 });
} catch { reclaimed = false; }
const wait3 = Date.now() - t3;
check("3a. 死锁号（pid 已不存在）被即时回收", reclaimed === true, `deadPid=${deadPid}`);
check("3b. 回收是即时的（远小于 staleMs=60s）", wait3 < 1500, `${wait3}ms`);

// 4. 老式锁文件（无 pid 内容）+ 超过 staleMs → 按时间回收
fs.writeFileSync(lockFile, "", "utf8");
const old = new Date(Date.now() - 120000);
try { fs.utimesSync(lockFile, old, old); } catch { /* 某些文件系统不支持，跳过 */ }
let reclaimedOld = false;
try {
  await withStateLock(sid, () => { reclaimedOld = true; }, { timeoutMs: 3000, staleMs: 30000 });
} catch { reclaimedOld = false; }
check("4a. 无 pid 的陈旧锁按 mtime 回收", reclaimedOld === true);
check("4b. 回收后不残留锁文件", !fs.existsSync(lockFile));

// 5. 退避不放大总耗时（多次竞争后仍能在 timeoutMs 内拿到锁）
let ok5 = 0;
for (let i = 0; i < 20; i++) {
  try { await withStateLock(sid, () => { ok5++; }, { timeoutMs: 2000 }); } catch { /* 计入失败 */ }
}
check("5a. 连续 20 次加锁全部成功（退避不会造成假超时）", ok5 === 20, `${ok5}/20`);

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("STATE_LOCK_OK");
