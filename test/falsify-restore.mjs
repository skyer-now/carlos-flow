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
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const { RUNS_DIR, sanitizeId, saveState, defaultState, loadState } = await import("../src/state.js");

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

// 4. 还原失败必须失败关闭（2026-11-19 修复的核心缺陷）
//    旧实现：created:true 的条目执行 unlink 时用 catch{} 吞掉一切错误，
//    随后继续往下跑并对外宣称「已还原」（负对照照样返回 ok:true）。
//    新实现：删除/还原失败被记账并如实报告，负对照失败关闭。
{
  const sid4 = sid + "-restore-fail";
  const runDir4 = path.join(RUNS_DIR, sanitizeId(sid4));
  const backupDir4 = path.join(runDir4, "backup");
  fs.mkdirSync(backupDir4, { recursive: true });
  // 派发时不存在、现在却是一个**非空目录** → 删除必然失败
  // （并且绝不允许递归删除目录）。
  const dirTarget = path.join(WORK, "created-dir");
  fs.mkdirSync(dirTarget, { recursive: true });
  fs.writeFileSync(path.join(dirTarget, "inner.txt"), "x\n", "utf8");
  fs.writeFileSync(
    path.join(backupDir4, "manifest.jsonl"),
    JSON.stringify({ ts: Date.now(), orig: dirTarget, backup: null, created: true }) + "\n",
    "utf8",
  );
  const r4 = await runNegativeControl(sid4, "node -e \"process.exit(0)\"", WORK);
  check(
    "4a. 删除失败被如实报告（不再吞错后宣称已还原）",
    r4.ok === false && typeof r4.error === "string" && /还原/.test(r4.error),
    r4.error || `ok=${r4.ok}`,
  );
  check("4b. 还原回执标为失败", !!(r4.restore && r4.restore.ok === false));
  check("4c. 目标目录未被递归删除", fs.existsSync(path.join(dirTarget, "inner.txt")));
  // 事务记录：失败后必须留下可核对的证据（journal.json + restore_log）
  const nc4 = path.join(runDir4, "negative_control");
  const dirs4 = fs.existsSync(nc4) ? fs.readdirSync(nc4) : [];
  let journal4 = null;
  for (const d of dirs4) {
    const p = path.join(nc4, d, "journal.json");
    if (fs.existsSync(p)) {
      journal4 = JSON.parse(fs.readFileSync(p, "utf8"));
      break;
    }
  }
  check(
    "4d. 失败后留下事务记录（journal.json + restore_log）",
    !!journal4 &&
      Array.isArray(journal4.restore_log) &&
      journal4.restore_log.length > 0 &&
      journal4.restore_log.some((a) => a.result !== "deleted" && a.result !== "restored" && a.result !== "absent"),
    journal4 ? `status=${journal4.status} log=${journal4.restore_log.length}` : "无 journal",
  );
  check(
    "4e. 失败时目录被保留（证据不删，下次还能接着恢复）",
    dirs4.length > 0 && journal4 && journal4.status === "restore_failed",
    `dirs=${dirs4.length} status=${journal4 ? journal4.status : "-"}`,
  );
}

