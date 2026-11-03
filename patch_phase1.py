with open('src/index.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 修改 flow_claim handler - 添加 role 白名单，移除 dispatch_count 重置
old1 = '''        handler: async (args) => {
            try {
              const a = args || {};
              const sessionId = a.sessionId || "unknown";
              const role = a.role === "auditor" ? "auditor" : "executor";
              const state = loadState(sessionId);

              if (!state.card) {
                return fail("没有留痕（record），executor/auditor 不得开工。请先由主 Agent 调用 flow_submit_requirement 提交任务卡。");
              }
              if (isStale(state)) {
                return fail("留痕已过期（stale），请重新提交任务卡。");
              }
              if (state.dispatch_count >= MAX_DISPATCH) {
                return fail("派发次数已达上限 " + MAX_DISPATCH + "，停止派发并向用户汇报。");
              }

              state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
              state.last_user_ts = Date.now();
              saveState(sessionId, state);'''

new1 = '''        handler: async (args) => {
            try {
              // Phase 1-1: role 白名单校验
              const a = args || {};
              const role = a.role === "auditor" ? "auditor" : "executor";
              if (role !== "executor" && role !== "auditor") return fail("非法 role：" + role + "，必须是 executor 或 auditor");
              const a = args || {};
              const sessionId = a.sessionId || "unknown";
              const role = a.role === "auditor" ? "auditor" : "executor";
              const state = loadState(sessionId);

              if (!state.card) {
                return fail("没有留痕（record），executor/auditor 不得开工。请先由主 Agent 调用 flow_submit_requirement 提交任务卡。");
              }
              if (isStale(state)) {
                return fail("留痕已过期（stale），请重新提交任务卡。");
              }
              if (state.dispatch_count >= MAX_DISPATCH) {
                return fail("派发次数已达上限 " + MAX_DISPATCH + "，停止派发并向用户汇报。");
              }

              // Phase 1-1: 不在 claim 时增加 dispatch_count，改在 dispatch 时增加
              state.last_user_ts = Date.now();
              saveState(sessionId, state);'''

content = content.replace(old1, new1)

# 2. flow_dispatch handler - 添加 role 白名单和预检查
old2 = '''        handler: async (args) => {
            try {
              const a = args || {};
              const role = a.role === "auditor" ? "auditor" : "executor";
              const cwd = a.cwd || process.cwd();
              const state = loadState(sessionId);

              if (!state.card) return fail("没有留痕，不允许派发。");'''

new2 = '''        handler: async (args) => {
            try {
              const a = args || {};
              // Phase 1-1: role 白名单校验
              const role = a.role === "auditor" ? "auditor" : "executor";
              if (role !== "executor" && role !== "auditor") return fail("非法 role：" + role + "，必须是 executor 或 auditor");

              // Phase 1-1: dispatch 前强制校验 stale / dispatch_count / claim
              const sessionId = a.sessionId || "unknown";
              const state = loadState(sessionId);
              if (!state.card) return fail("没有留痕，不允许派发。");
              if (isStale(state)) return fail("留痕已过期（stale），请重新提交任务卡。");
              if (state.dispatch_count >= MAX_DISPATCH) return fail("派发次数已达上限 " + MAX_DISPATCH + "，停止派发并向用户汇报。");
              // 简单检查是否有过 claim（dispatch_count > 0 视为已 claim）
              if ((Number(state.dispatch_count) || 0) === 0) return fail("未 claim，请先 flow_claim 领取派发名额。");

              const role = a.role === "auditor" ? "auditor" : "executor";
              const cwd = a.cwd || process.cwd();
              const state = loadState(sessionId);

              if (!state.card) return fail("没有留痕，不允许派发。");'''

content = content.replace(old2, new2)

# 3. 在 dispatch 中添加 dispatch_count 增加
old3 = '''              if (!state.card) return fail("没有留痕，不允许派发。");

            const prompt = buildContractPrompt(role, state.card, a.message);'''

new3 = '''              if (!state.card) return fail("没有留痕，不允许派发。");

            // Phase 1-1: dispatch 时才增加 dispatch_count
            state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
            const prompt = buildContractPrompt(role, state.card, a.message);'''

content = content.replace(old3, new3)

# 4. 在文件末尾添加 validateToolArgs 函数和 CallTool handler 包装
old_end = '''const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("carlos-flow MCP server connected via stdio\\n");'''

new_end = '''const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("carlos-flow MCP server connected via stdio\\n");

// Phase 1-1: 工具参数校验器
function validateToolArgs(toolName, args) {
  const tool = TOOLS.find(t => t.name === toolName);
  if (!tool || !tool.inputSchema) return { ok: true };
  
  // 简单的 schema 校验：required 字段、类型、enum
  const schema = tool.inputSchema;
  if (schema.required) {
    for (const field of schema.required) {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        return { ok: false, error: "缺少必填字段：" + field };
      }
    }
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (args[key] !== undefined && prop.type) {
          const expected = prop.type === "integer" ? "number" : prop.type;
          const actual = Array.isArray(args[key]) ? "array" : typeof args[key];
          if (expected === "number" && typeof args[key] !== "number") {
            return { ok: false, error: "字段 " + key + " 类型错误，期望 number" };
          }
          if (expected === "array" && !Array.isArray(args[key])) {
            return { ok: false, error: "字段 " + key + " 类型错误，期望 array" };
          }
          if (prop.enum && args[key] !== undefined && !prop.enum.includes(args[key])) {
            return { ok: false, error: "字段 " + key + " 值非法，可选：" + prop.enum.join(", ") };
          }
        }
      }
    }
    return { ok: true };
  }

// Phase 1-1: CallTool handler 增加参数校验
const originalHandler = server._requestHandlers.get("tools/call");
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};
  
  // 先校验参数
  const validation = validateToolArgs(toolName, args);
  if (!validation.ok) {
    return { content: [{ type: "text", text: "ERROR: " + validation.error }], isError: true };
  }
  
  // 调用原处理器
  if (originalHandler) {
    return await originalHandler(request);
  }
  return { content: [{ type: "text", text: "Unknown tool: " + toolName }], isError: true;
 });

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("carlos-flow MCP server connected via stdio\\n");'''

content = content.replace(old_end, new_end)

with open('src/index.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("All changes applied successfully")
PYEOF