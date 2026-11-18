// 门禁加固回归：超时整树回收 / 输出截断 / 快照去重与裁剪 / 存储可观测
//
// 覆盖的四个真实故障面（都来自实测）：
//   1. verify 超时后 cmd.exe 外壳被杀、派生的 node 子进程变孤儿（残留占端口/文件）；
//   2. 命令刷出几十 MB 日志 → stdout 字符串把进程内存打爆，门禁报「插件崩了」而不是「验证没通过」；
//   3. 多轮返工时 backup/ 对同一批文件重复整文件复制 → 单会话 94% 占用都在备份；
//   4. 没有度量就只能凭感觉删目录 → 误删活跃会话，丢门禁状态。
//
// 跑法：node test/hardening.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-hardening-home-"));
process.env.CARLOS_FLOW_HOME = HOME;
// 超时上限压到 800ms：这条用例要的是「超时后整树回收」，不是等 120 秒。
process.env.CARLOS_VERIFY_TIMEOUT_MS = "800";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const dispatch = await import("../src/dispatch.js");
const state = await import("../src/state.js");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
};

try {
  // ---- 1. 超时必须整树回收（Windows: taskkill /T /F；POSIX: 进程组）----
  {
    const pidFile = path.join(HOME, "grandchild.pid");
    // 命令自己写 pid 再挂住：它是 cmd.exe 的**子进程**，只杀外壳会留下它
    const cmd = `node -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},60000)" "${pidFile.replace(/\\/g, "/")}"`;
    const r = await dispatch.runVerifyCommand(cmd, HOME);
    check("1a. 超时后判定为失败", r.ok === false && /超时/.test(r.stderr), `exit=${r.exitCode}`);
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10); } catch { pid = 0; }
    check("1b. 命令确实派生出了子进程（用例前提成立）", pid > 0, `pid=${pid}`);
    if (pid > 0) {
      // Windows 上 taskkill /T 完成后进程可能需要一点时间真正消失
      let still = alive(pid);
      for (let i = 0; i < 30 && still; i++) {
        await new Promise((r2) => setTimeout(r2, 100));
        still = alive(pid);
      }
      check("1c. 超时把派生进程一起结束（无孤儿）", !still, still ? `pid=${pid} 仍存活` : "已回收");
    }
  }

  // ---- 2. 输出截断：头尾保留 + 如实记录原始字节 ----
  {
    const big = path.join(HOME, "big.js");
    fs.writeFileSync(big, `const line="x".repeat(1024);for(let i=0;i<3000;i++)console.log(line);`, "utf8");
    const r = await dispatch.runVerifyCommand(`node "${big.replace(/\\/g, "/")}"`, HOME);
    check("2a. 3MB 输出不整段进内存（回传被截断）", r.output_truncated === true,
      `trunc=${r.output_truncated} len=${String(r.stdout || "").length}`);
    check("2b. 原始字节数如实记录（不是只看截断后的长度）", (r.stdout_bytes || 0) > 2 * 1024 * 1024,
      `bytes=${r.stdout_bytes}`);
    check("2c. 回传体积有硬上界（< 1MB）", String(r.stdout || "").length < 1024 * 1024,
      `len=${String(r.stdout || "").length}`);
    check("2d. 截断处有明确标记（不静默丢内容）", /已截断 \d+ 字节/.test(r.stdout));
  }

  // ---- 3. 快照：内容寻址去重 + 每个 orig 只留最近 N 版 ----
  {
    const sid = "dedup-" + Date.now();
    const work = path.join(HOME, "work");
    fs.mkdirSync(work, { recursive: true });
    const target = path.join(work, "a.txt");

    fs.writeFileSync(target, "same-content\n", "utf8");
    const e1 = dispatch.snapshotFiles(sid, ["a.txt"], work);
    const e2 = dispatch.snapshotFiles(sid, ["a.txt"], work);
    check("3a. 同内容快照被识别为去重", e1[0].sha === e2[0].sha && e2[0].deduped === true,
      `sha=${String(e1[0].sha).slice(0, 8)} deduped=${e2[0].deduped}`);
    check("3b. 同内容只占一个 blob 文件", e1[0].backup === e2[0].backup);

    // 再来 5 轮不同内容 → 应只保留最近 3 版
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(target, "content-" + i + "\n", "utf8");
      dispatch.snapshotFiles(sid, ["a.txt"], work);
    }
    const manifest = path.join(state.RUNS_DIR, state.sanitizeId(sid), "backup", "manifest.jsonl");
    const entries = fs.readFileSync(manifest, "utf8").split("\n").filter((x) => x.trim());
    check("3c. manifest 每个 orig 只保留最近 3 版", entries.length === 3, `条目=${entries.length}`);
    const blobs = fs.readdirSync(path.dirname(manifest)).filter((n) => n.startsWith("sha-"));
    check("3d. 无引用的 blob 被删除（不残留）", blobs.length <= 3, `blob=${blobs.length}`);

    // 还原语义必须不变：最新版仍能指回正确内容
    const last = JSON.parse(entries[entries.length - 1]);
    const restored = fs.readFileSync(last.backup, "utf8").trim();
    check("3e. 保留的最新版内容正确（还原语义不变）", restored === "content-4", restored);
  }

  // ---- 4. flow_stats：只读 + 真能回答「占了多少、谁占的」----
  {
    // 造一个有状态的真实会话（只有状态文件才有「最近活跃时间」可报）
    state.saveState("stats-probe", { ...state.defaultState(), tier: "single_file", card: { goal: "统计探针" }, card_ts: Date.now() });
    const before = fs.statSync(path.join(state.RUNS_DIR)).mtimeMs;
    const { startMcpClient } = await import("./_mcp-client.mjs");
    const c = startMcpClient({
      entry: path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "src", "index.js"),
      cwd: process.cwd(),
      env: { CARLOS_FLOW_HOME: HOME },
    });
    try {
      await c.initialize();
      const res = await c.request("tools/call", { name: "flow_stats", arguments: { limit: 5 } }, 30000);
      const j = JSON.parse(res.result.content[0].text);
      check("4a. flow_stats 返回总占用与会话数", typeof j.total.bytes === "number" && j.total.sessions >= 1,
        `sessions=${j.total.sessions} bytes=${j.total.bytes}`);
      check("4b. 给出备份去重率（能看出备份值不值得清）", typeof j.backup.dedup_ratio === "number",
        `ratio=${j.backup.dedup_ratio}`);
      check("4c. 给出审计按日增长", Array.isArray(j.audit.recent_days));
      check("4d. 给出陈旧会话清单（含终态标记）", Array.isArray(j.stale.samples)
        && typeof j.stale.threshold_days === "number");
      const probe = (j.sessions_top || []).find((x) => x.session === "stats-probe");
      check("4e. 有状态的会话带最近活跃时间与卡片信息",
        !!probe && probe.last_active != null && probe.has_card === true && probe.tier === "single_file",
        probe ? `last_active=${probe.last_active} has_card=${probe.has_card}` : "未找到探针会话");
    } finally {
      await c.close();
    }
    const after = fs.statSync(path.join(state.RUNS_DIR)).mtimeMs;
    check("4f. flow_stats 是只读的（不改任何目录）", before === after);
  }
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("HARDENING_OK");