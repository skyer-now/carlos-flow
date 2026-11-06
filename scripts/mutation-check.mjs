#!/usr/bin/env node
// 变异测试：在临时副本上注入退化，确认测试套件能抓住。
// 目的：验证「激活只打印日志」「闸门失效」「会话撞名」这类退化无法蒙混过关。
//
// 用法: node scripts/mutation-check.mjs [源仓路径]
// 产物: <仓库>/.mutation-report.md（可用 MUTATION_REPORT 覆盖）
//
// 跨平台：原先硬编码 D:/cindy/... 与 Git Bash 路径，CI（ubuntu）必失败。
// 现在：源仓默认取当前仓库根目录；工作副本/报告路径走临时目录或环境变量；
// shell 按平台选择（Windows 用 cmd，POSIX 用默认 sh）。
import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC = resolve(process.argv[2] || process.env.MUTATION_SRC || REPO_ROOT);
const WORK = resolve(process.env.MUTATION_WORK || join(tmpdir(), "carlos-flow-mutant-work"));
const REPORT = resolve(process.env.MUTATION_REPORT || join(REPO_ROOT, ".mutation-report.md"));

// 变异定义：id / 描述 / 文件 / 旧文本 / 新文本（精确字符串替换）
const MUTANTS = [
  {
    id: "M1-激活只打印日志",
    desc: "把 checkTrigger 里的 callMCP 换成假返回（激活只剩日志）",
    file: "client/carlos.js",
    // 单行匹配，不受 CRLF/LF 影响；兼容单双引号两种写法
    pattern: /const r = await callMCP\((['"])tools\/call\1, \{ name: step\.tool, arguments: step\.args \}\);/,
    to: `const r = { result: { isError: false, content: [{ text: '{"ok":true}' }] } }; // MUTANT`,
  },
  {
    id: "M2-claim闸门失效",
    desc: "移除 flow_claim 的 activation_pending 闸门",
    file: "src/index.js",
    from: `        // 激活占位卡闸门：占位卡未补齐字段时不允许领取派发名额
        if (Array.isArray(state.activation_pending) && state.activation_pending.length > 0) {
          return fail("激活占位卡尚未补齐（待补：" + state.activation_pending.join("、") +
            "）。请先补齐后重新调用 flow_submit_requirement，再来领取派发名额。");
        }`,
    to: `        // MUTANT: claim 闸门被移除`,
  },
  {
    id: "M3-verdict闸门失效",
    desc: "移除 flow_verdict 的 activation_pending 闸门（占位卡可记 PASS）",
    file: "src/index.js",
    from: `        if (Array.isArray(state.activation_pending) && state.activation_pending.length > 0) {
          audit("decision", sessionId, {
            kind: "verdict_denied",
            reason: "激活占位卡未补齐",
            pending: state.activation_pending,
          });
          return fail("激活占位卡尚未补齐（待补：" + state.activation_pending.join("、") +
            "），不能记录裁定。请先补齐后重新调用 flow_submit_requirement。");
        }`,
    to: `        // MUTANT: verdict 闸门被移除`,
  },  {
    id: "M4-会话撞名",
    desc: "去掉 sanitizeSessionId 的哈希后缀（清洗后同形的 id 会撞名）",
    file: "src/trigger.js",
    from: `  const suffix = h.toString(16).padStart(8, '0').slice(0, 8);
  return safe + '-' + suffix;`,
    to: `  return safe; // MUTANT: 无哈希后缀`,
  },
  {
    id: "M5-scope不算补齐项",
    desc: "把 scope 从「当前缺失项」里剔除（scope 未补也不算缺）",
    file: "src/index.js",
    from: `          ...(!cardHasScope ? ["scope"] : []),`,
    to: `          ...(false ? ["scope"] : []), // MUTANT: scope 未补也不算缺`,
  },
  {
    id: "M6-半补齐绕过闸门",
    desc: "已激活会话改成「只要提交就解闸」（移除幂等派生）",
    file: "src/index.js",
    // 锚点必须**唯一且足够长**：曾经 M6/M9 共用同一段 from，
    // 该段一改缩进/注释 → 两个变异体同时 SKIP（变异测试失去守护却仍报 13/13）。
    // 现在带上 else-if 分支的专属上下文。
    from: `          } else if (wasActivatedBefore) {
            // 该会话开过占位卡：继续按**当前卡片实际缺什么**锁定。
            // 幂等派生（而不是「上一轮 pending 传递」），所以即使并发丢更新，
            // 落盘的 pending 永远与同一份落盘卡片一致，不会出现「卡片空却 pending=[]」。
            activationPending = currentMissing;
          } else {`,
    to: `          } else if (wasActivatedBefore) {
            // 该会话开过占位卡：继续按**当前卡片实际缺什么**锁定。
            // 幂等派生（而不是「上一轮 pending 传递」），所以即使并发丢更新，
            // 落盘的 pending 永远与同一份落盘卡片一致，不会出现「卡片空却 pending=[]」。
            activationPending = []; // MUTANT: 只要提交就解闸
          } else {`,
  },
  {
    id: "M9-闸门派生回退",
    desc: "把「普通卡分支」的待补项改回上一轮 pending 传递（并发丢更新时会失效）",
    file: "src/index.js",
    // 锚点与 M6 区分：M6 改「已激活会话」的赋值，M9 改「普通卡」分支的赋值。
    from: `          } else {
            // 普通卡（未标 activation，且本会话从未激活过）：不上闸门。
            // 档位必填项已由 validateCard 按 tier 强制（read_only 只要 goal+quote），
            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = [];`,
    to: `          } else {
            // 普通卡（未标 activation，且该会话从未激活过）：不上闸门。
            // 档位必填项已由 validateCard 按 tier 强制（read_only 只要 goal+quote），
            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = prevPendingBefore; // MUTANT: 回退到状态传递`,
  },
  {
    id: "M10-普通卡也上闸",
    desc: "普通卡（无 activation 且此前未被锁）也被上闸 —— 会误伤 T1 只读调研",
    file: "src/index.js",
    // 锚点从 2 行加长到 4 行：原来的 from 过短，任何相邻代码改动都可能连带改写它。
    from: `            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = [];
          }`,
    to: `            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = currentMissing; // MUTANT: 普通卡也上闸
          }`,
  },
  {
    id: "M11-占位卡硬编码三项",
    desc: "占位卡待补项退回硬编码三项（服务端派生失效）",
    file: "src/index.js",
    from: `            activationPending = currentMissing;
          } else if (wasActivatedBefore) {`,
    to: `            activationPending = ["scope", "acceptance", "verify.cmd"]; // MUTANT: 硬编码
          } else if (wasActivatedBefore) {`,
  },
  {
    id: "M12-跨进程锁失效",
    desc: "把锁文件改成非排他创建（'wx' → 'a'），跨进程排他性失效 → 读-改-写重新变成非原子",
    file: "src/state.js",
    from: `      const fd = fs.openSync(lockFile, "wx");`,
    to: `      const fd = fs.openSync(lockFile, "a"); // MUTANT: 非排他`,
  },
  {
    id: "M13-只读意图误判",
    desc: "把只读意图判定改为「命中只读词就算只读」（含改动动词时误判 → 会永久锁死）",
    file: "src/trigger.js",
    from: `  const hasMutating = mut.some((w) => s.includes(String(w).toLowerCase()));
  return !hasMutating;`,
    to: `  const hasMutating = mut.some((w) => s.includes(String(w).toLowerCase()));
  return true; // MUTANT: 无视改动动词`,
  },
  {
    id: "M7-空scope fail-open",
    desc: "enforceScope 在空 scope 时直接返回 ok:true（任意路径都算未越界）",
    file: "src/dispatch.js",
    from: `  if (!Array.isArray(scope) || scope.length === 0) {
    return {
      ok: false,
      violations: diffFiles.slice(),
      message: \`越界改动（卡片 scope 为空，不允许修改任何文件）：\${diffFiles.join(", ")}\`,
    };
  }`,
    to: `  if (!Array.isArray(scope) || scope.length === 0) {
    return { ok: true, violations: [] }; // MUTANT: fail-open
  }`,
  },
  {
    id: "M8-未派发可记PASS",
    desc: "移除 flow_verdict 的 dispatch_count 检查（未派发也能记 PASS）",
    file: "src/index.js",
    from: `        if (verdict === "PASS" && !(Number(state.dispatch_count) > 0)) {`,
    to: `        if (false) { // MUTANT: 允许未派发就记 PASS`,
  },
];

function sh(cmd, cwd, env = {}) {
  try {
    // Windows 下走 Git Bash（npm 是 .cmd 包装器），POSIX 下用系统 sh
    const isWin = process.platform === "win32";
    const shell = isWin ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
    return execSync(cmd, {
      cwd,
      encoding: "utf8",
      shell,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600000,
    });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "") + "\nEXIT=" + (e.status ?? "err");
  }
}

const lines = [];
lines.push("# 变异测试报告");
lines.push("");
lines.push(`- 源仓库：\`carlos-flow-cindy\` / \`carlos-flow-opencode\`（工作副本路径已改写为占位符）`);
lines.push(`- 变异副本：临时目录（用完自动删除，不入库）`);
lines.push(`- 目的：确认测试套件能抓住「激活只打印日志」「闸门失效」「会话撞名」等退化`);
lines.push("");

// ---- 工具：安全删目录 / 清理残留 bridge ------------------------------------
// Windows 上临时目录里若有后台 bridge 进程占用文件，rmSync 会抛 EBUSY 直接崩溃。
// 这里改成「重试若干次 → 仍失败则给出可读错误并改用新工作目录继续」，不裸崩。
const rmDirSafe = (dir) => {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      const code = e && e.code;
      if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
        // 占用的进程还没退出：等一下再试
        try { execSync(process.platform === "win32" ? "ping -n 2 127.0.0.1 >nul" : "sleep 1"); } catch { /* ignore */ }
        continue;
      }
      console.error(`⚠ 清理临时目录失败（${dir}）：${e && e.message ? e.message : e}`);
      return false;
    }
  }
  console.error(
    `⚠ 清理临时目录失败（${dir}）：Windows 上仍有进程占用该目录（EBUSY）。` +
    `已改用新的工作目录继续，避免整轮变异测试崩溃。`
  );
  return false;
};

