// Carlos MCP 快速客户端 — 自包含，自动管理 Bridge 生命周期
// 用法: node carlos.js <tool_name> [json_args]
// 首次调用自动启动 Bridge，后续直连复用

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

// 状态/审计根目录默认值：与 src/state.js 的 FLOW_HOME 保持一致（跨平台）
const DEFAULT_FLOW_HOME = join(os.homedir(), ".carlos-flow");

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "19099", 10);
const ROOT = process.env.CARLOS_FLOW_MCP_ROOT || ".";
const ROOT_ABS = resolve(ROOT);
// Bridge 脚本位置：优先 bridge/mcp-bridge.js（发布版布局），回退到根目录 mcp-bridge.js（扁平布局）
const BRIDGE_SCRIPT = [
  ROOT_ABS + "/bridge/mcp-bridge.js",
  ROOT_ABS + "/mcp-bridge.js",
].find((p) => existsSync(p)) || ROOT_ABS + "/bridge/mcp-bridge.js";
const MCP_SERVER = ROOT_ABS + "/src/index.js";
// PID 文件按端口区分：多 Bridge 并存（测试用独立端口）时不会互相覆盖
const PID_FILE = ROOT_ABS + "/bridge-" + BRIDGE_PORT + ".pid";
const BRIDGE_TOKEN = process.env.CARLOS_BRIDGE_TOKEN || "carlos-local-token-2026";

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

if (!toolName) {
  console.error("用法: node carlos.js <tool_name> [json_args]");
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
          console.error(`[Carlos Trigger] 激活步骤 ${step.tool} 失败：${txt.split('\n')[0]}`);
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

// 检查 bridge 是否已在运行（先读 PID，再 TCP 探测）
function isBridgeRunning() {
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
    const s = createConnection(BRIDGE_PORT, "127.0.0.1");
    s.on("connect", () => {
      // 发送健康检查
      s.write("GET /health\n");
    });
    s.on("data", (data) => {
      const resp = data.toString().trim();
      try {
        const json = JSON.parse(resp);
        if (json.status === "ok") { s.end(); resolve(true); return; }
      } catch {}
      s.end();
      // 健康检查失败但端口存活，也算运行中
      resolve(true);
    });
    s.on("error", () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
}

// 自动启动 bridge（后台常驻）
function startBridge() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, String(BRIDGE_PORT)], {
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

    // 写入 PID 文件
    try { writeFileSync(PID_FILE, String(child.pid), "utf8"); } catch {}

    // 等待 bridge 就绪：用轻量健康检查端点，不占用 MCP 的 initialize 握手
    // （否则同一 MCP server 会被握手两次，导致首次调用挂起）
    const check = setInterval(async () => {
      const ready = await new Promise((res) => {
        const s = createConnection(BRIDGE_PORT, "127.0.0.1");
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
    const socket = createConnection(BRIDGE_PORT, "127.0.0.1");
    let buf = "";
    const reqId = Math.floor(Math.random() * 100000000) + 2;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; socket.destroy(); reject(new Error("超时 (5s)")); }
    }, 5000);

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

async function main() {
  // 确保 bridge 运行（带重试）
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await isBridgeRunning()) break;
    try {
      await startBridge();
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

  // 智能触发检查：真实输入来源优先取显式传入的用户原话
  //   node carlos.js flow_status '{"sessionId":"x","triggerMessage":"把登录接口加上参数校验"}'
  //   或环境变量 CARLOS_TRIGGER_MESSAGE
  const triggerMessage = args.triggerMessage || process.env.CARLOS_TRIGGER_MESSAGE || (toolName + ' ' + argsJson);
  delete args.triggerMessage; // triggerMessage 是客户端专用字段，不透传给 MCP 工具
  const triggerResult = await checkTrigger(triggerMessage);
  if (triggerResult.autoTrigger) {
    console.error('[Carlos Trigger] 工作流已激活（会话进入已留痕状态），继续执行本次工具调用...');
  }

  // Call tool
  let resp;
  try {
    resp = await callMCP("tools/call", { name: toolName, arguments: args });
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