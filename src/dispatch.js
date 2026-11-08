// dispatch.js — Carlos 工作流：四段合同 prompt / 文件快照 / opencode 子进程 / 验证执行 / scope 校验（Node ESM）
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { RUNS_DIR, sanitizeId } from "./state.js";

export const MAX_DISPATCH = 5;

// role ∈ "executor" | "auditor"
export function buildContractPrompt(role, card, extra) {
  const isAuditor = role === "auditor";
  const isExecutor = role === "executor";
  if (!isAuditor && !isExecutor) {
    throw new Error(`buildContractPrompt: 未知 role "${role}"（仅支持 executor/auditor）`);
  }
  const c = card && typeof card === "object" ? card : {};

  const objective = `objective: ${c.goal || ""}`;

  const outputFormat = isExecutor
    ? "output format: 报告 ≤300 字，四段：结论（一句话，做完/没做完） / 改动（file:line 逐条列出，没改写“无”） / 验证（命令 → 结果摘要，未跑写“未验证”） / 遗留风险"
    : "output format: 报告 ≤200 字，五段：裁定（通过/不通过） / 失败类型（操作错误/环境问题/卡片问题） / scope 标注（是否越界改动） / 证据（file:line 或实跑命令输出） / 附注";

  const verifyCmd = c.verify && c.verify.cmd ? String(c.verify.cmd) : "";
  let guidance = verifyCmd || "未指定验证命令，用只读取证";
  if (isAuditor) {
    guidance += "；独立跑 git status --porcelain 与 git diff 取证，不轻信 executor 自述";
  }
  const toolGuidance = `tool guidance: ${guidance}`;

  const scopeArr = Array.isArray(c.scope) ? c.scope.map(String) : [];
  let boundaries;
  if (isAuditor) {
    boundaries = "零文件改动，只读取证";
  } else {
    boundaries = scopeArr.length > 0 ? scopeArr.join(", ") : "无文件可改，只读任务";
  }
  const taskBoundaries = `task boundaries: ${boundaries}`;

  let prompt = [objective, outputFormat, toolGuidance, taskBoundaries].join("\n");
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

