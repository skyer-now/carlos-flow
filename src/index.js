// MCP 服务入口：目录装配、参数校验、请求补偿与传输。
import { createCatalog, createExternalCatalog } from './handlers/catalog.js'
import {
  auditRequests,
  auditIdentity,
  bindAuditVersion,
  pendingAuditEntries,
  historicalAuditEntries,
  isCurrentAuditFailure,
  recoverRequestAudit,
  log,
  ok,
  readFileSync,
  serveStdio,
  loadProjectSensitiveConfig,
  loadState,
  commitState,
  formatError,
  path,
} from './handlers/shared.js'
// 工具面：默认保持 26 个底层操作（兼容已发布的客户端契约）；
// 设 CARLOS_FLOW_TOOL_SURFACE=external 时只暴露四个门面（v3.0.0 的默认形态）。
// 分发集合必须始终包含全部底层操作：门面只是“对外可见面”，
// 其动作仍要经统一校验入口路由到内部实现。把两者混成一个数组会让
// external 面下所有门面动作都返回 Unknown tool（真实缺陷，已修）。
const ALL_TOOLS = createCatalog(callTool)
const TOOLS =
  String(process.env.CARLOS_FLOW_TOOL_SURFACE || '').toLowerCase() === 'external'
    ? createExternalCatalog(callTool)
    : ALL_TOOLS
// ---- 工具去重自检 ----------------------------------------------------------
//
// TOOLS 数组里出现两个同名工具定义时：
// 路由用 TOOLS.find((t) => t.name === name) **只取第一个匹配项**，
// 后一份健壮实现就成了永不执行的死代码 —— 而整个过程**没有任何报错**，
// 属于静默失效，非常危险。
//
// 这里在模块加载时做一次硬校验：一旦发现重名就抛出带明确信息的 Error
// （指出工具名 + 首次/重复出现的索引），让 MCP server 拒绝启动。
// 正常情况下（无重名）不产生任何副作用，直接返回 true。
function assertNoDuplicateTools(tools = TOOLS) {
  const seen = new Map() // 工具名 -> 首次出现的索引
  const dups = [] // { name, first, second }
  tools.forEach((tool, idx) => {
    const key = tool && tool.name
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        'TOOLS[' + idx + '] 缺少合法的 name 字段，无法完成工具去重校验',
      )
    }
    if (seen.has(key)) {
      dups.push({ name: key, first: seen.get(key), second: idx })
    } else {
      seen.set(key, idx)
    }
  })
  if (dups.length > 0) {
    const detail = dups
      .map(
        (d) =>
          '「' +
          d.name +
          '」（首次出现于 TOOLS[' +
          d.first +
          ']，重复出现于 TOOLS[' +
          d.second +
          ']）',
      )
      .join('、')
    throw new Error(
      'TOOLS 中存在重复的工具名：' +
        detail +
        ' —— 重名会导致 TOOLS.find() 只路由到第一份，后一份成为永不执行的死代码。已拒绝启动 MCP server。',
    )
  }
  return true
}

// 启动前自检：重名即拒绝启动，并打印清晰错误（不静默失效）。
try {
  assertNoDuplicateTools()
} catch (e) {
  process.stderr.write(
    '[carlos-flow] 致命错误：工具定义校验失败，MCP server 拒绝启动 —— ' +
      (e && e.message ? e.message : String(e)) +
      '\n',
  )
  throw e
}

// ---- 服务器装配 ------------------------------------------------------------

// server 版本号必须从 package.json 读：写死版本号会让客户端 initialize
// 拿到错版本，无法据此判断真实能力。
const pkgVersion = (() => {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(pkgUrl, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// 对外工具清单（tools/list 的载荷）：**绝不能**把 handler 带出去 ——
// 它是函数，序列化后会变成 undefined 或被宿主拒收。
const TOOL_SCHEMAS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}))

// ⚠️ 必须守住：不得重复装配 handler（后装配的会覆盖先装配的），
// 否则参数校验（required / 类型 / enum）静默失效。
// 口径：只有 `callTool` 一条通路，且它**必须先过 validateToolArgs**。
// check:no-dead-handler 门禁守着「按 name 分发 + 真的调用了参数校验」这两点。

