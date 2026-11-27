#!/usr/bin/env node
// Carlos MCP 快速客户端 — 自包含，自动管理 Bridge 生命周期
// 用法: node carlos.js <tool_name> [json_args]
//        node carlos.js init --target generic
// 首次调用自动启动 Bridge，后续直连复用

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, rmSync, lstatSync, openSync, closeSync, fstatSync, fsyncSync, renameSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, join, dirname, isAbsolute, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

// 状态/审计根目录默认值：与 src/state.js 的 FLOW_HOME 保持一致（跨平台）
const DEFAULT_FLOW_HOME = join(os.homedir(), ".carlos-flow");

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "19099", 10);
// 优先用环境变量；否则从脚本位置推导包根目录（client/ 同级）
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CARLOS_FLOW_MCP_ROOT || resolve(SCRIPT_DIR, "..");
const ROOT_ABS = resolve(ROOT);
// Bridge 脚本位置：优先 bridge/mcp-bridge.js（发布版布局），回退到根目录 mcp-bridge.js（扁平布局）
const BRIDGE_SCRIPT = [
  ROOT_ABS + "/bridge/mcp-bridge.js",
  ROOT_ABS + "/mcp-bridge.js",
].find((p) => existsSync(p)) || ROOT_ABS + "/bridge/mcp-bridge.js";
const MCP_SERVER = ROOT_ABS + "/src/index.js";
// PID 文件按端口区分：多 Bridge 并存（测试用独立端口）时不会互相覆盖
const PID_FILE = ROOT_ABS + "/bridge-" + BRIDGE_PORT + ".pid";

// ===== 平台接入注册表（仅 Windows 实测路径）=====
// format 决定能否直接写入：
//   strict — 严格 JSON，且容器内是标准 {command,args} 结构，可安全增量合并
//   jsonc  — 允许注释/尾逗号，按 JSON 重写会破坏原格式，只提示不写
//   toml   — 非 JSON，不能按 JSON 写入
//   other  — 自有 schema（如 OpenCode 的 type/command 数组），与标准结构不同
const appDataDir = () => process.env.APPDATA || join(os.homedir(), "AppData", "Roaming");
const PLATFORM_REGISTRY = [
  { id: "cursor", label: "Cursor（全局）", path: () => join(os.homedir(), ".cursor", "mcp.json"), container: "mcpServers", format: "strict" },
  { id: "claude-desktop", label: "Claude Desktop", path: () => join(appDataDir(), "Claude", "claude_desktop_config.json"), container: "mcpServers", format: "strict" },
  { id: "windsurf", label: "Windsurf / Devin", path: () => join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"), container: "mcpServers", format: "strict" },
  { id: "workbuddy", label: "WorkBuddy", path: () => join(os.homedir(), ".workbuddy", "mcp.json"), container: "mcpServers", format: "strict" },
  { id: "trae", label: "Trae", path: () => join(appDataDir(), "Trae", "User", "mcp.json"), container: "mcpServers", format: "strict" },
  { id: "trae-cn", label: "Trae CN", path: () => join(appDataDir(), "Trae CN", "User", "mcp.json"), container: "mcpServers", format: "strict" },
  { id: "qoder", label: "Qoder", path: () => join(appDataDir(), "Qoder", "User", "mcp.json"), container: "mcpServers", format: "strict" },
  { id: "vscode", label: "VS Code（mcp.json）", path: () => join(appDataDir(), "Code", "User", "mcp.json"), container: "servers", format: "strict" },
  { id: "cline", label: "Cline（VS Code 扩展）", path: () => join(appDataDir(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), container: "mcpServers", format: "strict" },
  { id: "vscode-settings", label: "VS Code settings.json", path: () => join(appDataDir(), "Code", "User", "settings.json"), format: "jsonc", reason: "VS Code settings.json 允许注释与尾逗号（JSONC），按 JSON 重写会破坏原格式" },
  { id: "cursor-settings", label: "Cursor settings.json", path: () => join(appDataDir(), "Cursor", "User", "settings.json"), format: "jsonc", reason: "Cursor settings.json 同属 JSONC，按 JSON 重写会破坏原格式" },
  { id: "codex", label: "Codex CLI", path: () => join(os.homedir(), ".codex", "config.toml"), format: "toml", reason: "Codex 使用 TOML 配置，不能按 JSON 写入" },
  { id: "opencode", label: "OpenCode", path: () => join(os.homedir(), ".config", "opencode", "opencode.json"), format: "other", reason: "OpenCode 使用自有 mcp 结构（type + command 数组），与标准 mcpServers 不同" },
];
// 实际使用的 bridge 端口：pickBridgePort 选定后写入，后续 callMCP 一律用它。
// 早先 callMCP 写死 BRIDGE_PORT，而 bridge 可能起在别的端口 → 连不上。
let ACTIVE_PORT = BRIDGE_PORT;
const BRIDGE_TOKEN_FILE = () => join(DEFAULT_FLOW_HOME, "bridge-token");

// 读取或生成 Bridge token。
//
// 早先这里是 `process.env.CARLOS_BRIDGE_TOKEN || "carlos-local-token-2026"` ——
// 一个**硬编码的默认值**。任何本机进程都知道这个字符串，都能连上本机 bridge
// （虽然只监听 127.0.0.1，但「本机任意进程可连」本身就是一道没关的门），
// 而且它与 bridge 侧的 fail-closed 行为不一致（bridge 没设环境变量就拒绕）。
//
// 现在：
//   1) 优先用环境变量 CARLOS_BRIDGE_TOKEN；
//   2) 没有则首次运行生成随机 token 落到 $CARLOS_FLOW_HOME/bridge-token（0600），
//      之后跨进程复用同一个（client 与 bridge 必须用同一把钥匙）；
//   3) 文件权限设 0600（POSIX）；Windows 上靠 ACL 默认保护。
//
// 这样既没有硬编码默认值，也不需要用户手工配置环境变量。
function resolveBridgeToken() {
  const fromEnv = process.env.CARLOS_BRIDGE_TOKEN;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();

  const file = BRIDGE_TOKEN_FILE();
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim();
      if (t.length >= 32) return t;
    }
  } catch { /* 读不到 → 重新生成 */ }

  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // 落盘失败（只读 HOME 等）→ 退化为进程级临时 token：
    // 本进程内 client 与 bridge 仍然一致，只是重启后失效。
  }
  return token;
}

const BRIDGE_TOKEN = process.argv[2] === "init" ? undefined : resolveBridgeToken();

