// dispatch.js — Carlos 工作流：四段合同 prompt / 文件快照 / opencode 子进程 / 验证执行 / scope 校验（Node ESM）
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { RUNS_DIR, sanitizeId } from "./state.js";

export const MAX_DISPATCH = 5;

// 通用设计基线（坏味道清单）—— Standards 轴的第二层基线。
//
// 出处与边界（重要，不要夸大）：
//   · 本表由 Carlos 项目自维护，**术语对齐** Fowler et al.《Refactoring:
//     Improving the Design of Existing Code》第二版第 3 章「Code Smells」；
//   · 但它**不是原书全表**，也不声称逐条等同原书 —— 原书两版条目数不同，
//     市面上流传的「Fowler 12 种坏味道」是二手博客的说法、不是书里的口径。
//     把一个无法核实的数字写进审计权威，subagent 就会拿着错的基准去判定。
//   · 显式化清单的价值不在「权威」，在**可枚举、可测试、口径一致**：
//     判定不再依赖模型记性，测试也能断言基线条目一条都没被静默删掉。
export const SMELL_BASELINE = [
  { name: "Duplicated Code", desc: "同一段逻辑重复出现，改一处漏一处" },
  { name: "Long Method", desc: "函数承担过多职责，应拆分" },
  { name: "Long Parameter List", desc: "参数过多，应封装成对象" },
  { name: "Large Class", desc: "类承担过多职责" },
  { name: "Data Clumps", desc: "同一组字段/参数反复成组出现" },
  { name: "Primitive Obsession", desc: "用基本类型代替领域对象" },
  { name: "Feature Envy", desc: "方法比宿主对象更依赖别的对象的数据" },
  { name: "Message Chains", desc: "过长的链式调用（a.getB().getC().getD()）" },
  { name: "Middle Man", desc: "类/方法只做转发，自己没有职责" },
  { name: "Divergent Change", desc: "一个类因多种不相关的原因被修改" },
  { name: "Shotgun Surgery", desc: "一处逻辑改动要同步改多个文件" },
  { name: "Speculative Generality", desc: "为尚不存在的需求预留扩展点" },
  { name: "Temporary Field", desc: "字段只在某段流程内有值" },
  { name: "Refused Bequest", desc: "子类继承父类却拒绝/覆盖其大部分行为" },
  { name: "Data Class", desc: "只有数据没有行为" },
  { name: "Lazy Class", desc: "只有方法没有实质职责" },
  { name: "Comments", desc: "用注释掩盖代码本该表达的东西" },
  { name: "Dead Code", desc: "永不可达的废弃代码" },
];

// 渲染审计 checklist 段：条目逐条编号，便于 subagent 按项检查、便于测试逐条断言。
function renderChecklist(checklist) {
  const items = (checklist.items || [])
    .map((it, i) => `${i + 1}. ${it.name} — ${it.desc}`)
    .join("\n");
  return `${checklist.title}（逐条检查，命中即给 file:line 证据）：\n${items}\n注：${checklist.note}`;
}

