// carlos-flow MCP server — stdio transport.
// Carlos 工作流的机械门禁工具集（留痕 / 派发 / 裁定 / 审计 / 快照还原计划）。
// 重要：stdout 是 MCP 传输通道，所有日志一律走 stderr。
import { spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PROTOCOL } from "./protocol.js";
import { parseCard, validateCard, riskTier, isSensitive } from "./card.js";
import { loadState, saveState, defaultState, audit, readAudit, getUserMessages, writeUserMessage, pathExists, gitHead, isStale, isBypassed, verifyAuditChain } from "./state.js";
import { buildContractPrompt, snapshotFiles, readManifest, readManifestAll, writeDispatchPrompt, saveAgentResult, runVerifyCommand, enforceScope, MAX_DISPATCH } from "./dispatch.js";

const log = (msg) => {
  try {
    process.stderr.write(`[carlos-flow] ${msg}\n`);
  } catch {
    /* stderr 不可写时静默 */
  }
};

// ---- 通用工具函数 ----------------------------------------------------------

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (message) => ({ content: [{ type: "text", text: "ERROR: " + String(message) }], isError: true });

const asStringArray = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

const TOOLS = [
  // 1 -----------------------------------------------------------------------
  {
    name: "flow_protocol",
    description:
      "读取 Carlos 工作流协议全文（路由档位 T0/T1/T2、四段合同、报告规格、错误分层、状态字段、审计事件类型、免检触发词、任务卡模板）。" +
      "当你不确定该走哪一档、任务卡该怎么写、executor/auditor 报告格式或门禁规则时，先调用本工具拿到权威定义，不要凭记忆猜。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => ok({ protocol: PROTOCOL }),
  },

  // 2 -----------------------------------------------------------------------
  {
    name: "flow_submit_requirement",
    description:
      "提交（留痕）一张任务卡，作为后续派发的唯一依据。任何 T2 改动前必须先调用本工具。" +
      "可以传结构化参数（goal/quote/scope/acceptance/unknowns/assumptions/files/verify/confirmed），" +
      "也可以直接传 cardText（形如 FLOW_CARD:{...} 的单行 JSON）。" +
      "本工具会做锚点校验（quote 必须能在用户原话里定位）、scope 路径存在性校验、必填字段校验、敏感路径确认；" +
      "校验不通过会返回 ok:false 与 findings，此时不得派发。返回 ok:true 表示留痕成功，可以继续调 flow_claim。",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "一句话目标（任务卡 objective）" },
        quote: { type: "string", description: "用户原话摘录，用于锚点校验，必须能在用户消息中定位" },
        scope: { type: "array", items: { type: "string" }, description: "只准改动的文件清单（相对 cwd 的路径）" },
        acceptance: { type: "array", items: { type: "string" }, description: "可判定的验收标准" },
        unknowns: { type: "array", items: { type: "string" }, description: "未知/待澄清事项" },
        assumptions: { type: "array", items: { type: "string" }, description: "已做的假设" },
        files: {
          type: "array",
          description: "关键定位点，每项需带 path 与 line",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "number" },
            },
            required: ["path", "line"],
          },
        },
        verify: { type: "object", properties: { cmd: { type: "string" } }, description: "主 Agent 指定的验证命令" },
        confirmed: { type: "boolean", description: "敏感路径是否已获用户确认（sensitive 档必须为 true）" },
        parallel_plan: { type: "string", description: "并行派发计划说明（可选）" },
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
        userMessages: { type: "array", items: { type: "string" }, description: "用户原话列表（可选，会与自动读取的结果合并）" },
        cardText: { type: "string", description: "完整任务卡文本，含 FLOW_CARD: 前缀；提供时优先于结构化参数" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const cwd = a.cwd || process.cwd();

        let card = null;
        if (typeof a.cardText === "string" && a.cardText.trim() !== "") {
          const parsed = parseCard(a.cardText);
          if (parsed && parsed.error) return fail(parsed.error);
          if (!parsed || !parsed.card) return fail("FLOW_CARD 解析失败：请按模板重写（单行 JSON，英文双引号）。");
          card = parsed.card;
        } else {
          card = {
            goal: a.goal,
            quote: a.quote,
            scope: asStringArray(a.scope),
            acceptance: asStringArray(a.acceptance),
            unknowns: asStringArray(a.unknowns),
            assumptions: asStringArray(a.assumptions),
            files: Array.isArray(a.files) ? a.files : [],
            verify: asObject(a.verify),
            confirmed: a.confirmed === true,
          };
          if (typeof a.parallel_plan === "string" && a.parallel_plan !== "") card.parallel_plan = a.parallel_plan;
        }

        // 锚点数据源：调用方传入的 userMessages + 自动从 opencode SQLite 读取的用户原话
        let messages = asStringArray(a.userMessages);
        try {
          const fetched = await getUserMessages(sessionId, 20);
          if (Array.isArray(fetched)) messages = messages.concat(fetched);
        } catch (e) {
          log(`getUserMessages 失败：${e && e.message ? e.message : e}`);
        }

        const options = {
          userMessages: messages,
          scopeExists: (p) => pathExists(cwd, p),
          // 走 cardText 提交的卡片，其自身的 confirmed 字段同样必须生效，否则敏感路径永远无法通过
          confirmed: (a.confirmed === true) || card.confirmed === true,
        };

        const tier = riskTier(card.scope);
        const result = validateCard(card, options);
        const findings = (result && Array.isArray(result.findings)) ? result.findings : [];

        if (!result || result.ok !== true) {
          const reason = (result && result.reason) || "卡片不合规";
          for (const f of findings) audit("finding", sessionId, { kind: "card_finding", detail: f, tier });
          audit("decision", sessionId, { kind: "blocked", reason, tier });
          return ok({ ok: false, reason, findings, tier });
        }

        card.env = { git_head: gitHead(cwd), project: cwd };

        const prev = loadState(sessionId);
        const state = {
          ...defaultState(),
          ...prev,
          card,
          card_ts: Date.now(),
          tier,
          dispatch_count: 0,
          claimed: false,
          claimed_role: null,
          write_files: 0,
          last_user_ts: Date.now(),
          bypass: false,
          verdict: null,
          completed_ok: false,
          stale: false,
        };
        saveState(sessionId, state);

        audit("run", sessionId, { kind: "record", tier, goal: card.goal });
        audit("decision", sessionId, { kind: "accepted", tier, goal: card.goal });
        for (const f of findings) audit("finding", sessionId, { kind: "card_finding", detail: f, tier });

        const sensitivePaths = (Array.isArray(card.scope) ? card.scope : []).filter((p) => isSensitive(p));

        return ok({ ok: true, tier, findings, card, state, sensitive: sensitivePaths });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 3 -----------------------------------------------------------------------
  {
    name: "flow_claim",
    description:
      "领取一次派发名额（executor 或 auditor）。返回四段合同 prompt，可直接作为子 Agent 的任务描述。" +
      "前置条件：必须有 flow_submit_requirement 留下的卡；卡过期（stale）或派发次数达到上限会直接报错。" +
      "每次 claim 都会消耗一次派发额度，重复 claim 前先想清楚是否必要。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        role: { type: "string", enum: ["executor", "auditor"], description: "领取角色" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        // Phase 1-1: role 白名单校验（非法值必须报错，不得静默降级）
        const a = args || {};
        const rawRole = a.role === undefined || a.role === null || a.role === "" ? "executor" : String(a.role);
        if (rawRole !== "executor" && rawRole !== "auditor") {
          return fail("非法 role：" + rawRole + "，必须是 executor 或 auditor");
        }
        const role = rawRole;
        const sessionId = a.sessionId || "unknown";
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
        // claim 只标记已领取（state.claimed），不消耗派发额度
        state.claimed = true;
        state.claimed_role = role;
        state.last_user_ts = Date.now();
        saveState(sessionId, state);

        audit("decision", sessionId, { kind: "claimed", role, dispatch_count: state.dispatch_count });

        const result = {
          ok: true,
          role,
          card: state.card,
          tier: state.tier,
          dispatch_count: state.dispatch_count,
          prompt: buildContractPrompt(role, state.card),
        };
        if (state.bypass === true) result.bypass = true;
        return ok(result);
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 4 -----------------------------------------------------------------------
  {
    name: "flow_dispatch",
    description:
      "按四段合同派发子 Agent（executor 写代码 / auditor 独立复核）。" +
      "派发前会自动对 scope 内文件做快照（用于事后还原），message 会以原样附在合同末尾。" +
      "run=false（默认）只生成 prompt 供你自己派子 Agent；run=true 则由本工具拉起 opencode 子进程直接跑并回传 stdout/stderr。" +
      "必须先 flow_submit_requirement 留痕，否则报错。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        role: { type: "string", enum: ["executor", "auditor"], description: "派发角色" },
        message: { type: "string", description: "附加说明，原样附在合同末尾" },
        run: { type: "boolean", description: "true = 由本工具直接运行 opencode；false/absent = 只返回 prompt" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        // Phase 1-1: role 白名单校验（非法值必须报错，不得静默降级）
        const rawRole = a.role === undefined || a.role === null || a.role === "" ? "executor" : String(a.role);
        if (rawRole !== "executor" && rawRole !== "auditor") {
          return fail("非法 role：" + rawRole + "，必须是 executor 或 auditor");
        }
        const role = rawRole;

        // Phase 1-1: dispatch 前强制校验 stale / dispatch_count / claim
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);
        if (!state.card) return fail("没有留痕，不允许派发。");
        if (isStale(state)) return fail("留痕已过期（stale），请重新提交任务卡。");
        if (state.dispatch_count >= MAX_DISPATCH) return fail("派发次数已达上限 " + MAX_DISPATCH + "，停止派发并向用户汇报。");
        // 必须先 flow_claim 领取派发名额（claimed 标记由 claim 设置）
        if (state.claimed !== true) return fail("未 claim，请先 flow_claim 领取派发名额。");

        const cwd = a.cwd || process.cwd();

        // Phase 1-1: dispatch 时才增加 dispatch_count（claim 不计数）
        state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
        // 额度已消耗，需要重新 claim 才能再次派发
        state.claimed = false;
        state.write_files = 0;
        // Phase 1-1: 派发后自动清零免检，避免“忘记关免检”长期生效
        if (state.bypass === true) {
          state.bypass = false;
          state.bypass_ts = 0;
          audit("decision", sessionId, { kind: "bypass_auto_reset", reason: "派发后自动清零" });
        }
        saveState(sessionId, state);

        const prompt = buildContractPrompt(role, state.card, a.message);

        const scope = Array.isArray(state.card.scope) ? state.card.scope : [];
        const entries = snapshotFiles(sessionId, scope, cwd);
        audit("run", sessionId, { kind: "snapshot", role, files: scope.length, ok: true });

        if (a.run === true) {
          // 写入 prompt 文件，供主 Agent 读取后通过 subagent 工具派发
          const { file } = writeDispatchPrompt(sessionId, role, prompt, cwd);
          audit("run", sessionId, { kind: "dispatch", role, prompt_file: file });
          return ok({
            ok: true,
            role,
            prompt,
            snapshot: entries,
            run: {
              prompt_file: file,
              note: "主 Agent 请读取 prompt_file 内容，使用 subagent 工具按角色派发（executor=worker, auditor=reviewer）。执行完成后调用 save_agent_result 保存结果。",
            },
          });
        }

        return ok({ ok: true, role, prompt, snapshot: entries, run: null });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 5 -----------------------------------------------------------------------
  {
    name: "flow_verdict",
    description:
      "记录 auditor 的裁定结果（PASS / DIRECTION / LOCAL）。只有 PASS 会把 completed_ok 置为 true。" +
      "DIRECTION 表示方向对但需返工，LOCAL 表示问题局限在局部。在向用户汇报完成前必须先落裁定，否则视为未复核。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        verdict: { type: "string", enum: ["PASS", "DIRECTION", "LOCAL"], description: "裁定结果" },
        notes: { type: "string", description: "裁定说明/证据摘要" },
        role: { type: "string", description: "记录裁定者角色（通常 auditor）" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);

        if (!state.card) return fail("没有留痕，无法记录裁定。");

        const verdict = a.verdict;
        const findings = [];
        if (state.verdict && state.verdict !== verdict) {
          findings.push(`裁定被覆盖：${state.verdict} → ${verdict}`);
          audit("finding", sessionId, { kind: "verdict_overwrite", from: state.verdict, to: verdict, tier: state.tier });
        }

        state.verdict = verdict;
        state.completed_ok = verdict === "PASS";
        state.verdict_ts = Date.now();
        saveState(sessionId, state);

        audit("resolution", sessionId, { kind: "verdict", verdict, notes: a.notes, role: a.role });

        const result = { ok: true, verdict, completed_ok: state.completed_ok, notes: a.notes };
        if (findings.length) result.findings = findings;
        return ok(result);
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 6 -----------------------------------------------------------------------
  {
    name: "flow_status",
    description:
      "查询当前会话的门禁状态：是否有任务卡、风险档、已派发次数/上限、裁定结果、是否过期、是否处于免检模式、卡片内容与时间戳。" +
      "在汇报进度、判断能否继续派发、或确认任务是否真的收尾时调用。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);

        const result = {
          sessionId,
          has_card: !!state.card,
          tier: state.tier,
          dispatch_count: state.dispatch_count,
          max_dispatch: MAX_DISPATCH,
          verdict: state.verdict,
          verified: !!state.verdict,
          completed_ok: state.completed_ok === true,
          stale: isStale(state),
          bypass: !!state.bypass,
          card: state.card,
          card_ts: state.card_ts,
        };
        if (state.card && !state.verdict) result.unreviewed = true;
        return ok(result);
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 7 -----------------------------------------------------------------------
  {
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
  },

  // 8 -----------------------------------------------------------------------
  {
    name: "flow_diff_hunks",
    description:
      "对指定文件跑 git diff -U0 并解析出每个文件的 hunk 范围（oldStart/oldCount/newStart/newCount）。" +
      "用于独立复核 executor 到底改了哪些行、是否越界。cwd 不是 git 仓库或 git 失败时返回 files:[] 与 error 字段（不算工具错误）。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "仓库工作目录，默认 process.cwd()" },
        paths: { type: "array", items: { type: "string" }, description: "要检查的文件路径列表" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const cwd = a.cwd || process.cwd();
        const paths = asStringArray(a.paths);

        const proc = spawnSync("git", ["diff", "-U0", "--no-color", ...paths], {
          cwd,
          encoding: "utf8",
          shell: false,
          maxBuffer: 10 * 1024 * 1024,
        });

        const stderr = proc.stderr ? String(proc.stderr) : "";
        if (proc.error || (proc.status !== 0 && !stderr)) {
          return ok({
            ok: false,
            files: [],
            raw_length: 0,
            error: proc.error ? String(proc.error.message || proc.error) : (stderr || `git exited with status ${proc.status}`),
          });
        }

        const out = proc.stdout ? String(proc.stdout) : "";
        const files = [];
        let current = null;
        for (const line of out.split("\n")) {
          if (line.startsWith("+++ ")) {
            const p = line.slice(4).trim();
            current = { path: p.startsWith("b/") ? p.slice(2) : p, hunks: [] };
            files.push(current);
            continue;
          }
          if (line.startsWith("@@")) {
            const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (m && current) {
              current.hunks.push({
                oldStart: Number(m[1]),
                oldCount: m[2] === undefined ? 1 : Number(m[2]),
                newStart: Number(m[3]),
                newCount: m[4] === undefined ? 1 : Number(m[4]),
              });
            }
          }
        }

        return ok({ ok: true, files, raw_length: out.length });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 9 -----------------------------------------------------------------------
  {
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
        confirmed: { type: "boolean", description: "开启免检时必须为 true（表示用户已明确授权）" },
        reason: { type: "string", description: "开启/关闭理由（建议写用户原话）" },
      },
      required: ["on"],
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);

        if (!state.card) {
          return fail("没有留痕，无法开启免检。免检只能在已提交任务卡的前提下使用。");
        }

        // Phase 1-1: 开启免检必须显式确认，不允许隐式触发
        if (a.on === true && a.confirmed !== true) {
          audit("decision", sessionId, { kind: "bypass_denied", reason: "未确认" });
          return fail("开启免检需要显式确认：用户必须明确授权后，传入 confirmed=true。");
        }

        state.bypass = a.on === true;
        state.bypass_ts = Date.now();
        saveState(sessionId, state);
        audit("decision", sessionId, {
          kind: state.bypass ? "bypass_on" : "bypass_off",
          reason: a.reason,
          confirmed: a.confirmed === true,
        });
        return ok({
          ok: true,
          bypass: state.bypass,
          reason: a.reason,
          note: state.bypass ? "免检已开启；下次 flow_dispatch 后会自动清零。" : "免检已关闭。",
        });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },

  // 10 -----------------------------------------------------------------------
  {
    name: "flow_add_user_msg",
    description:
      "写入一条用户原话到会话消息文件，供 quote 锚点校验使用。" +
      "在提交任务卡之前调用，把用户消息原文存下来。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        text: { type: "string", description: "用户原话原文" },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const text = String(a.text || "");
        if (!text) return fail("text 不能为空");
        const ok2 = writeUserMessage(sessionId, text);
        return ok({ ok: ok2, sessionId, text_len: text.length });
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
];

// ---- 服务器装配 ------------------------------------------------------------

const server = new Server(
  { name: "carlos-flow", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const t = TOOLS.find((x) => x.name === request.params.name);
  if (!t) {
    return { content: [{ type: "text", text: "Unknown tool: " + request.params.name }], isError: true };
  }
  try {
    return await t.handler(request.params.arguments || {});
  } catch (e) {
    return {
      content: [{ type: "text", text: "ERROR: " + (e && e.message ? e.message : String(e)) }],
      isError: true,
    };
  }
});

// ---- Phase 1-1: 工具参数校验器（required 字段 / 类型 / enum）----
function validateToolArgs(toolName, args) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool || !tool.inputSchema) return { ok: true };
  const schema = tool.inputSchema;

  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      const v = args[field];
      if (v === undefined || v === null || v === "") {
        return { ok: false, error: "缺少必填字段：" + field };
      }
    }
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const v = args[key];
      if (v === undefined || v === null) continue;
      if (prop.type) {
        const expected = prop.type === "integer" ? "number" : prop.type;
        if (expected === "number" && typeof v !== "number") {
          return { ok: false, error: "字段 " + key + " 类型错误，期望 number" };
        }
        if (expected === "array" && !Array.isArray(v)) {
          return { ok: false, error: "字段 " + key + " 类型错误，期望 array" };
        }
        if (expected === "string" && typeof v !== "string") {
          return { ok: false, error: "字段 " + key + " 类型错误，期望 string" };
        }
        if (expected === "boolean" && typeof v !== "boolean") {
          return { ok: false, error: "字段 " + key + " 类型错误，期望 boolean" };
        }
      }
      if (prop.enum && !prop.enum.includes(v)) {
        return { ok: false, error: "字段 " + key + " 值非法，可选：" + prop.enum.join(", ") };
      }
    }
  }
  return { ok: true };
}

// ---- CallTool：先校验参数，再分发到工具 handler ----
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  const t = TOOLS.find((x) => x.name === toolName);
  if (!t) {
    return { content: [{ type: "text", text: "Unknown tool: " + toolName }], isError: true };
  }

  const validation = validateToolArgs(toolName, args);
  if (!validation.ok) {
    return { content: [{ type: "text", text: "ERROR: " + validation.error }], isError: true };
  }

  try {
    return await t.handler(args);
  } catch (e) {
    return {
      content: [{ type: "text", text: "ERROR: " + (e && e.message ? e.message : String(e)) }],
      isError: true,
    };
  }
});

// ---- 传输模式：stdio（单次调用，兼容旧用法） ----
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("carlos-flow MCP server connected via stdio\n");