// 智能触发引擎（本文件是 ESM，必须用动态 import；require 在 ESM 中不存在）
// 加载失败时降级为「不触发」，不影响主流程
let TriggerEngine = null;
try {
  if (process.argv[2] !== "init") {
    const triggerMod = await import(pathToFileURL(join(ROOT_ABS, "src", "trigger.js")).href);
    TriggerEngine = triggerMod.TriggerEngine || null;
  }
} catch (e) {
  TriggerEngine = null;
}

const toolName = process.argv[2];
const argsJson = process.argv[3] || "{}";

// 测试会自动生成大量会话。这些前缀是「机器造的」，与真实使用可可靠区分，
// clean 命令默认只动它们。
const TEST_SESSION_PREFIXES = ["e2e-", "p0-", "probe-", "guide-", "test-", "smoke-", "unknown"];

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += statSync(full).size; } catch {} }
    }
  };
  walk(p);
  return total;
}

/**
 * 清理测试残留会话（gate-state/runs/<sid>）。
 *
 * 绝不删除 gate-audit：审计是逐日哈希链，删一天就断链，
 * 「谁在什么时候批了什么」就永久查不回来了 —— 这不是磁盘占用问题，是可信度问题。
 */
function runClean(opts) {
  const runsDir = join(process.env.CARLOS_FLOW_HOME || DEFAULT_FLOW_HOME, "gate-state", "runs");
  if (!existsSync(runsDir)) {
    console.log("没有需要清理的会话目录（" + runsDir + " 不存在）");
    return { ok: true };
  }
  const now = Date.now();
  const cutoff = opts.olderThanDays > 0 ? now - opts.olderThanDays * 86400_000 : 0;
  const isTest = (name) => (opts.prefixes ? opts.prefixes.some((p) => name === p || name.startsWith(p)) : true);

  let names = [];
  try {
    names = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    console.error("读取会话目录失败：" + e.message);
    return { ok: false };
  }

  const targets = [];
  const kept = [];
  for (const n of names) {
    const full = join(runsDir, n);
    let mtimeMs = 0;
    try { mtimeMs = statSync(full).mtimeMs; } catch {}
    const oldEnough = !cutoff || mtimeMs < cutoff;
    if (isTest(n) && oldEnough) targets.push({ name: n, full, size: dirSize(full) });
    else kept.push(n);
  }

  const totalBytes = targets.reduce((s, t) => s + t.size, 0);
  const mb = (n) => (n / 1048576).toFixed(1) + " MB";

  console.log("════ 会话清理" + (opts.apply ? "（执行模式）" : "（预览模式，不会删任何东西）") + " ════");
  console.log("  会话目录: " + runsDir);
  console.log("  总会话数: " + names.length);
  console.log("  待清理  : " + targets.length + " 个测试残留，共 " + mb(totalBytes));
  console.log("  保留    : " + kept.length + " 个（真实会话 + 不匹配前缀的）");
  if (targets.length > 0) {
    const sample = targets.slice(0, 5).map((t) => t.name).join(", ");
    console.log("  样例    : " + sample + (targets.length > 5 ? " …" : ""));
  }
  console.log("  注意    : 审计流水（gate-audit）永远不会被删 —— 它是哈希链，断一天就查不回去了");

  if (!opts.apply) {
    console.log("\n确认无误后加 --apply 真正执行：");
    console.log("  node carlos.js clean --apply");
    console.log("只清更早的：  node carlos.js clean --apply --older-than 7");
    return { ok: true };
  }

  let removed = 0, reclaimed = 0, failed = 0;
  for (const t of targets) {
    try {
      rmSync(t.full, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed++; reclaimed += t.size;
    } catch {
      failed++;
    }
  }
  console.log("\n✅ 已删除 " + removed + " 个会话，释放 " + mb(reclaimed) + (failed ? "；失败 " + failed + " 个（可能被占用）" : ""));
  if (failed) console.log("   补充：关闭占用这些目录的进程后重跑即可。");
  return { ok: failed === 0 };
}

// ===== init 命令：一键生成宿主配置 =====
if (toolName === "init") {
  try { runInit(); } catch (error) {
    console.error("初始化拒绝：" + error.message + "；请使用 --target generic 导出并手工核对。");
    process.exit(1);
  }
  process.exit(0);
}

if (toolName === "clean") {
  // 清理命令（不需要 bridge / MCP）：轻量化的运维入口。
  //
  // 背景（2026-11-17 实测）：840 个会话目录里 587 个是测试残留，18MB。
  // 以前没有任何清理手段，只能人工进目录删。
  //
  // 安全口径：
  //   · 默认**只列不删**（dry-run），必须显式 --apply 才真的删
  //   · 默认只动**测试前缀**的会话（e2e-/p0-/probe-/guide-/test-/smoke-），
  //     真实会话（root-/maint-/audit-/用户自起名）一律不碰
  //   · **绝不删除 gate-audit**：审计是哈希链，删一天就断链，追溯能力就没了
  const opts = { apply: false, prefixes: TEST_SESSION_PREFIXES, olderThanDays: 0 };
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--all") opts.prefixes = null; // 危险：连真实会话一起列（仍默认不删）
    else if (a === "--older-than") opts.olderThanDays = Number(process.argv[++i]) || 0;
    else if (a === "--prefix") opts.prefixes = [String(process.argv[++i] || "").trim()].filter(Boolean);
  }
  const r = runClean(opts);
  process.exit(r.ok ? 0 : 1);
}

if (!toolName) {
  console.error("用法: node carlos.js <工具名> [json参数]");
  console.error("      node carlos.js clean [--apply] [--older-than 7]   清理测试残留会话（默认只列不删）");
  console.error("      node carlos.js init --target cindy|opencode|cursor|cline|vscode|claude|workbuddy|codex|trae|qoder");
  console.error("");
  console.error("最常用的三个工具（其余见 flow_protocol）：");
  console.error("  flow_status     看当前进度：有没有任务卡、走到哪一步、下一步该做什么");
  console.error("  flow_trigger_check  判断这句话该不该启动工作流（智能激活）");
  console.error("  flow_bypass     临时跳过审查（需 confirmed:true）");
  process.exit(1);
}

let args;
try { args = JSON.parse(argsJson); } catch (e) { console.error("JSON 解析失败:", e.message); process.exit(1); }

/**
 * 智能触发检查
 * 在调用 MCP 之前，检查是否应该触发工作流
 */