// Dispatcher 配置：双轴审查 prompt 配置表。
// 新增轴只改这里，不动 buildContractPrompt 的函数体（避免分支膨胀）。
//
// 判定词表必须与 flow_audit_submit 的 enum（PASS / WARN / FAIL）对齐：
// 词表不一致时 subagent 会输出「通过/违规」这类自然语言，由主 Agent 手工映射，
// 而 FAIL（硬拦）与 WARN（不拦）的差别就在这一步 —— 映射错了硬拦就失效了。
const AXIS_PROMPTS = {
  standards: {
    objective: "审计：仓库代码规范与坏味道",
    format: "判定（PASS / WARN / FAIL） / 规范依据 / file:line 证据 / 是否硬违规",
    guidance:
      "两层基线同时执行：" +
      "① 仓库规范层：先在目标仓库内发现规范文件（eslint 配置、prettier 配置、editorconfig、" +
      "CONTRIBUTING.md、AGENTS.md、tsconfig 的 lint 选项、CI 里的 lint/test 命令），" +
      "把发现的规范文件清单写进报告，再逐条对照；" +
      "② 通用设计层：按下面的「坏味道基线」逐条检查。" +
      "只读取证 git diff，不轻信 executor 自述，每条命中都要给 file:line 证据。" +
      "判定口径：违反仓库明文规范判 FAIL；命中通用设计基线判 WARN。",
    boundaries: "零文件改动，只读取证",
    checklist: {
      title: "坏味道基线",
      items: SMELL_BASELINE,
      note: "本表由 Carlos 自维护，术语对齐 Fowler《Refactoring》第二版第 3 章 Code Smells，非原书全表",
    },
  },
  spec: {
    objective: "审计：任务卡验收标准忠实度",
    format: "判定（PASS / WARN / FAIL） / 验收标准逐条核对结果 / 越界改动（file:line）",
    guidance:
      "对照任务卡 goal/acceptance/scope，逐条核对卡上的验收标准，跑 flow_check_scope 校验越界，" +
      "独立跑验证命令取证。判定口径：验收标准全部满足且无越界判 PASS；未实现验收或越界改动判 FAIL；" +
      "仅部分存疑判 WARN。",
    boundaries: "零文件改动，只读取证",
  },
};

// role ∈ "executor" | "auditor"
// axis ∈ undefined（默认四段合同） | "standards" | "spec"（双轴审计模式）
export function buildContractPrompt(role, card, extra, axis) {
  const isAuditor = role === "auditor";
  const isExecutor = role === "executor";
  if (!isAuditor && !isExecutor) {
    throw new Error(`buildContractPrompt: 未知 role "${role}"（仅支持 executor/auditor）`);
  }

  // 模式注入：指定了 axis 就走配置表（覆盖式），否则走原有逻辑
  let objective, outputFormat, toolGuidance, taskBoundaries;

  if (axis && AXIS_PROMPTS[axis]) {
    const cfg = AXIS_PROMPTS[axis];
    objective = `objective: ${cfg.objective}`;
    outputFormat = `output format: ${cfg.format}`;
    toolGuidance = `tool guidance: ${cfg.guidance}`;
    taskBoundaries = `task boundaries: ${cfg.boundaries}`;
  } else {
    const c = card && typeof card === "object" ? card : {};

    objective = `objective: ${c.goal || ""}`;

    outputFormat = isExecutor
      ? "output format: 报告 ≤300 字，四段：结论（一句话，做完/没做完） / 改动（file:line 逐条列出，没改写“无”） / 验证（命令 → 结果摘要，未跑写“未验证”） / 遗留风险"
      : "output format: 报告 ≤200 字，五段：裁定（通过/不通过） / 失败类型（操作错误/环境问题/卡片问题） / scope 标注（是否越界改动） / 证据（file:line 或实跑命令输出） / 附注";

    const verifyCmd = c.verify && c.verify.cmd ? String(c.verify.cmd) : "";
    let guidance = verifyCmd || "未指定验证命令，用只读取证";
    if (isAuditor) {
      guidance += "；独立跑 git status --porcelain 与 git diff 取证，不轻信 executor 自述";
    }
    toolGuidance = `tool guidance: ${guidance}`;

    const scopeArr = Array.isArray(c.scope) ? c.scope.map(String) : [];
    let boundaries;
    if (isAuditor) {
      boundaries = "零文件改动，只读取证";
    } else {
      boundaries = scopeArr.length > 0 ? scopeArr.join(", ") : "无文件可改，只读任务";
    }
    taskBoundaries = `task boundaries: ${boundaries}`;
  }

  let prompt = [objective, outputFormat, toolGuidance, taskBoundaries].join("\n");

  // 轴模式：附上该轴的基线清单（Standards 轴的坏味道基线）。
  // 清单必须内联进 prompt —— 审计 subagent 跑在**目标仓库**里，
  // 读不到 carlos-flow 包内的文件，写成 docs/xxx.md 让它去读等于没写。
  const axisCfg = axis ? AXIS_PROMPTS[axis] : null;
  if (axisCfg && axisCfg.checklist) {
    prompt += "\n\n" + renderChecklist(axisCfg.checklist);
  }

  if (extra && String(extra) !== "") {
    prompt += "\n\n" + String(extra); // 原样附在末尾
  }
  return prompt;
}

