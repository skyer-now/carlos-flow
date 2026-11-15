#!/usr/bin/env node
// Carlos MCP 快速客户端 — 自包含，自动管理 Bridge 生命周期
// 用法: node carlos.js <tool_name> [json_args]
//        node carlos.js init --target cindy|opencode
// 首次调用自动启动 Bridge，后续直连复用

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, join, dirname } from "node:path";
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

const BRIDGE_TOKEN = resolveBridgeToken();

// 智能触发引擎（本文件是 ESM，必须用动态 import；require 在 ESM 中不存在）
// 加载失败时降级为「不触发」，不影响主流程
let TriggerEngine = null;
try {
  const triggerMod = await import(pathToFileURL(join(ROOT_ABS, "src", "trigger.js")).href);
  TriggerEngine = triggerMod.TriggerEngine || null;
} catch (e) {
  TriggerEngine = null;
}

const toolName = process.argv[2];
const argsJson = process.argv[3] || "{}";

// ===== init 命令：一键生成宿主配置 =====
if (toolName === "init") {
  const target = process.argv.includes("--target")
    ? process.argv[process.argv.indexOf("--target") + 1]
    : process.env.CARLOS_INIT_TARGET;
  const VALID_TARGETS = ["cindy", "opencode", "cursor", "cline", "vscode", "claude"];
  if (!target || !VALID_TARGETS.includes(target)) {
    console.error("用法: node carlos.js init --target cindy|opencode|cursor|cline|vscode|claude");
    console.error("  或设置环境变量 CARLOS_INIT_TARGET=<target>");
    process.exit(1);
  }
  await runInit(target);
  process.exit(0);
}

if (!toolName) {
  console.error("用法: node carlos.js <tool_name> [json_args]");
  console.error("      node carlos.js init --target cindy|opencode|cursor|cline|vscode|claude");
  console.error("工具: flow_protocol flow_submit_requirement flow_claim flow_dispatch flow_run_verify flow_check_scope flow_verdict flow_status flow_audit flow_diff_hunks flow_bypass flow_add_user_msg flow_save_result flow_revert_plan");
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
      stdio: ["ignore", "ignore", "pipe"],
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
    // stderr 管道会挂住父进程的事件循环（bridge 常驻，管道永不关闭）→ 必须 unref
    try { child.stderr?.unref?.(); } catch {}

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
async function runInit(target) {
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
  const rootJson = JSON.stringify(ROOT_ABS).slice(1, -1);
  const rootYaml = ROOT_ABS.replace(/\\/g, "/");

  if (target === "cindy") {
    // --- Cindy: 生成 ghost.json 到 ~/.cindy/ghosts/ ---
    const ghostsDir = join(home, ".cindy", "ghosts");
    mkdirSync(ghostsDir, { recursive: true });
    const ghostPath = join(ghostsDir, "carlos-flow.json");

    const ghostTemplate = readFileSync(resolve(ROOT_ABS, "ghost.json"), "utf8");
    const ghostContent = ghostTemplate.replace(/__ROOT__/g, rootJson);
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
  }
  console.log(`\n🎉 初始化完成！现在可以使用 carlos-flow 了。`);
  console.log(`   提示: 设置环境变量 CARLOS_FLOW_HOME 可自定义状态目录（默认 ~/.carlos-flow）`);
}

async function main() {
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