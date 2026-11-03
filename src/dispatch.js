// dispatch.js — Carlos 工作流：四段合同 prompt / 文件快照 / opencode 子进程（Node ESM）
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
    fs.appendFileSync(path.join(bdir, "manifest.jsonl"), lines, "utf8");
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
