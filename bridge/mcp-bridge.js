// Carlos MCP Bridge — 安全 TCP 桥接层
// 监听 127.0.0.1:19099，仅本地访问
// 用法: node mcp-bridge.js [端口]
// 环境变量: CARLOS_BRIDGE_TOKEN（必填，用于认证）

import { spawnSync, spawn } from "node:child_process";

// === Windows 自保：GUI 父进程 spawn 时隐藏自身控制台窗口 ===
// 注意 2 点:
//   1) Add-Type 使用单引号包裹 MemberDefinition，内层双引号才是 C# 字面量
//   2) .NET IntPtr 不是 IComparable, 必须先 ToInt64() 再 -gt 0，否则报错
if (process.platform === 'win32') {
  spawnSync('powershell', [
    '-NoProfile', '-Command',
    `$w = (Get-Process -Id ${process.pid}).MainWindowHandle.ToInt64(); if ($w -gt 0) { Add-Type -Name Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Namespace Native; [Native.Win32]::ShowWindow([IntPtr]$w, 0) }`
  ], { stdio: 'ignore', windowsHide: true });
}
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT || "19099", 10);
const TOKEN = process.env.CARLOS_BRIDGE_TOKEN;
// 路径自探测：环境变量优先（向后兼容），否则按 bridge/ 的位置自动定位项目根目录。
// 这样在 Cursor / VS Code / Windsurf 里只需填 bridge 脚本路径，无需再手写 ROOT 绝对路径。
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MCP_ROOT = process.env.CARLOS_FLOW_MCP_ROOT
  ? path.resolve(process.env.CARLOS_FLOW_MCP_ROOT)
  : PROJECT_ROOT;
const MCP_SERVER = path.resolve(MCP_ROOT, "src/index.js");
const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB
const RATE_LIMIT = 10; // 每秒最多请求数
// 请求超时：必须大于服务端的最长单次执行时间。
// 服务端 flow_run_verify 的内部超时是 120s（真实 spawn verify.cmd），
// 其它工具都是毫秒级。
// 旧实现固定 5s —— 结果是任何耗时 >5s 的验证命令（如 `npm test`）必然超时失败，
// 用户只看到「Timeout」，而服务端那边命令其实跑得好好的。
// 现在默认 180s（> 服务端 120s 上限），可用 CARLOS_BRIDGE_TIMEOUT_MS 覆盖。
const REQUEST_TIMEOUT = Number(process.env.CARLOS_BRIDGE_TIMEOUT_MS) || 180000; // 180s

// ---- 空闲退出（idle reaper）----
//
// 为什么必须有：ghost.json 一直声明着 `"idleTimeoutSeconds": 300` 与
// `"lifecycle": "on-demand"`，但本文件从来没有任何空闲退出实现。
// 结果实测（2026-11-17）：机器上常驻 14 个进程、私有内存 430MB，
// 仓库里还堆着 40 个 bridge-*.pid（36 个指向已死进程）。
//
// 代价很低：实测 bridge 从启动到 /health 就绪只要 118ms（server 155ms），
// 所以「用的时候起、闲了就退」几乎无感。默认 30 分钟（不是 5 分钟），
// 避免短暂休息就触发冷启动。
// CARLOS_BRIDGE_IDLE_MS=0 可关闭本机制（常驻场景）。
const IDLE_MS = (() => {
  const raw = process.env.CARLOS_BRIDGE_IDLE_MS;
  if (raw === undefined || raw === "") return 30 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30 * 60 * 1000;
  return n;
})();
let lastActivity = Date.now();
let activeSockets = 0;
const touch = () => { lastActivity = Date.now(); };

// ---- 启动时清理僵尸工牌 ----
//
// 背景（2026-11-17 实测）：仓库根堆了 40 个 bridge-*.pid，其中 36 个指向已不存在的进程。
// 这些文件没有任何用处，却会让人「以为 bridge 还在跑」，也让排查端口占用时判断失真。
// 只删 **pid 已死** 的工牌：活着的一律不动（pid 可能被别的进程复用，误删会掩盖真实占用）。
function sweepStalePidFiles() {
  let names = [];
  try { names = readdirSync(MCP_ROOT); } catch { return { removed: 0, kept: 0 }; }
  let removed = 0;
  let kept = 0;
  for (const name of names) {
    if (!/^bridge-\d+\.pid$/.test(name)) continue;
    const file = path.join(MCP_ROOT, name);
    let pid = 0;
    try { pid = parseInt(readFileSync(file, "utf8").trim(), 10); } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) { kept++; continue; }
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      // ESRCH = 进程不存在；EPERM = 存在但无权发信号 → 按活着处理
      if (e && e.code === "ESRCH") alive = false;
    }
    if (alive) { kept++; continue; }
    try { unlinkSync(file); removed++; } catch { /* 被别的进程删了 */ }
  }
  return { removed, kept };
}