// 测试期间由副本拉起的 bridge 会写 <dir>/bridge-<port>.pid；
// 只清理**本次新增**的 pid 文件（不碰用户自己的 bridge）。
const bridgePidFiles = (dir) => {
  try {
    return readdirSync(dir).filter((f) => /^bridge-\d+\.pid$/.test(f));
  } catch {
    return [];
  }
};
const killBridge = (pid) => {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
    return true;
  } catch {
    return false; // 进程已退出
  }
};
const cleanupBridges = (dir, before) => {
  for (const f of bridgePidFiles(dir)) {
    if (before && before.has(f)) continue; // 源仓已存在的 pid 文件（如用户自己的 bridge）绝不碰
    try {
      const pid = readFileSync(join(dir, f), "utf8").trim();
      if (/^\d+$/.test(pid) && killBridge(pid)) {
        console.log(`  [cleanup] 已终止残留 bridge（pid=${pid}, ${f}）`);
      }
    } catch {
      /* ignore */
    }
  }
};

// 基线：源仓里已存在的 bridge pid 文件（用户自己开的、或上一轮遗留的）。
// 工作目录是从源仓复制出来的，里面的 pid 文件天然都在这个集合里 → 只有**本轮新产生**的
// 端口对应的 pid 文件才会被清理，绝不会误杀源仓/用户已在运行的 bridge。
const SRC_BRIDGES = new Set(bridgePidFiles(SRC));