// 快照：存在→复制到 RUNS_DIR/<id>/backup/<ts>_<name>；不存在→created:true；复制失败→error 且不中断其余
export function snapshotFiles(sid, paths, cwd) {
  const bdir = path.join(RUNS_DIR, sanitizeId(sid), "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const entries = [];
  const list = Array.isArray(paths) ? paths : [];
  for (const p of list) {
    const ts = new Date().toISOString();
    const orig = path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p);
    if (!fs.existsSync(orig)) {
      entries.push({ ts, orig, backup: null, created: true });
      continue;
    }
    try {
      // 生成随机后缀（确保是字符串）
      const randSuffix = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      const backup = path.join(bdir, `${Date.now()}_${randSuffix}_${path.basename(orig)}`);
      fs.copyFileSync(orig, backup);
      // 完整性校验：比较大小
      const srcStat = fs.statSync(orig);
      const bakStat = fs.statSync(backup);
      if (srcStat.size !== bakStat.size) {
        fs.unlinkSync(backup);
        entries.push({ ts, orig, error: "完整性校验失败（大小不匹配）" });
      } else {
        entries.push({ ts, orig, backup, created: false });
      }
    } catch (e) {
      entries.push({ ts, orig, error: String(e) });
    }
  }
  try {
    const lines = entries.map((x) => JSON.stringify(x)).join("\n") + "\n";
    fs.appendFileSync(path.join(RUNS_DIR, sanitizeId(sid), "backup", "manifest.jsonl"), lines, "utf8");
  } catch (e) {
    try {
      process.stderr.write(`[flow-snapshot] manifest 追加失败: ${e && e.message ? e.message : e}\n`);
    } catch {}
  }
  return entries;
}

export function readManifest(sid) {
  const file = path.join(RUNS_DIR, sanitizeId(sid), "backup", "manifest.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const all = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        all.push(JSON.parse(t));
      } catch {}
    }
    // 只返回每个 orig 的最新条目（按 ts 去重）
    const latest = new Map();
    for (const e of all) {
      if (!e || !e.orig) continue;
      const existing = latest.get(e.orig);
      if (!existing || e.ts > existing.ts) {
        latest.set(e.orig, e);
      }
    }
    return Array.from(latest.values());
  } catch {
    return [];
  }
}

// 读取 manifest 所有条目（不去重），用于回滚计划
export function readManifestAll(sid) {
  const file = path.join(RUNS_DIR, sanitizeId(sid), "backup", "manifest.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const all = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        all.push(JSON.parse(line));
      } catch {}
    }
    return all;
  } catch {
    return [];
  }
}

// 写入派发 prompt 到文件，供主 Agent（Cindy）读取后通过 subagent 工具派发。
// 返回 prompt 文件路径，主 Agent 读取后自行调用 subagent 工具。
export function writeDispatchPrompt(sid, role, message, cwd) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid), "dispatch");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${role}.prompt.txt`);
    const content = message || "";
    fs.writeFileSync(file, content, "utf8");
    return { file, content };
  } catch (e) {
    return { file: null, content: null, error: String(e && e.message ? e.message : e) };
  }
}

// 保存子 Agent 执行结果到会话目录
export function saveAgentResult(sid, role, stdout, stderr, code) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid), "dispatch");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${role}.result.json`);
    const rec = { ts: new Date().toISOString(), role, code: code ?? -1, stdout: String(stdout || ""), stderr: String(stderr || "") };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    return file;
  } catch {
    return null;
  }
}

