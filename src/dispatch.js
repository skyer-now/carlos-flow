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

import { PROMPT_PROFILES } from "./profiles.js";

// role ∈ "executor" | "auditor"
// options ∈ { axis?: "standards"|"spec", profile?: string }
export function buildContractPrompt(role, card, extra, options = {}) {
  const isAuditor = role === "auditor";
  const isExecutor = role === "executor";
  if (!isAuditor && !isExecutor) {
    throw new Error(`buildContractPrompt: 未知 role "${role}"（仅支持 executor/auditor）`);
  }

  // 模式注入：指定了 axis/profile 就走配置表（覆盖式），否则走原有逻辑
  let objective, outputFormat, toolGuidance, taskBoundaries;
  const { axis, profile } = typeof options === 'string' ? { axis: options } : options;

  if (axis && AXIS_PROMPTS[axis]) {
    const cfg = AXIS_PROMPTS[axis];
    objective = `objective: ${cfg.objective}`;
    outputFormat = `output format: ${cfg.format}`;
    toolGuidance = `tool guidance: ${cfg.guidance}`;
    taskBoundaries = `task boundaries: ${cfg.boundaries}`;
  } else if (profile && PROMPT_PROFILES[profile]) {
    const cfg = PROMPT_PROFILES[profile];
    objective = `objective: ${cfg.objective}`;
    outputFormat = `output format: ${cfg.format}`;
    toolGuidance = `tool guidance: ${cfg.guidance}`;
    taskBoundaries = isAuditor ? "task boundaries: 零文件改动，只读取证" : "task boundaries: 无文件可改，只读任务";
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

// 每个 orig 保留几份历史快照。
//
// 为什么是 3：flow_revert_plan 的语义是「回到派发时」，多轮返工时真正需要的是
// 「最近几轮」；保留全部历史只有审计价值，却让 backup/ 随返工次数线性膨胀
// （实测单会话 94% 的目录占用都在 backup/）。改成 3 版后占用变成常数级上界。
export const SNAPSHOT_KEEP_VERSIONS = 3;

// 内容寻址备份文件名：sha-<sha256 前 32 位>_<原文件名>。
// 同内容只存一份 —— 多轮返工时最常见的形态是「来来回回改同一批文件」，
// 内容哈希天然去重，比按时间戳存 N 份省得多。
function backupFileNameFor(sha, orig) {
  return `sha-${sha.slice(0, 32)}_${path.basename(orig)}`;
}

// 清理：每个 orig 只保留最近 maxVersions 条 manifest 记录，并删除不再被引用的 blob。
// 只在快照时调用（低频），不参与任何热路径。
export function pruneSnapshots(sid, maxVersions = SNAPSHOT_KEEP_VERSIONS) {
  const dir = path.join(RUNS_DIR, sanitizeId(sid), "backup");
  const manifest = path.join(dir, "manifest.jsonl");
  let all = [];
  try {
    all = fs.readFileSync(manifest, "utf8").split("\n").filter((x) => x.trim()).map((x) => JSON.parse(x));
  } catch {
    return { kept: 0, dropped: 0, blobsRemoved: 0 };
  }
  const byOrig = new Map();
  for (const e of all) {
    if (!e || !e.orig) continue;
    if (!byOrig.has(e.orig)) byOrig.set(e.orig, []);
    byOrig.get(e.orig).push(e);
  }
  const kept = [];
  let dropped = 0;
  for (const [, list] of byOrig) {
    // 稳定排序：时间戳相同（同一次快照）时按写入顺序
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const keepFrom = Math.max(0, list.length - maxVersions);
    for (let i = 0; i < list.length; i++) {
      if (i >= keepFrom) kept.push(list[i]);
      else dropped++;
    }
  }
  const referenced = new Set();
  for (const e of kept) if (e.backup) referenced.add(path.resolve(e.backup));
  let blobsRemoved = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("sha-")) continue;
      const full = path.resolve(path.join(dir, name));
      if (referenced.has(full)) continue;
      try { fs.unlinkSync(full); blobsRemoved++; } catch { /* 可能正被别人读着 */ }
    }
  } catch { /* ignore */ }
  if (dropped > 0 || blobsRemoved > 0) {
    try {
      fs.writeFileSync(manifest, kept.map((x) => JSON.stringify(x)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    } catch { /* 写不进去就保留旧 manifest，最多不省空间 */ }
  }
  return { kept: kept.length, dropped, blobsRemoved };
}

// 快照：存在→复制到 RUNS_DIR/<id>/backup/sha-<hash>_<name>（内容相同只存一份）；
// 不存在→created:true；复制失败→error 且不中断其余
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
      const buf = fs.readFileSync(orig);
      const sha = createHash("sha256").update(buf).digest("hex");
      const backup = path.join(bdir, backupFileNameFor(sha, orig));
      let deduped = false;
      if (fs.existsSync(backup)) {
        deduped = true; // 同内容已存在：不重复写盘
      } else {
        fs.writeFileSync(backup, buf);
      }
      entries.push({ ts, orig, backup, created: false, sha, bytes: buf.length, deduped });
    } catch (e) {
      entries.push({ ts, orig, error: String(e) });
    }
  }
  try {
    const manifest = path.join(RUNS_DIR, sanitizeId(sid), "backup", "manifest.jsonl");
    fs.appendFileSync(manifest, entries.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  } catch (e) {
    try {
      process.stderr.write(`[flow-snapshot] manifest 追加失败: ${e && e.message ? e.message : e}\n`);
    } catch {}
  }
  // 写完立刻做一次版本裁剪（每个 orig 只留最近 N 版 + 删无引用 blob）
  try { pruneSnapshots(sid); } catch { /* 裁剪失败不影响快照本身 */ }
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
// ---------------------------------------------------------------------------
// 输出截断（子 Agent 结果落盘 / verify 命令输出共用）
// ---------------------------------------------------------------------------
//
// 为什么必须截断：flow_save_result 会把子 Agent 的**完整** stdout/stderr 落盘，
// flow_run_verify 会把命令输出原样回传。两条路都没有上限 —— 一次 50MB 的输出
// 足以把磁盘（落盘）或宿主进程内存（回传 JSON）一起打爆，而门禁信息量集中在
// 头尾（结论 + 报错尾部堆栈），中间多半是重复日志。
//
// 策略：头部 + 尾部 + 中间折叠，并**如实记录原始字节数**（截断不能静默）。
export const OUTPUT_KEEP_BYTES = 256 * 1024; // 头尾各留 256KB

export function truncateOutput(text, keepBytes = OUTPUT_KEEP_BYTES) {
  const s = typeof text === "string" ? text : String(text == null ? "" : text);
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= keepBytes * 2) return { text: s, bytes, truncated: false };
  // 按字节切，避免把多字节字符截成半个（Buffer 切片后再 toString 会丢字符，
  // 用 toString("utf8") 的解码容错把末尾残缺字符丢掉即可）。
  const buf = Buffer.from(s, "utf8");
  const head = buf.subarray(0, keepBytes).toString("utf8");
  const tail = buf.subarray(bytes - keepBytes).toString("utf8");
  const omitted = bytes - keepBytes * 2;
  return {
    text: head + "\n" + `…[已截断 ${omitted} 字节，原始 ${bytes} 字节]…` + "\n" + tail,
    bytes,
    truncated: true,
    omitted_bytes: omitted,
  };
}

