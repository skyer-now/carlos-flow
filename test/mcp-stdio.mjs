// 零依赖 MCP stdio 服务端（src/mcp-stdio.mjs）—— 协议回归测试
//
// 背景：为了让插件能以 .cindy 形态随包运行（Forge 跳过 node_modules、运行期不许联网装依赖），
// 我们不再依赖 @modelcontextprotocol/sdk，改为自己实现 MCP stdio 的子集。
// 「自己实现协议」最容易出的三类事故，本测试逐条钉死：
//   1. 握手不完整 → 宿主以为连上了，实际一个工具都拿不到；
//   2. stdout 混入非协议内容（日志/调试输出）→ 客户端解析整条流崩掉；
//   3. 通知被当成请求回包 / 未知方法不回错 → 客户端永久挂起。
//
// 跑法：node test/mcp-stdio.mjs
import { parseTools, verifyParserFormats } from '../scripts/check-no-dead-handler.mjs'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpClient } from "./_mcp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-mcp-home-"));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

check('工具解析格式回归', verifyParserFormats() === 8)

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const client = startMcpClient({
  entry: path.join(ROOT, "src", "index.js"),
  cwd: ROOT,
  env: { CARLOS_FLOW_HOME: HOME },
});

try {
  // 1. 握手
  const init = await client.initialize();
  const info = init.result || {};
  check("1a. initialize 有 result", !!init.result, init.error ? JSON.stringify(init.error) : "");
  check("1b. serverInfo 名称/版本来自 package.json",
    info.serverInfo && info.serverInfo.name === "carlos-flow" && info.serverInfo.version === pkgVersion,
    info.serverInfo ? `${info.serverInfo.name}@${info.serverInfo.version}` : "缺失");
  check("1c. 回传协议版本（客户端支持的版本优先）",
    info.protocolVersion === "2025-06-18", String(info.protocolVersion));
  check("1d. 声明 tools 能力", !!(info.capabilities && info.capabilities.tools));

  // 2. 工具目录
  const listed = await client.request("tools/list", {});
  const tools = (listed.result && listed.result.tools) || [];
  // 期望数量从源码推导：加/删工具时不用手改一堆魔法数字（改错反而制造假红）
  const sourceText = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')
  const parsedTools = parseTools(sourceText)
  const srcTools = parsedTools.map((tool) => tool.name)
  // 用实际工具对象回归两种引号及数组换行，避免只验证孤立名称片段。
  for (const quote of ['\'', '"']) {
    for (const ending of ['\n];', '\r\n]']) {
      const blocks = parsedTools.map((tool) => `{${tool.block.replace(/^(\s*name\s*:\s*)(['"])(flow_[a-z_]+)\2/, (_, prefix, old, name) => prefix + quote + name + quote)}}`)
      const reparsed = parseTools('const TOOLS = [\n' + blocks.join(',\n') + ending)
      check(`工具解析兼容引号 ${quote} 与数组边界 ${JSON.stringify(ending)}`,
        JSON.stringify(reparsed) === JSON.stringify(parsedTools.map((tool, i) => ({ ...tool, block: blocks[i].slice(1, -1) }))))
    }
  }
  check('工具名单与源码一致', JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify(srcTools.slice().sort()))
  check(`2a. tools/list 与源码一致（${srcTools.length} 个）`, tools.length === srcTools.length, `${tools.length} 个`);
  check("2b. 工具定义不泄露 handler（函数不可序列化）",
    tools.every((t) => t.handler === undefined), "");
  check("2c. 每个工具都有 name/description/inputSchema",
    tools.every((t) => typeof t.name === "string" && typeof t.description === "string" && t.inputSchema && t.inputSchema.type === "object"));

  // 3. 真实调用
  const proto = await client.request("tools/call", { name: "flow_protocol", arguments: {} });
  const protoText = proto.result && proto.result.content && proto.result.content[0] && proto.result.content[0].text;
  let protoJson = null;
  try { protoJson = JSON.parse(String(protoText)); } catch { /* 下面断言会失败 */ }
  check("3a. tools/call 能跑通真实工具（flow_protocol）",
    !!protoJson && !!protoJson.protocol && /T2/.test(String(protoJson.protocol.ROUTE_TABLE)),
    protoText ? `${String(protoText).length} 字符` : "无内容");
  check("3b. 成功结果不带 isError", (proto.result || {}).isError !== true);

  // 4. 参数校验仍生效（required 缺失）
  const bad = await client.request("tools/call", { name: "flow_mode", arguments: {} });
  const badText = String((bad.result && bad.result.content && bad.result.content[0] && bad.result.content[0].text) || "");
  check("4a. 缺必填参数返回 isError", (bad.result || {}).isError === true, badText.slice(0, 40));
  check("4b. 错误文案可操作（指出缺哪个字段）", /缺少必填字段：mode/.test(badText), badText.slice(0, 60));

  // 5. 未知工具 → 工具级错误（不是协议错误，宿主不会因此断连）
  const unknown = await client.request("tools/call", { name: "flow_not_exist", arguments: {} });
  check("5a. 未知工具返回 isError 而非协议错误",
    !unknown.error && (unknown.result || {}).isError === true);

  // 6. 未知方法必须回 -32601（否则客户端会一直等）
  const unknownMethod = await client.request("resources/does-not-exist", {});
  check("6a. 未知方法返回 -32601",
    !!(unknownMethod.error && unknownMethod.error.code === -32601),
    unknownMethod.error ? `code=${unknownMethod.error.code}` : "没有 error");

  // 7. 通知不产生回包（用 ping 验证「流没被堵住」）
  client.notify("notifications/initialized", {});
  client.notify("notifications/cancelled", { requestId: 1, reason: "test" });
  const pong = await client.request("ping", {});
  check("7a. 通知不回包且不阻塞后续请求（ping 有响应）", !!pong.result);

  // 7b. 「带 id 的通知」必须回包（否则调用方永久挂起）
  //     规范里 notify 是不带 id 的，但实测有客户端会带 id；不回包比报错更难查。
  const notifyWithId = await client.request("notifications/initialized", {});
  check("7b. 带 id 的通知会得到空结果（不挂起调用方）", !!notifyWithId.result);

  // 8. 能力探测的空列表应答（宿主会问，不能报错）
  const res = await client.request("resources/list", {});
  const prompts = await client.request("prompts/list", {});
  check("8a. resources/list 回空列表", Array.isArray(res.result && res.result.resources));
  check("8b. prompts/list 回空列表", Array.isArray(prompts.result && prompts.result.prompts));

  // 8b. 宿主用 require() 加载随包入口 —— 有顶层 await 就会 ERR_REQUIRE_ASYNC_MODULE
  //     （2026-11-17 实测：插件一调就「Node 工作进程已退出」，排查成本很高）
  {
    const { execFileSync } = await import("node:child_process");
    let requireOut = "";
    let requireOk = true;
    try {
      requireOut = execFileSync(process.execPath, ["-e", "require('./src/index.js');console.log('REQUIRE_OK')"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CARLOS_FLOW_HOME: HOME },
      });
    } catch (e) {
      requireOk = false;
      requireOut = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    }
    check("8b. 入口可被 require() 加载（无顶层 await）",
      requireOk && /REQUIRE_OK/.test(requireOut),
      requireOk ? "" : requireOut.slice(0, 120));
  }

  // 9. stdout 只能有协议消息（日志必须走 stderr）
  check("9a. stdout 没有混入非 JSON 内容", client.noise.length === 0,
    client.noise.length ? client.noise.slice(0, 2).join(" | ") : "");
  check("9b. 启动日志走 stderr", client.stderr.join("").includes("ready (stdio)"));
} finally {
  await client.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 同步收行捕获：分帧与并发闭包隔离，不接受carlosContext里的伪能力。
{
  const { StdioServer } = await import('../src/mcp-stdio.mjs')
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const originalInput = Object.getOwnPropertyDescriptor(process, 'stdin')
  const originalWrite = process.stdout.write
  const replies = []
  let active
  globalThis.__CINDY_NODE__ = { bindLaunch: () => {
    const captured = active
    return captured === undefined ? undefined : () => captured
  } }
  Object.defineProperty(process, 'stdin', { configurable: true, value: input })
  process.stdout.write = text => { replies.push(JSON.parse(text)); return true }
  try {
    const server = new StdioServer({ name: '捕获检查', version: '1', tools: [],
      callTool: async (name, args, context, runtime) => {
        await Promise.resolve()
        return { captured: runtime.launch?.(), failure: runtime.failure, forged: context?.launch }
      },
    })
    const done = server.start()
    const line = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: '检查', arguments: { rpcId: '伪造' }, carlosContext: { launch: '伪造' },
    } }) + '\n'
    input.write(line(1).slice(0, 20))
    active = '请求一'
    input.write(line(1).slice(20))
    active = '请求二'
    input.write(line(2))
    active = undefined
    input.write(line(3))
    globalThis.__CINDY_NODE__ = { get bindLaunch() { throw new Error('不泄露原错误') } }
    input.write(line(4))
    input.end()
    await done
  } finally {
    Object.defineProperty(process, 'stdin', originalInput)
    process.stdout.write = originalWrite
    delete globalThis.__CINDY_NODE__
  }
  check('B1 分帧同步捕获与并发闭包隔离', replies.find(r => r.id === 1)?.result.captured === '请求一' && replies.find(r => r.id === 2)?.result.captured === '请求二')
  check('B2 丢失scope与getter异常明确失败', replies.find(r => r.id === 3)?.result.failure === 'HOST_HASH_UNSUPPORTED' && replies.find(r => r.id === 4)?.result.failure === 'HOST_HASH_CAPTURE_FAILED')
  check('B3 JSON上下文不能转交伪能力且EOF等待全部完成', replies.length === 4 && replies.every(r => r.result.forged === undefined))
}

