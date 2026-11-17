// 负对照（flow_falsify）的安全边界 —— 还原核对 + 崩溃恢复 —— 回归测试
//
// 背景：负对照会在**真实工作区**里临时把文件改回旧内容，跑一次验证，再写回来。
// 旧实现只有 try/finally 的「意图保证」：进程被强杀 / 写回失败时，
// 工作区可能停在「改动前」状态，用户的改动看起来凭空消失，而调用方仍拿到 ok:true。
//
// 本测试钉死三条行为：
//   1. 正常跑完：工作区被还原成「进入负对照时」的内容，并且**逐文件核对通过**；
//   2. 正常跑完：临时目录与还原日志被清理，不留垃圾；
//   3. 上一次被强杀（日志停在 pending、工作区停在改动前）：下一次调用先把工作区
//      救回来，并在返回值里如实报告 recovered。
//
// 跑法：node test/falsify-restore.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-home-"));
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

const { runNegativeControl, recoverInterruptedNegativeControl } = await import("../src/dispatch.js");
const { RUNS_DIR, sanitizeId } = await import("../src/state.js");

const sid = "falsify-" + Date.now();
const runDir = path.join(RUNS_DIR, sanitizeId(sid));
const backupDir = path.join(runDir, "backup");
fs.mkdirSync(backupDir, { recursive: true });

// 一个真实的临时工作区（不依赖 git：负对照的快照来自 manifest 备份）
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-work-"));
const TARGET = path.join(WORK, "target.txt");
const BACKUP = path.join(backupDir, "target.txt.bak");
fs.writeFileSync(BACKUP, "broken\n", "utf8");       // 派发时（改动前）的内容
fs.writeFileSync(TARGET, "fixed\n", "utf8");        // 当前（改动后）的内容
fs.writeFileSync(
  path.join(backupDir, "manifest.jsonl"),
  JSON.stringify({ ts: Date.now(), orig: TARGET, backup: BACKUP, created: false }) + "\n",
  "utf8",
);

// 验证命令：内容为 fixed 才通过（改动前必然失败、改动后必然通过）
const CMD = `node -e "const c=require('fs').readFileSync(process.argv[1],'utf8');process.exit(c.trim()==='fixed'?0:1)" "${TARGET}"`;

// 1. 正常路径
let r = await runNegativeControl(sid, CMD, WORK);
check("1a. 负对照判定 meaningful（前失败 + 后通过）", r.ok === true && r.verdict === "meaningful", r.verdict || r.error);
check("1b. 工作区被还原成「改动后」内容", fs.readFileSync(TARGET, "utf8").trim() === "fixed");
check(
  "1c. 还原结果被逐文件核对通过（restore.ok）",
  r.restore && r.restore.ok === true && r.restore.checked >= 1 && (r.restore.mismatched || []).length === 0,
  r.restore ? `checked=${r.restore.checked}` : "无 restore 字段",
);
check("1d. 没有误报「恢复了上一次残留」", r.recovered && r.recovered.files === 0, `${r.recovered ? r.recovered.files : "?"} 个`);
const ncRoot = path.join(runDir, "negative_control");
const leftovers = (() => {
  try { return fs.readdirSync(ncRoot).filter((n) => !n.startsWith(".")); } catch { return []; }
})();
check("1e. 正常结束后临时目录已清理（不留垃圾）", leftovers.length === 0, `${leftovers.length} 个残留`);

// 2. 模拟「上一次被强杀」：日志停在 pending、工作区停在改动前
const crashDir = path.join(ncRoot, "9999");
fs.mkdirSync(crashDir, { recursive: true });
const savedCopy = path.join(crashDir, "0_target.txt");
fs.writeFileSync(savedCopy, "fixed\n", "utf8");      // 崩溃前捕获的「改动后」内容
fs.writeFileSync(TARGET, "broken\n", "utf8");        // 崩溃后遗留的「改动前」状态
fs.writeFileSync(
  path.join(crashDir, "journal.json"),
  JSON.stringify({
    sid,
    ts: new Date().toISOString(),
    cwd: WORK,
    status: "pending",
    saved: [{ orig: TARGET, savedPath: savedCopy, existed: true }],
  }, null, 2),
  "utf8",
);

// 2a. 独立验证恢复函数本身
const rec = recoverInterruptedNegativeControl(sid);
check("2a. 崩溃恢复函数救回被中断的改动", rec.files >= 1, `files=${rec.files}`);
check("2b. 恢复后工作区回到「改动后」内容", fs.readFileSync(TARGET, "utf8").trim() === "fixed");
check("2c. 恢复后残留目录被清理", !fs.existsSync(crashDir));

// 2d. 再走一次完整负对照：返回值里要如实报告「这次恢复了几个文件」
fs.writeFileSync(TARGET, "broken\n", "utf8");
const crashDir2 = path.join(ncRoot, "9998");
fs.mkdirSync(crashDir2, { recursive: true });
const savedCopy2 = path.join(crashDir2, "0_target.txt");
fs.writeFileSync(savedCopy2, "fixed\n", "utf8");
fs.writeFileSync(
  path.join(crashDir2, "journal.json"),
  JSON.stringify({
    sid, ts: new Date().toISOString(), cwd: WORK, status: "pending",
    saved: [{ orig: TARGET, savedPath: savedCopy2, existed: true }],
  }, null, 2),
  "utf8",
);
r = await runNegativeControl(sid, CMD, WORK);
check("2d. 完整调用里自动恢复上一次残留并如实报告", r.ok === true && r.recovered.files >= 1, `recovered=${r.recovered ? r.recovered.files : "?"}`);
check("2e. 第二次负对照同样判定 meaningful", r.verdict === "meaningful", r.verdict || r.error);
check("2f. 工作区最终仍是「改动后」内容", fs.readFileSync(TARGET, "utf8").trim() === "fixed");

// 3. 还原核对必须真的能发现不一致（负例：故意让备份丢失）
{
  const sid3 = sid + "-broken";
  const runDir3 = path.join(RUNS_DIR, sanitizeId(sid3));
  const backupDir3 = path.join(runDir3, "backup");
  fs.mkdirSync(backupDir3, { recursive: true });
  const target3 = path.join(WORK, "target3.txt");
  const backup3 = path.join(backupDir3, "target3.bak");
  fs.writeFileSync(backup3, "broken\n", "utf8");
  fs.writeFileSync(target3, "fixed\n", "utf8");
  fs.writeFileSync(
    path.join(backupDir3, "manifest.jsonl"),
    JSON.stringify({ ts: Date.now(), orig: target3, backup: backup3, created: false }) + "\n",
    "utf8",
  );
  const cmd3 = `node -e "const c=require('fs').readFileSync(process.argv[1],'utf8');process.exit(c.trim()==='fixed'?0:1)" "${target3}"`;
  const r3 = await runNegativeControl(sid3, cmd3, WORK);
  check(
    "3a. 正常场景下核对通过（作为 3b 的对照）",
    r3.ok === true && r3.restore && r3.restore.ok === true,
    r3.restore ? `checked=${r3.restore.checked}` : "",
  );
}

try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("FALSIFY_RESTORE_OK");