// Phase 1-1: 执行验证命令并返回结果
//
// 跨平台：原先硬编码 `spawn("cmd", ["/c", cmd], { shell: true })` —— cmd.exe 只存在于 Windows，
// 在 Linux/macOS 上 `cmd` 不是可执行文件 → 命令根本没跑起来，
// exitCode=127（command not found），记 PASS 的前置证据永远拿不到，
// ubuntu CI 的 e2e 会整片变红。
//
// 现在按平台选 shell：
//   · Windows：cmd.exe /c + shell:true（实测 shell:false 会把带引号的
//     `node -e "process.exit(3)"` 的引号吃掉，退出码变成 0 而不是 3 ——
//     那样「验证失败必须拦住 PASS」的门禁就形同虚设）；
//   · POSIX：/bin/sh -c + shell:false（明确指定解释器，不依赖 PATH 里的 sh）。
export async function runVerifyCommand(cmd, cwd) {
  if (!cmd || !cmd.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "验证命令为空" };
  }
  // 可选：拦截高危命令模式。
  //
  // 威胁模型说明（重要，不要夸大）：
  //   · verify.cmd 本质上就是「执行用户指定的验证命令」—— 它的设计目标就是能跑任意命令
  //     （`npm test` / `pytest` / `cargo build` …），所以**默认不拦**。
  //   · 真正的风险来源是「verify.cmd 的来源可信度」：
  //     - 人工填写的任务卡 → 可信，是用户/Agent 的本意
  //     - 自动激活产生的占位卡 → activation 时 scope/acceptance 为空、**没有 verify.cmd**，
  //       必须人工补齐才能过闸门 → 自动触发路径已被 activation 闸门挡住
  //   · 因此默认不拦是对的；把黑名单默认打开会误伤合法脚本
  //     （比如 `rm -rf node_modules` 出现在清理步骤里是完全合法的）。
  //   · 需要更严的用户可以打开 CARLOS_FLOW_BLOCK_DANGEROUS=1。
  if (process.env.CARLOS_FLOW_BLOCK_DANGEROUS === "1") {
    const dangerous = /\b(rm\s+-[rRf]{1,2}[^\s]*\s+\/|sudo\s|curl\s+[^|]*\|\s*(ba)?sh|mkfs(\.|\s)|dd\s+if=|:\(\)\{|>\s*\/dev\/sd[a-z])/i;
    if (dangerous.test(cmd)) {
      return {
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: `验证命令包含高危模式，已拒绝执行：${cmd}\n` +
          "（CARLOS_FLOW_BLOCK_DANGEROUS=1 已开启；确认该命令安全后可关闭此开关）",
      };
    }
  }
  const isWindows = process.platform === "win32";
  const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];
  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + "\n验证命令超时 (120s)" });
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, exitCode: -1, stdout, stderr: String(err) });
    });
  });
}

// ---------------------------------------------------------------------------
// 输出指纹 + 负对照（negative control）
// ---------------------------------------------------------------------------

// 一次验证运行的输出指纹：exitCode + stdout + stderr。
//
// 为什么需要：裁定要绑定的是「一次可复现的运行」，而不是「我说测试过了」。
// 把输出哈希记进 last_verify，裁定时比对，就能发现「证据被换掉 / 命令不确定」。
export function computeOutputHash(exitCode, stdout, stderr) {
  try {
    const h = createHash("sha256");
    h.update("exitCode=" + String(exitCode === undefined || exitCode === null ? -1 : exitCode));
    h.update("\n");
    h.update(typeof stdout === "string" ? stdout : "");
    h.update("\n");
    h.update(typeof stderr === "string" ? stderr : "");
    return h.digest("hex");
  } catch {
    return "";
  }
}

