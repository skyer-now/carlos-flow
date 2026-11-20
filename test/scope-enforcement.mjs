// 越界拦截真实验证 —— 「越界直接阻断」必须真的成立
//
// 背景：2026-11-07 的第三方审查发现 enforceScope 从不自己跑 git diff，
// 且 flow_dispatch 里零 scope 校验 —— README 承诺的「越界直接阻断派发」
// 实际不成立。本次修复把它落到「裁定前用增量阻断 PASS」。
//
// 这个脚本用**真实 git 仓库 + 真实改动**验证：
//   1) scope 内改动 → 允许 PASS
//   2) scope 外改动 → 阻断 PASS（这是核心断言）
//   3) 用户派发前就有的未提交改动 → **不误判**为越界
//
// 跑法：node test/scope-enforcement.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "src", "index.js");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${d}`); }
};

// ---- 建一个真实 git 仓库 ----
const repo = mkdtempSync(join(tmpdir(), "carlos-scope-"));
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
writeFileSync(join(repo, "in-scope.txt"), "original\n");
writeFileSync(join(repo, "out-of-scope.txt"), "original\n");
writeFileSync(join(repo, "pre-existing.txt"), "original\n");
git("add", "-A");
git("commit", "-q", "-m", "初始提交");

// ---- 起 MCP server ----
const child = spawn(process.execPath, [SERVER], {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CARLOS_FLOW_HOME: join(repo, ".flowhome") },
});
let buf = ""; const pending = new Map(); let id = 1;
child.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
// 子进程崩了 / 不回包时必须**快速失败**，而不是让整个门禁挂在超时上：
// 旧写法没有超时也没有 exit 处理，协议层一出问题就是「测试卡住」而不是「测试变红」。
child.on("exit", (code) => {
  for (const [, r] of pending) r({ error: "MCP server 退出（code=" + code + "）" });
  pending.clear();
});
const req = (method, params) => new Promise((r) => {
  const rid = id++;
  const timer = setTimeout(() => {
    if (pending.has(rid)) { pending.delete(rid); r({ error: "TIMEOUT " + method }); }
  }, 30000);
  pending.set(rid, (msg) => { clearTimeout(timer); r(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
});
const tool = async (name, args) => {
  const r = await req("tools/call", { name, arguments: args });
  const text = String(r.result?.content?.[0]?.text || "");
  const isError = r.result?.isError === true;
  try { return { ...JSON.parse(text), __isError: isError }; }
  catch { return { ok: false, __raw: text, __isError: isError }; }
};

await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scope-test", version: "1" } });
await req("notifications/initialized", {});

console.log("\n════ 越界拦截真实验证 ════\n");

const QUOTE = "改 in-scope 文件";
// 真实测试：检查 in-scope.txt 内容 —— 改动前（original）失败、改动后（含 changed）通过。
// 旧版用 `process.stdout.write(\"OK\")`（永远退 0）—— 正是负对照要抓的「空测试」。
const VERIFY = "node -e \"const c=require(\'fs\').readFileSync(\'in-scope.txt\',\'utf8\');process.exit(c.includes(\'changed\')?0:1)\"";

/** 跑一轮：提交卡 → claim → dispatch → 改文件 → verify → verdict */
async function round(name, { mutate, expectPass, expectFalsify, verify }) {
  const sid = "scope-" + name + "-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid, text: QUOTE });
  await tool("flow_submit_requirement", {
    sessionId: sid, goal: "测试 scope 拦截", quote: QUOTE,
    scope: ["in-scope.txt"], acceptance: ["改对了"],
    verify: { cmd: verify || VERIFY }, cwd: repo, confirmed: true,
  });
  await tool("flow_claim", { sessionId: sid, role: "executor" });
  const d = await tool("flow_dispatch", { sessionId: sid, role: "executor", run: false });
  if (d.__isError || d.ok === false) {
    check(`${name}：dispatch 成功`, false, d.__raw || JSON.stringify(d).slice(0, 100));
    return;
  }
  mutate();
  // 负对照：改动前必须失败、改动后必须通过（空测试在这里被判定为 vacuous）
  const f = await tool("flow_falsify", { sessionId: sid, cwd: repo });
  if (expectFalsify) {
    check(`${name}：负对照结论 = ${expectFalsify}`, f.verdict === expectFalsify,
      `实际 ${f.verdict}${f.reason ? "（" + f.reason + "）" : ""}`);
  }
  // auditor claim 后 verdict
  await tool("flow_claim", { sessionId: sid, role: "auditor" });
  // 双轴门禁：落 PASS 前必须收齐 Standards / Spec 两轴证据。
  // 正反用例**都**提交：否则「阻断 PASS」可能是被缺两轴挡住的，
  // 而不是被被测的那道闸（越界 / 负对照）挡住 —— 断言会变成自证。
  await tool("flow_audit_axes", { sessionId: sid });
  await tool("flow_audit_submit", { sessionId: sid, axis: "standards", verdict: "PASS", findings: ["符合规范"], evidence: "scope 实测人工核验" });
  await tool("flow_audit_submit", { sessionId: sid, axis: "spec", verdict: "PASS", findings: ["验收满足"], evidence: "scope 实测人工核验" });
  const verdict = await tool("flow_verdict", { sessionId: sid, verdict: "PASS", notes: "测试", cwd: repo });
  const gotPass = verdict.ok === true && verdict.completed_ok === true;
  check(`${name}：${expectPass ? "允许 PASS" : "阻断 PASS"}`,
    gotPass === expectPass,
    expectPass ? `竟然被拒：${verdict.__raw || verdict.reason || ""}` : `竟然放行了：${JSON.stringify(verdict).slice(0, 120)}`);
  return verdict;
}

// ---- 用例 1：scope 内改动 → 允许 PASS ----
await round("用例1-scope内", {
  mutate: () => writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n"),
  expectPass: true, expectFalsify: "meaningful",
});

// 恢复
git("checkout", "--", "in-scope.txt");

// ---- 用例 2：scope 外改动 → 必须阻断 PASS（核心断言）----
await round("用例2-scope外", {
  mutate: () => writeFileSync(join(repo, "out-of-scope.txt"), "changed by agent OUT OF SCOPE\n"),
  expectPass: false, expectFalsify: "not_passing",
});
git("checkout", "--", "out-of-scope.txt");

// ---- 用例 3：派发【之前】就存在的未提交改动 → 不得误判为越界 ----
writeFileSync(join(repo, "pre-existing.txt"), "用户自己先改的（派发前就有）\n");
await round("用例3-派发前已有改动", {
  mutate: () => writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n"),
  expectPass: true, expectFalsify: "meaningful",
});
git("checkout", "--", "in-scope.txt");
git("checkout", "--", "pre-existing.txt");

// ---- 用例 6：空测试（改动前后都退 0）→ 负对照判定 vacuous，阻断 PASS ----
// 这是负对照存在的理由：`|| true` / `process.exit(0)` 这类命令永远「验证通过」，
// 旧门禁会把它们当成证据。
await round("用例6-空测试", {
  mutate: () => writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n"),
  expectPass: false, expectFalsify: "vacuous",
  verify: "node -e \"process.exit(0)\"",
});
git("checkout", "--", "in-scope.txt");

// ---- 用例 7：新文件授权（new_files）—— 授权的新文件不被判越界 ----
// 「派发时尚不存在的新文件」走独立字段精确授权：
// 允许集 = scope + new_files，授权的新文件被创建后不得判越界。
{
  const sid7 = "scope-newfile-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid7, text: QUOTE });
  // 授权说明必须能在**用户原话**中定位（与 quote 同级锚定）：
  // 自述 confirmed 不算数，说明得真的出现在用户说过的话里。
  await tool("flow_add_user_msg", { sessionId: sid7, text: "用户原话：允许新建 authorized-new.txt" });
  const sub7 = await tool("flow_submit_requirement", {
    sessionId: sid7, goal: "新增文件授权", quote: QUOTE,
    scope: ["in-scope.txt"], acceptance: ["x"],
    verify: { cmd: VERIFY }, cwd: repo, confirmed: true,
    newFiles: ["authorized-new.txt"], newFilesReason: "用户原话：允许新建 authorized-new.txt",
  });
  check("用例7：合法新文件授权可落卡（new_files 写入卡片）",
    sub7.ok === true && Array.isArray(sub7.card?.new_files) && sub7.card.new_files.includes("authorized-new.txt"),
    JSON.stringify(sub7.card?.new_files || sub7.reason || ""));
  // 授权的新文件被创建后 → 不判越界
  writeFileSync(join(repo, "authorized-new.txt"), "created by agent\n");
  const scoped = await tool("flow_check_scope", { sessionId: sid7, cwd: repo, paths: ["authorized-new.txt"] });
  check("用例7：授权的新文件不被判越界",
    scoped.__isError === false && scoped.ok === true && (scoped.violations || []).length === 0,
    JSON.stringify(scoped).slice(0, 160));
  // 未授权的新文件 → 判越界
  const un = await tool("flow_check_scope", { sessionId: sid7, cwd: repo, paths: ["unauthorized-new.txt"] });
  check("用例7：未授权的新文件判越界",
    un.__isError === false && un.ok === false && (un.violations || []).includes("unauthorized-new.txt"),
    JSON.stringify(un).slice(0, 160));
  // 未跟踪的新文件必须纳入越界检测（2026-11-19 第二张卡）：
  // git diff --name-only 只含已跟踪文件，旧实现完全看不见新建的文件。
  writeFileSync(join(repo, "untracked-new.txt"), "created by agent\n");
  const autoAll = await tool("flow_check_scope", { sessionId: sid7, cwd: repo });
  check("用例7：自动模式能发现未授权的未跟踪新文件",
    autoAll.__isError === false && autoAll.ok === false && (autoAll.violations || []).includes("untracked-new.txt"),
    JSON.stringify(autoAll.violations || []).slice(0, 160));
  check("用例7：自动模式不误报已授权的未跟踪新文件",
    !(autoAll.violations || []).includes("authorized-new.txt"),
    JSON.stringify(autoAll.violations || []).slice(0, 160));
  try { rmSync(join(repo, "authorized-new.txt"), { force: true }); } catch {}
  try { rmSync(join(repo, "untracked-new.txt"), { force: true }); } catch {}
}

// ---- 用例 9：派发后新建未跟踪文件 → 必须阻断 PASS ----
// 新建文件不在 scope / new_files 里 = 越界。旧实现看不见未跟踪文件，
// 于是「顺手新建一个文件」这类越界改动可以畅通无阻地拿到 PASS。
await round("用例9-派发后新建未授权文件", {
  mutate: () => {
    writeFileSync(join(repo, "in-scope.txt"), "changed by agent\n");
    writeFileSync(join(repo, "sneaky-new-file.txt"), "顺手新建的\n");
  },
  expectPass: false, expectFalsify: "meaningful",
});
git("checkout", "--", "in-scope.txt");
try { rmSync(join(repo, "sneaky-new-file.txt"), { force: true }); } catch {}

// ---- 用例 10：路径键的平台语义（win32 大小写不敏感 / 其它平台敏感）----
// 授权写法与落盘写法大小写不同时，正确的行为**按平台不同**：
//   · win32 文件系统本身大小写不敏感 → “Docs/Guide.md” 与 “docs/guide.md”
//     是同一个文件，已授权的路径不得被判成越界；
//   · POSIX 大小写敏感 → 它们是两个不同文件，落盘的那个**不在**允许集里，
//     必须判越界（把它放过就是放宽门禁）。
// 断言取「当前平台应有的正确行为」，不把生产语义改宽。
{
  const { enforceScope } = await import(pathToFileURL(join(ROOT, "src", "dispatch.js")).href);
  const { pathKey } = await import(pathToFileURL(join(ROOT, "src", "card.js")).href);
  const caseInsensitive = process.platform === "win32";
  const upper = enforceScope(["Docs/Guide.md"], repo, ["docs/guide.md"]);
  check(
    `用例10：大小写不同的路径按当前平台判定（${caseInsensitive ? "win32 大小写不敏感 → 不得误判越界" : "POSIX 大小写敏感 → 必须判越界"}）`,
    caseInsensitive
      ? upper.ok === true && (upper.violations || []).length === 0
      : upper.ok === false && (upper.violations || []).includes("docs/guide.md"),
    JSON.stringify(upper.violations || []).slice(0, 120),
  );
  // 反例：确实不在允许集里的文件仍然必须被判越界（口径收紧不能变成放行一切）
  const outside = enforceScope(["Docs/Guide.md"], repo, ["other/file.md"]);
  check(
    "用例10：不在允许集里的文件仍被判越界",
    outside.ok === false && (outside.violations || []).includes("other/file.md"),
    JSON.stringify(outside.violations || []).slice(0, 120),
  );
  // 全仓只有一把平台感知的路径键：授权层与越界检测层必须给出同一个答案。
  const folded = pathKey("Docs/Guide.md") === pathKey("docs/guide.md");
  check(
    "用例10：路径键的大小写语义与当前平台一致（唯一一把 pathKey）",
    folded === caseInsensitive,
    `folded=${folded} platform=${process.platform}`,
  );
}

// ---- 用例 12：派发时复核新文件授权的真实路径边界 ----
// 授权（落卡）与执行（派发）之间可能隔很久：期间授权路径的父目录可能被换成
// 指向仓库外的符号链接 / junction —— 落卡时安全，执行时文件已经写到仓库外。
// 派发时必须复核并拒绝派发。
{
  const outsideDir = mkdtempSync(join(tmpdir(), "carlos-scope-outside-"));
  const parentDir = join(repo, "junction-parent");
  mkdirSync(parentDir, { recursive: true });
  const sid12 = "scope-nf-boundary-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid12, text: QUOTE });
  await tool("flow_add_user_msg", { sessionId: sid12, text: "用户原话：允许新建 junction-parent/authorized.txt" });
  const sub12 = await tool("flow_submit_requirement", {
    sessionId: sid12, goal: "新文件授权", quote: QUOTE,
    scope: ["in-scope.txt"], acceptance: ["x"],
    verify: { cmd: VERIFY }, cwd: repo, confirmed: true,
    newFiles: ["junction-parent/authorized.txt"],
    newFilesReason: "用户原话：允许新建 junction-parent/authorized.txt",
  });
  check("用例12：落卡时边界合法（真实父目录在仓库内）", sub12.ok === true, String(sub12.reason || sub12.__raw || ""));
  await tool("flow_claim", { sessionId: sid12, role: "executor" });
  let linked = false;
  try {
    rmSync(parentDir, { recursive: true, force: true });
    symlinkSync(outsideDir, parentDir, process.platform === "win32" ? "junction" : "dir");
    linked = true;
  } catch {
    linked = false;
  }
  if (!linked) {
    console.log("  · 跳过派发时边界复核用例（本机不允许创建目录链接）");
  } else {
    const d12 = await tool("flow_dispatch", { sessionId: sid12, role: "executor", run: false, cwd: repo });
    const raw12 = String(d12.reason || d12.__raw || "");
    check("用例12：派发时复核发现真实路径落在仓库外 → 拒绝派发",
      d12.__isError === true || d12.ok === false,
      raw12.slice(0, 160));
    check("用例12：拒绝原因指明是新文件授权路径复核未通过",
      /复核/.test(raw12),
      raw12.slice(0, 160));
    check("用例12：仓库外一个字节都没被创建",
      !existsSync(join(outsideDir, "authorized.txt")));
  }
  try { rmSync(parentDir, { recursive: true, force: true }); } catch {}
  try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
}

// ---- 用例 13：派发基准必须按**卡片登记的项目根** ----
// 派发到别的仓库/目录时，新文件授权的越界复核不得跟着换基准重新判一遍；
// 派发目录与卡片项目根不一致 → 明确拒绝派发并说明原因。
// 同时守住「同一项目下派发仍然正常」（不得误伤既有路径）。
{
  const otherRepo = mkdtempSync(join(tmpdir(), "carlos-scope-other-"));
  const gitOther = (...args) => spawnSync("git", args, { cwd: otherRepo, encoding: "utf8" });
  gitOther("init", "-q");
  gitOther("config", "user.email", "t@t");
  gitOther("config", "user.name", "t");
  writeFileSync(join(otherRepo, "other.txt"), "other\n");
  gitOther("add", "-A");
  gitOther("commit", "-q", "-m", "初始提交");

  const sid13 = "scope-dispatch-root-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid13, text: QUOTE });
  await tool("flow_add_user_msg", { sessionId: sid13, text: "用户原话：允许新建 dispatch-root-new.txt" });
  const sub13 = await tool("flow_submit_requirement", {
    sessionId: sid13, goal: "派发基准按卡片项目根", quote: QUOTE,
    scope: ["in-scope.txt"], acceptance: ["x"], verify: { cmd: VERIFY },
    cwd: repo, confirmed: true,
    newFiles: ["dispatch-root-new.txt"],
    newFilesReason: "用户原话：允许新建 dispatch-root-new.txt",
  });
  check("用例13：卡片落卡（项目根 = 落卡时的仓库根）",
    sub13.ok === true, String(sub13.reason || sub13.__raw || ""));
  await tool("flow_claim", { sessionId: sid13, role: "executor" });
  // 派发到**另一个仓库** → 必须拒绝
  const d13 = await tool("flow_dispatch", { sessionId: sid13, role: "executor", run: false, cwd: otherRepo });
  const raw13 = String(d13.reason || d13.__raw || "");
  check("用例13：派发目录与卡片项目根不一致 → 拒绝派发",
    d13.__isError === true || d13.ok === false, raw13.slice(0, 200));
  check("用例13：拒绝原因指明是项目根不一致",
    /项目根|不一致/.test(raw13), raw13.slice(0, 200));
  // 被拒的派发不得消耗派发名额
  const st13 = await tool("flow_status", { sessionId: sid13 });
  check("用例13：被拒的派发不消耗派发名额",
    Number(st13.dispatch_count || 0) === 0, String(st13.dispatch_count));
  // 同一项目下派发仍然正常（不得误伤既有路径）
  const d13b = await tool("flow_dispatch", { sessionId: sid13, role: "executor", run: false, cwd: repo });
  check("用例13：同一项目下派发仍然成功",
    d13b.__isError === false && d13b.ok === true,
    String(d13b.reason || d13b.__raw || "").slice(0, 160));
  try { rmSync(otherRepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
}

// ---- 用例 11：flow_check_scope 自动模式必须做基线相减 ----
// 派发**之前**就存在的未跟踪文件属于基线，不得被自查报成越界；
// 派发**之后**新增的未跟踪文件必须被报成越界。
{
  const sid11 = "scope-baseline-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid11, text: QUOTE });
  await tool("flow_submit_requirement", {
    sessionId: sid11, goal: "基线相减", quote: QUOTE,
    scope: ["in-scope.txt"], acceptance: ["x"], cwd: repo, confirmed: true,
    verify: { cmd: "node -e \"process.exit(0)\"" },
  });
  // 派发前就存在的未跟踪文件
  writeFileSync(join(repo, "pre-existing-untracked.txt"), "用户自己先建的\n");
  await tool("flow_claim", { sessionId: sid11, role: "executor" });
  await tool("flow_dispatch", { sessionId: sid11, role: "executor", run: false, cwd: repo });
  // 派发后新引入的未跟踪文件
  writeFileSync(join(repo, "introduced-untracked.txt"), "本次执行新建的\n");

  const auto = await tool("flow_check_scope", { sessionId: sid11, cwd: repo });
  const violations = (auto.violations || []).map((v) => String(v).replace(/\\/g, "/"));
  check(
    "用例11：自动模式减去派发基线（派发前的未跟踪文件不报越界）",
    auto.__isError === false && !violations.includes("pre-existing-untracked.txt"),
    JSON.stringify(violations).slice(0, 140),
  );
  check(
    "用例11：自动模式仍报出本次执行引入的未跟踪文件",
    auto.__isError === false && violations.includes("introduced-untracked.txt"),
    JSON.stringify(violations).slice(0, 140),
  );
  try { rmSync(join(repo, "pre-existing-untracked.txt"), { force: true }); } catch {}
  try { rmSync(join(repo, "introduced-untracked.txt"), { force: true }); } catch {}
}

// ---- 用例 8：空 scope 仍然 fail-closed ----
// new_files 是独立字段，但它**不能**把「空 scope = 什么都不许改」的口径改宽。
{
  const sid8 = "scope-empty-" + Date.now();
  await tool("flow_add_user_msg", { sessionId: sid8, text: QUOTE });
  const sub8 = await tool("flow_submit_requirement", {
    sessionId: sid8, goal: "空 scope 卡", quote: QUOTE,
    scope: [], cwd: repo, confirmed: true,
  });
  check("用例8：空 scope 的卡可落卡（read_only 档）", sub8.ok === true, String(sub8.reason || ""));
  const empty = await tool("flow_check_scope", { sessionId: sid8, cwd: repo, paths: ["anything.txt"] });
  check("用例8：空 scope 仍 fail-closed（任何改动都算越界）",
    empty.__isError === false && empty.ok === false && (empty.violations || []).length > 0,
    JSON.stringify(empty).slice(0, 160));
  // 空 scope 时不允许授权新文件
  const sub8b = await tool("flow_submit_requirement", {
    sessionId: sid8, goal: "空 scope 卡加新文件", quote: QUOTE,
    scope: [], cwd: repo, confirmed: true,
    newFiles: ["should-not-pass.txt"], newFilesReason: "用户同意新建",
  });
  check("用例8：空 scope 不允许授权新文件",
    sub8b.ok === false && /scope/.test(String(sub8b.reason || "")),
    String(sub8b.reason || "").slice(0, 120));
}

// ---- 用例 4：flow_check_scope 不传 paths 时自动跑 git diff ----
const sid4 = "scope-auto-" + Date.now();
await tool("flow_add_user_msg", { sessionId: sid4, text: QUOTE });
await tool("flow_submit_requirement", {
  sessionId: sid4, goal: "自动 diff 模式", quote: QUOTE,
  scope: ["in-scope.txt"], acceptance: ["x"], cwd: repo, confirmed: true,
});
writeFileSync(join(repo, "out-of-scope.txt"), "auto diff detects this\n");
const auto = await tool("flow_check_scope", { sessionId: sid4, cwd: repo });
// 语义：payload 里的 ok 是 enforceScope 的结果（false = 有越界），
// MCP 层面没报错（__isError 为 false）
check("flow_check_scope 不传 paths → 自动跑 git diff 并发现越界",
  auto.__isError === false && auto.ok === false && Array.isArray(auto.violations) && auto.violations.length > 0,
  JSON.stringify(auto).slice(0, 140));
git("checkout", "--", "out-of-scope.txt");

// ---- 用例 5：enforceScope 自己跑 git（不经调用方传 paths）----
const mod = await import(pathToFileURL(join(ROOT, "src", "dispatch.js")).href);
const gitInside = mod.enforceScope.toString().includes("git") && mod.enforceScope.toString().includes("diff");
check("enforceScope 函数体内确实包含 git diff 调用", gitInside);
const untrackedInside = mod.enforceScope.toString().includes("ls-files");
check("enforceScope 函数体内确实包含未跟踪文件扫描（ls-files）", untrackedInside);

child.kill();
// Windows 上子进程退出前目录仍被占用 → 清理失败不应影响测试结论
try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) {
  console.log("\n⚠️  越界拦截未生效 —— README「越界直接阻断」的承诺仍然不成立。");
}
process.exit(fail === 0 ? 0 : 1);