// 输入error必须等待已接收handler的finally，不得接收后续消息或泄露原错误。
{
  const { StdioServer } = await import('../src/mcp-stdio.mjs')
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const originalInput = Object.getOwnPropertyDescriptor(process, 'stdin')
  const originalWrite = process.stdout.write
  const order = []
  let accepted = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  Object.defineProperty(process, 'stdin', { configurable: true, value: input })
  process.stdout.write = () => true
  try {
    const server = new StdioServer({ name: '输入错误', version: '1', tools: [], callTool: async () => {
      accepted++
      try { await barrier; return {} } finally { order.push('finally') }
    } })
    const done = server.start().then(() => order.push('resolved'), error => {
      order.push('rejected')
      if (error.message.includes('秘密')) order.push('leaked')
    })
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '检查' } }) + '\n'
    input.write(line)
    input.emit('error', new Error('秘密/原路径'))
    input.emit('error', new Error('重复错误'))
    input.write(line)
    const beforeDrain = [...order]
    release()
    await done
    check('R3 输入error停止新接收且先finally后reject', accepted === 1 && beforeDrain.length === 0 && order.join(',') === 'finally,rejected')
    check('R3 pending收尾归零且输入错误监听清理', server.pending.size === 0 && input.listenerCount('error') === 0)
  } finally {
    input.end()
    Object.defineProperty(process, 'stdin', originalInput)
    process.stdout.write = originalWrite
  }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("MCP_STDIO_OK");