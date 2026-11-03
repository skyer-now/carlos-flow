import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// ============================================================
// 1. 更新 imports - 添加新函数
// ============================================================
const oldImports = `import { loadState, saveState, defaultState, audit, readAudit, getUserMessages, writeUserMessage, pathExists, gitHead, isStale } from "./state.js";
import { buildContractPrompt, snapshotFiles, readManifest, writeDispatchPrompt, saveAgentResult, MAX_DISPATCH } from "./dispatch.js";`;

const newImports = `import { loadState, saveState, defaultState, audit, readAudit, getUserMessages, writeUserMessage, pathExists, gitHead, isStale, isBypassed, verifyAuditChain } from "./state.js";
import { buildContractPrompt, snapshotFiles, readManifest, readManifestAll, writeDispatchPrompt, saveAgentResult, runVerifyCommand, enforceScope, MAX_DISPATCH } from "./dispatch.js";`;

content = content.replace(oldImports, newImports);
console.log("1. Imports updated: OK");

// ============================================================
// 2. 更新 TOOLS 数组 - 添加 flow_run_verify 和 flow_check_scope
// ============================================================
// 找到 TOOLS 数组的结束位置（在 flow_revert_plan 之后）
const oldToolsEnd = `  },
];

// ---- 服务器装配`;

const newToolsEnd = `  },

  // 13 -----------------------------------------------------------------------
  {
    name: "flow_run_verify",
    description:
      "执行卡片中指定的验证命令，返回执行结果（退出码、stdout、stderr）。" +
      "用于在派发 executor 后验证其工作成果，或手动触发验证。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);
        if (!state.card) return fail("没有留痕，无法执行验证。");
        if (!state.card.verify || !state.card.verify.cmd) return fail("卡片未指定验证命令。");
        
        const result = await runVerifyCommand(state.card.verify.cmd, a.cwd);
        // 保存验证结果供后续裁定参考
        const state2 = loadState(sessionId);
        state2.last_verify = {
          ts: new Date().toISOString(),
          cmd: state.card.verify.cmd,
          exitCode: result.exitCode,
          ok: result.ok,
        };
        saveState(sessionId, state2);
        
        return ok({ ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 14 -----------------------------------------------------------------------
  {
    name: "flow_check_scope",
    description:
      "检查指定文件列表是否在卡片 scope 范围内。用于在提交裁定前自查越界改动。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        paths: { type: "array", items: { type: "string" }, description: "要检查的文件路径列表" },
        cwd: { type: "string", description: "仓库工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);
        if (!state.card) return fail("没有留痕，无法检查 scope。");
        
        const scope = Array.isArray(state.card.scope) ? state.card.scope : [];
        const paths = Array.isArray(a.paths) ? a.paths : [];
        const result = enforceScope(scope, a.paths, a.cwd);
        
        return ok({ ok: result.ok, scope, checked: a.paths, ...result });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },
];

// ---- 服务器装配`;

content = content.replace(/  },\s*\n\s*\];\s*\n\s*\/\/\-+ 服务器装配/, newToolsEnd);
console.log("1. New tools added: OK");

// ============================================================
// 2. 更新 flow_bypass - 返回 bypass 状态供其他工具检查
// ============================================================
const oldBypass = `  {
    name: "flow_bypass",
    description:
      "开关免检模式（bypass）。当用户明确说“直接干 / 跳过门禁 / 免检 / 别管流程”时调用。" +
      "on=true 打开，on=false 关闭，每次开关都会写入审计流水并留下时间戳与理由。" +
      "仅在用户明确授权时使用，不要自行开启。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        on: { type: "boolean", description: "true 开启免检，false 关闭" },
        reason: { type: "string", description: "开启/关闭理由（建议写用户原话）" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);
        state.bypass = a.on === true;
        state.bypass_ts = Date.now();
        saveState(sessionId, state);
        audit("decision", sessionId, {
          kind: state.bypass ? "bypass_on" : "bypass_off",
          reason: a.reason,
        });
        return ok({ ok: true, bypass: state.bypass, reason: a.reason });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },`;