// 每个变异体的 BRIDGE_PORT 基准（可用 MUTATION_PORT_BASE 调整）。
// 注意：**不要并发跑两个 mutation-check 实例** —— 端口段固定，并发实例会互相抢端口，
// 导致套件启动失败/结果失真（表现为 concurrency 套件输出异常）。
const PORT_BASE = Number(process.env.MUTATION_PORT_BASE || 20100);

const base = sh("npm run test:e2e 2>&1; echo E2E_EXIT=$?; npm run test:trigger 2>&1; echo TR_EXIT=$?; npm run test:concurrency 2>&1; echo CONC_EXIT=$?", SRC, {
  CARLOS_FLOW_HOME: join(tmpdir(), "carlos-flow-mutant-home", "base"),
});
const baseE2e = /════ 结果: (\d+) 通过 \/ (\d+) 失败/.exec(base);
const baseTr = /总测试数: (\d+)[\s\S]*?✅ 通过: (\d+)[\s\S]*?❌ 失败: (\d+)/.exec(base);
const baseConc = /✅ 通过: (\d+)[\s\S]*?❌ 失败: (\d+)/.exec(base.slice(base.lastIndexOf("跨进程并发")));

// 基线必须全绿：否则每个变异体「注入后仍然失败」会被误判成「被抓住」，
// 脚本就会在基线本身是红的情况下报「全部被抓住」并 exit 0（假绿）。
const baseProblems = [];
if (!baseE2e) baseProblems.push("e2e 未取到结果");
else if (Number(baseE2e[2]) > 0) baseProblems.push(`e2e ${baseE2e[2]} 条失败`);
if (!baseTr) baseProblems.push("trigger 未取到结果");
else if (Number(baseTr[3]) > 0) baseProblems.push(`trigger ${baseTr[3]} 条失败`);
if (!baseConc) baseProblems.push("concurrency 未取到结果");
else if (Number(baseConc[2]) > 0) baseProblems.push(`concurrency ${baseConc[2]} 条失败`);
const baseGreen = baseProblems.length === 0;

