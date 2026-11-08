// carlos-flow MCP server — stdio transport.
// Carlos 工作流的机械门禁工具集（留痕 / 派发 / 裁定 / 审计 / 快照还原计划）。
// 重要：stdout 是 MCP 传输通道，所有日志一律走 stderr。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createServer, connect } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PROTOCOL } from "./protocol.js";
import { parseCard, validateCard, riskTier, isSensitive } from "./card.js";
import { loadState, saveState, defaultState, audit, readAudit, getUserMessages, writeUserMessage, pathExists, gitHead, isStale, isBypassed, verifyAuditChain, withStateLock, auditHashMode } from "./state.js";
import { buildContractPrompt, snapshotFiles, readManifest, readManifestAll, writeDispatchPrompt, saveAgentResult, runVerifyCommand, enforceScope, MAX_DISPATCH } from "./dispatch.js";

const log = (msg) => {
  try {
    process.stderr.write(`[carlos-flow] ${msg}\n`);
  } catch {
    /* stderr 不可写时静默 */
  }
};

// ---- 通用工具函数 ----------------------------------------------------------

// 成功响应：统一注入 ok:true。
//
// 之前各工具的 payload 有的显式写 \`ok: true\`、有的没写（如 flow_audit），
// 于是调用方拿到手的心智模型不一致 —— 想判断成败只能逐个工具记「这个有没有 ok」。
// 现在由 ok() 统一注入：
//   · payload 里没有 ok 字段 → 补上 ok:true
//   · payload 里已有 ok 字段 → 保留原值（不改 ok:false 的语义）
// 这是**增量兼容**：现有调用方读取 total / events / by_type 等字段不受影响。
const ok = (obj) => {
  const payload = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : { value: obj };
  const withOk = "ok" in payload ? payload : { ok: true, ...payload };
  return { content: [{ type: "text", text: JSON.stringify(withOk, null, 2) }] };
};
const fail = (message) => ({ content: [{ type: "text", text: "ERROR: " + String(message) }], isError: true });

const asStringArray = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);

// 卡片文本字段（scope / acceptance / unknowns / assumptions）**保留原始元素类型**，
// 不做任何过滤/转换。
// 背景：早先用 asStringArray（String(x)）会把 null→「null」、{}→「[object Object]」，
// 垃圾串被当成合法验收标准；改成 asTextArray（filter 掉非字符串）虽然堵住了垃圾串，
// 但又让「[null, \"x\"]」静默变成合法的 [\"x\"] —— 严格口径根本没机会判定。
// 现在的做法：**两条入口都保留原样**，由 card.js 的必填校验统一判定
// （文本类数组必须每个元素都是非空字符串）。这样：
//   · 口径唯一，两条入口（结构化 / cardText）行为一致；
//   · 含无效元素的卡片被**明确拒绝**，而不是静默降级或静默过滤；
//   · 无效元素不会落盘、更不会进入 executor 的合同文本。
const asRawArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// 卡片里声明的验证命令（归一化后用于比较）
const cardVerifyCmd = (state) => {
  const c = state && state.card && state.card.verify;
  return c && typeof c.cmd === "string" ? c.cmd.trim() : "";
};

