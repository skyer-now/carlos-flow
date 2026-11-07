// carlos-flow-trigger — OpenCode 插件：把智能触发引擎真正接到消息事件上
//
// 为什么需要这个插件：
//   Carlos 工作流的「智能触发引擎」（src/trigger.js）原本只接在**命令行客户端**
//   （client/carlos.js）上 —— MCP server 根本不接触发引擎。
//   而在 OpenCode 里，Agent 走的是 MCP 工具路径（直接调 flow_* 工具），
//   于是 README 里那张「工作流会自己认出该上场的时候」的流程图在**实际使用路径上是不成立的**。
//
// 本插件做的事：
//   监听 OpenCode 的 `chat.message` 钩子（用户每发一条消息都会触发），
//   把消息原文交给 MCP 的 flow_trigger_check 工具 —— 由它做评分与决策，
//   达标时**实际完成激活**（写入用户原话 + 开占位卡 → 会话进入门禁态）。
//
//   评分与决策逻辑与命令行路径**共用同一份实现**（src/trigger.js），
//   所以两条路径的行为完全一致，不会出现「命令行能触发、MCP 不能」。
//
// 安装：
//   方式 A（本地文件）：把本文件放到 OpenCode 的插件目录
//        ~/.config/opencode/plugins/carlos-flow-trigger.js
//        Windows 下则是 %APPDATA%\opencode\plugins\carlos-flow-trigger.js
//        项目级则放 .opencode/plugins/carlos-flow-trigger.js
//   方式 B（npm 包）：在 opencode.json 里加
//        { "plugin": ["carlos-flow/plugins/carlos-flow-trigger.js"] }
//   然后重启 OpenCode。
//
// 可选环境变量：
//   CARLOS_FLOW_TRIGGER=off      关闭插件（临时停用自动触发）
//   CARLOS_FLOW_TRIGGER_DEBUG=1  打印触发决策日志
//
// 说明：
//   · 插件只做「判断 + 激活」，**不代替 Agent 决定改哪些文件**；
//     激活后仍需补齐 scope / acceptance / verify.cmd 才能派发（闸门不放松）；
//   · 任何异常都只记日志、绝不阻断用户消息（插件出错不应该让 OpenCode 挂掉）。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEBUG = process.env.CARLOS_FLOW_TRIGGER_DEBUG === "1";
const ENABLED = process.env.CARLOS_FLOW_TRIGGER !== "off";

// 找到 MCP server 的 src/index.js。
// 插件可能位于：
//   1) <pkg>/plugins/carlos-flow-trigger.js（npm 包内，方式 B）
//   2) ~/.config/opencode/plugins/carlos-flow-trigger.js（本地文件，方式 A）
//   3) <repo>/plugins/carlos-flow-trigger.js（源码 checkout）
//
// ⚠️ 包名是 **carlos-flow**（v2.6.0 起统一单包）。
// 旧版这里硬编码的是 carlos-flow-opencode —— 单包化之后那个目录根本不存在，
// 于是除「方式 B」（插件就在包内）外的所有安装方式都**找不到 MCP server**，
// 自动触发**静默失效**。
// 现在同时接受新包名与两个已弃用的旧包名（兼容老用户尚未迁移的 node_modules）。
const PKG_NAMES = ["carlos-flow", "carlos-flow-opencode", "carlos-flow-cindy"];
function findMcpServer() {
  const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const dir = resolve(here);
  const candidates = [
    join(dir, "..", "src", "index.js"),                                    // <pkg>/plugins/ → <pkg>/src/
  ];
  for (const name of PKG_NAMES) {
    candidates.push(
      join(dir, "..", "..", "node_modules", name, "src", "index.js"),
      join(dir, "..", "..", "..", "node_modules", name, "src", "index.js"),
      join(homedir(), ".config", "opencode", "node_modules", name, "src", "index.js"),
      join(homedir(), "AppData", "Roaming", "opencode", "node_modules", name, "src", "index.js"),
    );
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// 以 MCP 的 stdio 协议调一个工具（一次性拉起，用完即退）
async function callMcpTool(serverPath, toolName, args, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    let stderr = "";
    const pending = new Map();
    let id = 1;

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolvePromise({ ok: false, error: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        } catch {}
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const req = (method, params) => new Promise((r) => {
      const rid = id++;
      pending.set(rid, r);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolvePromise({ ok: false, error: String(e && e.message ? e.message : e) });
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: stderr.slice(-300) || "server exited" });
    });

    (async () => {
      try {
        await req("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "carlos-flow-trigger", version: "1.0.0" },
        });
        const res = await req("tools/call", { name: toolName, arguments: args });
        const text = res?.result?.content?.[0]?.text || "";
        clearTimeout(timer);
        try { child.kill(); } catch {}
        if (res?.result?.isError) {
          resolvePromise({ ok: false, error: String(text).slice(0, 300) });
        } else {
          try {
            resolvePromise({ ok: true, data: JSON.parse(text) });
          } catch {
            resolvePromise({ ok: false, error: "bad json: " + String(text).slice(0, 200) });
          }
        }
      } catch (e) {
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolvePromise({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
  });
}

// 从 parts 里取出用户消息文本（只看 type==="text" 的部分）
function extractText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export const CarlosFlowTriggerPlugin = async ({ client, $, worktree, directory }) => {
  const serverPath = findMcpServer();
  if (!serverPath) {
    console.error("[carlos-flow-trigger] 未找到 MCP server（src/index.js），自动触发未启用");
    console.error("[carlos-flow-trigger] 请确认已全局安装：npm install -g carlos-flow");
  }
  if (DEBUG) {
    console.error("[carlos-flow-trigger] server:", serverPath, "cwd:", worktree || directory);
  }

  return {
    "chat.message": async (input, output) => {
      if (!ENABLED) return;
      if (!serverPath) return;

      const message = extractText(output && output.parts);
      if (!message) return;

      const sessionId = input.sessionID || "default";
      try {
        const res = await callMcpTool(serverPath, "flow_trigger_check", {
          sessionId,
          message,
          cwd: worktree || directory || process.cwd(),
        });

        if (!res.ok) {
          if (DEBUG) console.error("[carlos-flow-trigger] 调用失败:", res.error);
          return; // 插件出错绝不阻断用户消息
        }

        const d = res.data || {};
        if (DEBUG) {
          console.error(
            `[carlos-flow-trigger] decision=${d.decision} score=${d.score} activated=${d.activated}`
          );
        }
        if (d.activated) {
          console.error(
            `[carlos-flow-trigger] 已自动激活 Carlos 工作流（评分 ${d.score}）—— ` +
            `请补齐 ${(d.pending_fields || []).join(" / ")} 后再派发`
          );
        }
      } catch (e) {
        if (DEBUG) console.error("[carlos-flow-trigger] 异常:", e && e.message ? e.message : e);
      }
    },
  };
};
