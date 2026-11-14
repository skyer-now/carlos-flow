// 冒烟测试：真 RPC 往返验证 MCP 深度兼容性
//
// 关键约束（来自 bridge/mcp-bridge.js）：
//   1. 每个请求走**独立连接** —— Bridge 响应一个请求后立刻 socket.end()
//   2. 请求必须带 _token（放在 params._token 或顶层 _token）
//   3. 速率限制 10 次/秒，本测试仅 2 次
import { spawn } from "node:child_process";
import net from "node:net";
import { performance } from "node:perf_hooks";

const PORT = Number(process.env.BRIDGE_PORT || 20099);
const TOKEN = process.env.CARLOS_BRIDGE_TOKEN || "";
const EXPECTED_TOOLS_COUNT = 20;

// 单次 RPC：一条连接发一个请求，收满响应就返回
function rpcOnce(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const socket = net.createConnection(
      { port: PORT, host: "127.0.0.1" },
      () => {
        socket.write(JSON.stringify(request) + "\n");
      },
    );

    socket.on("data", (d) => chunks.push(d));
    socket.on("end", () =>
      finish(resolve, Buffer.concat(chunks).toString("utf8")),
    );
    socket.on("close", () =>
      finish(resolve, Buffer.concat(chunks).toString("utf8")),
    );
    socket.on("error", (err) => finish(reject, err));

    setTimeout(() => {
      socket.destroy();
      finish(reject, new Error("RPC 超时：" + request.method));
    }, 10000);
  });
}

async function main() {
  const start = performance.now();

  // 第 1 次：initialize
  const initRaw = await rpcOnce({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
      _token: TOKEN,
    },
  });

  const initMsg = JSON.parse(initRaw.trim().split("\n").filter(Boolean).pop());
  if (initMsg.error) {
    throw new Error(
      "initialize 被拒：" + JSON.stringify(initMsg.error),
    );
  }
  if (!initMsg.result) {
    throw new Error("initialize 无 result 字段：" + initRaw.trim());
  }
  console.log("✅ initialize 握手成功");

  // 第 2 次：tools/list（独立连接）
  const listRaw = await rpcOnce({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: { _token: TOKEN },
  });

  const listMsg = JSON.parse(listRaw.trim().split("\n").filter(Boolean).pop());
  if (listMsg.error) {
    throw new Error("tools/list 被拒：" + JSON.stringify(listMsg.error));
  }

  const tools = listMsg.result?.tools || [];
  const elapsed = (performance.now() - start).toFixed(2);

  console.log(">>> RPC 往返总耗时：" + elapsed + "ms");
  console.log(">>> 发现工具数：" + tools.length);

  if (tools.length !== EXPECTED_TOOLS_COUNT) {
    throw new Error(
      "工具数量不符：期望 " +
        EXPECTED_TOOLS_COUNT +
        "，实际 " +
        tools.length,
    );
  }

  console.log("🎉 深度兼容性验证通过（真 RPC 往返拿到 " + tools.length + " 个工具）");
}

const bridge = spawn(process.execPath, ["bridge/mcp-bridge.js"], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env },
});

// 等 Bridge 真正监听端口（最多 8 秒）
async function waitForPort() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ port: PORT, host: "127.0.0.1" });
      s.on("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  if (!(await waitForPort())) {
    throw new Error("Bridge 未能在 8 秒内监听 " + PORT + " 端口");
  }
  await main();
  process.exitCode = 0;
} catch (err) {
  console.error("💥 冒烟测试失败：" + err.message);
  process.exitCode = 1;
} finally {
  bridge.kill();
}
