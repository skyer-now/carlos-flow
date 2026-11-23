// infra 领域：真实工具实现与原始契约。
import {
  audit,
  bindAuditVersion,
  readAuditState,
  archiveCardAudit,
  ok,
  fail,
  asStringArray,
  resolveRepoRoot,
  dispatchDirInsideProject,
  verifyPassed,
  verifyState,
  collectAxisWarnings,
  evidenceIdentity,
  introducedChanges,
  spawnSync,
  PROTOCOL,
  validateCard,
  validateNewFiles,
  riskTier,
  deriveWizardStatus,
  storageOverview,
  loadState,
  saveState,
  defaultState,
  writeUserMessage,
  gitHead,
  isStale,
  withStateLock,
  commitState,
  FLOW_HOME,
  readManifest,
  saveAgentResult,
  snapshotIdentity,
  enforceScope,
  MAX_DISPATCH,
  path,
} from './shared.js'
const TOOLS = [
{
    name: 'flow_protocol',
    description:
      '读取 Carlos 工作流协议全文（路由档位 T0/T1/T2、四段合同、报告规格、错误分层、状态字段、审计事件类型、免检触发词、任务卡模板）。' +
      '当你不确定该走哪一档、任务卡该怎么写、executor/auditor 报告格式或门禁规则时，先调用本工具拿到权威定义，不要凭记忆猜。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => ok({ protocol: PROTOCOL }),
  },
{
    name: 'flow_mode',
    description: '切换工作流模式：pro（专业）/ guide（向导）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['pro', 'guide'] },
        reason: { type: 'string' },
      },
      required: ['mode'],
    },
    handler: async (args) => {
      const { sessionId, mode, reason } = args
      const sid = sessionId || 'unknown'
      let nextMode = mode
      await commitState(sid, (latest) => {
        bindAuditVersion(sid, latest)
        latest.mode = mode
        latest.mode_ts = Date.now()
        nextMode = latest.mode
      })
      audit('decision', sid, { kind: 'mode_on', mode: mode, reason: reason })
      return ok({ mode: nextMode })
    },
  },
{
    name: 'flow_stats',
    description:
      '存储与运行态统计（**只读**）：各会话占用 Top N、备份去重率、审计日志按日增长、' +
      '陈旧会话清单（含最近活跃时间与是否终态）。清理/归档前先用它看清楚「现在占了多少、谁占的、删了会不会影响回溯」，' +
      '不要凭感觉删目录。不会修改任何文件。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '返回多少个会话/多少天（默认 10，最大 50）',
        },
        inactiveDays: {
          type: 'integer',
          description: '判定「陈旧会话」的天数阈值（默认 7）',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const limit = Math.min(50, Math.max(1, Number(a.limit) || 10))
        const inactiveDays = Math.max(1, Number(a.inactiveDays) || 7)

        // 口径统一在 src/storage.js（度量和清理必须用同一份，否则「统计说 4MB、
        // 清理删了 6MB」这类对不上账的情况迟早发生）。
        const o = storageOverview({ limit, inactiveDays })

        return ok({
          ok: true,
          home: FLOW_HOME,
          generated_at: new Date().toISOString(),
          total: {
            bytes: o.totalBytes,
            sessions: o.summaries.length,
            backup_bytes: o.backupBytes,
            backup_share:
              o.totalBytes > 0
                ? Number((o.backupBytes / o.totalBytes).toFixed(3))
                : 0,
          },
          sessions_top: o.top,
          backup: o.dedup,
          audit: {
            total_bytes: o.auditBytes,
            days: o.auditDays.length,
            recent_days: o.auditDays.slice(0, limit),
            note: '单文件上限由 CARLOS_FLOW_AUDIT_MAX_BYTES 控制（默认 8MB），超出后滚动为 <date>.N.jsonl。',
          },
          trigger_state: o.triggerUsage,
          stale: {
            threshold_days: inactiveDays,
            count: o.staleCandidates.length,
            terminal_count: o.terminal.length,
            samples: o.staleCandidates.slice(0, limit),
            note: 'verdict 非 null 的会话属终态，可安全归档；没有结论的会话请先确认没有在跑的派发。',
          },
          advice:
            o.staleCandidates.length > 0
              ? '存在陈旧会话：' +
                o.terminal.length +
                ' 个已是终态（可归档），其余 ' +
                (o.staleCandidates.length - o.terminal.length) +
                ' 个仍有未完成状态，建议先看 flow_status 再决定。' +
                '归档用 `carlos prune --apply`（移动，不删除；审计目录永不参与）。'
              : '没有超过阈值的陈旧会话。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_status',
    description:
      '查询当前会话的门禁状态：是否有任务卡、风险档、已派发次数/上限、裁定结果、是否过期、是否处于免检模式、卡片内容与时间戳。' +
      '在汇报进度、判断能否继续派发、或确认任务是否真的收尾时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        includeSnapshots: { type: 'boolean', default: false },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        let state = loadState(sessionId)
        const sampledIdentity = evidenceIdentity(state)
        let verification = await verifyState(state, runtime)
        const latest = loadState(sessionId)
        if (evidenceIdentity(latest) !== sampledIdentity) {
          verification = { state: 'fail', fingerprint: 'unavailable' }
        }
        state = latest
        const warns = collectAxisWarnings(state)
        const verificationPassed = verification.fingerprint === 'unavailable' && verification.state === 'fail' ? false : verifyPassed(state)
        const taskStale = isStale(state)

        const result = {
          sessionId,
          has_card: !!state.card,
          tier: state.tier,
          dispatch_count: state.dispatch_count,
          max_dispatch: MAX_DISPATCH,
          verdict: state.verdict,
          // 本条裁定是谁落的（"auditor" | "executor" | null）。
          // 与 claimed_role 不同：后者是「会话最近 claim 的角色」，可能已过期；
          // 这个字段直接回答「这条 PASS 是谁落的」。
          verdict_role:
            state.verdict_role === undefined ? null : state.verdict_role,
          verified: !!state.verdict,
          // verify_passed：真实验证是否通过（last_verify.ok===true 且命令与当前卡片一致）。
          // 注意 verified 只表示「是否已有裁定」，不代表验证通过——两者语义不同，不可混用。
          verify_passed: verificationPassed,
          // 四态验证状态：not_run / fail / stale / pass。
          // stale = 验证通过后代码被改过 —— 不阻断（fail-open），但必须如实告知。
          verify_state: verification.state,
          wizard: deriveWizardStatus(state, {
            verify_state: verification.state,
            verify_passed: verificationPassed,
            fingerprint_available: typeof verification.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(verification.fingerprint),
            task_stale: taskStale,
            sampled_at: Date.now(),
          }),
          completed_ok: state.completed_ok === true,
          audit_pending: state.audit_pending || null,
          audit_history_pending: state.audit_history_pending || [],
          stale: taskStale,
          bypass: !!state.bypass,
          card: state.card,
          card_ts: state.card_ts,
          activation_pending: Array.isArray(state.activation_pending)
            ? state.activation_pending
            : [],
          // 调研/方案互审（v3.1）：与 T2 双轴无关，只用于“回答前是否已复核”。
          advisory: (await import('../advisory.js')).summarizeAdvisory(state.advisory),
          // 双轴审查证据：主 Agent 落 PASS 前可读它确认两轴状态与 card_ts 绑定。
          // axes_ready = 两轴都有结论且 card_ts 与当前卡一致且无轴 FAIL。
          audit_axes: state.audit_axes,
          audit_axes_ts: state.audit_axes_ts,
          axes_ready: (() => {
            const ax = state.audit_axes
            const axisOk = (x) =>
              ax && ax[x] && ax[x].verdict && ax[x].card_ts === state.card_ts
            return (
              axisOk('standards') &&
              axisOk('spec') &&
              ax.standards.verdict !== 'FAIL' &&
              ax.spec.verdict !== 'FAIL'
            )
          })(),
          // WARN 汇总（与 flow_verdict 同一份派生口径）：只读镜像，供事后复查。
          warn_count: warns.length,
        }
        if (a.includeSnapshots === true) {
          result.snapshot_identity = snapshotIdentity(
            sessionId,
            state.dispatch_baseline,
          )
        }
        if (warns.length) result.warn_findings = warns
        if (state.card && !state.verdict) result.unreviewed = true
        return ok(result)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_diff_hunks',
    description:
      '对指定文件跑 git diff -U0 并解析出每个文件的 hunk 范围（oldStart/oldCount/newStart/newCount）。' +
      '用于独立复核 executor 到底改了哪些行、是否越界。cwd 不是 git 仓库或 git 失败时返回 files:[] 与 error 字段（不算工具错误）。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '仓库工作目录，默认 process.cwd()',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要检查的文件路径列表',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const cwd = resolveRepoRoot(a.cwd || process.cwd())
        const paths = asStringArray(a.paths)

        const proc = spawnSync('git', ['diff', '-U0', '--no-color', ...paths], {
          cwd,
          encoding: 'utf8',
          shell: false,
          maxBuffer: 10 * 1024 * 1024,
        })

        const stderr = proc.stderr ? String(proc.stderr) : ''
        if (proc.error || (proc.status !== 0 && !stderr)) {
          return ok({
            ok: false,
            files: [],
            raw_length: 0,
            error: proc.error
              ? String(proc.error.message || proc.error)
              : stderr || `git exited with status ${proc.status}`,
          })
        }

        const out = proc.stdout ? String(proc.stdout) : ''
        const files = []
        let current = null
        for (const line of out.split('\n')) {
          if (line.startsWith('+++ ')) {
            const p = line.slice(4).trim()
            current = { path: p.startsWith('b/') ? p.slice(2) : p, hunks: [] }
            files.push(current)
            continue
          }
          if (line.startsWith('@@')) {
            const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
            if (m && current) {
              current.hunks.push({
                oldStart: Number(m[1]),
                oldCount: m[2] === undefined ? 1 : Number(m[2]),
                newStart: Number(m[3]),
                newCount: m[4] === undefined ? 1 : Number(m[4]),
              })
            }
          }
        }

        return ok({ ok: true, files, raw_length: out.length })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_cancel',
    description:
      '一键撤销/取消当前任务卡，重置门禁状态回自由态。' +
      '当用户明确说“取消门禁 / 撤销任务 / 不走流程 / 随便问问”时调用。' +
      '会清空未决占位卡，记录审计事件并释放派发锁。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        reason: { type: 'string', description: '取消理由（建议写用户原话）' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        const cancelledTaskId =
          state && state.card && state.card.env
            ? (state.card.env.worktree_task_id || (state.card.env.worktree && state.card.env.worktree.task_id) || null)
            : null

        await commitState(sessionId, (latest) => {
          // 清身份前保留当前卡及 scope 祖先的完整事件；取消自身审计绑定实际取消的卡。
          bindAuditVersion(sessionId, latest)
          archiveCardAudit(latest)
          latest.card = null
          latest.card_ts = 0
          delete latest.audit_scope_ancestors
          latest.activation_pending = []
          latest.activation_activated = false
          latest.claimed = false
          latest.claimed_role = null
          latest.dispatch_count = 0
          latest.verdict = null
          latest.completed_ok = false
          latest.stale = false
        })

        // 取消即任务结束：清掉工作区运行标记，允许后续受控清理。
        if (cancelledTaskId) {
          try {
            const { clearTaskRunning } = await import('../worktree.js')
            clearTaskRunning(cancelledTaskId, { flowHome: FLOW_HOME })
          } catch {}
        }

        audit('decision', sessionId, {
          kind: 'card_cancelled',
          reason: a.reason || '用户请求撤销',
        })

        // 在线学习：捕获负向信号，自动将触发句式与特征存入本地抑制规则库
        try {
          const { LearnedRulesManager } = await import('../trigger.js')
          if (state && state.card && state.card.quote) {
            LearnedRulesManager.recordNegativeFeedback(state.card.quote, 'hard_negative')
          }
        } catch {}

        return ok({
          ok: true,
          sessionId,
          cancelled: true,
          reason: a.reason || '用户请求撤销',
          note: '门禁任务卡已一键撤销，会话已恢复自由态。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_bypass',
    description:
      '开关免检模式（bypass）。当用户明确说“直接干 / 跳过门禁 / 免检 / 别管流程”时调用。' +
      'on=true 打开，on=false 关闭，每次开关都会写入审计流水并留下时间戳与理由。' +
      '仅在用户明确授权时使用，不要自行开启。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        on: { type: 'boolean', description: 'true 开启免检，false 关闭' },
        confirmed: {
          type: 'boolean',
          description: '开启免检时必须为 true（表示用户已明确授权）',
        },
        reason: {
          type: 'string',
          description: '开启/关闭理由（建议写用户原话）',
        },
      },
      required: ['on'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = readAuditState(sessionId)

        if (!state.card) {
          return fail(
            '没有留痕，无法开启免检。免检只能在已提交任务卡的前提下使用。',
          )
        }

        // Phase 1-1: 开启免检必须显式确认，不允许隐式触发
        if (a.on === true && a.confirmed !== true) {
          audit('decision', sessionId, {
            kind: 'bypass_denied',
            reason: '未确认',
          })
          return fail(
            '开启免检需要显式确认：用户必须明确授权后，传入 confirmed=true。',
          )
        }

        let bypassNow = false
        await commitState(sessionId, (latest) => {
          if (JSON.stringify([latest.card_ts, latest.card]) !== JSON.stringify([state.card_ts, state.card]))
            throw new Error('免检提交前任务卡已变化，未修改新卡')
          bindAuditVersion(sessionId, latest)
          latest.bypass = a.on === true
          latest.bypass_ts = Date.now()
          bypassNow = latest.bypass
          state.bypass = bypassNow
        })
        void bypassNow
        audit('decision', sessionId, {
          kind: state.bypass ? 'bypass_on' : 'bypass_off',
          reason: a.reason,
          confirmed: a.confirmed === true,
        })
        if (state.bypass && state.card && state.card.quote) {
          try {
            const { LearnedRulesManager } = await import('../trigger.js')
            LearnedRulesManager.recordNegativeFeedback(state.card.quote, 'hard_negative')
          } catch {}
        }
        return ok({
          ok: true,
          bypass: state.bypass,
          reason: a.reason,
          note: state.bypass
            ? '免检已开启；下次 flow_dispatch 后会自动清零。'
            : '免检已关闭。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_add_user_msg',
    description:
      '写入一条用户原话到会话消息文件，供 quote 锚点校验使用。' +
      '在提交任务卡之前调用，把用户消息原文存下来。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        text: { type: 'string', description: '用户原话原文' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const text = String(a.text || '')
        if (!text) return fail('text 不能为空')
        const ok2 = writeUserMessage(sessionId, text)
        return ok({ ok: ok2, sessionId, text_len: text.length })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_save_result',
    description:
      '保存子 Agent（executor/auditor）的执行结果到会话目录。' +
      '主 Agent 通过 subagent 工具拿到结果后调用本工具持久化，便于后续审计与还原。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        role: {
          type: 'string',
          enum: ['executor', 'auditor'],
          description: '执行角色',
        },
        stdout: { type: 'string', description: '子 Agent 的 stdout' },
        stderr: { type: 'string', description: '子 Agent 的 stderr' },
        code: { type: 'number', description: '退出码' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const role = a.role === 'auditor' ? 'auditor' : 'executor'
        readAuditState(sessionId) // 同步保存产物前接纳实际卡，不能沿用入口 await 前的卡。
        const file = saveAgentResult(
          sessionId,
          role,
          a.stdout,
          a.stderr,
          a.code,
        )
        audit('run', sessionId, {
          kind: 'agent_result',
          role,
          code: a.code,
          file,
        })
        return ok({ ok: !!file, sessionId, role, file })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_revert_plan',
    description:
      '根据本次会话的快照 manifest 生成还原计划：新建文件（created）→ delete，原有文件 → 从 backup 恢复到 orig。' +
      '只返回计划，绝不自动执行；实际还原需人工确认后按 plan 操作。用于改动出问题需要回滚的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const entries = readManifest(sessionId)
        const plan = []
        for (const entry of entries) {
          if (!entry) continue
          if (entry.created === true) {
            plan.push({ action: 'delete', target: entry.orig, source: null })
          } else {
            plan.push({
              action: 'restore',
              source: entry.backup,
              target: entry.orig,
            })
          }
        }
        return ok({
          sessionId,
          count: plan.length,
          plan,
          note: '这是还原计划，不会自动执行；实际还原需人工确认后按 plan 操作。',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_check_scope',
    description:
      '检查指定文件列表是否在卡片 scope 范围内。用于在提交裁定前自查越界改动。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要检查的文件路径列表',
        },
        cwd: {
          type: 'string',
          description: '仓库工作目录，默认 process.cwd()',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = loadState(sessionId)
        if (!state.card) return fail('没有留痕，无法检查 scope。')

        const scope = Array.isArray(state.card.scope) ? state.card.scope : []
        // 允许集 = scope + new_files（获授权可新建的文件同样算在允许范围内）
        const newFiles = Array.isArray(state.card.new_files)
          ? state.card.new_files
          : []
        const allowed = [...scope, ...newFiles]
        const paths = Array.isArray(a.paths) ? a.paths : []
        // 不传 paths → 自动跑 `git diff --name-only` 取当前实际改动清单。
        // 传了 paths → 用调用方给的清单（自查场景）。
        // 自查同样按仓库根基准，否则「自查没越界、裁定却报越界」会自相矛盾
        const scopeRoot = resolveRepoRoot(state.card.env?.project || a.cwd || process.cwd())
        if (a.cwd && !dispatchDirInsideProject(scopeRoot, resolveRepoRoot(a.cwd)))
          return fail('范围自查目录与卡片项目根不一致')
        // 自动模式（不传 paths）：与裁定路径**一致**地减去派发时基线。
        // 派发前就存在的未跟踪文件属于基线，不是本次执行引入的改动，
        // 自查时不得把它报成越界（否则「自查没越界、裁定却报越界」自相矛盾）。
        // 传了 paths → 用调用方给的清单逐项自查（调用方自己指定要查什么）。
        const result = paths.length
          ? enforceScope(allowed, scopeRoot, paths)
          : (() => {
              const current = enforceScope(allowed, scopeRoot)
              const introduced = introducedChanges(
                current.checked || [],
                state.dispatch_baseline,
              )
              const scoped = enforceScope(allowed, scopeRoot, introduced)
              return {
                ...scoped,
                checked: introduced,
                baseline_excluded: (current.checked || []).length - introduced.length,
              }
            })()

        return ok({
          ok: result.ok,
          scope,
          new_files: newFiles,
          checked: paths.length ? paths : result.checked || [],
          ...result,
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_trigger_check',
    description:
      '智能触发检查：判断当前这条用户消息是否应该启动 Carlos 工作流，并在达标时**实际完成激活**（写入用户原话 + 开占位卡 → 会话进入门禁态）。' +
      '宿主在收到用户消息时调用本工具，就能获得与命令行客户端完全一致的自动触发行为。' +
      '未达阈值时只如实返回评分与决策，不做任何动作；被限流时也如实返回真实评分。' +
      '中文流程词（工作流/门禁/派发/审计…）已内置，中文需求同样能触发。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        message: {
          type: 'string',
          description: '用户本轮消息原文（必须是真实原话，用于 quote 锚点）',
        },
        complexity: { type: 'number', description: '任务复杂度系数，默认 1.0' },
        execute: {
          type: 'boolean',
          description:
            'true = 达标时实际执行激活步骤（默认 true）；false = 只评分不动作',
        },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
      required: ['message'],
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const message = String(a.message || '')
        if (!message.trim()) {
          return fail(
            'message 不能为空：触发检查需要用户本轮消息原文（quote 锚点与评分都依赖它）',
          )
        }
        const shouldExecute = a.execute !== false

        // 触发引擎（纯 JS，零外部依赖）：与 CLI 客户端共用同一份实现，
        // 保证「命令行路径」与「MCP 路径」的评分与决策完全一致。
        const { TriggerEngine } = await import('../trigger.js')
        const result = TriggerEngine.processUserMessage(message, {
          sessionId,
          complexity: typeof a.complexity === 'number' ? a.complexity : 1.0,
        })

        // 旁路：只附带“这次内容是否需要调研/方案互审”，不改变 T0/T1/T2 决策与激活。
        const advisoryModule = await import('../advisory.js')
        const advisoryHint = advisoryModule.classifyAdvisory({ text: message, state: loadState(sessionId) })

        // 只提示，不自动建记录/写 prompt：由 Agent 在决定交付前显式调用
        // carlos_review{action:'advisory_axes'}，避免每条消息都落盘。

        const base = {
          ok: true,
          sessionId,
          advisory: {
            level: advisoryHint.level,
            matched_rules: advisoryHint.matched_rules,
            reason: advisoryHint.reason,
            budget: advisoryHint.budget,
            prepared: false,
            advisory_id: null,
            axes: [],
            prompts: null,
            next: advisoryHint.level === 'none'
              ? null
              : '如需互审，调用 carlos_review{action:"advisory_axes"} 生成两轴合同；常规核查不需要。',
          },
          decision: result.decision,
          score: result.score,
          confidence: result.confidence,
          breakdown: result.breakdown,
          reason: result.reason,
          should_trigger: result.shouldTrigger === true,
          executed: [],
        }

        // 未达标 / 被限流：只如实报告，不做任何动作。
        if (
          !result.shouldTrigger ||
          !result.activationPlan ||
          !result.activationPlan.activated
        ) {
          return ok({
            ...base,
            activated: false,
            pending_fields:
              (result.activationPlan && result.activationPlan.pendingFields) ||
              [],
            note:
              result.decision === 'throttled'
                ? '被限流：本轮不触发（已如实返回真实评分）'
                : result.decision === 'review'
                  ? '接近阈值：建议手动启动门禁，未自动激活'
                  : '未达触发阈值：不激活',
          })
        }

        // 只读调研意图不进门禁（占位卡恒为 read_only，待补项永远无法满足 → 会话会被锁死）
        const plan = result.activationPlan
        if (plan.activated === false) {
          return ok({
            ...base,
            activated: false,
            pending_fields: plan.pendingFields || [],
            note: plan.reason || '不激活',
          })
        }

        if (!shouldExecute) {
          return ok({
            ...base,
            activated: false,
            execute_suppressed: true,
            pending_fields: plan.pendingFields || [],
            note: '只评分不动作（execute=false）',
          })
        }

        // ---- 执行激活计划中 auto=true 的步骤 ----
        // 安全约束（与 CLI 客户端一致）：
        //   · 会话已有任务卡 → 不自动开卡（不覆盖用户已有任务）
        //   · 只执行 auto 步骤；needsFill 步骤交回 Agent 补齐
        const existing = readAuditState(sessionId)
        if (existing.card) {
          return ok({
            ...base,
            activated: false,
            note: '会话已有任务卡，跳过自动开卡（不覆盖用户已有任务）',
          })
        }

        const executed = []
        for (const step of plan.steps || []) {
          if (!step || step.auto !== true) continue
          const stepArgs = { ...(step.args || {}), sessionId }
          if (step.tool === 'flow_add_user_msg') {
            writeUserMessage(sessionId, String(stepArgs.text || message))
            executed.push({ tool: step.tool, ok: true })
          } else if (step.tool === 'flow_submit_requirement') {
            // 触发器落卡路径与提交路径**口径一致**：
            //   · 同样给卡片层校验补上仓库根（缺了就按保守口径拒绝）；
            //   · 同样用 card.js 的 validateNewFiles 校新文件授权
            //     （确认 + 授权说明 + 授权说明能在用户原话中定位）。
            const triggerRoot = resolveRepoRoot(a.cwd || process.cwd())
            const triggerMessages = [message]
            const triggerCard = { ...stepArgs }
            if (Array.isArray(stepArgs.newFiles) && stepArgs.newFiles.length) {
              const checkedNew = validateNewFiles(
                stepArgs.newFiles,
                stepArgs.scope,
                triggerRoot,
                {
                  confirmed: stepArgs.confirmed === true,
                  reason:
                    typeof stepArgs.newFilesReason === 'string'
                      ? stepArgs.newFilesReason
                      : '',
                  userMessages: triggerMessages,
                },
              )
              if (!checkedNew.ok) {
                executed.push({
                  tool: step.tool,
                  ok: false,
                  reason: checkedNew.reason,
                })
                continue
              }
              triggerCard.new_files = checkedNew.files
              triggerCard.new_files_reason = checkedNew.reason
              triggerCard.new_files_reasons = Object.fromEntries(
                checkedNew.files.map((f) => [f, checkedNew.reason]),
              )
            }
            const r = validateCard(triggerCard, {
              userMessages: triggerMessages,
              scopeExists: () => true,
              confirmed: stepArgs.confirmed === true,
              repoRoot: triggerRoot,
            })
            if (!r || r.ok !== true) {
              executed.push({
                tool: step.tool,
                ok: false,
                reason: (r && r.reason) || '卡片不合规',
              })
              continue
            }
            const card = { ...triggerCard }
            card.env = {
              git_head: gitHead(a.cwd || process.cwd()),
              project: a.cwd || process.cwd(),
            }
            const tier = riskTier(card.scope)
            const withLock = await withStateLock(sessionId, () => {
              const prev = loadState(sessionId)
              if (prev.card) return null // 锁外观察为空不是覆盖许可；等待期间新卡必须保留。
              archiveCardAudit(prev)
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
                activation_pending: ['scope', 'acceptance', 'verify.cmd'],
                activation_activated: true,
              }
              delete state.audit_scope_ancestors
              saveState(sessionId, state)
              bindAuditVersion(sessionId, state)
              return state
            })
            if (!withLock) return ok({
              ...base, activated: false, executed,
              note: '等锁期间会话已有任务卡，跳过自动开卡（未覆盖当前任务）',
            })
            audit('run', sessionId, {
              kind: 'activation',
              tier,
              goal: card.goal,
              pending: withLock.activation_pending,
            })
            executed.push({ tool: step.tool, ok: true, tier })
          }
        }

        const after = loadState(sessionId)
        return ok({
          ...base,
          activated: true,
          executed,
          has_card: !!after.card,
          activation_pending: Array.isArray(after.activation_pending)
            ? after.activation_pending
            : [],
          pending_fields: plan.pendingFields || [],
          note: '已自动激活：会话进入门禁态，补齐 scope/acceptance/verify.cmd 后方可派发',
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
]
export { TOOLS }