const newBypass = `  {
    name: "flow_bypass",
    description:
      "开关免检模式（bypass）。当用户明确说“直接干 / 跳过门禁 / 免检 / 别管流程”时调用。" +
      "on=true 打开，on=false 关闭，每次开关都会写入审计流水并留下时间戳与理由。" +
      "仅在用户明确授权时使用，不要自行开启。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        on: { type: "boolean", description: "true 开启免检，false 关闭" },
        reason: { type: "string", description: "开启/关闭理由（建议写用户原话）" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);
        state.bypass = a.on === true;
        state.bypass_ts = Date.now();
        saveState(sessionId, state);
        audit("decision", sessionId, {
          kind: state.bypass ? "bypass_on" : "bypass_off",
          reason: a.reason,
        });
        return ok({ ok: true, bypass: state.bypass, reason: a.reason });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },`;

content = content.replace(oldBypass, newBypass);
console.log("1. flow_bypass updated: OK");

// ============================================================
// 3. 更新 flow_audit - 添加 verifyAuditChain 调用
// ============================================================
const oldAudit = `  {
    name: "flow_audit",
    description:
      "读取审计流水（gate-audit/*.jsonl），返回事件列表与按 type / kind 的统计。可按 sessionId、type（run/finding/decision/resolution）、日期过滤。" +
      "不给 sessionId 则聚合全部会话。用于复核“到底派发了什么、改了什么、谁批的”，也用于事后追溯。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID；不传则聚合全部" },
        type: { type: "string", description: "事件类型过滤：run / finding / decision / resolution" },
        limit: { type: "number", description: "最多返回最近 N 条" },
        date: { type: "string", description: "YYYY-MM-DD，默认今天" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const opts = {};
        if (a.sessionId != null && a.sessionId !== "") opts.sessionId = a.sessionId;
        if (a.type != null && a.type !== "") opts.type = a.type;
        if (typeof a.limit === "number") opts.limit = a.limit;
        if (typeof a.date === "string" && a.date !== "") opts.date = a.date;

        const rows = readAudit(opts);
        const by_type = {};
        const by_kind = {};
        for (const row of rows) {
          const t = row.type || "none";
          by_type[t] = (by_type[t] || 0) + 1;
          const k = row.kind || "none";
          by_kind[k] = (by_kind[k] || 0) + 1;
        }
        return ok({ total: rows.length, by_type, by_kind, events: rows });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },`;

const newAudit = `  {
    name: "flow_audit",
    description:
      "读取审计流水（gate-audit/*.jsonl），返回事件列表与按 type / kind 的统计。可按 sessionId、type（run/finding/decision/resolution）、日期过滤。" +
      "不给 sessionId 则聚合全部会话。用于复核“到底派发了什么、改了什么、谁批的”，也用于事后追溯。" +
      "同时可验证审计链完整性。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID；不传则聚合全部" },
        type: { type: "string", description: "事件类型过滤：run / finding / decision / resolution" },
        limit: { type: "number", description: "最多返回最近 N 条" },
        date: { type: "string", description: "YYYY-MM-DD，默认今天" },
        verifyChain: { type: "boolean", description: "是否验证审计链完整性" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const opts = {};
        if (a.sessionId != null && a.sessionId !== "") opts.sessionId = a.sessionId;
        if (a.type != null && a.type !== "") opts.type = a.type;
        if (typeof a.limit === "number") opts.limit = a.limit;
        if (typeof a.date === "string" && a.date !== "") opts.date = a.date;

        const rows = readAudit(opts);
        const by_type = {};
        const by_kind = {};
        for (const row of rows) {
          const t = row.type || "none";
          by_type[t] = (by_type[t] || 0) + 1;
          const k = row.kind || "none";
          by_kind[k] = (by_kind[k] || 0) + 1;
        }

        let chainResult = null;
        if (a.verifyChain) {
          chainResult = verifyAuditChain(opts);
        }

        return ok({ total: rows.length, by_type, by_kind, events: rows, chain: chainResult });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },`;

content = content.replace(oldAudit, newAudit);
console.log("2. flow_audit updated: OK");

