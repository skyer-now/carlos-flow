// chip 两段式目录（main.js）—— 分发回归测试
//
// 为什么必须有这套测试：Cindy 对 tools 声明有硬上限 16 项，本插件有 20 个操作，
// 所以改成「只声明 list_tools / call_tool，目录与分发表在 main.js」。
// 这条链路一旦断了，用户在 Cindy 里**一个门禁操作都点不到**，而 src/index.js 的单测全绿
// —— 属于典型的「实现没问题、接线断了」事故。
//
// 做法：真的起随包 MCP 服务端（src/index.js），再用一个最小 `cindy` 桩在 vm 里执行
// main.js（沙箱里只有一个全局 cindy）。这样测的是**真实链路**，不是 mock 出来的假链路。
//
// 跑法：node test/cindy-dispatch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpClient } from "./_mcp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-dispatch-home-"));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const server = startMcpClient({
  entry: path.join(ROOT, "src", "index.js"),
  cwd: ROOT,
  env: { CARLOS_FLOW_HOME: HOME },
});

// ---- 最小 cindy 桩：只提供 main.js 真正用到的东西 ----
let handler = null;
const sent = [];
const cindy = {
  onHostMessage(cb) { handler = cb; },
  send(msg) { sent.push(msg); },
  node: {
    async request(req) {
      if (req.method === "tools/list") {
        const res = await server.request("tools/list", req.params || {});
        return res.error ? { ok: false, message: JSON.stringify(res.error) } : { ok: true, result: res.result };
      }
      if (req.method === "tools/call") {
        const res = await server.request("tools/call", req.params || {});
        return res.error ? { ok: false, message: JSON.stringify(res.error) } : { ok: true, result: res.result };
      }
      return { ok: false, message: "桩不支持的方法：" + req.method };
    },
  },
};

const sandbox = { cindy, setInterval, clearInterval, console };
vm.createContext(sandbox);
const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
vm.runInContext(mainSrc, sandbox, { filename: "main.js" });

let callId = 0;
async function invoke(tool, args) {
  sent.length = 0;
  callId++;
  await handler({ type: "tool-call", tool, args, callId: "c" + callId });
  return sent[sent.length - 1];
}

try {
  await server.initialize();

  check("1. main.js 注册了 tool-call 处理器", typeof handler === "function");

  // 2. 概览
  const overview = await invoke("list_tools", {});
  const ov = overview && overview.result;
  const names = (ov && ov.categories ? ov.categories.map((c) => c.name) : []).join(",");
  check("2a. list_tools 不传 category 返回概览", !!(ov && ov.categories));
  check("2b. 类目为 gate/verify/audit/infra/trigger",
    names === "gate,verify,audit,infra,trigger", names);
  const expectedTotal = [...new Set([...fs.readFileSync(path.join(ROOT, "src", "index.js"), "utf8")
    .matchAll(/name:\s*"(flow_[a-z_]+)"/g)].map((m) => m[1]))].length;
  check(`2c. 概览里的操作总数与源码一致（${expectedTotal}）`, ov && ov.total === expectedTotal, String(ov && ov.total));
  check("2d. 概览给出下一步提示", !!(ov && ov.hint));

  // 3. 类目下钻：必须同时给工具明细与 RULES
  const gate = await invoke("list_tools", { category: "gate" });
  const g = gate && gate.result;
  check("3a. 下钻返回该类目工具明细", !!(g && Array.isArray(g.tools) && g.tools.length === 4),
    g ? `${g.tool_count} 个` : "");
  check("3b. 明细里带参数 schema（可直接照着填）",
    !!(g && g.tools.every((t) => t.parameters && t.parameters.type === "object")));
  check("3c. 同一份结果里下发 RULES（手册硬要求）",
    !!(g && Array.isArray(g.rules) && g.rules.length >= 2), g ? `${g.rules.length} 条` : "");
  check("3d. RULES 讲的是门禁关键约束（留痕/auditor/scope）",
    !!(g && g.rules.join(" ").includes("留痕") && g.rules.join(" ").includes("auditor")));

  // 4. 未知类目 → 可操作的错误
  const badCat = await invoke("list_tools", { category: "nope" });
  check("4a. 未知类目返回 ok:false", badCat && badCat.ok === false);
  check("4b. 错误里列出可用类目", /gate/.test(String(badCat && badCat.message)));

  // 5. call_tool 正常转发
  const proto = await invoke("call_tool", { name: "flow_protocol", args: {} });
  const protoText = proto && proto.result && proto.result.mcpResult
    && proto.result.mcpResult.content && proto.result.mcpResult.content[0]
    && proto.result.mcpResult.content[0].text;
  check("5a. call_tool 原样透传 MCP 结果（mcpResult）",
    proto && proto.ok === true && !!protoText, protoText ? `${String(protoText).length} 字符` : "");
  check("5b. 透传结果能解析出协议内容（真的跑到了服务端）",
    /ROUTE_TABLE/.test(String(protoText)));

  // 6. 未知操作名 → 附全部可用操作名 + 回查提示
  const unknown = await invoke("call_tool", { name: "flow_不存在" });
  check("6a. 未知操作返回 ok:false", unknown && unknown.ok === false);
  check(`6b. 未知操作附全部可用操作名（${expectedTotal} 个）`,
    unknown && unknown.result && Array.isArray(unknown.result.available_tools)
      && unknown.result.available_tools.length === expectedTotal,
    unknown && unknown.result ? `${unknown.result.available_tools.length} 个` : "");
  check("6c. 提示先 list_tools 回查", /list_tools/.test(String(unknown && unknown.message)));

  // 7. 缺必填参数 → 附 schema + 规则（自纠所需）
  const missing = await invoke("call_tool", { name: "flow_mode", args: {} });
  check("7a. 缺必填参数返回 ok:false", missing && missing.ok === false);
  check("7b. 错误指出缺哪个字段", /mode/.test(String(missing && missing.message)));
  check("7c. 附该操作的参数 schema", !!(missing && missing.result && missing.result.schema
    && missing.result.schema.properties && missing.result.schema.properties.mode));
  check("7d. 附所属类目 RULES", !!(missing && missing.result && Array.isArray(missing.result.rules)
    && missing.result.rules.length > 0));

  // 8. args 类型不合法
  const badArgs = await invoke("call_tool", { name: "flow_status", args: "不是对象" });
  check("8a. args 非对象时返回 ok:false 且附 schema", badArgs && badArgs.ok === false
    && !!(badArgs.result && badArgs.result.schema));

  // 9. 服务端返回的工具级失败仍被如实透传（isError 不被吞）
  const toolErr = await invoke("call_tool", { name: "flow_claim", args: { role: "executor" } });
  const mcpErr = toolErr && toolErr.ok === true && toolErr.result && toolErr.result.mcpResult;
  check("9a. 工具级错误（未留痕）如实透传 isError",
    !!(mcpErr && mcpErr.isError === true),
    mcpErr ? String((mcpErr.content || [])[0] && (mcpErr.content[0].text || "")).slice(0, 40) : "无结果");

  // 10. 非本插件的元工具调用要有明确指引
  const wrongTool = await invoke("something_else", {});
  check("10. 未知元工具返回指引（指向 call_tool）",
    wrongTool && wrongTool.ok === false && /call_tool/.test(String(wrongTool.message)));
} finally {
  await server.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("CINDY_DISPATCH_OK");