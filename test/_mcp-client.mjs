// 极简 MCP stdio 客户端（测试专用）
//
// 用途：给 test/mcp-stdio.mjs 与 test/cindy-dispatch.mjs 共用。
// 只实现本仓库需要的子集：起进程、发请求、收响应、发通知。
// 刻意**不依赖 @modelcontextprotocol/sdk**：那正是被测代码重新实现的部分，
// 用同一个 SDK 来测等于自证。
import { spawn } from "node:child_process";

// surface: 'legacy'（默认，覆盖 26 个底层操作）或 'default'（不注入，验证 v3 默认四门面）。
export function startMcpClient({ entry, cwd, env = {}, surface = 'legacy' }) {
  const baseEnv = { ...process.env };
  delete baseEnv.CARLOS_FLOW_TOOL_SURFACE;
  if (surface === 'legacy') baseEnv.CARLOS_FLOW_TOOL_SURFACE = 'legacy';
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...baseEnv, ...env },
    windowsHide: true,
  });

  let buf = "";
  const waiting = new Map(); // id -> { resolve, reject, timer }
  const stderr = [];
  let nextId = 1;
  const noise = [];
  const client = {
    child,
    request,
    notify,
    initialize,
    close,
    stderr,
    noise,
    onMessage: null,
  };

  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        noise.push(line); // stdout 里出现非协议内容 = 违规
        continue;
      }
      if (msg.id === undefined || msg.id === null) {
        if (typeof client.onMessage === "function") client.onMessage(msg);
        continue; // 通知
      }
      const w = waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  });
  child.stderr.on("data", (d) => stderr.push(d.toString("utf8")));

  function write(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function request(method, params, timeoutMs = 20000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("MCP 请求超时：" + method));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, params: params === undefined ? {} : params });
    });
  }

  function notify(method, params) {
    write({ jsonrpc: "2.0", method, params: params === undefined ? {} : params });
  }

  async function initialize() {
    const res = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    notify("notifications/initialized");
    return res;
  }

  async function close() {
    for (const [, w] of waiting) clearTimeout(w.timer);
    waiting.clear();
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((r) => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } r(); }, 2000);
      child.on("exit", () => { clearTimeout(t); r(); });
    });
  }

  return client;
}