// 真实验证是否已通过：必须存在 flow_run_verify 写入的 last_verify、ok===true，
// 且验证的正是**当前卡片**的 verify.cmd（防止拿旧卡的验证结果冒充新卡）。
const verifyPassed = (state) => {
  const lv = state && state.last_verify;
  if (!lv || typeof lv !== "object") return false;
  if (lv.ok !== true) return false;
  const want = cardVerifyCmd(state);
  if (!want) return false;
  return typeof lv.cmd === "string" && lv.cmd.trim() === want;
};

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
        activation: { type: "boolean", description: "true = 这是智能触发引擎自动开的占位卡；在 scope/acceptance/verify.cmd 补齐前会阻止派发" },
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
            scope: asRawArray(a.scope),
            acceptance: asRawArray(a.acceptance),
            unknowns: asRawArray(a.unknowns),
            assumptions: asRawArray(a.assumptions),
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

        // ---- 闸门待补项：服务端从当前卡片内容**幂等派生** ----
        // 内容判定：与 validateCard 的必填字段口径**严格一致**（两边都要求
        // 「每个元素都是非空字符串」）。acceptance=[""] / [null] / ["a",null] 这类
        // 含无效元素的伪填充，既不算卡片合规，也不算闸门已补齐 —— 统一卡严，避免绕过。
        const cardHasScope = Array.isArray(card.scope) && card.scope.length > 0 && card.scope.every(
          (p) => typeof p === "string" && p.trim() !== "" && p !== "." && p !== ".."
        );
        const cardHasAcceptance = Array.isArray(card.acceptance) && card.acceptance.length > 0 && card.acceptance.every(
          (x) => typeof x === "string" && x.trim() !== ""
        );
        const cardHasVerify = !!(card.verify && typeof card.verify.cmd === "string" && card.verify.cmd.trim() !== "");
        const currentMissing = [
          ...(!cardHasScope ? ["scope"] : []),
          ...(!cardHasAcceptance ? ["acceptance"] : []),
          ...(!cardHasVerify ? ["verify.cmd"] : []),
        ];

        // activation 标记既可能来自工具参数（结构化提交），也可能来自卡片本身（cardText 提交）。
        // 两条路径必须一致，否则 cardText 路径可以完全绕开闸门。
        const isActivation = a.activation === true || card.activation === true;

        // ---- 读-改-写放进跨进程排他锁 ----
        // 多个 MCP server 进程共享同一 CARLOS_FLOW_HOME 时，未加锁会丢更新：
        // 后写入者用过期 prevState 算出 pending=[]，而它写的卡片字段仍为空 ⇒ 闸门被绕过。
        const gated = withStateLock(sessionId, () => {
          const prev = loadState(sessionId);
          const wasActivatedBefore = prev.activation_activated === true;
          const prevPendingBefore = Array.isArray(prev.activation_pending) ? prev.activation_pending : [];

          let activationPending;
          if (isActivation) {
            // 显式占位卡：待补项 = 服务端从这张卡实际缺什么推导出来的。
            activationPending = currentMissing;
          } else if (wasActivatedBefore) {
            // 该会话开过占位卡：继续按**当前卡片实际缺什么**锁定。
            // 幂等派生（而不是「上一轮 pending 传递」），所以即使并发丢更新，
            // 落盘的 pending 永远与同一份落盘卡片一致，不会出现「卡片空却 pending=[]」。
            activationPending = currentMissing;
          } else {
            // 普通卡（未标 activation，且本会话从未激活过）：不上闸门。
            // 档位必填项已由 validateCard 按 tier 强制（read_only 只要 goal+quote），
            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = [];
          }

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
            activation_pending: activationPending,
            // 单调标记：一旦激活过就永不清除
            activation_activated: isActivation || wasActivatedBefore,
          };
          saveState(sessionId, state);
          return { state, activationPending, wasActivatedBefore, prevPendingBefore };
        });

        const { state, activationPending, wasActivatedBefore, prevPendingBefore } = gated;

        // 闸门事件：建立 / 保持 / 解除，都要在审计链里留痕。
        if (isActivation) {
          audit("decision", sessionId, {
            kind: "activation_gate_activated",
            reason: "智能触发占位卡激活（服务端从卡片内容派生待补字段）",
            pending: activationPending,
          });
        } else if (wasActivatedBefore && prevPendingBefore.length > 0 && activationPending.length === 0) {
          // 解锁事件统一由「pending 由非空变空」触发，避免被误记成 activated。
          audit("decision", sessionId, {
            kind: "activation_gate_unlocked",
            reason: "字段已补齐，激活闸门解除",
            released: prevPendingBefore,
          });
        } else if (wasActivatedBefore && activationPending.length > 0) {
          audit("decision", sessionId, {
            kind: "activation_gate_held",
            reason: "字段尚未补齐，激活闸门继续保持",
            pending: activationPending,
          });
        }

        audit("run", sessionId, { kind: "record", tier, goal: card.goal });
        audit("decision", sessionId, { kind: "accepted", tier, goal: card.goal });
        for (const f of findings) audit("finding", sessionId, { kind: "card_finding", detail: f, tier });

        // 激活占位卡建立 / 闸门解除都要在审计链里留专属事件，
        // 否则事后无法从 gate-audit 流水回答「这是不是占位卡、有没有解闸过」。
        if (isActivation) {
          audit("run", sessionId, {
            kind: "activation",
            tier,
            goal: card.goal,
            pending: activationPending,
          });
        } else if (wasActivatedBefore && prevPendingBefore.length > 0 && activationPending.length === 0) {
          audit("decision", sessionId, {
            kind: "activation_released",
            tier,
            goal: card.goal,
            released: prevPendingBefore,
          });
        }

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
        // 激活占位卡闸门：占位卡未补齐字段时不允许领取派发名额
        if (Array.isArray(state.activation_pending) && state.activation_pending.length > 0) {
          return fail("激活占位卡尚未补齐（待补：" + state.activation_pending.join("、") +
            "）。请先补齐后重新调用 flow_submit_requirement，再来领取派发名额。");
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
        // 激活占位卡闸门：占位卡未补齐字段时不允许派发
        if (Array.isArray(state.activation_pending) && state.activation_pending.length > 0) {
          return fail("激活占位卡尚未补齐（待补：" + state.activation_pending.join("、") +
            "）。请先补齐后重新调用 flow_submit_requirement，再来派发。");
        }
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

        // Phase 1-1: 记录「派发前基线」。
        //
        // 为什么是记录而不是当场阻断：
        //   派发这一刻，子 Agent **还没动手** —— 它之后会改哪些文件根本无从得知。
        //   此时跑 git diff 得到的是「用户自己已有的未提交改动」，
        //   拿它当越界拦下来会**误伤正常用法**（用户本来就在改这些文件）。
        //
        // 正确的时机是**裁定前**：用「当前改动 - 派发基线」算出**本次执行引入的**
        // 改动，再与卡片 scope 比对 —— 这才是「越界直接阻断」的真实落点，
        // 阻断的是「越界之后仍然拿到 PASS」这个闭环。
        const baseline = enforceScope(scope, cwd);
        state.dispatch_baseline = Array.isArray(baseline.checked) ? baseline.checked : [];
        saveState(sessionId, state);
        audit("run", sessionId, {
          kind: "dispatch_baseline",
          role,
          files: state.dispatch_baseline.length,
        });

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

        // 激活占位卡尚未补齐时不允许裁定：
        // 否则会出现「未派发、未验证、却直接 PASS」的假闭环。
        // （先于 dispatch_count 检查：占位卡的错误信息更具体，也更可操作）
        if (Array.isArray(state.activation_pending) && state.activation_pending.length > 0) {
          audit("decision", sessionId, {
            kind: "verdict_denied",
            reason: "激活占位卡未补齐",
            pending: state.activation_pending,
          });
          return fail("激活占位卡尚未补齐（待补：" + state.activation_pending.join("、") +
            "），不能记录裁定。请先补齐后重新调用 flow_submit_requirement。");
        }

        // 防假闭环之二：从未派发过任何执行，就不允许落 PASS 裁定。
        // 否则一张刚提交、什么都没跑的卡也能直接标 completed_ok=true。
        // 只施加于 PASS：DIRECTION / LOCAL 是「有问题」的裁定，不构成「完成」，
        // 允许在未派发时先记录返工意见。
        if (verdict === "PASS" && !(Number(state.dispatch_count) > 0)) {
          audit("decision", sessionId, {
            kind: "verdict_denied",
            reason: "尚未派发任何执行",
            dispatch_count: state.dispatch_count,
          });
          return fail("尚未派发任何执行（dispatch_count=0），不能记录 PASS 裁定。" +
            "请先 flow_claim / flow_dispatch 派发并完成验证后再落 PASS。");
        }

        // 防假闭环之三：记 PASS 必须有**真实验证通过**的证据。
        // 「派发过」≠「验证过」——只查 dispatch_count 时，一张跑过但验证失败的卡
        // 照样能落 PASS（completed_ok=true），等于把验证环节架空。
        // 三个条件同时成立才放行：
        //   1) 存在 flow_run_verify 写入的 state.last_verify；
        //   2) last_verify.ok === true（真实执行退出码为 0）；
        //   3) last_verify.cmd 与**当前卡片**的 verify.cmd 一致（防止旧卡结果冒充新卡）。
        // 只施加于 PASS：DIRECTION / LOCAL 是返工意见，不要求已完成验证。
        if (verdict === "PASS") {
          const lv = state.last_verify;
          const want = cardVerifyCmd(state);
          if (!lv || typeof lv !== "object") {
            // 区分两种「没验证」：卡片压根没写 verify.cmd（用户无从下手）
            // vs 写了但还没跑。前者必须给出可操作的下一步，否则是死路。
            if (!want) {
              audit("decision", sessionId, {
                kind: "verdict_denied",
                reason: "卡片未指定验证命令",
              });
              return fail("卡片未指定 verify.cmd，没有可核验的验证依据，不能记录 PASS 裁定。" +
                "请重新提交带 verify.cmd 的任务卡（flow_submit_requirement），" +
                "用 flow_run_verify 跑通后再记录裁定。");
            }
            audit("decision", sessionId, {
              kind: "verdict_denied",
              reason: "尚未执行验证",
            });
            return fail("尚未执行验证，不能记录 PASS 裁定。请先调用 flow_run_verify " +
              "跑通卡片里的 verify.cmd，再记录裁定。");
          }
          if (lv.ok !== true) {
            audit("decision", sessionId, {
              kind: "verdict_denied",
              reason: "验证未通过",
              exitCode: lv.exitCode,
              verify_cmd: lv.cmd,
            });
            return fail("验证未通过（exitCode=" + lv.exitCode + "），不能记录 PASS 裁定。" +
              "请先修复问题、让 verify.cmd 真实跑通（flow_run_verify），再记录裁定。");
          }
          if (!want || typeof lv.cmd !== "string" || lv.cmd.trim() !== want) {
            audit("decision", sessionId, {
              kind: "verdict_denied",
              reason: "验证命令与当前卡片不一致",
              verify_cmd: lv.cmd,
              card_cmd: want,
            });
            return fail("已有的验证结果对应的命令与当前卡片的 verify.cmd 不一致，不能记录 PASS 裁定。" +
              "请对当前卡片重新执行 flow_run_verify，再记录裁定。");
          }

          // 防假闭环之四：越界改动必须被拦住。
          //
          // 「越界直接阻断」的**真实落点**在这里：判定「本次执行有没有改到
          // scope 之外的文件」，而不是「派发前工作区干不干净」。
          //
          // 做法：拿「当前 git 改动清单」减去「派发时记录的基线」，
          // 剩下的就是**本次执行引入的**改动 —— 用户自己原有的未提交改动
          // 不会被误判为越界。
          //
          // 无基线（未走过 flow_dispatch）时退化为「全量改动」判定：
          // 此时没有参照点，用全量更保守（fail-closed）。
          const scopeNow = Array.isArray(state.card.scope) ? state.card.scope : [];
          const current = enforceScope(scopeNow, a.cwd || process.cwd());
          const baseline = Array.isArray(state.dispatch_baseline) ? state.dispatch_baseline : [];
          const baselineSet = new Set(baseline.map((f) => path.normalize(f)));
          const introduced = (current.checked || []).filter((f) => !baselineSet.has(path.normalize(f)));
          const scopeCheck = enforceScope(scopeNow, a.cwd || process.cwd(), introduced);
          if (!scopeCheck.ok) {
            audit("decision", sessionId, {
              kind: "scope_violation",
              reason: "越界改动",
              violations: scopeCheck.violations,
              introduced: introduced.length,
            });
            return fail("检测到越界改动，不能记录 PASS 裁定：" +
              (scopeCheck.violations || []).join(", ") +
              "。这些文件不在卡片 scope 白名单内。" +
              "请把越界文件加入 scope（重新提交任务卡）后重试，或先撤销这些改动。");
          }
        }

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
          // verify_passed：真实验证是否通过（last_verify.ok===true 且命令与当前卡片一致）。
          // 注意 verified 只表示「是否已有裁定」，不代表验证通过——两者语义不同，不可混用。
          verify_passed: verifyPassed(state),
          completed_ok: state.completed_ok === true,
          stale: isStale(state),
          bypass: !!state.bypass,
          card: state.card,
          card_ts: state.card_ts,
          activation_pending: Array.isArray(state.activation_pending) ? state.activation_pending : [],
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

        return ok({ total: rows.length, by_type, by_kind, events: rows, chain: chainResult, mode: auditHashMode() });
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
        
        // 工作目录优先级：显式 cwd > 卡片提交时的项目目录 > server 进程 cwd。
        // 旧实现只用后两者中的 process.cwd() —— MCP server 是常驻进程，
        // 它的 cwd 是**启动时**的目录（可能是几个月前的某个旧仓库），
        // 于是 verify.cmd 会在错误的目录里跑，测试脚本找不到、路径全错，
        // 而门禁把这种失败当成了「验证不通过」（真 PASS 被误杀）。
        const cardProject = state.card.env && typeof state.card.env.project === "string"
          ? state.card.env.project
          : "";
        const workdir = a.cwd || cardProject || undefined;
        const result = await runVerifyCommand(state.card.verify.cmd, workdir);
        const state2 = loadState(sessionId);
        state2.last_verify = {
          ts: new Date().toISOString(),
          cmd: state.card.verify.cmd,
          cwd: workdir || process.cwd(),
          exitCode: result.exitCode,
          ok: result.ok,
        };
        saveState(sessionId, state2);
        
        return ok({ ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, cwd: workdir || process.cwd() });
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
        // 不传 paths → 自动跑 `git diff --name-only` 取当前实际改动清单。
        // 传了 paths → 用调用方给的清单（自查场景）。
        const result = paths.length
          ? enforceScope(scope, a.cwd, paths)
          : enforceScope(scope, a.cwd);
        
        return ok({ ok: result.ok, scope, checked: paths.length ? paths : result.checked || [], ...result });
      } catch (e) {
        return fail(e && e.message ? e.message : String(e));
      }
    },
  },
  // 15 -----------------------------------------------------------------------
  {
    name: "flow_trigger_check",
    description:
      "智能触发检查：判断当前这条用户消息是否应该启动 Carlos 工作流，并在达标时**实际完成激活**（写入用户原话 + 开占位卡 → 会话进入门禁态）。" +
      "宿主在收到用户消息时调用本工具，就能获得与命令行客户端完全一致的自动触发行为。" +
      "未达阈值时只如实返回评分与决策，不做任何动作；被限流时也如实返回真实评分。" +
      "中文流程词（工作流/门禁/派发/审计…）已内置，中文需求同样能触发。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID，默认 unknown" },
        message: { type: "string", description: "用户本轮消息原文（必须是真实原话，用于 quote 锚点）" },
        complexity: { type: "number", description: "任务复杂度系数，默认 1.0" },
        execute: { type: "boolean", description: "true = 达标时实际执行激活步骤（默认 true）；false = 只评分不动作" },
        cwd: { type: "string", description: "工作目录，默认 process.cwd()" },
      },
      required: ["message"],
    },
    handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const message = String(a.message || "");
        if (!message.trim()) {
          return fail("message 不能为空：触发检查需要用户本轮消息原文（quote 锚点与评分都依赖它）");
        }
        const shouldExecute = a.execute !== false;

        // 触发引擎（纯 JS，零外部依赖）：与 CLI 客户端共用同一份实现，
        // 保证「命令行路径」与「MCP 路径」的评分与决策完全一致。
        const { TriggerEngine } = await import("./trigger.js");
        const result = TriggerEngine.processUserMessage(message, {
          sessionId,
          complexity: typeof a.complexity === "number" ? a.complexity : 1.0,
        });

        const base = {
          ok: true,
          sessionId,
          decision: result.decision,
          score: result.score,
          confidence: result.confidence,
          breakdown: result.breakdown,
          reason: result.reason,
          should_trigger: result.shouldTrigger === true,
          executed: [],
        };

        // 未达标 / 被限流：只如实报告，不做任何动作。
        if (!result.shouldTrigger || !result.activationPlan || !result.activationPlan.activated) {
          return ok({
            ...base,
            activated: false,
            pending_fields: (result.activationPlan && result.activationPlan.pendingFields) || [],
            note: result.decision === "throttled"
              ? "被限流：本轮不触发（已如实返回真实评分）"
              : (result.decision === "review"
                ? "接近阈值：建议手动启动门禁，未自动激活"
                : "未达触发阈值：不激活"),
          });
        }

        // 只读调研意图不进门禁（占位卡恒为 read_only，待补项永远无法满足 → 会话会被锁死）
        const plan = result.activationPlan;
        if (plan.activated === false) {
          return ok({
            ...base,
            activated: false,
            pending_fields: plan.pendingFields || [],
            note: plan.reason || "不激活",
          });
        }

        if (!shouldExecute) {
          return ok({
            ...base,
            activated: false,
            execute_suppressed: true,
            pending_fields: plan.pendingFields || [],
            note: "只评分不动作（execute=false）",
          });
        }

        // ---- 执行激活计划中 auto=true 的步骤 ----
        // 安全约束（与 CLI 客户端一致）：
        //   · 会话已有任务卡 → 不自动开卡（不覆盖用户已有任务）
        //   · 只执行 auto 步骤；needsFill 步骤交回 Agent 补齐
        const existing = loadState(sessionId);
        if (existing.card) {
          return ok({
            ...base,
            activated: false,
            note: "会话已有任务卡，跳过自动开卡（不覆盖用户已有任务）",
          });
        }

        const executed = [];
        for (const step of plan.steps || []) {
          if (!step || step.auto !== true) continue;
          const stepArgs = { ...(step.args || {}), sessionId };
          if (step.tool === "flow_add_user_msg") {
            writeUserMessage(sessionId, String(stepArgs.text || message));
            executed.push({ tool: step.tool, ok: true });
          } else if (step.tool === "flow_submit_requirement") {
            const r = validateCard(stepArgs, {
              userMessages: [message],
              scopeExists: () => true,
              confirmed: stepArgs.confirmed === true,
            });
            if (!r || r.ok !== true) {
              executed.push({ tool: step.tool, ok: false, reason: (r && r.reason) || "卡片不合规" });
              continue;
            }
            const card = { ...stepArgs };
            card.env = { git_head: gitHead(a.cwd || process.cwd()), project: a.cwd || process.cwd() };
            const tier = riskTier(card.scope);
            const withLock = withStateLock(sessionId, () => {
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
                // 幂等派生：待补项由当前卡片内容算出，落盘状态自洽
                activation_pending: ["scope", "acceptance", "verify.cmd"],
                activation_activated: true,
              };
              saveState(sessionId, state);
              return state;
            });
            audit("run", sessionId, { kind: "activation", tier, goal: card.goal, pending: withLock.activation_pending });
            executed.push({ tool: step.tool, ok: true, tier });
          }
        }

        const after = loadState(sessionId);
        return ok({
          ...base,
          activated: true,
          executed,
          has_card: !!after.card,
          activation_pending: Array.isArray(after.activation_pending) ? after.activation_pending : [],
          pending_fields: plan.pendingFields || [],
          note: "已自动激活：会话进入门禁态，补齐 scope/acceptance/verify.cmd 后方可派发",
        });
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