// 用快照 manifest 还原「派发时（改动前）」的工作区状态。
function restoreFromManifest(entries) {
  for (const e of entries) {
    if (!e || !e.orig) continue;
    try {
      if (e.created === true) {
        // 派发时该文件不存在 → 删除当前文件
        try { fs.unlinkSync(e.orig); } catch {}
      } else if (e.backup) {
        fs.mkdirSync(path.dirname(e.orig), { recursive: true });
        fs.copyFileSync(e.backup, e.orig);
      }
    } catch (err) {
      try { process.stderr.write(`[flow-falsify] 还原失败 ${e.orig}: ${err && err.message ? err.message : err}\n`); } catch {}
    }
  }
}

// 负对照：证明 verify.cmd 真的在测「本次改动」。
//
// 层次：这是「证据门禁」的执行侧 —— 不是让 LLM 声称「我试图证伪但没成功」，
// 而是让 harness 真的把工作区还原到改动前，跑同一命令，看它是否失败。
// 一个改动前就退 0 的测试是**空测试**，不构成任何证据（`|| true` / `echo ok` 就是这么漏过去的）。
//
// 安全：先把「改动后」的 scope 文件备份到临时目录，finally 里一定还原；
// 即使 verify 命令本身改动文件，也不会把工作区留在改动前状态。
//
// 局限（如实说明）：快照只覆盖卡片 scope 内的文件。如果 verify.cmd 依赖 scope 外的
// 文件、而执行者又改了它们，「改动前」状态只是近似。此时负对照结论仅供参考。
export async function runNegativeControl(sid, cmd, cwd) {
  const entries = readManifest(sid);
  if (!entries.length) {
    return { ok: false, error: "没有派发快照，无法做负对照（请先 flow_dispatch）" };
  }
  const tmpDir = path.join(RUNS_DIR, sanitizeId(sid), "negative_control", String(Date.now()));
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {
    return { ok: false, error: "无法创建负对照临时目录：" + (e && e.message ? e.message : e) };
  }

  // 1. 备份「改动后」的当前状态
  const saved = [];
  for (const e of entries) {
    if (!e || !e.orig) continue;
    const orig = e.orig;
    const existed = fs.existsSync(orig);
    let savedPath = null;
    if (existed) {
      try {
        savedPath = path.join(tmpDir, `${saved.length}_${path.basename(orig)}`);
        fs.copyFileSync(orig, savedPath);
      } catch (err) {
        try { process.stderr.write(`[flow-falsify] 备份当前文件失败 ${orig}: ${err && err.message ? err.message : err}\n`); } catch {}
      }
    }
    saved.push({ orig, savedPath, existed });
  }

  // 还原「改动后」状态（无论后续发生什么）
  const restoreCurrent = () => {
    for (const s of saved) {
      try {
        if (s.existed && s.savedPath) {
          fs.mkdirSync(path.dirname(s.orig), { recursive: true });
          fs.copyFileSync(s.savedPath, s.orig);
        } else if (!s.existed) {
          // 当前状态里该文件不存在（executor 删了它）→ 保持删除
          try { fs.unlinkSync(s.orig); } catch {}
        }
      } catch (err) {
        try { process.stderr.write(`[flow-falsify] 还原当前文件失败 ${s.orig}: ${err && err.message ? err.message : err}\n`); } catch {}
      }
    }
  };

  let before = null;
  let after = null;
  try {
    // 2. 还原「改动前」
    restoreFromManifest(entries);
    // 3. 跑改动前 —— 必须失败
    before = await runVerifyCommand(cmd, cwd);
    // 4. 还原「改动后」
    restoreCurrent();
    // 5. 跑改动后 —— 必须通过
    after = await runVerifyCommand(cmd, cwd);
  } finally {
    // 无论如何都还原改动后状态
    restoreCurrent();
  }

  const beforeHash = computeOutputHash(before.exitCode, before.stdout, before.stderr);
  const afterHash = computeOutputHash(after.exitCode, after.stdout, after.stderr);

  let verdict = "inconclusive";
  let reason = "";
  if (before.ok === true) {
    // 改动前就通过 → 空测试
    verdict = "vacuous";
    reason = "verify.cmd 在改动前就通过（exitCode=" + before.exitCode + "）—— 它没有测本次改动，是空测试";
  } else if (after.ok !== true) {
    verdict = "not_passing";
    reason = "verify.cmd 在改动后未通过（exitCode=" + after.exitCode + "）—— 改动本身有问题";
  } else {
    verdict = "meaningful";
    reason = "改动前失败（exitCode=" + before.exitCode + "）+ 改动后通过（exitCode=" + after.exitCode + "）—— 测试有判别力";
  }

  // 清理临时目录（还原已完成，不再需要备份）
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}

  return {
    ok: true,
    verdict,
    reason,
    before: { exitCode: before.exitCode, ok: before.ok, hash: beforeHash, stdout: before.stdout, stderr: before.stderr },
    after: { exitCode: after.exitCode, ok: after.ok, hash: afterHash, stdout: after.stdout, stderr: after.stderr },
  };
}