async function checkTrigger(message = '') {
  if (!TriggerEngine) {
    return { triggered: false, reason: '触发引擎未加载' };
  }

  // 没有显式传入用户原话 → 不启用触发（不评分、不动作）
  if (!message || String(message).trim() === '') {
    return { triggered: false, reason: '未提供 triggerMessage，不启用自动触发' };
  }

  const sessionId = args.sessionId || 'default';

  try {
    const result = TriggerEngine.processUserMessage(message, {
      sessionId,
      complexity: args.complexity || 1.0
    });

    if (!result.shouldTrigger) {
      // 未达触发阈值：只如实报告评分，不做任何动作
      if (result.decision === 'review' || result.decision === 'throttled') {
        console.error(`[Carlos Trigger] 未激活（${result.decision}）：评分 ${result.score} · 置信度 ${result.confidence} · ${result.reason}`);
      }
      return { triggered: false, result };
    }

    console.error(`[Carlos Trigger] 判定触发：评分 ${result.score} · 置信度 ${result.confidence}`);

    const plan = result.activationPlan;
    if (!plan || !plan.activated) {
      return { triggered: true, result };
    }

    if (result.action && result.action.recommendedAction !== 'auto') {
      // manual 档：只给出建议，不自动执行
      console.error('[Carlos Trigger] 建议手动启动门禁（未达自动激活阈值）');
      console.error(plan.prompt);
      return { triggered: true, result, plan, autoTrigger: false };
    }

    // ---- 自动激活：执行激活计划中参数完整的步骤 ----
    const executed = [];
    for (const step of plan.steps) {
      if (!step.auto) continue;

      // 安全约束：会话已有卡片时，不自动开卡（避免覆盖用户已有任务）
      if (step.tool === 'flow_submit_requirement') {
        const st = await callMCP('tools/call', { name: 'flow_status', arguments: { sessionId } });
        const statusText = st.result?.content?.[0]?.text || '';
        let hasCard = false;
        try { hasCard = JSON.parse(statusText).has_card === true; } catch {}
        if (hasCard) {
          console.error('[Carlos Trigger] 会话已有任务卡，跳过自动开卡（不覆盖已有任务）');
          break;
        }
      }

      try {
        const r = await callMCP('tools/call', { name: step.tool, arguments: step.args });
        const isErr = r.result?.isError === true;
        const txt = r.result?.content?.[0]?.text || '';
        if (isErr) {
          console.error(`[Carlos Trigger] 激活步骤 ${step.tool} 失败：${txt.split('\\n')[0]}`);
        } else {
          executed.push(step.tool);
          console.error(`[Carlos Trigger] 已执行激活步骤：${step.tool}（${step.reason}）`);
        }
      } catch (e) {
        console.error(`[Carlos Trigger] 激活步骤 ${step.tool} 异常：${e.message}`);
      }
    }

    console.error('');
    console.error(plan.prompt);
    console.error('');

    return { triggered: true, result, plan, autoTrigger: true, executed };
  } catch (e) {
    console.error('[Carlos Trigger] 触发检查失败:', e.message);
    return { triggered: false, error: e.message };
  }
}

// 路径归一化比较：判断两个路径是否指向同一个目录。
// 为什么要归一化：同一个目录在不同环境下可能是 POSIX 形式（Git Bash 的 /tmp/x）、
// Windows 形式、带不带尾斜杠、大小写差异 —— 直接字符串比较会把
// 「同一个目录」判成「不同身份」，于是永远不复用、每次都另起一个 bridge。
function samePath(a, b) {
  if (!a || !b) return true;          // 对方没报 → 不以此为拒理由
  const norm = (p) => {
    try {
      let s = resolve(String(p));
      // 去掉尾分隔符（根目录除外）
      if (s.length > 1) s = s.replace(/[\\/]+$/, "");
      return process.platform === "win32" ? s.toLowerCase() : s;
    } catch {
      return String(p);
    }
  };
  return norm(a) === norm(b);
}

// 检查 bridge 是否已在运行（先读 PID，再 TCP 探测）
function isBridgeRunning(port = BRIDGE_PORT) {
  return new Promise((resolve) => {
    // 先检查 PID 文件
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
        if (pid && pid !== process.pid) {
          try { process.kill(pid, 0); } catch {
            // 进程不存在，清理 PID 文件
            try { unlinkSync(PID_FILE); } catch {}
            // 继续 TCP 探测
          }
        }
      } catch {}
    }

    // TCP 探测
    const s = createConnection(port, "127.0.0.1");
    s.on("connect", () => {
      // 发送健康检查
      s.write("GET /health\n");
    });
    s.on("data", (data) => {
      const resp = data.toString().trim();
      try {
        const json = JSON.parse(resp);
        if (json.status !== "ok") { s.end(); resolve(false); return; }
        // ⚠️ 身份校验：端口上跑的 bridge 必须是**我这份代码 + 我这个 HOME**。
        //
        // 早先只判 status==ok 就复用 —— 于是端口上是**另一个 ROOT** 的 bridge 时
        // （比如开发机上的旧仓库那份），本进程会静默连过去：
        //   · 它启动时的 CARLOS_FLOW_HOME 生效 → 本次传入的 HOME 完全失效，
        //     状态/审计写到**别人的目录**（测试污染生产状态的真凶）；
        //   · 协议/版本可能不匹配 → 调用挂死。
        // 现在比对 root 与 flow_home，不符就当“未运行”，另起一个自己的 bridge。
        //
        // 路径必须**归一化**后再比：同一个目录在不同环境下可能是
        // POSIX 形式（Git Bash：/tmp/x）、Windows 形式（D:\\x）、带不带尾斜杠、
        // 大小写差异 —— 直接字符串比较会把「同一个目录」判成「不同身份」，
        // 于是永远不复用、每次都另起一个 bridge。
        const sameRoot = samePath(json.root, ROOT_ABS);
        const wantHome = process.env.CARLOS_FLOW_HOME || DEFAULT_FLOW_HOME;
        const sameHome = samePath(json.flow_home, wantHome);
        if (!sameRoot || !sameHome) {
          s.end();
          resolve(false);
          return;
        }
        s.end();
        resolve(true);
        return;
      } catch {}
      s.end();
      // 健康检查失败但端口存活，也算运行中
      resolve(true);
    });
    s.on("error", () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
}

// 找一个能用的端口。
//
// 首选 BRIDGE_PORT；若该端口已被**另一个身份的 bridge** 占用，
// 则向上探测若干个端口另起一个 —— 不能硬挤同一端口：
// 挤不进去时 spawn 会失败或挂死（实测客户端因此超时挂死 30s）。
async function pickBridgePort() {
  for (let i = 0; i < 20; i++) {
    const port = BRIDGE_PORT + i;
    // 端口空闲 → 直接用
    const busy = await new Promise((res) => {
      const s = createConnection(port, "127.0.0.1");
      s.on("connect", () => { s.end(); res(true); });
      s.on("error", () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 800);
    });
    if (!busy) return port;
    // 端口被占 → 若是**同身份**的 bridge，直接复用
    if (await isBridgeRunning(port)) return port;
  }
  return BRIDGE_PORT;
}

// 自动启动 bridge（后台常驻）
function startBridge(port = BRIDGE_PORT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, String(port)], {
      // 后台桥接不能把日志管道留给会正常退出的启动客户端，否则后续写入会触发 EPIPE。
      // 此处不建立常驻日志服务：桥接及其服务端的详细标准错误将被丢弃；启动失败与超时仍由客户端报告。
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        CARLOS_BRIDGE_TOKEN: BRIDGE_TOKEN,
        // Bridge 需要用它定位 MCP server 与 pid 文件；未设置时 bridge 会拼出 undefined/src/index.js
        CARLOS_FLOW_MCP_ROOT: ROOT_ABS,
        // 状态/审计根目录：注入后由 bridge → MCP server 逐级继承
        CARLOS_FLOW_HOME: process.env.CARLOS_FLOW_HOME || DEFAULT_FLOW_HOME,
      },
    });
    child.unref();

    // 写入 PID 文件（按**实际使用的端口**命名，避免多实例互相覆盖）
    try { writeFileSync(join(ROOT_ABS, `bridge-${port}.pid`), String(child.pid), "utf8"); } catch {}

    // 等待 bridge 就绪：用轻量健康检查端点，不占用 MCP 的 initialize 握手
    // （否则同一 MCP server 会被握手两次，导致首次调用挂起）
    const check = setInterval(async () => {
      const ready = await new Promise((res) => {
        const s = createConnection(port, "127.0.0.1");
        let buf = "";
        s.on("connect", () => { s.write("GET /health\n"); });
        s.on("data", (data) => {
          buf += data.toString();
          try {
            const resp = JSON.parse(buf.trim());
            if (resp.status === "ok") { s.end(); res(true); }
          } catch {}
        });
        s.on("error", () => res(false));
        setTimeout(() => { s.destroy(); res(false); }, 1000);
      });
      if (ready) { clearInterval(check); resolve(true); }
    }, 500);

    setTimeout(() => {
      clearInterval(check);
      reject(new Error("Bridge 启动超时 (10s)"));
    }, 10000);

    child.on("error", (e) => {
      clearInterval(check);
      reject(new Error("Bridge 启动失败: " + e.message));
    });
  });
}

