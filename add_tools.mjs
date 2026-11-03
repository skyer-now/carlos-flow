import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

const newTools = `  },

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

  // 11 -----------------------------------------------------------------------
  {
    name: "flow_save_result",
    description:
      "保存子 Agent（executor/auditor）的执行结果到会话目录。" +
      "主 Agent 通过 subagent 工具拿到结果后调用本工具持久化，便于后续审计与还原。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        role: { type: "string", enum: ["executor", "auditor"], description: "执行角色" },
        stdout: { type: "string", description: "子 Agent 的 stdout" },
        stderr: { type: "string", description: "子 Agent 的 stderr" },
        code: { type: "number", description: "退出码" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const role = a.role === "auditor" ? "auditor" : "executor";
        const file = saveAgentResult(sessionId, role, a.stdout, a.stderr, a.code);
        audit("run", sessionId, { kind: "agent_result", role, code: a.code, file });
        return ok({ ok: !!file, sessionId, role, file });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 12 -----------------------------------------------------------------------
  {
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
  },
];

// ---- 服务器装配 ------------------------------------------------------------`;

const oldEnd = `  },

  // 11 -----------------------------------------------------------------------
  {
    name: "flow_save_result",
    description:
      "保存子 Agent（executor/auditor）的执行结果到会话目录。" +
      "主 Agent 通过 subagent 工具拿到结果后调用本工具持久化，便于后续审计与还原。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        role: { type: "string", enum: ["executor", "auditor"], description: "执行角色" },
        stdout: { type: "string", description: "子 Agent 的 stdout" },
        stderr: { type: "string", description: "子 Agent 的 stderr" },
        code: { type: "number", description: "退出码" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const role = a.role === "auditor" ? "auditor" : "executor";
        const file = saveAgentResult(sessionId, role, a.stdout, a.stderr, a.code);
        audit("run", sessionId, { kind: "agent_result", role, code: a.code, file });
        return ok({ ok: !!file, sessionId, role, file });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 12 -----------------------------------------------------------------------
  {
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
  },
];

// ---- 服务器装配 ------------------------------------------------------------`;

content = content.replace(
  `  },

  // 11 -----------------------------------------------------------------------
  {
    name: "flow_save_result",
    description:
      "保存子 Agent（executor/auditor）的执行结果到会话目录。" +
      "主 Agent 通过 subagent 工具拿到结果后调用本工具持久化，便于后续审计与还原。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        role: { type: "string", enum: ["executor", "auditor"], description: "执行角色" },
        stdout: { type: "string", description: "子 Agent 的 stdout" },
        stderr: { type: "string", description: "子 Agent 的 stderr" },
        code: { type: "number", description: "退出码" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const role = a.role === "auditor" ? "auditor" : "executor";
        const file = saveAgentResult(sessionId, role, a.stdout, a.stderr, a.code);
        audit("run", sessionId, { kind: "agent_result", role, code: a.code, file });
        return ok({ ok: !!file, sessionId, role, file });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 12 -----------------------------------------------------------------------
  {
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
  },
];

// ---- 服务器装配 ------------------------------------------------------------`;

content = content.replace(oldEnd, newEnd);
console.log("New tools added: OK");

import fs from 'fs';
fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
console.log("All changes applied successfully");