// ⚠️ 这里曾经**重复注册**过一次 CallToolRequestSchema（另一个不带参数校验的版本）。
// MCP SDK 的 setRequestHandler 用 Map.set → 后注册的覆盖先注册的，
// 于是先注册的那个（含约 17 行）**永远不会执行** —— 当前行为是对的，
// 但它靠的是「注册顺序」这种隐式约定：任何一次重排或插入都会静默
// 丢掉参数校验（required 字段 / 类型 / enum 全部失效）。
// 现在只保留下面那一个带 validateToolArgs 的注册。
//
// check:no-dead-handler 门禁会统计同一 schema 的注册次数，>1 即红。

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
      // 数组**元素**类型校验：schema 已声明 items:{type:"string"} 时，
      // 只校验顶层 array 类型是不够的 —— 元素类型不符会一路传到 Node 内部
      // 才报错（例：flow_check_scope 的 paths:["README.md",123] 会抛
      // "The \"path\" argument must be of type string" 这种底层错误），
      // 调用方拿到的是不可读的堆栈信息。改为在入口就给出明确提示。
      // 注意：**null 也要拦**（typeof null !== "string"）—— 否则 unknowns=[null]
      // 这类值会静默落盘（虽然不参与档位必填、不进 executor 合同文本，
      // 但会在 flow_status 回显整卡时露出 null 元素）。
      if (prop.type === "array" && Array.isArray(v) && prop.items && prop.items.type) {
        const want = prop.items.type === "integer" ? "number" : prop.items.type;
        for (let i = 0; i < v.length; i++) {
          const el = v[i];
          if (el === undefined) continue;
          const bad =
            (want === "number" && typeof el !== "number") ||
            (want === "string" && typeof el !== "string") ||
            (want === "boolean" && typeof el !== "boolean") ||
            (want === "object" && (typeof el !== "object" || el === null || Array.isArray(el)));
          if (bad) {
            return { ok: false, error: "字段 " + key + "[" + i + "] 类型错误，期望 " + want };
          }
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