// 通过 bridge 调用 MCP
function callMCP(method, params) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(ACTIVE_PORT, "127.0.0.1");
    let buf = "";
    const reqId = Math.floor(Math.random() * 100000000) + 2;
    let resolved = false;

    // 超时必须大于服务端的最长执行时间：
    //   · flow_run_verify 的服务端超时是 120s（verify.cmd 真实执行）
    //   · 其余工具都是毫秒级
    // 旧实现统一用 5s —— 结果是 CLI 调 flow_run_verify 永远超时失败，
    // 而 MCP server 那边还在正常跑命令，用户只看到「超时」看不到真实退出码。
    const timeoutMs = Number(process.env.CARLOS_MCP_TIMEOUT_MS) || 180000;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; socket.destroy(); reject(new Error(`超时 (${Math.round(timeoutMs / 1000)}s)`)); }
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params: { ...params, _token: BRIDGE_TOKEN } }) + "\n");
    });

    socket.on("data", (data) => {
      buf += data.toString("utf8");
      const lines = buf.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t) continue;
        try {
          const resp = JSON.parse(t);
          if (resp.jsonrpc === "2.0" && resp.id === reqId) {
            if (!resolved) { resolved = true; clearTimeout(timer); socket.destroy(); resolve(resp); }
            return;
          }
        } catch {}
      }
    });

    socket.on("error", (e) => {
      if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error("连接失败: " + e.message)); }
    });

    socket.on("close", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error("连接已关闭")); }
    });
  });
}

