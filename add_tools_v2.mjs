import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Find the position after flow_revert_plan tool (before the closing ] of TOOLS array)
const marker = `  },

  // 11 -----------------------------------------------------------------------
  {
    name: "flow_save_result",`;

const idx = content.indexOf(marker);
if (idx === -1) {
    console.error("ERROR: marker not found");
    process.exit(1);
}

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
  },`;

const insertPos = content.indexOf('  },', content.indexOf('flow_revert_plan')) + 2;
if (content.indexOf('flow_run_verify') !== -1) {
    console.log("Tools already added");
} else {
    const insertPos = content.indexOf('  },', content.indexOf('flow_revert_plan')) + 2;
    if (insertPos > 2) {
        content = content.slice(0, insertPos) + '\n' + newTools + '\n' + content.slice(insertPos);
        console.log("New tools inserted");
    } else {
        console.error("Could not find insertion point");
        process.exit(1);
    }
}

fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
console.log("New tools added successfully");