// ---- Phase 1-1: 工具参数校验器（required 字段 / 类型 / enum）----
function validateToolArgs(toolName, args) {
  // 校验也查完整目录：门面动作的目标工具不在对外可见面里，但必须被校验。
  const tool = ALL_TOOLS.find((t) => t.name === toolName)
  if (!tool || !tool.inputSchema) return { ok: true }
  const schema = tool.inputSchema
  function validate(schema, value, field = 'arguments') {
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${field} 类型错误，期望 object`
      for (const key of schema.required || []) {
        if (value[key] === undefined || value[key] === null || value[key] === '') return '缺少必填字段：' + key
      }
      if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties || {}, key)))
        return `${field} 包含未知字段`
      for (const [key, child] of Object.entries(schema.properties || {})) {
        if (value[key] === undefined) continue
        const error = validate(child, value[key], `${field}.${key}`)
        if (error) return error
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(value)) return `${field} 类型错误，期望 array`
      for (let i = 0; i < value.length; i++) {
        const error = validate(schema.items || {}, value[i], `${field}[${i}]`)
        if (error) return error
      }
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)))
        return `${field} 类型错误，期望 ${schema.type}`
      if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))
        return `${field} 超出允许范围`
    } else if (schema.type && typeof value !== schema.type) return `${field} 类型错误，期望 ${schema.type}`
    if (schema.enum && !schema.enum.includes(value)) return `${field} 值非法，可选：${schema.enum.join(', ')}`
    return null
  }
  const recursiveError = validate(schema, args)
  if (recursiveError) return { ok: false, error: recursiveError }

  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      const v = args[field]
      if (v === undefined || v === null || v === '') {
        return { ok: false, error: '缺少必填字段：' + field }
      }
    }
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const v = args[key]
      if (v === undefined || v === null) continue
      if (prop.type) {
        const expected = prop.type === 'integer' ? 'number' : prop.type
        if (expected === 'number' && typeof v !== 'number') {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 number' }
        }
        if (expected === 'array' && !Array.isArray(v)) {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 array' }
        }
        if (expected === 'string' && typeof v !== 'string') {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 string' }
        }
        if (expected === 'boolean' && typeof v !== 'boolean') {
          return { ok: false, error: '字段 ' + key + ' 类型错误，期望 boolean' }
        }
      }
      // 数组**元素**类型校验：schema 已声明 items:{type:"string"} 时，
      // 只校验顶层 array 类型是不够的 —— 元素类型不符会一路传到 Node 内部
      // 才报错（例：flow_check_scope 的 paths:["README.md",123] 会抛
      // "The \"path\" argument must be of type string" 这种底层错误），
      // 调用方拿到的是不可读的堆栈信息。改为在入口就给出明确提示。
      // 注意：**null 也要拦**（typeof null !== "string"）—— 否则 unknowns=[null]
      // 这类值会静默落盘（虽然不参与档位必填、不进 executor 合同文本，
      // 但会在 flow_status 回显整卡时露出 null 元素）。
      if (
        prop.type === 'array' &&
        Array.isArray(v) &&
        prop.items &&
        prop.items.type
      ) {
        const want = prop.items.type === 'integer' ? 'number' : prop.items.type
        for (let i = 0; i < v.length; i++) {
          const el = v[i]
          if (el === undefined) continue
          const bad =
            (want === 'number' && typeof el !== 'number') ||
            (want === 'string' && typeof el !== 'string') ||
            (want === 'boolean' && typeof el !== 'boolean') ||
            (want === 'object' &&
              (typeof el !== 'object' || el === null || Array.isArray(el)))
          if (bad) {
            return {
              ok: false,
              error: '字段 ' + key + '[' + i + '] 类型错误，期望 ' + want,
            }
          }
        }
      }
      if (prop.enum && !prop.enum.includes(v)) {
        return {
          ok: false,
          error: '字段 ' + key + ' 值非法，可选：' + prop.enum.join(', '),
        }
      }
    }
  }
  return { ok: true }
}



// ---- CallTool：先校验参数，再分发到工具 handler ----
async function callTool(toolName, args = {}, context, runtime) {
  // 路由与校验一律查完整目录，不受对外可见面影响。
  const t = ALL_TOOLS.find((x) => x.name === toolName)
  if (!t) {
    return {
      content: [{ type: 'text', text: 'Unknown tool: ' + toolName }],
      isError: true,
    }
  }

  const validation = validateToolArgs(toolName, args)
  if (!validation.ok) {
    return {
      content: [{ type: 'text', text: 'ERROR: ' + validation.error }],
      isError: true,
      structuredContent: {
        ok: false,
        code: 'INVALID_TOOL_ARGUMENTS',
        tool: toolName,
        error: validation.error,
        missing: (t.inputSchema.required || []).filter(field => args?.[field] === undefined || args?.[field] === null || args?.[field] === ''),
        schema: t.inputSchema,
        originalArguments: structuredClone(args),
        instructions: '依据 Schema 修正参数，保留已填字段；缺少授权、范围或验收事实时向用户澄清，不自动生成或确认。',
      },
    }
  }

  // 项目级敏感路径扩展：从 cwd 逐级向上找 `.carlos.json`（只追加，不能缩减）。
  // 放在这里统一加载，保证同一请求里所有路径判定用同一份规则；
  // 配置缺失 / 损坏时自动退回内置基线，不影响门禁。
  try {
    loadProjectSensitiveConfig(
      typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd(),
    )
  } catch {
    /* 配置不可读：保持内置基线 */
  }

  return auditRequests.run([], async () => {
    let result
    let error
    try {
      // 捕获原请求版本；等待期间换卡也不能静默丢失旧卡未确认事件。
      const sid = args.sessionId || 'unknown'
      bindAuditVersion(sid, loadState(sid))
      auditRequests.getStore().tool = toolName
      auditRequests.getStore().identity = auditIdentity({ toolName, args, cwd: process.cwd() })
      if (runtime?.failure && (toolName === 'flow_run_verify' || toolName === 'flow_falsify' ||
          (toolName === 'flow_verdict' && args.verdict === 'PASS')))
        throw new Error('Host固定哈希能力不可用，未执行操作。')
      const recovered = await recoverRequestAudit(sid)
      if (!recovered) bindAuditVersion(sid, loadState(sid)) // recovery 的 await 后，handler 才实际接纳卡。
      result = recovered ? ok(recovered) : await t.handler(args, context, runtime)
    } catch (e) {
      error = e && e.message ? e.message : String(e)
    }
    // handler（包括其 catch）已返回，所有状态临界区均已释放。
    // 失败仍返回失败；补记失败不能被原 handler 的成功回执遮掩。
    for (const failure of auditRequests.getStore()) {
      error = `审计未确认持久化，请重试并复核状态: ${failure.error}`
      try {
        await commitState(failure.sid, (latest) => {
          // 即使等待期间换卡，旧事件也必须保留；不得覆盖并发失败或新证据。
          const entries = pendingAuditEntries(latest)
          const history = historicalAuditEntries(latest)
          if (entries.some(e => e.id === failure.id) || history.some(e => e.id === failure.id)) return
          if (isCurrentAuditFailure(failure, latest)) {
            entries.push(failure)
            latest.completed_ok = false
            latest.audit_pending = {
              kind: 'events', entries,
              retry: '使用相同原操作及参数重试：仅补记匹配事件，不重跑业务；随后核对 flow_status 与产物',
            }
          } else {
            // 原卡 CAS 不匹配：只留历史事件，绝不触碰新卡完成/验证/领取。
            latest.audit_history_pending = [...history, failure]
          }
        })
      } catch (e) {
        error += `；失败状态补记也未持久化: ${e && e.message ? e.message : String(e)}`
      }
    }
    return error
      ? {
          content: [{ type: 'text', text: 'ERROR: ' + formatError(error) }],
          isError: true,
        }
      : result
  })
}

// ---- 传输模式：stdio（逐行 JSON-RPC 2.0） ----
// 启动日志必须在 await 之前写：serveStdio 会一直阻塞到 stdin 关闭（宿主退出），
// 写在后面等于「只在退出时打印」，排查时看不到任何启动痕迹。
process.stderr.write('carlos-flow MCP server ready (stdio)\n')
// ⚠️ 这里**不能**用顶层 await。
// 实测：Cindy 的随包 Node 进程用 require() 加载入口，
// ESM 图里只要有顶层 await，require 就抛 ERR_REQUIRE_ASYNC_MODULE，
// 插件表现为「一调就 Node 工作进程已退出」。
// serveStdio 返回的 Promise 不 await 也没关系：readline 订阅着 stdin，
// 进程不会被事件循环判定为空闲而退出；失败走 catch 落 stderr + 非零退出码。
serveStdio({
  name: 'carlos-flow',
  version: pkgVersion,
  tools: TOOL_SCHEMAS,
  callTool,
  log,
}).catch((e) => {
  try {
    process.stderr.write(
      '[carlos-flow] stdio 服务端异常退出：' +
        (e && e.message ? e.message : e) +
        '\n',
    )
  } catch {
    /* stderr 不可写时静默 */
  }
  process.exitCode = 1
})