// Phase 1-1: scope 机器校验 - 对比 diff 与 card.scope
//
// 用法：enforceScope(scope, cwd, diffFiles?)
//   - scope: 卡片中的 scope 白名单
//   - cwd:   仓库根目录（用于跑 git diff）
//   - diffFiles?: 可选，外部传入的改动文件列表；不传则自动跑 `git diff --name-only`
// 返回：{ ok, violations[], message? }
//
// 设计：
//   · 空 scope = 白名单为空 = fail-closed（所有变更都算越界）
//   · 无变更（diffFiles 为空）= 直接 ok
//   · 自动跑 `git diff --name-only`：派发前快照 vs 当前工作区
//   · 精确匹配 + 父目录匹配：scope 内文件及其子目录均算通过
export function enforceScope(scope, cwd, diffFiles) {
  // diffFiles 可选：外部传入的改动文件列表；不传则自动跑 `git diff --name-only`
  // cwd: 仓库根目录（用于跑 git diff）
  let autoCollected = false;
  if (!diffFiles) {
    autoCollected = true;
    diffFiles = [];
    try {
      const proc = spawnSync("git", ["diff", "--name-only"], {
        cwd: cwd || process.cwd(),
        encoding: "utf8",
        // git 不在 PATH / 不是仓库 / 超时 → 一律当作「无改动」而非抛错，
        // 避免把环境问题变成门禁误报（fail-closed 只针对 scope 语义，不针对环境）
        timeout: 10000,
        windowsHide: true,
      });
      if (proc.status === 0 && typeof proc.stdout === "string") {
        diffFiles = proc.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      }
    } catch { diffFiles = []; }
  }

  // 没有任何变更 → 无需判定
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) {
    return { ok: true, violations: [], checked: [] };
  }

  // 空 scope = 白名单为空 = **不允许改动任何文件**。
  // 早期实现直接 return { ok: true }，等于「白名单为空 → 随便改」，
  // 是 fail-open 漏洞；这里改为 fail-closed：所有变更都算越界。
  if (!Array.isArray(scope) || scope.length === 0) {
    return {
      ok: false,
      violations: diffFiles.slice(),
      checked: diffFiles.slice(),
      message: `越界改动（卡片 scope 为空，不允许修改任何文件）：${diffFiles.join(", ")}`,
    };
  }

  const scopeSet = new Set(scope.map(p => path.normalize(p)));
  const violations = [];
  
  for (const file of diffFiles) {
    const normalized = path.normalize(file);
    // 检查文件是否在 scope 内（精确匹配或父目录匹配）
    let allowed = false;
    for (const scopePath of scopeSet) {
      const normalizedScope = path.normalize(scopePath);
      if (normalized === normalizedScope || normalized.startsWith(normalizedScope + path.sep)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      violations.push(file);
    }
  }
  
  if (violations.length > 0) {
    return { ok: false, violations, checked: diffFiles.slice(), message: `越界改动（超出 scope）：${violations.join(", ")}` };
  }
  return { ok: true, violations: [], checked: diffFiles.slice() };
}

