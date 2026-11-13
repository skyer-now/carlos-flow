// Carlos MCP Bridge — 安全 TCP 桥接层
// 监听 127.0.0.1:19099，仅本地访问
// 用法: node mcp-bridge.js [端口]
// 环境变量: CARLOS_BRIDGE_TOKEN（必填，用于认证）

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";

const PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT || "19099", 10);
const TOKEN = process.env.CARLOS_BRIDGE_TOKEN;
const MCP_SERVER = process.env.CARLOS_FLOW_MCP_ROOT + "/src/index.js";
const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB
const RATE_LIMIT = 10; // 每秒最多请求数
// 请求超时：必须大于服务端的最长单次执行时间。
// 服务端 flow_run_verify 的内部超时是 120s（真实 spawn verify.cmd），
// 其它工具都是毫秒级。
// 旧实现固定 5s —— 结果是任何耗时 >5s 的验证命令（如 `npm test`）必然超时失败，
// 用户只看到「Timeout」，而服务端那边命令其实跑得好好的。
// 现在默认 180s（> 服务端 120s 上限），可用 CARLOS_BRIDGE_TIMEOUT_MS 覆盖。
const REQUEST_TIMEOUT = Number(process.env.CARLOS_BRIDGE_TIMEOUT_MS) || 180000; // 180s

if (!TOKEN) {
  process.stderr.write("[bridge] ❌ CARLOS_BRIDGE_TOKEN 未设置（fail-closed）\n");
  process.exit(1);
}

// 启动 MCP server 子进程
const child = spawn(process.execPath, [MCP_SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let childStdout = "";
const pendingClients = new Map(); // reqId -> { socket, timer }

child.stdout.on("data", (data) => {
  childStdout += data.toString("utf8");
  const lines = childStdout.split("\n");
  childStdout = lines.pop() || "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const resp = JSON.parse(t);
      if (resp.jsonrpc === "2.0" && resp.id !== undefined) {
        const client = pendingClients.get(resp.id);
        if (client) {
          clearTimeout(client.timer);
          pendingClients.delete(resp.id);
          try { client.socket.write(t + "\n"); } catch {}
          try { client.socket.end(); } catch {}
        }
      }
    } catch {}
  }
});

child.stderr.on("data", (data) => {
  process.stderr.write("[mcp] " + data.toString("utf8"));
});

child.on("error", (e) => {
  process.stderr.write("[bridge] 子进程错误: " + e.message + "\n");
});

child.on("exit", (code) => {
  process.stderr.write(`[bridge] MCP server 退出 (code=${code})\n`);
  for (const [, c] of pendingClients) {
    clearTimeout(c.timer);
    try { c.socket.end(); } catch {}
  }
  pendingClients.clear();
});

// 速率限制（per-connection sliding window）
const rateLimitMap = new Map(); // socket -> [timestamps]

function isRateLimited(socket) {
  const now = Date.now();
  const key = socket.remoteAddress + ":" + socket.remotePort;
  const timestamps = rateLimitMap.get(key) || [];
  const windowStart = now - 1000;
  const recent = timestamps.filter((t) => t > windowStart);
  recent.push(now);
  rateLimitMap.set(key, recent);
  return recent.length > RATE_LIMIT;
}

// TCP 服务器
const server = createServer((socket) => {
  let buf = "";
  let size = 0;

  socket.on("data", (data) => {
    size += data.length;
    if (size > MAX_REQUEST_SIZE) {
      socket.write(JSON.stringify({ error: "413 Payload Too Large" }) + "\n");
      socket.end();
      return;
    }

    if (isRateLimited(socket)) {
      socket.write(JSON.stringify({ error: "429 Too Many Requests" }) + "\n");
      socket.end();
      return;
    }

    buf += data.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;

      // 健康检查
      if (t === "GET /health") {
        // 必须回传**身份**，否则客户端无法判断“这个 bridge 是不是我该用的那个”。
        //
        // 背景：早先 /health 只回 {status:"ok"}，客户端只要看到 ok 就复用 ——
        // 于是端口上若跑着**另一个 ROOT / 另一个 CARLOS_FLOW_HOME** 的 bridge，
        // 客户端会静默连过去：它启动时的 HOME 生效、调用方传的 CARLOS_FLOW_HOME
        // 完全失效（状态写到别人的目录），且协议可能不匹配导致挂死。
        // 现在回传 root / flow_home / pid，客户端逐一比对，不符就当“未运行”。
        const health = {
          status: "ok",
          root: process.env.CARLOS_FLOW_MCP_ROOT || "",
          flow_home: process.env.CARLOS_FLOW_HOME || "",
          pid: process.pid,
          port: PORT,
        };
        socket.write(JSON.stringify(health) + "\n");
        continue;
      }

      try {
        const req = JSON.parse(t);

        // Token 认证
        const reqToken = req.params?._token || req._token;
        if (reqToken !== TOKEN) {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "Unauthorized" } }) + "\n");
          continue;
        }

        if (req.jsonrpc === "2.0") {
          const reqId = req.id;
          const timer = setTimeout(() => {
            if (pendingClients.has(reqId)) {
              pendingClients.delete(reqId);
              try { socket.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code: -1, message: "Timeout" } }) + "\n"); } catch {}
              try { socket.end(); } catch {}
            }
          }, REQUEST_TIMEOUT);

          pendingClients.set(reqId, { socket, timer });
          child.stdin.write(t + "\n");
        }
      } catch {}
    }
  });

  socket.on("error", () => {});
  socket.on("close", () => {
    for (const [reqId, c] of pendingClients) {
      if (c.socket === socket) {
        clearTimeout(c.timer);
        pendingClients.delete(reqId);
      }
    }
  });
});

server.on("error", (e) => {
  process.stderr.write("[bridge] TCP 错误: " + e.message + "\n");
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[bridge] Carlos MCP Bridge listening on 127.0.0.1:${PORT}\n`);
});

// 优雅退出
process.on("SIGTERM", () => {
  child.stdin.end();
  child.kill("SIGTERM");
  server.close();
  process.exit(0);
});