if (!TOKEN) {
  process.stderr.write("[bridge] ❌ CARLOS_BRIDGE_TOKEN 未设置（fail-closed）\n");
  process.exit(1);
}

// 启动 MCP server 子进程
// windowsHide: true —— Windows 下隐藏子进程控制台窗口，避免 Bridge 重启时弹黑框。
const child = spawn(process.execPath, [MCP_SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
  windowsHide: true,
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
  process.stderr.write("[Carlos-Diagnosis] ❌ MCP server 子进程启动失败: " + e.message + "\n");
  process.stderr.write(
    "[Carlos-Suggestion] 💡 请确认 Node.js 可用（node -v），且 " +
      MCP_SERVER +
      " 存在；若路径被移动过，可设置环境变量 CARLOS_FLOW_MCP_ROOT 指向项目根目录。\n",
  );
});

child.on("exit", (code) => {
  process.stderr.write(`[bridge] MCP server 退出 (code=${code})\n`);
  for (const [, c] of pendingClients) {
    clearTimeout(c.timer);
    try { c.socket.end(); } catch {}
  }
  pendingClients.clear();
  // 子进程没了，这个 bridge 已经没用了：必须跟着退出。
  // 否则会留下「端口活着、服务死了」的僵尸 —— 调用方连得上却永远等不到回包，
  // 只能等到 180s 超时（比进程根本不存要难查得多）。
  shutdown(code === 0 ? 0 : 1);
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

  // 活跃连接计数：只要还有连接就不算空闲（客户端可能正在等长调用）
  activeSockets++;
  touch();
  socket.on("close", () => { activeSockets = Math.max(0, activeSockets - 1); touch(); });

  socket.on("data", (data) => {
    touch();
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
          root: MCP_ROOT,
          flow_home: process.env.CARLOS_FLOW_HOME || "",
          pid: process.pid,
          port: PORT,
          // 空闲策略可观测：排查「为什么它退了 / 为什么它不退」时不用猜配置。
          // 恒为附加字段，客户端只比对 root / flow_home，不受影响。
          idle_ms: IDLE_MS,
          idle_for_ms: Date.now() - lastActivity,
          active_sockets: activeSockets,
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
  const swept = sweepStalePidFiles();
  if (swept.removed > 0) {
    process.stderr.write(`[bridge] 已清理 ${swept.removed} 个僵尸 pid 工牌（保留 ${swept.kept} 个活进程的）\n`);
  }
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // 自己把自己的工牌拆下来 —— 否则仓库里会继续堆死 pid 文件
  // （实测 40 个，其中 36 个指向已不存在的进程）。
  // 只删「内容是本进程 pid」的那个，避免两个桥互删工牌。
  try {
    const pidFile = path.join(MCP_ROOT, `bridge-${PORT}.pid`);
    if (parseInt(readFileSync(pidFile, "utf8").trim(), 10) === process.pid) {
      unlinkSync(pidFile);
    }
  } catch { /* 文件不存在 / 已属于别人：忽略 */ }
  try { child.stdin.end(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(code), 150).unref?.();
}

// 空闲巡检：只有「无活跃连接 + 无待回包请求」才算真空闲
if (IDLE_MS > 0) {
  const tickMs = Math.min(15000, Math.max(500, Math.floor(IDLE_MS / 4)));
  const timer = setInterval(() => {
    if (activeSockets > 0 || pendingClients.size > 0) { touch(); return; }
    const idleFor = Date.now() - lastActivity;
    if (idleFor < IDLE_MS) return;
    process.stderr.write(`[bridge] 已空闲 ${Math.round(idleFor / 1000)}s，按空闲策略退出（CARLOS_BRIDGE_IDLE_MS=${IDLE_MS}）\n`);
    shutdown(0);
  }, tickMs);
  // 定时器本身不能让进程活着（否则空闲退出永远等不到）
  timer.unref?.();
}

// 优雅退出
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));