// ============================================================
// 3. 更新 flow_revert_plan - 使用 readManifestAll
// ============================================================
const oldRevert = `  {
    name: "flow_revert_plan",
    description:
      "根据本次会话的快照 manifest 生成还原计划：新建文件（created）→ delete，原有文件 → 从 backup 恢复到 orig。" +
      "只返回计划，绝不自动执行；实际还原需人工确认后按 plan 操作。用于改动出问题需要回滚的场景。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";

        const entries = readManifest(sessionId);
        const plan = [];
        for (const entry of entries) {
          if (!entry) continue;
          if (entry.created === true) {
            plan.push({ action: "delete", target: entry.orig, source: null });
          } else {
            plan.push({ action: "restore", source: entry.backup, target: entry.orig });
          }
        }
        return ok({
          sessionId,
          count: plan.length,
          plan,
          note: "这是还原计划，不会自动执行；实际还原需人工确认后按 plan 操作。",
        });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },`;

const newRevert = `  {
    name: "flow_revert_plan",
    description:
      "根据本次会话的完整快照 manifest 生成还原计划：新建文件（created）→ delete，原有文件 → 从 backup 恢复到 orig。" +
      "只返回计划，绝不自动执行；实际还原需人工确认后按 plan 操作。用于改动出问题需要回滚的场景。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";

        const entries = readManifestAll(sessionId);
        const plan = [];
        for (const entry of entries) {
          if (!entry) continue;
          if (entry.created === true) {
            plan.push({ action: "delete", target: entry.orig, source: null });
          } else {
            plan.push({ action: "restore", source: entry.backup, target: entry.orig });
          }
        }
        return ok({
          sessionId,
          count: plan.length,
          plan,
          note: "这是还原计划，不会自动执行；实际还原需人工确认后按 plan 操作。",
        });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },`;

content = content.replace(oldRevert, newRevert);
console.log("3. flow_revert_plan updated: OK");

// ============================================================
// 3. 更新 flow_dispatch - 检查 bypass 状态，增加 write_files 计数
// ============================================================
const oldDispatch = `        handler: async (args) => {
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

        if (!state.card) return fail("没有留痕，不允许派发。");`;

const newDispatch = `        handler: async (args) => {
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

        // Phase 1-1: bypass 检查
        if (!isBypassed(state)) {
          if (isStale(state)) return fail("留痕已过期（stale），请重新提交任务卡。");
          if (state.dispatch_count >= MAX_DISPATCH) return fail("派发次数已达上限 " + MAX_DISPATCH + "，停止派发并向用户汇报。");
          // 简单检查是否有过 claim（dispatch_count > 0 视为已 claim）
          if ((Number(state.dispatch_count) || 0) === 0) return fail("未 claim，请先 flow_claim 领取派发名额。");
        }

        const role = a.role === "auditor" ? "auditor" : "executor";
        const cwd = a.cwd || process.cwd();
        const state = loadState(sessionId);

        if (!state.card) return fail("没有留痕，不允许派发。");

        
            // Phase 1-1: dispatch 时才增加 dispatch_count
            state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
            // Phase 1-1: 写文件计数器自增（估算，实际由 executor 汇报）
            state.write_files = (Number(state.write_files) || 0) + 1;
            saveState(sessionId, state);`;

content = content.replace(oldDispatch, newDispatch);
console.log("2. flow_dispatch updated: OK");

// ============================================================
// 3. 更新 flow_claim - 添加 write_files 追踪
// ============================================================
const oldClaim = `        handler: async (args) => {
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
              saveState(sessionId, state);`;

const newClaim = `        handler: async (args) => {
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
              // Phase 1-1: 初始化 write_files 计数器
              state.write_files = 0;
              saveState(sessionId, state);`;

content = content.replace(oldClaim, newClaim);
console.log("3. flow_claim updated: OK");

// ============================================================
// 4. 在文件末尾 - 添加 imports 已在前面完成
// ============================================================
console.log("All Phase 1-2 updates applied");

fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
console.log("All changes applied successfully");