// ===== init 命令实现 =====
// 初始化入口不访问Bridge。旧模板实现保留为未调用兼容参考，禁止从入口派发。
function runInit() {
  const opts = {};
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--all') { opts.all = true; continue; }
    if (key === '--discover') { opts.discover = true; continue; }
    if (!['--target', '--file', '--path', '--container'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(opts, key)) throw new Error('未知、重复或缺值参数：' + key);
    opts[key] = args[++i];
  }
  const sameIdentity = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs);
  const inspect = (file, expectedParents) => {
    let current = resolve(file), leaf = null;
    const parents = new Map();
    for (;;) {
      try {
        const s = lstatSync(current);
        if (s.isSymbolicLink()) throw new Error('拒绝链接：' + current);
        if (current === resolve(file)) { if (!s.isFile()) throw new Error('目标不是普通文件'); leaf = s; }
        else {
          if (!s.isDirectory()) throw new Error('父路径不是目录');
          parents.set(current, s);
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
    if (expectedParents) for (const [name, old] of expectedParents) {
      if (!sameIdentity(parents.get(name), old)) throw new Error('父目录链在合并期间变化');
    }
    return { leaf, parents };
  };
  // 在resolve消除“链接/..”之前检查原始路径经过的每一段。
  const inspectRaw = (file) => {
    const absolute = isAbsolute(file) ? file : process.cwd() + '/' + file;
    let prefix = parse(absolute).root;
    for (const part of absolute.slice(prefix.length).split(/[\\/]/)) {
      if (!part) continue;
      prefix += '/' + part;
      try { if (lstatSync(prefix).isSymbolicLink()) throw new Error('拒绝链接路径：' + prefix); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  };
  const publish = (file, content, old, bytes, expectedParents) => {
    const before = inspect(file, expectedParents);
    mkdirSync(dirname(file), { recursive: true });
    const parents = inspect(file, before.parents).parents;
    const lock = file + '.carlos-init.lock';
    const temp = file + '.carlos-' + randomBytes(12).toString('hex') + '.tmp';
    let fd, lockFd, tempIdentity, lockIdentity, primaryError;
    const cleanupFailures = [];
    const attemptCleanup = (stage, action) => {
      try { action(); } catch (error) { cleanupFailures.push({ stage, error }); }
    };
    const noFollow = constants.O_NOFOLLOW || 0;
    const cleanOwned = (name, identity) => {
      if (!identity) return;
      // 目录被替换后宁留现场，不沿攻击者的新路径清理文件。
      inspect(file, parents);
      let now;
      try { now = lstatSync(name); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      if (!sameIdentity(now, identity) || now.isSymbolicLink()) throw new Error('临时文件身份变化，停止清理');
      unlinkSync(name);
    };
    try {
      // 独占锁阻止本工具并发发布；它不是对同权限恶意进程的系统级沙箱。
      lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      lockIdentity = fstatSync(lockFd);
      inspect(file, parents);
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, old ? old.mode & 0o777 : 0o600);
      tempIdentity = fstatSync(fd);
      writeFileSync(fd, content); fsyncSync(fd);
      // 交出一次性关闭责任后再调用API；失败时也不能重试可能已被系统复用的描述符。
      const closingFd = fd; fd = undefined; closeSync(closingFd);
      const now = inspect(file, parents).leaf;
      if (old) {
        if (!sameIdentity(now, old) || now.mtimeMs !== old.mtimeMs || now.ctimeMs !== old.ctimeMs || now.size !== old.size) throw new Error('合并期间文件变化');
        const checkFd = openSync(file, constants.O_RDONLY | noFollow);
        let checkError;
        try {
          if (!sameIdentity(fstatSync(checkFd), old) || !readFileSync(checkFd).equals(bytes)) throw new Error('合并期间文件内容变化');
        } catch (error) { checkError = error; throw error; }
        finally {
          try { closeSync(checkFd); } catch (error) {
            if (!checkError) throw error;
            cleanupFailures.push({ stage: '关闭复核文件', error });
          }
        }
      } else if (now) throw new Error('目标已被并发创建，拒绝覆盖');
      inspect(file, parents);
      if (!sameIdentity(lstatSync(temp), tempIdentity)) throw new Error('临时文件身份变化');
      renameSync(temp, file);
      tempIdentity = undefined;
      inspect(file, parents);
    } catch (error) { primaryError = error; }
    finally {
      const closingFd = fd; fd = undefined;
      const closingLockFd = lockFd; lockFd = undefined;
      if (closingFd !== undefined) attemptCleanup('关闭临时文件', () => closeSync(closingFd));
      if (closingLockFd !== undefined) attemptCleanup('关闭独占锁', () => closeSync(closingLockFd));
      attemptCleanup('清理临时文件', () => cleanOwned(temp, tempIdentity));
      attemptCleanup('清理独占锁', () => cleanOwned(lock, lockIdentity));
    }
    if (cleanupFailures.length) {
      console.error('初始化清理附加信息：' + JSON.stringify(cleanupFailures.map(({ stage, error }) => ({ stage, code: error.code, message: error.message }))));
      if (!primaryError) primaryError = cleanupFailures[0].error;
    }
    if (primaryError) throw primaryError;
  };
  const merge = (file, container) => {
    if (!['mcpServers', 'servers'].includes(container)) throw new Error('必须显式指定容器mcpServers或servers');
    if (!file.endsWith('.json')) throw new Error('仅接受严格JSON，不处理JSONC/TOML/YAML');
    inspectRaw(file);
    file = resolve(file);
    const { leaf: old, parents } = inspect(file);
    let bytes, value = {};
    if (old) {
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let readError;
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || !sameIdentity(s, old)) throw new Error('读取时文件身份变化');
        bytes = readFileSync(fd);
        inspect(file, parents);
      } catch (error) { readError = error; }
      finally {
        try { closeSync(fd); } catch (error) {
          console.error('初始化清理附加信息：' + JSON.stringify([{ stage: '关闭旧配置', code: error.code, message: error.message }]));
          if (!readError) readError = error;
        }
      }
      if (readError) throw readError;
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON根必须为对象');
    if (Object.hasOwn(value, container) && (!value[container] || typeof value[container] !== 'object' || Array.isArray(value[container]))) throw new Error('容器必须为对象');
    const services = value[container] || {};
    if (!Object.hasOwn(services, 'carlos-flow')) {
      value[container] = { ...services, 'carlos-flow': { command: process.execPath, args: [join(ROOT_ABS, 'src', 'index.js')] } };
      publish(file, JSON.stringify(value, null, 2) + '\n', old, bytes, parents);
    }
    return value;
  };
  // 只读扫描：仅 lstat/read，不创建任何目录、不改任何文件
  const scanPlatforms = () => PLATFORM_REGISTRY.map((p) => {
    const file = p.path();
    let installed = false, readable = false;
    try { const s = lstatSync(file); installed = s.isFile() && !s.isSymbolicLink(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (installed) { try { readFileSync(file); readable = true; } catch { readable = false; } }
    return { id: p.id, label: p.label, path: file, installed, readable, format: p.format, injectable: installed && p.format === 'strict', note: p.format === 'strict' ? undefined : p.reason };
  });
  const platformSnippet = (p) => ({ [p.container || 'mcpServers']: { 'carlos-flow': { command: process.execPath, args: [join(ROOT_ABS, 'src', 'index.js')] } } });
  // 单平台接入：文件不存在→不猜路径不创建；非严格JSON→只输出片段；严格JSON→复用 merge 增量注入
  const injectPlatform = (p) => {
    const file = p.path();
    let s = null;
    try { s = lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!s) return { id: p.id, path: file, status: 'not_installed', note: '未检测到配置文件，不创建平台目录、不猜路径' };
    if (s.isSymbolicLink() || !s.isFile()) throw new Error(`${p.label} 配置不是可信普通文件，拒绝写入：${file}`);
    if (p.format !== 'strict') return { id: p.id, path: file, status: 'deferred', note: p.reason, snippet: platformSnippet(p) };
    return { id: p.id, path: file, status: 'injected', config: merge(file, p.container) };
  };
  if (opts.discover) {
    if (opts['--target'] || opts['--file'] || opts['--path'] || opts['--container'] || opts.all) throw new Error('--discover 不可混合其他参数');
    console.log(JSON.stringify({ platforms: scanPlatforms() }, null, 2));
    return;
  }
  const target = opts['--target'] || process.env.CARLOS_INIT_TARGET || (opts.all ? 'generic' : '');
  if (opts.all && (opts['--target'] || opts['--file'] || opts['--path'] || opts['--container'])) throw new Error('--all不可混合自定义参数');
  if (opts['--file'] && opts['--path'] && opts['--file'] !== opts['--path']) throw new Error('文件别名参数冲突');
  let exported;
  if (['custom-file', 'custom-path'].includes(target)) {
    const file = opts['--file'] || opts['--path'];
    if (!file) throw new Error('必须显式指定--file或--path');
    exported = merge(file, opts['--container']);
  } else {
    if (opts['--file'] || opts['--path'] || opts['--container']) throw new Error('自定义参数须用于custom-file/custom-path');
    if (!['generic', 'cursor', 'cindy', 'opencode', 'vscode', 'cline', 'claude', 'claude-code', 'workbuddy', 'codex', 'trae', 'qoder'].includes(target) && !PLATFORM_REGISTRY.some((p) => p.id === target)) throw new Error('用法：init --target generic，或custom-file --file 配置.json --container mcpServers');
    if (opts.all || target === 'cursor') {
      const marker = resolve('.cursor');
      try {
        const s = lstatSync(marker);
        if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('Cursor标记不是可信普通目录');
        merge(join(marker, 'mcp.json'), 'mcpServers');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    exported = merge(resolve('carlos-mcp.json'), 'mcpServers');
    const rules = '# AI开发约束\n\n仅作提示，不替代门禁，也不保证宿主自动读取。修改前明确范围；真实执行验证；未经用户授权不提交、不发布。\n';
    for (const name of ['AGENTS.md', 'AI-DEV-CONSTRAINTS.md']) {
      const file = resolve(name);
      if (!inspect(file).leaf) publish(file, rules);
    }
    const reg = PLATFORM_REGISTRY.find((p) => p.id === target);
    if (reg) {
      // 先装平台后装 Carlos：直接按注册表定位该平台已有配置并接入
      const r = injectPlatform(reg);
      exported = { exported, platform: r };
      if (r.status === 'deferred') console.error(`${reg.label} 降级为手工导入：${r.note}。已输出片段，未改动原文件。`);
      else if (r.status === 'not_installed') console.error(`${reg.label} 未安装（未找到 ${r.path}），已改为通用导出；不会创建平台目录。`);
    } else if (target !== 'generic') {
      console.error('该目标未纳入已核验平台注册表，已导出通用stdio配置，请按官方文档手工导入。');
    }
    if (opts.all) {
      // 先装平台后装 Carlos：扫描本机已装平台，仅对严格 JSON 平台增量注入
      const results = [];
      for (const p of PLATFORM_REGISTRY) {
        let hit = null;
        try { const s = lstatSync(p.path()); hit = s.isFile() && !s.isSymbolicLink() ? p : { unsafe: p }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (!hit) { results.push({ id: p.id, path: p.path(), status: 'not_installed' }); continue; }
        if (hit.unsafe) { results.push({ id: p.id, path: p.path(), status: 'refused', note: '不是可信普通文件' }); continue; }
        try {
          const r = injectPlatform(p);
          results.push({ id: p.id, path: p.path(), status: r.status, note: r.note });
        } catch (error) {
          results.push({ id: p.id, path: p.path(), status: 'failed', error: error.message });
        }
      }
      console.error('平台扫描结果：' + JSON.stringify(results.filter((r) => r.status !== 'not_installed')));
      exported = { exported, platforms: results };
    }
  }
  console.log(JSON.stringify(exported, null, 2));
}

async function legacyInitTemplateReference(target) {
  const home = resolve(os.homedir());
  
  // 通用：先生成触发器配置
  const flowHome = process.env.CARLOS_FLOW_HOME || join(home, ".carlos-flow");
  mkdirSync(flowHome, { recursive: true });
  const tcPath = join(flowHome, "trigger-config.json");
  if (!existsSync(tcPath)) {
    const tcTemplate = readFileSync(resolve(ROOT_ABS, "trigger-config.usable.json"), "utf8");
    writeFileSync(tcPath, tcTemplate, "utf8");
    console.log(`✅ 触发器配置已写入: ${tcPath}`);
  }
  
  // --- __ROOT__ 渲染：必须按目标格式转义 ---
  //
  // 背景（2026-11-13 实测）：旧实现直接 `.replace(/__ROOT__/g, ROOT_ABS)`，
  // 把 Windows 路径的**原始反斜杠**嵌进 JSON 模板，产出
  //   "D:\dev-env\node-v22.23.4-win-x64\node_modules\carlos-flow/bridge/mcp-bridge.js"
  // 其中 `\d` `\n` `\v` 都是**非法 JSON 转义序列** —— 文件根本解析不了，
  // 表现为「安装成功但插件不出现」，而且任何 JSON 解析器都报同一个位置。
  //
  // 两种目标格式要分别处理：
  // - JSON（ghost.json / mcp.json / opencode.json）：必须 JSON 转义（反斜杠 → \\）
  // - YAML（.mcprc）：Windows 路径一律用正斜杠（反斜杠在 YAML 双引号标量里同样非法）
  // 把包内相对入口（entry / node.entry / node.entries[] / settingsHtml / icon）渲染成绝对路径。
  //
  // 为什么需要：ghost.json 现在是**包清单**（chip 形态，包里全是相对路径），而
  // `init --target cindy` 只复制清单文件、不复制目录结构 —— 相对路径在
  // ~/.cindy/ghosts/ 下没有包根可参照，插件会起不来。这里渲染成绝对路径，
  // 保证「开发直连仓库」这条路继续可用。
  function renderRelativeEntries(text, rootAbs) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return text; // 已经是非法 JSON 就别再动它，交给门禁去报
    }
    const toAbs = (rel) => {
      if (typeof rel !== "string" || rel === "") return rel;
      const normalized = rel.replace(/\\/g, "/");
      if (/^([A-Za-z]:[\\/]|[\\/]|https?:)/.test(normalized)) return normalized;
      return join(rootAbs, normalized);
    };
    obj.entry = toAbs(obj.entry);
    if (obj.settingsHtml) obj.settingsHtml = toAbs(obj.settingsHtml);
    if (obj.icon) obj.icon = toAbs(obj.icon);
    if (obj.node && typeof obj.node === "object") {
      obj.node.entry = toAbs(obj.node.entry);
      if (Array.isArray(obj.node.entries)) obj.node.entries = obj.node.entries.map(toAbs);
    }
    return JSON.stringify(obj, null, 2) + "\n";
  }

  const rootJson = JSON.stringify(ROOT_ABS).slice(1, -1);
  const rootYaml = ROOT_ABS.replace(/\\/g, "/");

  if (target === "cindy") {
    // --- Cindy: 生成 ghost.json 到 ~/.cindy/ghosts/ ---
    const ghostsDir = join(home, ".cindy", "ghosts");
    mkdirSync(ghostsDir, { recursive: true });
    const ghostPath = join(ghostsDir, "carlos-flow.json");

    const ghostTemplate = readFileSync(resolve(ROOT_ABS, "ghost.json"), "utf8");
    const ghostContent = renderRelativeEntries(ghostTemplate.replace(/__ROOT__/g, rootJson), ROOT_ABS);
    writeFileSync(ghostPath, ghostContent, "utf8");
    console.log(`✅ Cindy ghost 已写入: ${ghostPath}`);
    console.log(`   重启 Cindy 后即可在侧栏看到 "Carlos 工作流" 插件`);
  } else if (target === "opencode") {
    // --- OpenCode: 生成 opencode.json 到 ~/.config/opencode/plugin/ ---
    const pluginDir = join(home, ".config", "opencode", "plugin");
    mkdirSync(pluginDir, { recursive: true });
    const pluginPath = join(pluginDir, "opencode.json");
    
    const pluginTemplate = readFileSync(resolve(ROOT_ABS, "opencode.json.template"), "utf8");
    const pluginContent = pluginTemplate.replace(/__ROOT__/g, rootJson);
    writeFileSync(pluginPath, pluginContent, "utf8");
    console.log(`✅ OpenCode 插件配置已写入: ${pluginPath}`);
    
    // 同时生成 .mcprc 到项目根目录（用户可手动复制）
    const mcprcTemplate = readFileSync(resolve(ROOT_ABS, ".mcprc.template"), "utf8");
    const mcprcContent = mcprcTemplate.replace(/__ROOT__/g, rootYaml);
    const mcprcPath = join(process.cwd(), ".mcprc");
    writeFileSync(mcprcPath, mcprcContent, "utf8");
    console.log(`✅ MCP 配置模板已写入: ${mcprcPath}`);
    console.log(`   请将其内容合并到您的项目 .mcprc 中（或直接使用该文件）`);
  } else if (target === "cursor" || target === "cline") {
    // --- Cursor / Cline / Windsurf: 生成 .cursor/mcp.json 或 .cline/mcp.json ---
    const configDir = join(process.cwd(), target === "cursor" ? ".cursor" : ".cline");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "mcp.json");
    
    const templatePath = resolve(ROOT_ABS, "templates", target, "mcp.json");
    const template = readFileSync(templatePath, "utf8");
    const content = template.replace(/__ROOT__/g, rootJson);
    writeFileSync(configPath, content, "utf8");
    console.log(`✅ ${target.charAt(0).toUpperCase() + target.slice(1)} 配置已写入: ${configPath}`);
  } else if (target === "vscode") {
    // --- VS Code (GitHub Copilot): 生成 .vscode/mcp.json ---
    const configDir = join(process.cwd(), ".vscode");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "mcp.json");
    
    const templatePath = resolve(ROOT_ABS, "templates", "vscode", "mcp.json");
    const template = readFileSync(templatePath, "utf8");
    const content = template.replace(/__ROOT__/g, rootJson);
    writeFileSync(configPath, content, "utf8");
    console.log(`✅ VS Code (Copilot) 配置已写入: ${configPath}`);
  } else if (target === "claude") {
    // --- Claude Desktop: 追加到 ~/Library/Application Support/Claude/claude_desktop_config.json ---
    let configDir;
    if (process.platform === "darwin") {
      configDir = join(home, "Library", "Application Support", "Claude");
    } else if (process.platform === "win32") {
      configDir = join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude");
    } else {
      configDir = join(home, ".config", "Claude");
    }
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "claude_desktop_config.json");
    
    let existing = {};
    if (existsSync(configPath)) {
      try { existing = JSON.parse(readFileSync(configPath, "utf8")); } catch {}
    }
    if (!existing.mcpServers) existing.mcpServers = {};
    
    const templatePath = resolve(ROOT_ABS, "templates", "claude", "claude_desktop_config.json");
    const template = JSON.parse(readFileSync(templatePath, "utf8"));
    existing.mcpServers["carlos-flow"] = template.mcpServers["carlos-flow"];
    
    // 替换 __ROOT__
    if (existing.mcpServers["carlos-flow"].args) {
      existing.mcpServers["carlos-flow"].args = existing.mcpServers["carlos-flow"].args.map(a => a.replace(/__ROOT__/g, ROOT_ABS));
    }
    if (existing.mcpServers["carlos-flow"].env) {
      for (const k of Object.keys(existing.mcpServers["carlos-flow"].env)) {
        existing.mcpServers["carlos-flow"].env[k] = existing.mcpServers["carlos-flow"].env[k].replace(/__ROOT__/g, ROOT_ABS);
      }
    }
    
    writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf8");
    console.log(`✅ Claude Desktop 配置已更新: ${configPath}`);
  } else if (target === "workbuddy") {
    // 写入腾讯 WorkBuddy 全局配置：~/.workbuddy/mcp.json
    const wbDir = join(home, ".workbuddy");
    mkdirSync(wbDir, { recursive: true });
    const wbPath = join(wbDir, "mcp.json");
    
    let existing = {};
    if (existsSync(wbPath)) {
      try { existing = JSON.parse(readFileSync(wbPath, "utf8")); } catch {}
    }
    if (!existing.mcpServers) existing.mcpServers = {};
    
    const templatePath = resolve(ROOT_ABS, "templates", "workbuddy", "mcp.json");
    const template = JSON.parse(readFileSync(templatePath, "utf8"));
    existing.mcpServers["carlos-flow"] = template.mcpServers["carlos-flow"];
    
    if (existing.mcpServers["carlos-flow"].args) {
      existing.mcpServers["carlos-flow"].args = existing.mcpServers["carlos-flow"].args.map(a => a.replace(/__ROOT__/g, ROOT_ABS));
    }
    if (existing.mcpServers["carlos-flow"].env) {
      for (const k of Object.keys(existing.mcpServers["carlos-flow"].env)) {
        existing.mcpServers["carlos-flow"].env[k] = existing.mcpServers["carlos-flow"].env[k].replace(/__FLOW_HOME__/g, flowHome).replace(/__ROOT__/g, ROOT_ABS);
      }
    }
    writeFileSync(wbPath, JSON.stringify(existing, null, 2), "utf8");
    console.log(`✅ Tencent WorkBuddy 配置已更新: ${wbPath}`);
  } else if (target === "codex") {
    // 写入 OpenAI Codex CLI 配置：~/.codex/config.toml
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, "config.toml");
    
    const templatePath = resolve(ROOT_ABS, "templates", "codex", "config.toml");
    let content = readFileSync(templatePath, "utf8");
    // TOML 格式 Windows 反斜杠需归一化为正斜杠或转义
    content = content.replace(/__ROOT__/g, rootYaml).replace(/__FLOW_HOME__/g, flowHome.replace(/\\/g, "/"));
    
    let existing = "";
    if (existsSync(codexPath)) {
      existing = readFileSync(codexPath, "utf8");
    }
    if (!existing.includes("[mcp_servers.carlos-flow]")) {
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
      writeFileSync(codexPath, existing + separator + content.trim() + "\n", "utf8");
      console.log(`✅ OpenAI Codex 配置已追加: ${codexPath}`);
    } else {
      console.log(`ℹ️ OpenAI Codex 配置中已包含 carlos-flow: ${codexPath}`);
    }
  } else if (target === "trae") {
    // 写入字节跳动 Trae 项目配置：.trae/mcp.json
    const configDir = join(process.cwd(), ".trae");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "mcp.json");
    
    const templatePath = resolve(ROOT_ABS, "templates", "trae", "mcp.json");
    const template = readFileSync(templatePath, "utf8");
    const content = template.replace(/__ROOT__/g, rootJson).replace(/__FLOW_HOME__/g, JSON.stringify(flowHome).slice(1, -1));
    writeFileSync(configPath, content, "utf8");
    console.log(`✅ ByteDance Trae 配置已写入: ${configPath}`);
  } else if (target === "qoder") {
    // 旧模板保留作迁移参考：Qoder与通义灵码不是同一产品。
    const configDir = join(process.cwd(), ".qoder");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "mcp.json");
    
    const templatePath = resolve(ROOT_ABS, "templates", "qoder", "mcp.json");
    const template = readFileSync(templatePath, "utf8");
    const content = template.replace(/__ROOT__/g, rootJson).replace(/__FLOW_HOME__/g, JSON.stringify(flowHome).slice(1, -1));
    writeFileSync(configPath, content, "utf8");
    console.log(`✅ Alibaba Qoder 配置已写入: ${configPath}`);
  }
  console.log(`\n🎉 初始化完成！现在可以使用 carlos-flow 了。`);
  console.log(`   提示: 设置环境变量 CARLOS_FLOW_HOME 可自定义状态目录（默认 ~/.carlos-flow）`);
}