export function saveAgentResult(sid, role, stdout, stderr, code) {
  try {
    const dir = path.join(RUNS_DIR, sanitizeId(sid), "dispatch");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${role}.result.json`);
    const out = truncateOutput(stdout);
    const err = truncateOutput(stderr);
    const rec = {
      ts: new Date().toISOString(),
      role,
      code: code ?? -1,
      // 截断结果 + 原始字节数：审计时能看出「这里被折叠了多少」，
      // 而不是以为子 Agent 只说了这么点。
      stdout: out.text,
      stderr: err.text,
      stdout_bytes: out.bytes,
      stderr_bytes: err.bytes,
      truncated: out.truncated || err.truncated,
    };
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
// 结束整棵进程树。
//
// Windows：taskkill /T /F 才是真的「连子进程一起杀」；child.kill 只结束 cmd.exe 外壳，
// 命令派生的 node.exe 会变孤儿（实测残留进程长期占着端口与文件句柄，下一次验证因此 EBUSY）。
// POSIX：进程组杀（detached 启动时 child.pid 就是组长），拿不到就退回 kill。
function killProcessTree(child) {
  try {
    if (!child || !child.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
      });
      return;
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
  }
}

export async function runVerifyCommand(cmd, cwd) {
  if (!cmd || !cmd.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: formatError("验证命令为空") };
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
        stderr: formatError(`验证命令包含高危模式，已拒绝执行：${cmd}`),
      };
    }
  }
  const isWindows = process.platform === "win32";
  const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];
  // 安全修复：禁止 cwd = '.' 或空（这会在 Windows 上触发 %SystemDrive% 目录扩展，污染仓库）
  const safeCwd = typeof cwd === "string" && cwd.length > 0 && cwd !== "." ? cwd : process.cwd();
  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd: safeCwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      windowsHide: true,
    });
    // 输出上限：命令可能刷出几十 MB 日志。全量拼字符串会把本进程内存打爆，
    // 门禁最后给出的会是「插件崩了」而不是「验证没通过」。这里做**环形截断**：
    // 超过上限后只计数不再占用内存，头尾各留一份，并如实回传原始字节数。
    const chunks = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    const CAP = OUTPUT_KEEP_BYTES * 4;
    const collect = (which, d) => {
      const text = d.toString();
      lengths[which] += Buffer.byteLength(text, "utf8");
      if (lengths[which] > CAP) return; // 已远超上限：只计数，不再占内存
      chunks[which].push(text);
    };
    child.stdout.on("data", (d) => collect("stdout", d));
    child.stderr.on("data", (d) => collect("stderr", d));

    // 回调入参：{ ok, exitCode, stderrText（可选）, appendStderr（可选）, formatStderr（可选） }
    const finish = (result) => {
      const out = truncateOutput(chunks.stdout.join(""));
      const rawErr = chunks.stderr.join("");
      let errText;
      if (result.stderrText !== undefined) errText = result.stderrText;
      else if (result.formatStderr) errText = formatError(String(rawErr));
      else errText = rawErr;
      if (result.appendStderr) errText = (errText ? errText + result.appendStderr : String(result.appendStderr).replace(/^\n+/g, ""));
      const err = truncateOutput(errText);
      resolve({
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: out.text,
        stderr: err.text,
        stdout_bytes: lengths.stdout,
        stderr_bytes: lengths.stderr,
        output_truncated: out.truncated || err.truncated,
      });
    };

    // 超时上限可用 CARLOS_VERIFY_TIMEOUT_MS 覆盖（测试要能在秒级复现「超时必须整树回收」）
    const timeoutMs = (() => {
      const n = Number(process.env.CARLOS_VERIFY_TIMEOUT_MS);
      return Number.isFinite(n) && n >= 200 ? n : 120000;
    })();
    const timeout = setTimeout(() => {
      // Windows 上 child.kill 只杀 cmd.exe 外壳，命令真正派生的 node 子进程会变成孤儿
      // （实测残留 node.exe 能活很久，还占着端口/文件）。必须整棵进程树一起结束。
      killProcessTree(child);
      finish({ ok: false, exitCode: -1, appendStderr: `\n验证命令超时 (${Math.round(timeoutMs / 1000)}s)` });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) finish({ ok: true, exitCode: code });
      else finish({ ok: false, exitCode: code, formatStderr: true });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      finish({ ok: false, exitCode: -1, stderrText: formatError(String(err)) });
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

// ---------------------------------------------------------------------------
// 负对照的状态工具：把「改动前态」「改动后态」显式化、可证明
// ---------------------------------------------------------------------------

// 文件内容摘要：存在→sha256 十六进制；不存在→"ABSENT"；无法读取→"UNKNOWN"
function digestOf(file) {
  if (!file) return "ABSENT";
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return "ABSENT";
    return "UNKNOWN";
  }
}

// 状态指纹：一组 {文件路径: 摘要} → 稳定 sha256。
// 用途：证明「改动前」「改动后」确实是**两个可区分的状态**，而不是同一份内容跑两遍。
function fingerprintOfState(digests) {
  const lines = Object.keys(digests).sort().map((k) => k + "=" + digests[k]);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// 比较「改动前」态与某个候选「改动后」态。
//   changed：内容确实不同的文件（= 本次改动留下的痕迹）
//   unknown：状态不可还原/不可读的文件（无法证明）
function diffStates(pre, post) {
  const changed = [];
  const unknown = [];
  for (const k of Object.keys(pre)) {
    const a = pre[k];
    const b = Object.prototype.hasOwnProperty.call(post, k) ? post[k] : "UNKNOWN";
    if (a === "UNKNOWN" || b === "UNKNOWN") { unknown.push(k); continue; }
    if (a !== b) changed.push(k);
  }
  for (const k of Object.keys(post)) {
    if (Object.prototype.hasOwnProperty.call(pre, k)) continue;
    const b = post[k];
    if (b === "UNKNOWN") { unknown.push(k); continue; }
    if (b !== "ABSENT") changed.push(k);
  }
  return { changed, unknown };
}

// 「改动后」态的**显式记录**文件。
//
// 为什么要单独一个文件：manifest.jsonl 的语义是「派发时的改动前快照」，
// restoreFromManifest() 完全依赖这个语义。把改动后态写进 manifest 会污染它，
// 导致「还原改动前」还原成「改动后」——负对照直接失效。
// 因此改动后态单独落在 backup/after_state.jsonl + backup/after_state_<ts>/ 目录。
function afterStateFile(sid) {
  return path.join(RUNS_DIR, sanitizeId(sid), "backup", "after_state.jsonl");
}

// 读取本会话最近一次记录的「改动后」态（按追加顺序，后写的覆盖先写的）
function readAfterState(sid) {
  const latest = new Map();
  try {
    const raw = fs.readFileSync(afterStateFile(sid), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (!e || !e.orig) continue;
        latest.set(e.orig, e);
      } catch {}
    }
  } catch {}
  return Array.from(latest.values());
}

// 追加记录「改动后」态
function writeAfterState(sid, records) {
  try {
    const file = afterStateFile(sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(file, lines, "utf8");
  } catch (e) {
    try { process.stderr.write(`[flow-falsify] 记录改动后态失败: ${e && e.message ? e.message : e}\n`); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 负对照的安全边界：崩溃恢复日志 + 还原结果可核验
// ---------------------------------------------------------------------------
//
// 背景（为什么需要这两个函数）：负对照的本质是**在真实工作区里临时把文件改回旧内容**，
// 跑一次验证，再把文件写回来。旧实现只有 try/finally 的「意图保证」：
//   · 进程被强杀 / 断电 → finally 不执行 → 工作区停在「改动前」状态，
//     用户的改动看起来凭空消失（最坏情况：把已修好的验证脚本回滚成坏的）；
//   · finally 里某次 copyFileSync 失败（文件被占用、权限不足）→ 只写一行 stderr，
//     调用方拿到的仍是 ok:true，没人知道工作区已经不干净了。
// 现在补两条机械保证：
//   ① **进入前写日志**（negative_control/<ts>/journal.json）：记录每个文件的原位、
//      进入时备份、是否需要删除。下次调用负对照时先把残留日志里的状态恢复回去，
//      所以「上一次被中断」不会把脏状态带到下一次；
//   ② **还原后核对摘要**：逐文件比对内容哈希与「进入时」是否一致，结果写回返回值
//      （restore.ok / restore.mismatched），失败时明确告警而不是静默放过。

function negativeControlRoot(sid) {
  return path.join(RUNS_DIR, sanitizeId(sid), "negative_control");
}

// 扫描并恢复被中断的负对照。返回 { dirs, files, unresolved }。
// 只处理「日志还标着 pending」的目录：正常结束的目录在 finishJournal 里已被删除。
export function recoverInterruptedNegativeControl(sid) {
  const root = negativeControlRoot(sid);
  const out = { dirs: 0, files: 0, unresolved: [] };
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    const dir = path.join(root, name);
    const journalFile = path.join(dir, "journal.json");
    let journal = null;
    try {
      journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    } catch { continue; } // 没有日志（或坏了）：不是本机制写的目录，不碰
    if (!journal || journal.status === "restored") {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      continue;
    }
    out.dirs++;
    for (const e of Array.isArray(journal.saved) ? journal.saved : []) {
      if (!e || typeof e.orig !== "string") continue;
      try {
        if (e.existed === true && e.savedPath) {
          fs.mkdirSync(path.dirname(e.orig), { recursive: true });
          fs.copyFileSync(e.savedPath, e.orig);
          out.files++;
        } else if (e.existed !== true) {
          try { fs.unlinkSync(e.orig); } catch {}
          out.files++;
        } else {
          // 进入时有文件但备份丢了：无法还原，如实记账
          out.unresolved.push(e.orig);
        }
      } catch (err) {
        out.unresolved.push(e.orig);
        try {
          process.stderr.write(`[flow-falsify] 恢复中断的负对照失败 ${e.orig}: ${err && err.message ? err.message : err}\n`);
        } catch {}
      }
    }
    try {
      fs.writeFileSync(journalFile, JSON.stringify({ ...journal, status: "restored", recoveredAt: new Date().toISOString() }, null, 2), "utf8");
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return out;
}

// 还原后核对：逐文件比对内容摘要与「进入负对照时」是否一致。
// UNKNOWN（读不到）不算失配 —— 无法证明 ≠ 证明坏了，如实归到 unreadable。
function verifyRestoredState(saved, expectedDigests) {
  let checked = 0;
  const mismatched = [];
  const unreadable = [];
  for (const s of saved) {
    if (!s || typeof s.orig !== "string") continue;
    const want = Object.prototype.hasOwnProperty.call(expectedDigests, s.orig)
      ? expectedDigests[s.orig]
      : null;
    if (want === null) continue;
    checked++;
    let got;
    try {
      got = fs.existsSync(s.orig) ? digestOf(s.orig) : "ABSENT";
    } catch {
      got = "UNKNOWN";
    }
    if (got === "UNKNOWN" || want === "UNKNOWN") { unreadable.push(s.orig); continue; }
    if (got !== want) mismatched.push(s.orig);
  }
  return { ok: mismatched.length === 0, checked, mismatched, unreadable };
}

// 负对照：证明 verify.cmd 真的在测「本次改动」。
//
// 层次：这是「证据门禁」的执行侧 —— 不是让 LLM 声称「我试图证伪但没成功」，
// 而是让 harness 真的把工作区还原到改动前，跑同一命令，看它是否失败。
// 一个改动前就退 0 的测试是**空测试**，不构成任何证据（`|| true` / `echo ok` 就是这么漏过去的）。
//
// 判定依据（本次修复的核心 —— 去掉隐含前提）：
//   before 与 after 必须是**两个可区分的状态**，否则「前失败/后通过」就没有归因意义。
//   本实现把两态都显式构造出来，并逐文件比对内容摘要：
//     · 改动前态 = 派发快照 manifest 的备份（restoreFromManifest）；
//     · 改动后态 = ①当前工作区（显式捕获后再显式还原），
//                  ②本会话上次负对照**显式记录**下来的改动后态（backup/after_state.jsonl）；
//       当①与改动前态逐字节一致（=工作区里根本没有改动后状态，例如主 Agent 手工改动后
//       未走标准派发窗口、或改动被回退）时，才启用②作为改动后态；
//       两者都没有可用时，如实标注「前后是同一状态」，并按保守口径判负对照，
//       绝不把「同一状态跑两遍」当成 meaningful。
//   改动后态在每次负对照后被显式落盘记录（after_state.jsonl + after_state_<ts>/），
//   于是「改动后应有的状态」不再依赖「调用时工作区恰好已经是改动后」这个隐含前提。
//
// 安全：先把进入时的 scope 文件备份到临时目录，finally 里一定还原成进入时的样子；
// 即使 verify 命令本身改动文件，也不会把工作区留在改动前状态。
//
// 局限（如实说明）：快照只覆盖卡片 scope 内的文件。如果 verify.cmd 依赖 scope 外的
// 文件、而执行者又改了它们，「改动前」状态只是近似。此时负对照结论仅供参考。
export async function runNegativeControl(sid, cmd, cwd) {
  const entries = readManifest(sid);
  if (!entries.length) {
    return { ok: false, error: formatError("没有派发快照，无法做负对照（请先 flow_dispatch）") };
  }
  // 先把上一次「被中断的负对照」恢复掉，否则脏状态会带进本次的 before/after 判定。
  const recovered = recoverInterruptedNegativeControl(sid);
  const tmpDir = path.join(negativeControlRoot(sid), String(Date.now()));
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {
    return { ok: false, error: formatError("无法创建负对照临时目录：" + (e && e.message ? e.message : e)) };
  }

  // ---- 状态 A：改动前态（派发时的快照，来自 manifest 备份） ----
  const preDigests = {};
  for (const e of entries) {
    if (!e || !e.orig) continue;
    if (e.created === true) preDigests[e.orig] = "ABSENT";
    else if (e.backup) preDigests[e.orig] = digestOf(e.backup);
    else preDigests[e.orig] = "UNKNOWN"; // 备份缺失 → 改动前态无法完整还原
  }

  // ---- 状态 B：改动后候选① —— 当前工作区（显式捕获，之后显式还原） ----
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
  const currentDigests = {};
  for (const s of saved) {
    if (!s.existed) currentDigests[s.orig] = "ABSENT";
    else if (s.savedPath) currentDigests[s.orig] = digestOf(s.savedPath);
    else currentDigests[s.orig] = "UNKNOWN";
  }

  // ---- 状态 C：改动后候选② —— 本会话显式记录过的改动后态 ----
  const recorded = readAfterState(sid);
  const recordedMap = new Map();
  const recordedDigests = {};
  for (const r of recorded) {
    if (!r || !r.orig) continue;
    recordedMap.set(r.orig, r);
    recordedDigests[r.orig] = r.absent === true ? "ABSENT" : digestOf(r.backup);
  }
  // 只有当记录覆盖了本次快照的全部文件时，才敢把它当作完整的「改动后态」
  const recordedCoversAll = entries.every((e) => e && e.orig && recordedMap.has(e.orig));

  // ---- 选定改动后态：优先当前工作区；当前工作区与改动前态完全一致时，退回显式记录 ----
  const curDiff = diffStates(preDigests, currentDigests);
  const recDiff = diffStates(preDigests, recordedDigests);
  let afterSource = "workspace";
  let afterDigests = currentDigests;
  let changedFiles = curDiff.changed;
  let unknownFiles = curDiff.unknown;
  if (curDiff.changed.length === 0 && recordedCoversAll && recDiff.changed.length > 0) {
    afterSource = "recorded";
    afterDigests = recordedDigests;
    changedFiles = recDiff.changed;
    unknownFiles = recDiff.unknown;
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

  // 还原「显式记录的改动后态」
  const restoreRecorded = () => {
    for (const r of recorded) {
      if (!r || !r.orig) continue;
      try {
        if (r.absent === true) {
          try { fs.unlinkSync(r.orig); } catch {}
        } else if (r.backup) {
          fs.mkdirSync(path.dirname(r.orig), { recursive: true });
          fs.copyFileSync(r.backup, r.orig);
        }
      } catch (err) {
        try { process.stderr.write(`[flow-falsify] 还原记录的改动后态失败 ${r.orig}: ${err && err.message ? err.message : err}\n`); } catch {}
      }
    }
  };

  // ---- 进入「会改动工作区」的临界区之前，先把还原所需信息落盘 ----
  // 这一步是崩溃恢复的唯一依据：进程被强杀时，下次调用靠它把工作区还原回去。
  const journalFile = path.join(tmpDir, "journal.json");
  const writeJournal = (status, extra) => {
    try {
      fs.writeFileSync(journalFile, JSON.stringify({
        sid,
        ts: new Date().toISOString(),
        cwd: cwd || null,
        status,
        saved: saved.map((x) => ({ orig: x.orig, savedPath: x.savedPath, existed: x.existed })),
        ...(extra || {}),
      }, null, 2), "utf8");
    } catch (e) {
      try { process.stderr.write(`[flow-falsify] 写还原日志失败: ${e && e.message ? e.message : e}\n`); } catch {}
    }
  };
  writeJournal("pending");

  // ---- 把选定的「改动后态」显式落盘记录（让下次负对照能按记录还原，而不是靠隐含前提） ----
  try {
    const afterDir = path.join(RUNS_DIR, sanitizeId(sid), "backup", "after_state_" + Date.now());
    fs.mkdirSync(afterDir, { recursive: true });
    const ts = new Date().toISOString();
    const records = [];
    for (const s of saved) {
      let backup = null;
      let absent = false;
      if (afterSource === "recorded") {
        const r = recordedMap.get(s.orig);
        if (r) { absent = r.absent === true; backup = r.absent === true ? null : r.backup; }
      } else if (!s.existed) {
        absent = true;
      } else if (s.savedPath) {
        backup = path.join(afterDir, `${records.length}_${path.basename(s.orig)}`);
        fs.copyFileSync(s.savedPath, backup);
      }
      records.push({ ts, orig: s.orig, backup, absent });
    }
    writeAfterState(sid, records);
  } catch (e) {
    try { process.stderr.write(`[flow-falsify] 快照改动后态失败: ${e && e.message ? e.message : e}\n`); } catch {}
  }

  let before = null;
  let after = null;
  let restoreReport = { ok: true, checked: 0, mismatched: [], unreadable: [] };
  try {
    // 1. 还原「改动前」（派发快照）—— 必须失败
    restoreFromManifest(entries);
    before = await runVerifyCommand(cmd, cwd);
    // 2. 显式还原「改动后」态再跑第二次 —— 必须通过
    if (afterSource === "recorded") restoreRecorded();
    else restoreCurrent();
    after = await runVerifyCommand(cmd, cwd);
  } finally {
    // 无论如何都把工作区还原成进入负对照时的样子。
    // 还原后必须**核对摘要**：只靠 try/finally 是意图保证，
    // 一次失败的文件写回会让用户改动静默消失，而调用方还以为一切正常。
    restoreCurrent();
    restoreReport = verifyRestoredState(saved, currentDigests);
    writeJournal(restoreReport.ok ? "restored" : "restore_failed", {
      restore: restoreReport,
      finishedAt: new Date().toISOString(),
    });
    if (!restoreReport.ok) {
      try {
        process.stderr.write(
          "[flow-falsify] ⚠️ 工作区还原不完整，以下文件与进入负对照前不一致：" +
            restoreReport.mismatched.join(", ") +
            "（备份保留在 " + tmpDir + "，下次调用 flow_falsify 会先尝试恢复）\n",
        );
      } catch { /* ignore */ }
    }
  }

  const beforeHash = computeOutputHash(before.exitCode, before.stdout, before.stderr);
  const afterHash = computeOutputHash(after.exitCode, after.stdout, after.stderr);
  const beforeStateHash = fingerprintOfState(preDigests);
  const afterStateHash = fingerprintOfState(afterDigests);

  // 两态是否可区分 —— 判定的前提，必须写进 reason（不能靠隐含假设）
  const stateNote = changedFiles.length > 0
    ? "；改动后态来源=" + (afterSource === "recorded" ? "上次负对照显式记录的改动后态" : "当前工作区") +
      "，检出改动文件 " + changedFiles.length + " 个：" + changedFiles.join(", ")
    : (unknownFiles.length > 0
      ? "；无法确认改动后态：" + unknownFiles.length + " 个文件状态不可还原/不可读（" + unknownFiles.join(", ") + "）"
      : "；未检出任何改动：工作区与派发快照逐字节一致，「改动前」「改动后」是同一状态");

  let verdict = "";
  let reason = "";
  if (before.ok === true) {
    // 改动前就通过 → 空测试
    verdict = "vacuous";
    reason = "verify.cmd 在改动前就通过（exitCode=" + before.exitCode + "）—— 它没有测本次改动，是空测试" + stateNote;
  } else if (after.ok !== true) {
    verdict = "not_passing";
    reason = "verify.cmd 在改动后未通过（exitCode=" + after.exitCode + "）—— 改动本身有问题" + stateNote;
  } else if (changedFiles.length > 0) {
    verdict = "meaningful";
    reason = "改动前失败（exitCode=" + before.exitCode + "）+ 改动后通过（exitCode=" + after.exitCode + "）—— 测试有判别力" + stateNote;
  } else {
    // 两次运行处于同一状态 → 结果差异不可能来自本次改动（只可能来自命令本身的不确定）
    verdict = "vacuous";
    reason = "改动前失败（exitCode=" + before.exitCode + "）+ 改动后通过（exitCode=" + after.exitCode + "），" +
      "但两次运行处于同一状态（未检出任何改动文件）—— 结果差异无法归因于本次改动，" +
      "不能证明该命令在测本次改动，按保守口径记为空测试" + stateNote;
  }

  // 清理临时目录：**只有还原被核对通过时才删**。
  // 还原失败时保留备份与日志 —— 下一次 flow_falsify 会先用它把工作区救回来，
  // 删掉就等于把用户改动的唯一副本扔了。
  if (restoreReport.ok) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }

  return {
    ok: true,
    verdict,
    reason,
    before: { exitCode: before.exitCode, ok: before.ok, hash: beforeHash, stdout: before.stdout, stderr: before.stderr, state_hash: beforeStateHash },
    after: { exitCode: after.exitCode, ok: after.ok, hash: afterHash, stdout: after.stdout, stderr: after.stderr, state_hash: afterStateHash },
    // 还原结果可核验：ok=false 表示工作区没能完整回到进入负对照前的状态
    restore: restoreReport,
    // 本次调用开始时顺手恢复掉的「上一次被中断的负对照」残留
    recovered: { dirs: recovered.dirs, files: recovered.files, unresolved: recovered.unresolved },
  };
}
// 辅助建议映射表
// 每条都回答三个问题：为什么被拦 / 依据什么规则 / 下一步怎么走
// 键是错误信息里的特征子串（按声明顺序匹配，先命中先用）
const ERROR_SUGGESTIONS = {
  "验证命令为空": " Carlos 需要一个可执行的验证命令（如 `npm test` / `pytest -q`）来判断改动是否真的做对了。它写在任务卡的 verify.cmd 里。",
  "包含高危模式": " 该命令里有删除系统路径、管道执行脚本、写块设备这类不可逆操作。默认不拦（因为清理命令本身合法），但开启 CARLOS_FLOW_BLOCK_DANGEROUS=1 后会拦。",
  "没有派发快照": " 负对照要拿「派发时的文件备份」当对照物，没派发就没有备份。先把任务派出去（flow_dispatch）再回来做负对照。",
  "越界改动": " 你改到了任务卡 scope 白名单之外的文件。这是机械门禁里最硬的一条 —— 防止 executor 顺手改了不该改的地方。",
  "卡片 scope 为空": " 空 scope 按 fail-closed 处理：既然没声明允许改什么，就视为什么都不许改。",
  "验证未通过": " verify.cmd 跑出了非 0 退出码，说明改动还没让验证通过。PASS 不能落，DIRTECTION/LOCAL 可以。",
  "验证结果已过期": " 验证通过后代码又被改动了（diff 指纹变了），所以那次验证已经不能证明当前代码。重新跑一次 flow_run_verify 即可。",
  "验证命令与当前卡片不一致": " 现有的验证结果对应的是另一个 verify.cmd（可能是旧卡的）。对当前卡重新跑一次验证。",
  "尚未执行验证": " 还没有跑过 verify.cmd，没有可核验的凭据。",
  "尚未派发任何执行": " 门禁要求改动必须经过派发窗口（有快照、有基线），跳过派发直接落 PASS 是不允许的。",
  "尚未做负对照": " 负对照用来证明 verify.cmd 真的有判别力（改动前失败、改动后通过），防止 `|| true` 这种空测试混过去。",
  "负对照未通过": " 验证命令没有判别力（例如改动前后都退出 0），不能拿它当「改动正确」的证据。",
  "缺少必填字段": " 当前风险档要求的字段没填齐。低风险档只要求 goal/quote/scope，cross_module 还要 acceptance 和 files。",
  "类型错误": " 参数类型与工具 schema 声明不符。常见于把数组写成字符串、或数组元素嵌套了一层。",
  "值非法": " 该参数只接受枚举里的值。",
  "未 claim": " 派发前要先 claim 领一个名额（executor 或 auditor），这是为了让审计知道是谁在做。",
  "quote 锚点": " quote 必须能在你的原话里定位到，防止 Agent 替你编需求。",
  "路径在磁盘上不存在": " scope 里的路径找不到。常见原因是没传 cwd，导致相对路径按 server 进程目录（而不是仓库根）解析。",
  "敏感路径": " scope 里包含敏感路径，需要你显式确认（confirmed=true）才能提交。",
  "获取状态锁超时": " 同一会话有另一个进程正在写状态，等它释放即可，不要绕过锁直接写。",
  "没有留痕": " 门禁要求先有任务卡（留痕），否则 executor/auditor 不知道边界在哪、也无法事后追溯。",
  "留痕已过期": " 卡片有 TTL（默认 4 小时），过期后再派发就不算同一张卡了，需重新提交。",
  "派发次数已达上限": " 同一张卡可派发次数有上限，防止无限重试把同一张卡磨到绿灯。",
  "占位卡尚未补齐": " 智能触发只开了一张占位卡，scope / acceptance / verify.cmd 还没填，填完才能派发。",
  "卡片未指定 verify": " 没有 verify.cmd 就没有可核验的证据，PASS 无法成立。",
  "两轴": " PASS 要求两轴（规范轴 + 验收轴）各自取证，单轴意见不足以放行。",
  "至少一轴": " 至少一轴判了 FAIL，说明问题确实存在，修完重跑再提。",
  "auditor": " PASS 只能由已领取 auditor 角色的会话落下，防止执行方自批。",
};


export function formatError(err) {
  const msg = typeof err === 'string' ? err : String((err && err.message) || err);
  let suggestion = "";
  for (const [key, val] of Object.entries(ERROR_SUGGESTIONS)) {
    if (msg.includes(key)) { suggestion = `\n💡 **为什么被拦**：${val}`; break; }
  }
  return `${msg}${suggestion}`;
}
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
      message: formatError(`越界改动（卡片 scope 为空，不允许修改任何文件）：${diffFiles.join(", ")}`),
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
    const msg = `越界改动（超出 scope）：${violations.join(", ")}`;
    return { ok: false, violations, checked: diffFiles.slice(), message: formatError(msg) };
  }
  return { ok: true, violations: [], checked: diffFiles.slice() };
}

