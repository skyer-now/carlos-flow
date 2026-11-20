// 最小 MCP stdio 服务端（零依赖）
//
// 为什么自己写而不继续用 @modelcontextprotocol/sdk：
// Cindy 插件（chip）要求随包 Node 程序**自带全部依赖** —— Forge 打包时会跳过
// node_modules，也禁止安装期/首跑期联网装依赖。SDK 一旦成为运行时依赖，
// 这个插件就不可能以 .cindy 形态装进 Cindy（只能靠绝对路径跑仓库里的副本）。
//
// 本实现只覆盖本插件真正用到的 MCP 子集：
//   握手（initialize）、初始化通知、心跳（ping）、工具目录与工具调用，
//   外加 resources/prompts 的空列表应答（宿主做能力探测时会问）。
// 传输形态：逐行 JSON-RPC 2.0（MCP stdio 规范），stdout 只写协议消息，日志走 stderr。
import readline from "node:readline";
import { captureHashContext } from './state.js'

// 声明的协议版本：客户端请求里的版本若在支持列表内就回声，否则回最新的。
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

export class StdioServer {
  constructor({ name, version, tools, callTool, log }) {
    this.name = name;
    this.version = version;
    this.tools = tools;
    this.callTool = callTool;
    this.log = typeof log === "function" ? log : () => {};
    this.initialized = false;
    this.pending = new Set();
  }

  reply(id, result) {
    if (id === undefined || id === null) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  replyError(id, code, message) {
    if (id === undefined || id === null) return;
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  write(message) {
    try {
      process.stdout.write(JSON.stringify(message) + "\n");
    } catch (e) {
      // 客户端已断开（EPIPE）：不再尝试写，避免把进程搞崩
      try {
        this.log("stdout 写入失败：" + (e && e.message ? e.message : e));
      } catch { /* ignore */ }
    }
  }

  async handle(message, runtime) {
    const method = message && message.method;
    const id = message && message.id;
    if (typeof method !== "string") return; // 客户端回来的响应（本服务端不发反向请求）：忽略

    switch (method) {
      case "initialize": {
        const asked = message.params && message.params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL;
        this.initialized = true;
        this.reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
        });
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        // 规范里这两个是**通知**（没有 id），我们不回复。
        // 但实测有客户端（包括本仓库自带的测试脚本）会带 id 发通知 ——
        // 那时若不回包，调用方就会**永久挂起**（比报错更难查）。
        // 因此：带 id 的「通知」按空结果应答，无 id 的照旧静默。
        this.reply(id, {});
        return;
      case "ping":
        this.reply(id, {});
        return;
      case "tools/list":
        this.reply(id, { tools: this.tools });
        return;
      case "resources/list":
        this.reply(id, { resources: [] });
        return;
      case "prompts/list":
        this.reply(id, { prompts: [] });
        return;
      case "tools/call": {
        const params = message.params || {};
        const name = params.name;
        const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
        let result;
        try {
          // 关联位置而非 Host 授权；只转交白名单，不接纳 arguments 内的自报上下文。
          const c = params.carlosContext
          const context = c && typeof c === 'object' ? {
            session_id: c.session_id, workdir: c.workdir,
            workdir_is_local: c.workdir_is_local, workdir_is_read_only: c.workdir_is_read_only,
          } : undefined
          result = await this.callTool(name, args, context, runtime)
        } catch (e) {
          // 工具内部抛错 → 按 MCP 约定以「工具结果 + isError」返回，
          // 而不是 JSON-RPC 协议错误（后者会让宿主把整个会话当故障）。
          result = {
            content: [{ type: "text", text: "ERROR: " + (e && e.message ? e.message : String(e)) }],
            isError: true,
          };
        }
        this.reply(id, result);
        return;
      }
      default:
        // 带 id 的未知方法必须回错（否则客户端会一直等）；
        // 不带 id 的是通知，静默忽略。
        this.replyError(id, -32601, "Method not found: " + method);
    }
  }

  async start() {
    const input = process.stdin
    const rl = readline.createInterface({ input, crlfDelay: Infinity })
    let accepting = true
    let transportError
    let closeInput
    const stop = () => {
      if (!transportError) transportError = new Error('MCP输入传输失败，已等待在途操作收尾。')
      accepting = false
      rl.close()
      closeInput?.()
    }
    // readline转发与输入流本身的error都收敛，关闭事件不能越过已接收操作的finally。
    rl.on('error', stop)
    input.on('error', stop)
    try {
      await new Promise(resolve => {
        closeInput = resolve
        rl.on('line', line => {
          if (!accepting) return
          const text = line.trim()
          if (!text) return
          let message
          try { message = JSON.parse(text) } catch {
            this.log('收到无法解析的 JSON-RPC 行，已忽略')
            return
          }
          // 在同步line回调内捕获，绝不借JSON中的rpcId/function/signal补身份。
          const runtime = message?.method === 'tools/call' ? captureHashContext() : undefined
          const p = this.handle(message, runtime)
            .catch(e => this.log('处理消息失败：' + (e && e.message ? e.message : e)))
            .finally(() => this.pending.delete(p))
          this.pending.add(p)
        })
        rl.on('close', () => { accepting = false; resolve() })
      })
      // 同步收行回调返回后pending已登记；正常EOF与传输故障均先等全部收尾。
      await Promise.allSettled([...this.pending])
      if (transportError) throw transportError
    } finally {
      input.off('error', stop)
      rl.off('error', stop)
    }
  }
}

export function serveStdio(options) {
  return new StdioServer(options).start();
}