lines.push(`## 基线（未变异）`);
lines.push("");
lines.push(`- e2e：${baseE2e ? `${baseE2e[1]} 通过 / ${baseE2e[2]} 失败` : "未取到"}`);
lines.push(`- trigger：${baseTr ? `${baseTr[2]} 通过 / ${baseTr[3]} 失败` : "未取到"}`);
lines.push(`- concurrency：${baseConc ? `${baseConc[1]} 通过 / ${baseConc[2]} 失败` : "未取到"}`);
lines.push("");
if (!baseGreen) {
  lines.push(`> ❌ **基线不绿**（${baseProblems.join("；")}）——基线红时无法区分「变异被抓住」与「基线本来就红」，`);
  lines.push(`> 本次变异结果**不可信**，脚本已以退出码 1 终止。请先修好基线再跑变异测试。`);
  lines.push("");
  writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
  console.error(`✗ 基线不绿：${baseProblems.join("；")}`);
  console.error("  基线红时，任何变异体都会「注入后仍然失败」→ 会被误判成被抓住（假绿）。");
  console.error("  请先修复基线（见报告 " + REPORT + "）。");
  process.exit(1);
}

const results = [];

let workDir = WORK;

for (const [mi, m] of MUTANTS.entries()) {
  // 删目录失败（Windows 上后台 bridge 占用 → EBUSY）时不裸崩：换新工作目录继续
  if (!rmDirSafe(workDir)) workDir = WORK + "-" + (mi + 1);
  mkdirSync(workDir, { recursive: true });
  cpSync(SRC, workDir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes(".git"),
  });
  // 复用依赖（必须成功，否则 bridge 找不到 MCP SDK，测试会全超时）
  const nm = join(workDir, "node_modules");
  if (!existsSync(nm)) {
    // 优先 junction/symlink（快）；POSIX 上若不支持则退化为拷贝（CI 稳但慢）
    let linked = false;
    try {
      symlinkSync(join(SRC, "node_modules"), nm, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (e) {
      console.warn("symlink 失败，退化为拷贝 node_modules：", e.message);
    }
    if (!linked) {
      try {
        cpSync(join(SRC, "node_modules"), nm, { recursive: true, dereference: true });
      } catch (e2) {
        console.error("✗ 无法准备 node_modules（symlink 与拷贝均失败）：", e2.message);
        process.exit(1);
      }
    }
  }

  const target = join(workDir, m.file);
  // 统一换行符：仓库里 index.js 等是 CRLF，trigger.js 等是 LF，不归一化会匹配不上
  const text = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  let mutated;
  if (m.pattern) {
    if (!m.pattern.test(text)) {
      results.push({ ...m, verdict: "SKIP", detail: "未匹配到变异点（源码已变）" });
      lines.push(`## ${m.id}`);
      lines.push("");
      lines.push("- 结果：**SKIP** —— 未匹配到变异点");
      lines.push("");
      continue;
    }
    mutated = text.replace(m.pattern, m.to);
  } else {
    if (!text.includes(m.from)) {
      results.push({ ...m, verdict: "SKIP", detail: "未匹配到变异点（源码已变）" });
      lines.push(`## ${m.id}`);
      lines.push("");
      lines.push("- 结果：**SKIP** —— 未匹配到变异点");
      lines.push("");
      continue;
    }
    mutated = text.split(m.from).join(m.to);
  }
  writeFileSync(target, mutated, "utf8");

  const out = sh("npm run test:e2e 2>&1; echo E2E_EXIT=$?; npm run test:trigger 2>&1; echo TR_EXIT=$?; npm run test:concurrency 2>&1; echo CONC_EXIT=$?", workDir, {
    CARLOS_FLOW_HOME: join(tmpdir(), "carlos-flow-mutant-home", m.id.replace(/[^A-Za-z0-9]/g, "_")),
    // 每个变异体用**独立端口**：否则会复用上一轮副本拉起的旧 bridge，
    // 旧 bridge 内存里跑的是旧代码 → 测试结果失真（可能假绿 / 假红）。
    BRIDGE_PORT: String(PORT_BASE + mi),
  });
  const e2eFail = /════ 结果: (\d+) 通过 \/ (\d+) 失败/.exec(out);
  const trFail = /总测试数: (\d+)[\s\S]*?✅ 通过: (\d+)[\s\S]*?❌ 失败: (\d+)/.exec(out);
  const concFail = /✅ 通过: (\d+)[\s\S]*?❌ 失败: (\d+)/.exec(out.slice(out.lastIndexOf("跨进程并发")));

  // fail-closed：套件**没跑起来**（输出里取不到结果）时，既不能算「被抓住」，
  // 也不能算「逃逸」——那是测试没运行，不是退化蒙混过关。
  // 高负载下并发套件偶尔启动失败，若当成 0 失败就会把变异体误判成 NOT CAUGHT（假红且误导）。
  const unparsed = [];
  if (!e2eFail) unparsed.push("e2e");
  if (!trFail) unparsed.push("trigger");
  if (!concFail) unparsed.push("concurrency");
  if (unparsed.length) {
    lines.push(`## ${m.id}`);
    lines.push("");
    lines.push(`- 注入：${m.desc}`);
    lines.push(`- 文件：\`${m.file}\``);
    lines.push("- 结果：**套件未成功运行（结果不可信）**");
    lines.push(`- 详情：无法解析结果的套件：${unparsed.join("、")}`);
    lines.push("");
    writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
    console.error(`✗ 变异体 ${m.id}：套件输出无法解析（${unparsed.join("、")}）—— 测试没有真正运行，结果不可信。`);
    console.error("  （不是「变异体逃逸」，而是套件没跑起来；请在低负载下重跑，或看 mutation-run.log）");
    console.error("  报告已写入: " + REPORT);
    process.exit(1);
  }

  const caught =
    (e2eFail && Number(e2eFail[2]) > 0) ||
    (trFail && Number(trFail[3]) > 0) ||
    (concFail && Number(concFail[2]) > 0);
  const verdict = caught ? "CAUGHT ✅" : "NOT CAUGHT ❌";
  results.push({
    ...m,
    verdict,
    detail: `e2e ${e2eFail ? e2eFail[1] + "/" + e2eFail[2] : "?"} 失败, trigger ${trFail ? trFail[3] : "?"} 失败, concurrency ${concFail ? concFail[2] : "?"} 失败`,
  });

  lines.push(`## ${m.id}`);
  lines.push("");
  lines.push(`- 注入：${m.desc}`);
  lines.push(`- 文件：\`${m.file}\``);
  lines.push(`- 结果：**${verdict}**`);
  lines.push(`- 详情：e2e ${e2eFail ? e2eFail[1] + " 通过 / " + e2eFail[2] + " 失败" : "?"}；trigger ${trFail ? trFail[2] + " 通过 / " + trFail[3] + " 失败" : "?"}；concurrency ${concFail ? concFail[1] + " 通过 / " + concFail[2] + " 失败" : "?"}`);
  lines.push("");
  const failed = (out.match(/✗[^\n]*/g) || []).slice(0, 6);
  if (failed.length) {
    lines.push("失败用例：");
    for (const f of failed) lines.push("```\n" + f.trim() + "\n```");
    lines.push("");
  }

  // 本轮收尾：先终止本轮拉起的 bridge，再删工作目录（否则 Windows 上删不掉 → EBUSY）
  cleanupBridges(workDir, SRC_BRIDGES);
  rmDirSafe(workDir);
}

cleanupBridges(workDir, SRC_BRIDGES);
rmDirSafe(workDir);

lines.unshift("## 总览");
lines.unshift("");
lines.push("| 变异 | 结果 | 详情 |");
lines.push("|---|---|---|");
for (const r of results) {
  lines.push(`| ${r.id} | ${r.verdict} | ${r.detail} |`);
}
lines.push("");

writeFileSync(REPORT, lines.join("\n"), "utf8");
console.log(lines.slice(0, 40).join("\n"));
console.log("\n报告已写入:", REPORT);
const notCaught = results.filter((r) => r.verdict !== "CAUGHT ✅");
process.exit(notCaught.length === 0 ? 0 : 1);