// 清理「指向已死进程」的 bridge-*.pid。
//
// 背景：bridge 以前从不退出，pid 文件也没人回收，实测仓库根里积了 40 个，
// 36 个指向早已不存在的进程。那些文件除了干扰人工排查，还会让新启动的
// 客户端误以为「某个端口上有 bridge」。
// 只删**确认已死**的，活着的一个不动。返回删掉的个数。
function sweepStalePidFiles() {
  try {
    const names = readdirSync(ROOT_ABS).filter((f) => /^bridge-\d+\.pid$/.test(f));
    let removed = 0;
    for (const n of names) {
      const full = join(ROOT_ABS, n);
      let pid = 0;
      try { pid = parseInt(readFileSync(full, "utf8").trim(), 10); } catch { continue; }
      if (!pid) {
        // 内容坏了：直接删，它已经提供不了任何信息
        try { unlinkSync(full); removed++; } catch {}
        continue;
      }
      if (pid === process.pid) continue;
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) {
        try { unlinkSync(full); removed++; } catch {}
      }
    }
    if (removed > 0) process.stderr.write(`[carlos] 已清理 ${removed} 个失效的 bridge pid 文件\n`);
    return removed;
  } catch {
    return 0;
  }
}

async function main() {
  // 启动前先扫一遍死工牌：bridge 现在会空闲自退，历史遗留的 pid 文件
  // 必须自动回收，不能越积越多。
  sweepStalePidFiles();

  // 确保 bridge 运行（带重试）
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await isBridgeRunning()) break;
    try {
      // 选端口：首选 BRIDGE_PORT；若被**别的身份的 bridge** 占用则向上另选
      const port = await pickBridgePort();
      ACTIVE_PORT = port;
      await startBridge(port);
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  if (lastErr && !(await isBridgeRunning())) {
    console.error("❌ 无法启动 Bridge:", lastErr.message);
    process.exit(1);
  }

  // Initialize
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await callMCP("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "carlos-cli", version: "1.0.0" },
      });
      break;
    } catch (e) {
      if (attempt === 2) { console.error("❌ 初始化失败:", e.message); process.exit(1); }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 智能触发检查：真实输入必须显式传入
  //   node carlos.js flow_status '{"sessionId":"x","triggerMessage":"run dispatch workflow"}'
  //   或环境变量 CARLOS_TRIGGER_MESSAGE
  //
  // 不传时**不启用自动触发**（空串 = 不触发）。
  // 早先的兜底项（工具名 + 参数 JSON）会造成两个真实故障：
  //   ① 自伤：参数里含触发词 → 自己给自己开占位卡 → 同一次调用的
  //      flow_dispatch 反被 activation_pending 闸门拒绝；
  //   ② 锚点污染：写入的“用户原话”是命令行文本 → Agent 用真实原话重提卡时
  //      quote 锚点校验失败 → 补齐流程被自己的兜底串卡死。
  const triggerMessage = args.triggerMessage || process.env.CARLOS_TRIGGER_MESSAGE || "";
  // 客户端专用字段不透传给 MCP 工具（用副本，避免改到调用方对象）
  const toolArgs = { ...args };
  delete toolArgs.triggerMessage;
  delete toolArgs.complexity;
  const triggerResult = await checkTrigger(triggerMessage);
  if (triggerResult.autoTrigger) {
    console.error('[Carlos Trigger] 工作流已激活（会话进入已留痕状态），继续执行本次工具调用...');
  }

  // Call tool
  let resp;
  try {
    resp = await callMCP("tools/call", { name: toolName, arguments: toolArgs });
  } catch (e) {
    console.error("❌ 工具调用失败:", e.message);
    process.exit(1);
  }

  if (resp.error) {
    console.error("❌ MCP 错误:", resp.error.message);
    process.exit(1);
  }

  const text = resp.result?.content?.[0]?.text || "";
  const isError = resp.result?.isError === true;

  if (isError) {
    // 错误必须走 stderr 且以非零码退出，调用方才能可靠区分成败
    console.error(text);
    process.exit(1);
  }

  console.log(text);
  // 显式退出：Bridge 是常驻子进程，其管道/句柄会让事件循环无法自然结束
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 调用失败:", e.message);
  process.exit(1);
});