// 5. 还原的范围边界：只允许动任务卡登记项目（仓库根）内的路径
{
  const sid5 = sid + "-out-of-scope";
  const runDir5 = path.join(RUNS_DIR, sanitizeId(sid5));
  const backupDir5 = path.join(runDir5, "backup");
  fs.mkdirSync(backupDir5, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-outside-"));
  const outsideFile = path.join(outsideDir, "outside.txt");
  fs.writeFileSync(outsideFile, "keep me\n", "utf8");
  fs.writeFileSync(
    path.join(backupDir5, "manifest.jsonl"),
    JSON.stringify({ ts: Date.now(), orig: outsideFile, backup: null, created: true }) + "\n",
    "utf8",
  );
  const r5 = await runNegativeControl(sid5, "node -e \"process.exit(0)\"", WORK);
  check(
    "5a. 越界路径被拒绝并如实报告",
    r5.ok === false && /还原/.test(String(r5.error || "")),
    r5.error || `ok=${r5.ok}`,
  );
  check(
    "5b. 越界文件没有被删（还原不越界）",
    fs.existsSync(outsideFile) && fs.readFileSync(outsideFile, "utf8") === "keep me\n",
  );
  const failures5 = (r5.restore && r5.restore.failures) || [];
  check(
    "5c. 越界原因被记账（out_of_scope）",
    failures5.some((f) => f.result === "out_of_scope"),
    JSON.stringify(failures5),
  );
  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
}

// 6. 只删普通文件：目标是符号链接时不得跟着链接去删别处内容
{
  const sid6 = sid + "-symlink";
  const runDir6 = path.join(RUNS_DIR, sanitizeId(sid6));
  const backupDir6 = path.join(runDir6, "backup");
  fs.mkdirSync(backupDir6, { recursive: true });
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-linktarget-"));
  const targetFile = path.join(targetDir, "target.txt");
  fs.writeFileSync(targetFile, "target content\n", "utf8");
  const linkPath = path.join(WORK, "link-to-target.txt");
  let linkMade = false;
  try {
    fs.symlinkSync(targetFile, linkPath, "file");
    linkMade = true;
  } catch {
    linkMade = false;
  }
  if (!linkMade) {
    console.log("  · 跳过符号链接用例（本机不允许创建符号链接）");
  } else {
    fs.writeFileSync(
      path.join(backupDir6, "manifest.jsonl"),
      JSON.stringify({ ts: Date.now(), orig: linkPath, backup: null, created: true }) + "\n",
      "utf8",
    );
    const r6 = await runNegativeControl(sid6, "node -e \"process.exit(0)\"", WORK);
    check(
      "6a. 符号链接目标被拒绝删除（不跟链接删别处内容）",
      r6.ok === false && fs.existsSync(targetFile) && fs.readFileSync(targetFile, "utf8") === "target content\n",
      r6.error || `ok=${r6.ok}`,
    );
  }
  try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
}

// 7. 写回分支必须与删除分支**口径一致**：目标是符号链接时拒绝还原，
//    仓库外的真实文件一个字节都不能被改动。
//    旧实现：写回分支直接 copyFileSync(backup, orig) —— 会顺着符号链接
//    把仓库外的文件覆盖掉（删除分支有 lstat 防护，写回分支没有）。
{
  const sid7 = sid + "-writeback-symlink";
  const runDir7 = path.join(RUNS_DIR, sanitizeId(sid7));
  const backupDir7 = path.join(runDir7, "backup");
  fs.mkdirSync(backupDir7, { recursive: true });
  const outsideDir7 = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-wb-outside-"));
  const outsideFile7 = path.join(outsideDir7, "outside.txt");
  fs.writeFileSync(outsideFile7, "outside original\n", "utf8");
  const linkPath7 = path.join(WORK, "link-writeback.txt");
  let linkMade7 = false;
  try {
    fs.symlinkSync(outsideFile7, linkPath7, "file");
    linkMade7 = true;
  } catch {
    linkMade7 = false;
  }
  if (!linkMade7) {
    console.log("  · 跳过写回分支符号链接用例（本机不允许创建符号链接）");
  } else {
    const backup7 = path.join(backupDir7, "writeback.bak");
    fs.writeFileSync(backup7, "OVERWRITTEN BY RESTORE\n", "utf8");
    fs.writeFileSync(
      path.join(backupDir7, "manifest.jsonl"),
      JSON.stringify({ ts: Date.now(), orig: linkPath7, backup: backup7, created: false }) + "\n",
      "utf8",
    );
    const r7 = await runNegativeControl(sid7, "node -e \"process.exit(0)\"", WORK);
    check(
      "7a. 写回分支：符号链接目标被拒绝还原（与删除分支同口径）",
      r7.ok === false,
      r7.error || `ok=${r7.ok}`,
    );
    check(
      "7b. 写回分支：仓库外真实文件字节未变",
      fs.readFileSync(outsideFile7, "utf8") === "outside original\n",
      fs.readFileSync(outsideFile7, "utf8"),
    );
  }
  try { fs.rmSync(outsideDir7, { recursive: true, force: true }); } catch {}
}

// 8. 父目录是 junction / 符号链接时同样必须拒绝（否则会顺着链接改到仓库外）
{
  const sid8 = sid + "-parent-junction";
  const runDir8 = path.join(RUNS_DIR, sanitizeId(sid8));
  const backupDir8 = path.join(runDir8, "backup");
  fs.mkdirSync(backupDir8, { recursive: true });
  const outsideDir8 = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-junction-outside-"));
  const outsideFile8 = path.join(outsideDir8, "target.txt");
  fs.writeFileSync(outsideFile8, "outside original\n", "utf8");
  const linkDir8 = path.join(WORK, "linked-dir");
  let linkMade8 = false;
  try {
    fs.symlinkSync(outsideDir8, linkDir8, process.platform === "win32" ? "junction" : "dir");
    linkMade8 = true;
  } catch {
    linkMade8 = false;
  }
  if (!linkMade8) {
    console.log("  · 跳过父目录链接用例（本机不允许创建目录链接）");
  } else {
    const backup8 = path.join(backupDir8, "parent.bak");
    fs.writeFileSync(backup8, "OVERWRITTEN BY RESTORE\n", "utf8");
    fs.writeFileSync(
      path.join(backupDir8, "manifest.jsonl"),
      JSON.stringify({ ts: Date.now(), orig: path.join(linkDir8, "target.txt"), backup: backup8, created: false }) + "\n",
      "utf8",
    );
    const r8 = await runNegativeControl(sid8, "node -e \"process.exit(0)\"", WORK);
    check(
      "8a. 父目录是链接：写回被拒绝（不顺着链接改仓库外）",
      r8.ok === false,
      r8.error || `ok=${r8.ok}`,
    );
    check(
      "8b. 父目录是链接：仓库外真实文件字节未变",
      fs.readFileSync(outsideFile8, "utf8") === "outside original\n",
      fs.readFileSync(outsideFile8, "utf8"),
    );
  }
  try { fs.rmSync(outsideDir8, { recursive: true, force: true }); } catch {}
}

// 9. 删除分支：目标在 junction 目录里 → 不得顺着链接删掉仓库外的文件
{
  const sid9 = sid + "-delete-junction";
  const runDir9 = path.join(RUNS_DIR, sanitizeId(sid9));
  const backupDir9 = path.join(runDir9, "backup");
  fs.mkdirSync(backupDir9, { recursive: true });
  const outsideDir9 = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-falsify-del-outside-"));
  const outsideFile9 = path.join(outsideDir9, "target.txt");
  fs.writeFileSync(outsideFile9, "outside original\n", "utf8");
  const linkDir9 = path.join(WORK, "linked-del-dir");
  let linkMade9 = false;
  try {
    fs.symlinkSync(outsideDir9, linkDir9, process.platform === "win32" ? "junction" : "dir");
    linkMade9 = true;
  } catch {
    linkMade9 = false;
  }
  if (!linkMade9) {
    console.log("  · 跳过删除分支链接用例（本机不允许创建目录链接）");
  } else {
    fs.writeFileSync(
      path.join(backupDir9, "manifest.jsonl"),
      JSON.stringify({ ts: Date.now(), orig: path.join(linkDir9, "target.txt"), backup: null, created: true }) + "\n",
      "utf8",
    );
    const r9 = await runNegativeControl(sid9, "node -e \"process.exit(0)\"", WORK);
    check(
      "9a. 父目录是链接：删除被拒绝",
      r9.ok === false,
      r9.error || `ok=${r9.ok}`,
    );
    check(
      "9b. 父目录是链接：仓库外真实文件未被删",
      fs.existsSync(outsideFile9) && fs.readFileSync(outsideFile9, "utf8") === "outside original\n",
    );
  }
  try { fs.rmSync(outsideDir9, { recursive: true, force: true }); } catch {}
}

// 10. 最终还原日志（journal.json）写盘失败必须如实报告，不得静默忽略
{
  const sid10 = sid + "-journal-fail";
  const runDir10 = path.join(RUNS_DIR, sanitizeId(sid10));
  const backupDir10 = path.join(runDir10, "backup");
  fs.mkdirSync(backupDir10, { recursive: true });
  const target10 = path.join(WORK, "journal-target.txt");
  fs.writeFileSync(target10, "fixed\n", "utf8");
  const backup10 = path.join(backupDir10, "journal-target.bak");
  fs.writeFileSync(backup10, "broken\n", "utf8");
  fs.writeFileSync(
    path.join(backupDir10, "manifest.jsonl"),
    JSON.stringify({ ts: Date.now(), orig: target10, backup: backup10, created: false }) + "\n",
    "utf8",
  );
  // 验证命令把本次负对照的 journal.json 改成只读 → 最后的写盘必然失败
  const cmd10 = `node -e "const fs=require('fs'),p=require('path');const d=p.join(process.env.CARLOS_FLOW_HOME,'gate-state','runs','${sanitizeId(sid10)}','negative_control');for(const n of fs.readdirSync(d)){const j=p.join(d,n,'journal.json');if(fs.existsSync(j)){try{fs.chmodSync(j,0o444)}catch(e){}}}"`;
  const r10 = await runNegativeControl(sid10, cmd10, WORK);
  check(
    "10a. 最终 journal 写盘失败被如实报告（不静默忽略）",
    r10.ok === false && !!r10.restore && r10.restore.journal_write_failed === true,
    r10.error || `ok=${r10.ok}`,
  );
  // 复原只读属性（便于清理）
  try {
    const nc10 = path.join(runDir10, "negative_control");
    for (const n of fs.existsSync(nc10) ? fs.readdirSync(nc10) : []) {
      const j = path.join(nc10, n, "journal.json");
      if (fs.existsSync(j)) { try { fs.chmodSync(j, 0o666); } catch {} }
    }
  } catch {}
}

// 真实MCP负对照还原结束后，损坏Git指纹仍失败，但不能再次把字节改回before。
{
  const { startMcpClient } = await import('./_mcp-client.mjs')
  const { fileURLToPath } = await import('node:url')
  fs.mkdirSync(path.join(WORK, '.git'))
  saveState(sid, { ...defaultState(), card_ts: Date.now(), card: { verify: { cmd: CMD }, env: { project: WORK } } })
  const beforeBytes = fs.readFileSync(TARGET)
  const client = startMcpClient({ entry: fileURLToPath(new URL('../src/index.js', import.meta.url)), cwd: WORK, env: { CARLOS_FLOW_HOME: HOME } })
  try {
    await client.initialize()
    const response = await client.request('tools/call', { name: 'flow_falsify', arguments: { sessionId: sid, cwd: WORK } }, 60000)
    const stored = loadState(sid)
    check('B4 还原后指纹失败仍拒证据且保留原字节', response.result?.isError === true && fs.readFileSync(TARGET).equals(beforeBytes))
    check('B5 指纹失败不掩盖真实还原回执', stored.last_verify?.ok === false && stored.last_falsify?.restore?.ok === true)
  } finally { await client.close() }
}

// C1. 还原范围参数不得缺省放行：缺 options.root 必须按「拒绝」处理。
//     旧实现缺省即跳过边界判定（fail-open）—— 能把仓库外的文件改掉/删掉。
{
  const { restoreEntries } = await import('../src/dispatch.js')
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-falsify-noroot-'))
  const outsideFile = path.join(outsideDir, 'outside.txt')
  fs.writeFileSync(outsideFile, 'keep me\n', 'utf8')
  const noRoot = restoreEntries([{ orig: outsideFile, mode: 'delete' }])
  check(
    'C1a. restoreEntries 缺 options.root：按拒绝处理（不得默认跳过边界判定）',
    noRoot.ok === false && Array.isArray(noRoot.failures) && noRoot.failures.length === 1,
    JSON.stringify(noRoot.failures || []).slice(0, 140),
  )
  check(
    'C1b. restoreEntries 缺 options.root：目标文件未被删除',
    fs.existsSync(outsideFile) && fs.readFileSync(outsideFile, 'utf8') === 'keep me\n',
  )
  // 对照：给了 root 时才按根内判定（正常路径仍可用）
  const insideRoot = restoreEntries([{ orig: outsideFile, mode: 'delete' }], { root: outsideDir })
  check(
    'C1c. restoreEntries 给了 options.root：根内路径按正常路径处理',
    insideRoot.ok === true && !fs.existsSync(outsideFile),
    JSON.stringify(insideRoot.failures || []).slice(0, 140),
  )
  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
}

// C2. 最终还原不完整 → 负对照结论不得记为 meaningful。
//     还原失败项（errors）此前只挂在 restoreReport.errors 上，restore.ok 仍是 true，
//     verdict 仍是 meaningful —— 意味着「工作区没还原干净」也能支撑 PASS。
{
  const sidC2 = sid + '-restore-incomplete'
  const runDirC2 = path.join(RUNS_DIR, sanitizeId(sidC2))
  const backupDirC2 = path.join(runDirC2, 'backup')
  fs.mkdirSync(backupDirC2, { recursive: true })
  const targetC2 = path.join(WORK, 'restore-incomplete.txt')
  fs.writeFileSync(targetC2, 'fixed\n', 'utf8')
  const backupC2 = path.join(backupDirC2, 'restore-incomplete.bak')
  fs.writeFileSync(backupC2, 'broken\n', 'utf8')
  fs.writeFileSync(
    path.join(backupDirC2, 'manifest.jsonl'),
    JSON.stringify({ ts: Date.now(), orig: targetC2, backup: backupC2, created: false }) + '\n',
  )
  // 验证命令：读到 fixed（改动后态）就把目标换成目录 → 最后一次还原写不回去
  const cmdC2 = `node -e "const fs=require('fs');const p=process.argv[1];const c=fs.readFileSync(p,'utf8');if(c.trim()==='fixed'){fs.rmSync(p);fs.mkdirSync(p);}process.exit(c.trim()==='fixed'?0:1)" "${targetC2}"`;
  const rC2 = await runNegativeControl(sidC2, cmdC2, WORK);
  check(
    'C2a. 最终还原不完整：restore.ok 必须为 false（不得只挂 errors）',
    !!(rC2.restore && rC2.restore.ok === false),
    `restore=${JSON.stringify(rC2.restore || {}).slice(0, 160)}`,
  );
  check(
    'C2b. 最终还原不完整：负对照结论不得记为 meaningful',
    rC2.verdict !== 'meaningful',
    `verdict=${rC2.verdict}`,
  );
  try { fs.rmSync(targetC2, { recursive: true, force: true }); } catch {}
}

// C3. 真实路径解析**只有一份**实现。
//     卡片层（授权路径的真实边界）与还原层（写回/删除前的边界闸）都要回答
//     「这条路径真实落在哪里」—— 两份实现一旦漂移，就会出现「落卡时判定在
//     仓库内、执行/还原时判定在仓库外」这种自相矛盾。
{
  const { realTargetPath } = await import('../src/card.js')
  const dispatchSrc = fs.readFileSync(path.join(ROOT, 'src', 'dispatch.js'), 'utf8')
  check('C3a. card.js 导出唯一的真实路径解析实现', typeof realTargetPath === 'function')
  check('C3b. dispatch.js 不再自带第二份 realTargetPath', !/function\s+realTargetPath/.test(dispatchSrc))
  check('C3c. dispatch.js 从 card.js 引入这一份',
    /realTargetPath/.test(dispatchSrc) && /from '\.\/card\.js'/.test(dispatchSrc))
  const existing = realTargetPath(path.join(WORK, 'target.txt'))
  check('C3d. 已存在的文件：解析出真实路径',
    !existing.error && String(existing.path || '').replace(/\\/g, '/').endsWith('/target.txt'),
    JSON.stringify(existing))
  const missing = realTargetPath(path.join(WORK, 'not-there', 'deep', 'x.txt'))
  check('C3e. 不存在的路径：按最深已存在祖先 + 余下路径段拼出',
    !missing.error && String(missing.path || '').replace(/\\/g, '/').endsWith('/not-there/deep/x.txt'),
    JSON.stringify(missing))
  const unresolvable = realTargetPath('no-such-relative-dir-xyz/x.txt')
  check('C3f. 找不到任何已存在祖先：报错（调用方按保守口径拒绝，不静默放行）',
    !!unresolvable.error,
    JSON.stringify(unresolvable))
}

try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("FALSIFY_RESTORE_OK");
