// gate 领域：真实工具实现与原始契约。
import {
  pendingAuditEntries,
  auditCardIdentity,
  archiveCardAudit,
  storeAuditEntries,
  isRetryableVerdict,
  audit,
  auditRequests,
  bindAuditVersion,
  readAuditState,
  log,
  ok,
  fail,
  guideError,
  asStringArray,
  resolveRepoRoot,
  dispatchDirInsideProject,
  asRawArray,
  asObject,
  cardVerifyCmd,
  fingerprintKind,
  fingerprintFailed,
  fingerprintError,
  collectAxisWarnings,
  introducedChanges,
  readHardDenyFalsifyInvalidation,
  readFalsifyInvalidationFailure,
  spawnSync,
  statSync,
  realpathSync,
  parseCard,
  validateCard,
  validateNewFiles,
  riskTier,
  isSensitive,
  pathKey,
  checkNewFilesBoundary,
  detectProjectTestCommand,
  validateAgentMesh,
  checkCardScopeRules,
  checkGitDiffRules,
  generateQASheet,
  loadState,
  saveState,
  defaultState,
  appendAudit,
  getUserMessages,
  pathExists,
  gitHead,
  isStale,
  withStateLock,
  commitState,
  workspaceFingerprintAsync,
  buildContractPrompt,
  snapshotFiles,
  writeDispatchPrompt,
  enforceScope,
  formatError,
  MAX_DISPATCH,
  path,
  issueStaleOffer,
  FLOW_HOME,
} from './shared.js'
const TOOLS = [
{
    name: 'flow_submit_requirement',
    description:
      '提交（留痕）一张任务卡，作为后续派发的唯一依据。任何 T2 改动前必须先调用本工具。' +
      '可以传结构化参数（goal/quote/scope/newFiles/newFilesReason/acceptance/unknowns/assumptions/files/verify/confirmed），' +
      '也可以直接传 cardText（形如 FLOW_CARD:{...} 的单行 JSON）。' +
      '本工具会做锚点校验（quote 必须能在用户原话里定位）、scope 路径存在性校验、必填字段校验、敏感路径确认；' +
      '新增文件请用 newFiles（相对仓库根、派发时尚不存在）单独授权，必须同时带 confirmed=true 与 newFilesReason；' +
      '校验不通过会返回 ok:false 与 findings，此时不得派发。返回 ok:true 表示留痕成功，可以继续调 flow_claim。',
    inputSchema: {
      type: 'object',
      properties: {
        appendScope: {
          type: 'array',
          items: { type: 'string' },
          description: '经用户确认只追加范围，保留既有派发与快照',
        },
        reason: { type: 'string', description: '追加范围的用户授权说明' },
        goal: { type: 'string', description: '一句话目标（任务卡 objective）' },
        quote: {
          type: 'string',
          description: '用户原话摘录，用于锚点校验，必须能在用户消息中定位',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: '只准改动的文件清单（相对 cwd 的路径）',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '可判定的验收标准',
        },
        unknowns: {
          type: 'array',
          items: { type: 'string' },
          description: '未知/待澄清事项',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: '已做的假设',
        },
        files: {
          type: 'array',
          description: '关键定位点，每项需带 path 与 line',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'number' },
            },
            required: ['path', 'line'],
          },
        },
        verify: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          description: '主 Agent 指定的验证命令',
        },
        confirmed: {
          type: 'boolean',
          description: '敏感路径是否已获用户确认（sensitive 档必须为 true）',
        },
        newFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            '获授权可新建的文件路径（相对仓库根，派发时尚不存在）。' +
            '必须同时带 confirmed=true 与 newFilesReason；已存在的文件请放进 scope',
        },
        newFilesReason: {
          type: 'string',
          description: '新文件授权的用户授权说明（与 newFiles 配套，必填且非空）',
        },
        parallel_plan: {
          type: 'string',
          description: '并行派发计划说明（可选）',
        },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
        userMessages: {
          type: 'array',
          items: { type: 'string' },
          description: '用户原话列表（可选，会与自动读取的结果合并）',
        },
        cardText: {
          type: 'string',
          description:
            '完整任务卡文本，含 FLOW_CARD: 前缀；提供时优先于结构化参数',
        },
        activation: {
          type: 'boolean',
          description:
            'true = 这是智能触发引擎自动开的占位卡；在 scope/acceptance/verify.cmd 补齐前会阻止派发',
        },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        // scope 校验基准 = git 仓库根（与 git diff 同基准）；
        // verify 执行目录 = 调用方显式给的目录，没给才用仓库根。
        const cwdInput = a.cwd || process.cwd()
        const scopeRoot = resolveRepoRoot(cwdInput)
        const execDir = a.cwd || scopeRoot

        if (Object.hasOwn(a, 'appendScope')) {
          const allowed = new Set([
            'sessionId',
            'cwd',
            'appendScope',
            'confirmed',
            'reason',
            'newFiles',
            'newFilesReason',
          ])
          if (Object.keys(a).some((key) => !allowed.has(key)))
            return fail('追加范围不能混用完整重提交参数')
          if (a.confirmed !== true)
            return fail('追加范围需要用户明确确认 confirmed=true')
          if (typeof a.reason !== 'string' || !a.reason.trim())
            return fail('追加范围必须提供授权说明 reason')
          if (!Array.isArray(a.appendScope) || !a.appendScope.length)
            return fail('追加范围必须是非空路径数组')
          if (!loadState(sessionId).card)
            return fail('没有既有任务卡，不能追加范围')
          // ---- 追加新文件授权（与追加 scope 同语义：确认 + 授权说明缺一不可）----
          // 追加的是「获授权可新建的文件」：派发时它们不存在，
          // 追加后卡片的既有派发次数、快照、角色与证据保持不变。
          let newFileAdditions = []
          let newFileReasonText = ''
          // 锚点数据源（用户原话）：与提交路径同源。
          let appendMessages = []
          if (
            Object.hasOwn(a, 'newFiles') &&
            a.newFiles !== undefined &&
            a.newFiles !== null
          ) {
            if (typeof a.newFilesReason !== 'string' || !a.newFilesReason.trim())
              return fail('追加新文件授权必须提供授权说明 newFilesReason')
            const before = loadState(sessionId)
            try {
              const fetched = await getUserMessages(sessionId, 50)
              if (Array.isArray(fetched)) appendMessages = appendMessages.concat(fetched)
            } catch (e) {
              log(`getUserMessages 失败：${e && e.message ? e.message : e}`)
            }
            const checkedNew = validateNewFiles(
              a.newFiles,
              before.card.scope,
              scopeRoot,
              {
                confirmed: true,
                reason: a.newFilesReason,
                userMessages: appendMessages,
              },
            )
            if (!checkedNew.ok) return fail(checkedNew.reason)
            newFileAdditions = checkedNew.files
            newFileReasonText = a.newFilesReason.trim()
          }
          const root = realpathSync(scopeRoot)
          const additions = a.appendScope.map((p) => {
            if (typeof p !== 'string' || !p.trim())
              throw new Error('追加范围包含无效路径')
            const full = realpathSync(
              path.resolve(scopeRoot, p.replace(/\\/g, '/')),
            )
            const rel = path.relative(root, full).replace(/\\/g, '/')
            if (
              !rel ||
              rel === '..' ||
              rel.startsWith('../') ||
              path.isAbsolute(rel) ||
              !statSync(full).isFile()
            ) {
              throw new Error('追加范围必须是仓库内存在的文件')
            }
            return rel
          })
          const appended = await commitState(
            sessionId,
            (latest) => {
              if (!latest.card) throw new Error('没有既有任务卡，不能追加范围')
              if (
                latest.card.env?.project &&
                realpathSync(resolveRepoRoot(latest.card.env.project)) !== root
              ) {
                throw new Error('追加范围的仓库与原卡项目不一致')
              }
              const oldScope = Array.isArray(latest.card.scope)
                ? latest.card.scope
                : []
              // 路径键用**平台感知**的那一把（card.js 的 pathKey）：
              // win32 折叠大小写、其它平台敏感 —— 与授权校验、越界检测同一口径。
              const scopeKey = (p) => pathKey(path.resolve(scopeRoot, p))
              const keys = new Set(oldScope.map(scopeKey))
              const added = additions.filter((p) => {
                const key = scopeKey(p)
                if (keys.has(key)) return false
                keys.add(key)
                return true
              })
              // 新文件授权：去重口径与 scope 追加一致（已存在的不重复加）
              const oldNewFiles = Array.isArray(latest.card.new_files)
                ? latest.card.new_files
                : []
              const newKeys = new Set(oldNewFiles.map(scopeKey))
              for (const p of oldScope) newKeys.add(scopeKey(p))
              const addedNewFiles = newFileAdditions.filter((p) => {
                const key = scopeKey(p)
                if (newKeys.has(key)) return false
                newKeys.add(key)
                return true
              })
              if (!added.length && !addedNewFiles.length)
                return {
                  added: [],
                  added_new_files: [],
                  card_ts: latest.card_ts,
                  preserved_dispatch: true,
                }
              // 逐文件保留新文件授权依据：旧文件的授权说明**不得被新说明覆盖**
              // （否则追加一次就把之前的授权依据抹掉了，事后无法回答「当时凭什么授权的」）。
              const oldNewFilesReasons =
                latest.card.new_files_reasons &&
                typeof latest.card.new_files_reasons === 'object'
                  ? { ...latest.card.new_files_reasons }
                  : {}
              const newFilesReasons = { ...oldNewFilesReasons }
              for (const p of addedNewFiles) {
                newFilesReasons[p] = newFileReasonText
              }
              const candidate = {
                ...latest.card,
                scope: [...oldScope, ...added],
                ...(addedNewFiles.length
                  ? {
                      new_files: [...oldNewFiles, ...addedNewFiles],
                      // 汇总字段只保留**首次**授权说明；逐文件依据见 new_files_reasons。
                      new_files_reason:
                        typeof latest.card.new_files_reason === 'string' &&
                        latest.card.new_files_reason.trim()
                          ? latest.card.new_files_reason
                          : newFileReasonText,
                      new_files_reasons: newFilesReasons,
                    }
                  : {}),
              }
              const checked = validateCard(candidate, {
                // 用户原话 + 原卡的 quote：quote 在落卡时已锚定过，
                // 这里带上它是为了不因为数据源窗口滚动而误杀追加操作。
                userMessages: appendMessages.concat([
                  latest.card.quote || '',
                ]),
                confirmed: true,
                scopeExists: (p) => pathExists(scopeRoot, p),
                repoRoot: scopeRoot,
              })
              if (!checked.ok)
                throw new Error(checked.reason || '追加范围后的卡片不合规')
              const cardTs = Math.max(
                Date.now(),
                Number(latest.card_ts || 0) + 1,
              )
              // 失败审计不触发常规失败补偿；本分支在改卡前必须得到持久化回执。
              const receipt = appendAudit('run', sessionId, {
                kind: 'scope_append_prepared',
                phase: 'prepared',
                reason: a.reason,
                added,
                added_new_files: addedNewFiles,
                previous_card_ts: latest.card_ts,
                card_ts: cardTs,
                preserved_dispatch: true,
              })
              if (!receipt.persisted)
                throw new Error(`追加范围审计未确认持久化: ${receipt.error}`)
              latest.audit_scope_ancestors = [...(latest.audit_scope_ancestors || []), auditCardIdentity(latest)]
              latest.card = candidate
              latest.card_ts = cardTs
              latest.tier = riskTier(candidate.scope)
              latest.last_verify = null
              latest.last_falsify = null
              latest.audit_axes = { standards: null, spec: null }
              latest.audit_axes_ts = 0
              latest.verdict = null
              latest.verdict_role = null
              latest.completed_ok = false
              bindAuditVersion(sessionId, latest)
              return {
                added,
                added_new_files: addedNewFiles,
                card_ts: cardTs,
                preserved_dispatch: true,
              }
            },
            { skipUnchanged: true },
          )
          // ---- 追加的新文件必须补记快照（created:true）----
          //
          // 为什么：负对照的「改动前态」来自派发快照。如果追加授权的新文件
          // 没有进快照，负对照还原不到「它们不存在」的改动前态 ——
          // 验证命令在「改动前」照样通过 → 负对照变成 vacuous（空测试）。
          // 补记的条目在还原时按「删除该文件」处理。
          if (appended && Array.isArray(appended.added_new_files) && appended.added_new_files.length) {
            try {
              snapshotFiles(sessionId, appended.added_new_files, scopeRoot)
            } catch (e) {
              // 补记失败必须如实报告：卡片已生效，但负对照会失去判别力。
              audit('run', sessionId, {
                kind: 'snapshot',
                role: 'append_scope',
                files: appended.added_new_files.length,
                new_files: appended.added_new_files.length,
                ok: false,
                error: e && e.message ? e.message : String(e),
              })
              return fail(
                '追加范围已生效，但补记新文件快照失败：' +
                  (e && e.message ? e.message : String(e)) +
                  '（负对照将无法还原到改动前态，请重新派发后再做负对照）',
              )
            }
          }
          return ok({
            ok: true,
            ...appended,
            preserved: '既有派发次数、基线、角色及所有快照保持不变',
          })
        }

        let card = null
        if (typeof a.cardText === 'string' && a.cardText.trim() !== '') {
          const parsed = parseCard(a.cardText)
          if (parsed && parsed.error) return fail(parsed.error)
          if (!parsed || !parsed.card)
            return fail(
              'FLOW_CARD 解析失败：请按模板重写（单行 JSON，英文双引号）。',
            )
          card = parsed.card
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
          }
          // Auto-Verify: 若未显式传入 verify.cmd，且调用方显式提供了非空 scope 时，才推断测试命令
          // （防止在空 scope 或未初始化的普通卡上提前填入 verify.cmd 导致 activation_pending 丢失 verify.cmd 校验项）
          const hasExplicitScope = Array.isArray(a.scope) && a.scope.length > 0
          if (!a.activation && hasExplicitScope && (!card.verify || !card.verify.cmd)) {
            const detectedCmd = detectProjectTestCommand(scopeRoot || execDir);
            if (detectedCmd) {
              card.verify = { ...(card.verify || {}), cmd: detectedCmd, autoInferred: true };
            }
          }
          if (typeof a.parallel_plan === 'string' && a.parallel_plan !== '')
            card.parallel_plan = a.parallel_plan
        }

        // 锚点数据源：调用方传入的 userMessages + 自动从 opencode SQLite 读取的用户原话
        // （quote 与**新文件授权说明**共用这一份数据源 —— 两者都是「能在用户原话中定位」的锚点）
        let messages = asStringArray(a.userMessages)
        try {
          const fetched = await getUserMessages(sessionId, 20)
          if (Array.isArray(fetched)) messages = messages.concat(fetched)
        } catch (e) {
          log(`getUserMessages 失败：${e && e.message ? e.message : e}`)
        }

        // ---- 新文件授权：两条入口（结构化参数 / cardText）口径必须一致 ----
        //
        // 结构化入口用 newFiles / newFilesReason；
        // cardText 入口用卡片里的 new_files（授权说明可放 new_files_reason）。
        // 两条入口的拒绝条件完全相同，否则 cardText 路径就能绕开门禁。
        //
        // **冲突必须显式拒绝**：cardText 里已经声明了 new_files（或 new_files_reason），
        // 而参数里又给了 newFiles（或 newFilesReason）—— 两处都声明了授权依据，
        // 静默取其中一份等于「把另一份授权依据丢掉」。宁可报错让调用方自己说清用哪份。
        // 两处**完全一致**时不算冲突（没有丢信息），不算冲突时直接按同一份处理。
        const paramHasNewFiles =
          Object.hasOwn(a, 'newFiles') &&
          a.newFiles !== undefined &&
          a.newFiles !== null
        const paramHasNewFilesReason =
          typeof a.newFilesReason === 'string' && a.newFilesReason.trim() !== ''
        const cardHasNewFiles =
          Array.isArray(card.new_files) && card.new_files.length > 0
        const cardHasNewFilesReason =
          typeof card.new_files_reason === 'string' &&
          card.new_files_reason.trim() !== ''
        const sameFileList =
          cardHasNewFiles &&
          paramHasNewFiles &&
          JSON.stringify(card.new_files) === JSON.stringify(a.newFiles)
        if (cardHasNewFiles && paramHasNewFiles && !sameFileList) {
          return fail(
            'cardText 里的 new_files 与参数 newFiles 冲突：两处都声明了获授权的新文件，' +
              '请只保留其中一处（不要静默丢弃其中一份授权依据）',
          )
        }
        if (
          cardHasNewFilesReason &&
          paramHasNewFilesReason &&
          card.new_files_reason.trim() !== a.newFilesReason.trim()
        ) {
          return fail(
            'cardText 里的 new_files_reason 与参数 newFilesReason 冲突：两处都声明了授权说明，' +
              '请只保留其中一处',
          )
        }
        let newFilesInput = null
        let newFilesReasonText = ''
        if (paramHasNewFiles) {
          newFilesInput = a.newFiles
          newFilesReasonText =
            typeof a.newFilesReason === 'string' ? a.newFilesReason.trim() : ''
        } else if (cardHasNewFiles) {
          newFilesInput = card.new_files
          newFilesReasonText = paramHasNewFilesReason
            ? a.newFilesReason.trim()
            : card.new_files_reason.trim()
        }
        if (newFilesInput) {
          const tierNow = riskTier(card.scope)
          const rejectNewFiles = (reason, findings) => {
            for (const f of findings || [])
              audit('finding', sessionId, {
                kind: 'card_finding',
                detail: f,
                tier: tierNow,
              })
            audit('decision', sessionId, {
              kind: 'blocked',
              reason,
              tier: tierNow,
            })
            return ok({ ok: false, reason, findings: findings || [], tier: tierNow })
          }
          // 规则本体在 src/card.js 的 validateNewFiles（卡片层与提交层同一份）。
          // 这里只负责把上下文喂进去：仓库根 / scope / 授权说明 / 用户原话。
          const checkedNew = validateNewFiles(
            newFilesInput,
            card.scope,
            scopeRoot,
            {
              confirmed: a.confirmed === true || card.confirmed === true,
              reason: newFilesReasonText,
              userMessages: messages,
            },
          )
          if (!checkedNew.ok)
            return rejectNewFiles(checkedNew.reason, checkedNew.findings)
          card.new_files = checkedNew.files
          // 授权说明随卡片落盘：卡片层复核时要求它存在（非空），
          // 事后审计也能看到「当时凭什么授权了这个新文件」。
          card.new_files_reason = newFilesReasonText
          // 逐文件保留授权依据：追加授权时旧文件的说明不得被覆盖。
          card.new_files_reasons = Object.fromEntries(
            checkedNew.files.map((f) => [f, newFilesReasonText]),
          )
        }

        const options = {
          userMessages: messages,
          scopeExists: (p) => pathExists(scopeRoot, p),
          // 走 cardText 提交的卡片，其自身的 confirmed 字段同样必须生效，否则敏感路径永远无法通过
          confirmed: a.confirmed === true || card.confirmed === true,
          // new_files 的仓库边界由 card.js 的 validateNewFiles 统一判定（不再各写一份）
          repoRoot: scopeRoot,
        }

        // 多 Agent 网格校验
        if (a.agents && typeof a.agents === 'object') {
          const meshCheck = validateAgentMesh(a.agents, card.scope)
          if (!meshCheck.ok) {
            return fail(meshCheck.reason)
          }
          card.agents = meshCheck.agents
        }

        // 15条通用防撞规则：在提交层前置校验白名单敏感资产 (R1~R3, R15)
        // 占位卡阶段（空 scope）或只读调研不阻断
        const isActivationInit = a.activation === true || card.activation === true
        if (!isActivationInit && Array.isArray(card.scope) && card.scope.length > 0) {
          const scopeRulesCheck = checkCardScopeRules(card.scope, card.new_files, {
            confirmed: a.confirmed === true || card.confirmed === true,
          })
          if (!scopeRulesCheck.ok) {
            const failViolation = scopeRulesCheck.violations.find((v) => v.level === 'FAIL')
            if (failViolation) {
              audit('decision', sessionId, {
                kind: 'blocked',
                rule: failViolation.rule,
                reason: failViolation.message,
                tier: riskTier(card.scope),
              })
              return ok({
                ok: false,
                reason: `${failViolation.message}\n💡 提示：${failViolation.hint}`,
                findings: [failViolation.message],
                tier: riskTier(card.scope),
              })
            }
          }
        }

        const tier = riskTier(card.scope)
        const result = validateCard(card, options)
        const findings =
          result && Array.isArray(result.findings) ? result.findings : []

        if (!result || result.ok !== true) {
          const reason = (result && result.reason) || '卡片不合规'
          for (const f of findings)
            audit('finding', sessionId, {
              kind: 'card_finding',
              detail: f,
              tier,
            })
          audit('decision', sessionId, { kind: 'blocked', reason, tier })
          return ok({ ok: false, reason, findings, tier })
        }

        card.env = { git_head: gitHead(execDir), project: execDir }

        // ---- 闸门待补项：服务端从当前卡片内容**幂等派生** ----
        // 内容判定：与 validateCard 的必填字段口径**严格一致**（两边都要求
        // 「每个元素都是非空字符串」）。acceptance=[""] / [null] / ["a",null] 这类
        // 含无效元素的伪填充，既不算卡片合规，也不算闸门已补齐 —— 统一卡严，避免绕过。
        const cardHasScope =
          Array.isArray(card.scope) &&
          card.scope.length > 0 &&
          card.scope.every(
            (p) =>
              typeof p === 'string' &&
              p.trim() !== '' &&
              p !== '.' &&
              p !== '..',
          )
        const cardHasAcceptance =
          Array.isArray(card.acceptance) &&
          card.acceptance.length > 0 &&
          card.acceptance.every((x) => typeof x === 'string' && x.trim() !== '')
        const cardHasVerify = !!(
          card.verify &&
          typeof card.verify.cmd === 'string' &&
          card.verify.cmd.trim() !== ''
        )
        const currentMissing = [
          ...(!cardHasScope ? ['scope'] : []),
          ...(!cardHasAcceptance ? ['acceptance'] : []),
          ...(!cardHasVerify ? ['verify.cmd'] : []),
        ]

        // activation 标记既可能来自工具参数（结构化提交），也可能来自卡片本身（cardText 提交）。
        // 两条路径必须一致，否则 cardText 路径可以完全绕开闸门。
        const isActivation = a.activation === true || card.activation === true

        // ---- 读-改-写放进跨进程排他锁 ----
        // 多个 MCP server 进程共享同一 CARLOS_FLOW_HOME 时，未加锁会丢更新：
        // 后写入者用过期 prevState 算出 pending=[]，而它写的卡片字段仍为空 ⇒ 闸门被绕过。
        const gated = await withStateLock(sessionId, () => {
          const prev = loadState(sessionId)
          if (isActivation && prev.card) return null // CLI/activation 等锁期间出现卡，同样不得覆盖或归档。
          const wasActivatedBefore = prev.activation_activated === true
          const prevPendingBefore = Array.isArray(prev.activation_pending)
            ? prev.activation_pending
            : []

          let activationPending
          if (isActivation) {
            // 显式占位卡：待补项 = 服务端从这张卡实际缺什么推导出来的。
            activationPending = currentMissing
          } else if (wasActivatedBefore) {
            // 该会话开过占位卡：继续按**当前卡片实际缺什么**锁定。
            // 幂等派生（而不是「上一轮 pending 传递」），所以即使并发丢更新，
            // 落盘的 pending 永远与同一份落盘卡片一致，不会出现「卡片空却 pending=[]」。
            activationPending = currentMissing
          } else {
            // 普通卡（未标 activation，且本会话从未激活过）：不上闸门。
            // 档位必填项已由 validateCard 按 tier 强制（read_only 只要 goal+quote），
            // 此处再加闸门会误伤 T1 只读调研。
            activationPending = []
          }

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
            activation_pending: activationPending,
            // 单调标记：一旦激活过就永不清除
            activation_activated: isActivation || wasActivatedBefore,
          }
          delete state.audit_scope_ancestors
          saveState(sessionId, state)
          bindAuditVersion(sessionId, state)
          return {
            state,
            activationPending,
            wasActivatedBefore,
            prevPendingBefore,
          }
        })

        if (!gated) return ok({ ok: true, activated: false, skipped: true,
          reason: '会话已有任务卡，跳过激活（未覆盖当前任务）' })
        const {
          state,
          activationPending,
          wasActivatedBefore,
          prevPendingBefore,
        } = gated

        // 闸门事件：建立 / 保持 / 解除，都要在审计链里留痕。
        if (isActivation) {
          audit('decision', sessionId, {
            kind: 'activation_gate_activated',
            reason: '智能触发占位卡激活（服务端从卡片内容派生待补字段）',
            pending: activationPending,
          })
        } else if (
          wasActivatedBefore &&
          prevPendingBefore.length > 0 &&
          activationPending.length === 0
        ) {
          // 解锁事件统一由「pending 由非空变空」触发，避免被误记成 activated。
          audit('decision', sessionId, {
            kind: 'activation_gate_unlocked',
            reason: '字段已补齐，激活闸门解除',
            released: prevPendingBefore,
          })
        } else if (wasActivatedBefore && activationPending.length > 0) {
          audit('decision', sessionId, {
            kind: 'activation_gate_held',
            reason: '字段尚未补齐，激活闸门继续保持',
            pending: activationPending,
          })
        }

        audit('run', sessionId, { kind: 'record', tier, goal: card.goal })
        audit('decision', sessionId, {
          kind: 'accepted',
          tier,
          goal: card.goal,
        })
        for (const f of findings)
          audit('finding', sessionId, { kind: 'card_finding', detail: f, tier })

        // 激活占位卡建立 / 闸门解除都要在审计链里留专属事件，
        // 否则事后无法从 gate-audit 流水回答「这是不是占位卡、有没有解闸过」。
        if (isActivation) {
          audit('run', sessionId, {
            kind: 'activation',
            tier,
            goal: card.goal,
            pending: activationPending,
          })
        } else if (
          wasActivatedBefore &&
          prevPendingBefore.length > 0 &&
          activationPending.length === 0
        ) {
          audit('decision', sessionId, {
            kind: 'activation_released',
            tier,
            goal: card.goal,
            released: prevPendingBefore,
          })
        }

        const sensitivePaths = (
          Array.isArray(card.scope) ? card.scope : []
        ).filter((p) => isSensitive(p))

        return ok({
          ok: true,
          tier,
          findings,
          card,
          state,
          sensitive: sensitivePaths,
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_claim',
    description:
      '领取一次派发名额（executor 或 auditor）。返回四段合同 prompt，可直接作为子 Agent 的任务描述。' +
      '前置条件：必须有 flow_submit_requirement 留下的卡；卡过期（stale）或派发次数达到上限会直接报错。' +
      '每次 claim 都会消耗一次派发额度，重复 claim 前先想清楚是否必要。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        role: {
          type: 'string',
          enum: ['executor', 'auditor'],
          description: '领取角色',
        },
      },
    },
    handler: async (args) => {
      try {
        // Phase 1-1: role 白名单校验（非法值必须报错，不得静默降级）
        const a = args || {}
        const rawRole =
          a.role === undefined || a.role === null || a.role === ''
            ? 'executor'
            : String(a.role)
        if (rawRole !== 'executor' && rawRole !== 'auditor') {
          return fail('非法 role：' + rawRole + '，必须是 executor 或 auditor')
        }
        const role = rawRole
        const sessionId = a.sessionId || 'unknown'
        const state = readAuditState(sessionId)

        if (!state.card) {
          return fail(
            guideError(
              state,
              '没有留痕（record），executor/auditor 不得开工。请先由主 Agent 调用 flow_submit_requirement 提交任务卡。',
            ),
          )
        }
        if (isStale(state)) {
          return fail(
            guideError(state, '留痕已过期（stale），请重新提交任务卡。'),
          )
        }
        if (state.dispatch_count >= MAX_DISPATCH) {
          return fail(
            guideError(
              state,
              '派发次数已达上限 ' + MAX_DISPATCH + '，停止派发并向用户汇报。',
            ),
          )
        }
        // 激活占位卡闸门：占位卡未补齐字段时不允许领取派发名额
        if (
          Array.isArray(state.activation_pending) &&
          state.activation_pending.length > 0
        ) {
          return fail(
            guideError(
              state,
              '激活占位卡尚未补齐（待补：' +
                state.activation_pending.join('、') +
                '）。请先补齐后重新调用 flow_submit_requirement，再来领取派发名额。',
            ),
          )
        }

        // Phase 1-1: 不在 claim 时增加 dispatch_count，改在 dispatch 时增加
        // claim 只标记已领取（state.claimed），不消耗派发额度。
        // 读-改-写放进短锁：上面刚做完整卡校验，这里用最新状态合并，
        // 避免把「校验时的快照」整体写回、回滚掉别人在间隙里写的字段。
        await commitState(sessionId, (latest) => {
          if (latest.card_ts !== state.card_ts || JSON.stringify(latest.card) !== JSON.stringify(state.card) ||
              !latest.card || isStale(latest) || latest.activation_pending?.length || latest.dispatch_count >= MAX_DISPATCH)
            throw new Error('领取前任务卡或门禁状态已变化，请重新核对状态')
          bindAuditVersion(sessionId, latest)
          latest.claimed = true
          latest.claimed_role = role
          latest.last_user_ts = Date.now()
          state.claimed = latest.claimed
          state.claimed_role = latest.claimed_role
        })

        audit('decision', sessionId, {
          kind: 'claimed',
          role,
          dispatch_count: state.dispatch_count,
        })

        const result = {
          ok: true,
          role,
          card: state.card,
          tier: state.tier,
          dispatch_count: state.dispatch_count,
          prompt: buildContractPrompt(role, state.card),
        }
        if (state.bypass === true) result.bypass = true
        return ok(result)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_dispatch',
    description:
      '按四段合同派发子 Agent（executor 写代码 / auditor 独立复核）。' +
      '派发前会自动对 scope 内文件做快照（用于事后还原），message 会以原样附在合同末尾。' +
      'run=false（默认）只生成 prompt 供你自己派子 Agent；run=true 则由本工具拉起 opencode 子进程直接跑并回传 stdout/stderr。' +
      '必须先 flow_submit_requirement 留痕，否则报错。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        role: {
          type: 'string',
          enum: ['executor', 'auditor'],
          description: '派发角色',
        },
        message: { type: 'string', description: '附加说明，原样附在合同末尾' },
        run: {
          type: 'boolean',
          description:
            'true = 由本工具直接运行 opencode；false/absent = 只返回 prompt',
        },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args) => {
      try {
        const a = args || {}
        // Phase 1-1: role 白名单校验（非法值必须报错，不得静默降级）
        const rawRole =
          a.role === undefined || a.role === null || a.role === ''
            ? 'executor'
            : String(a.role)
        if (rawRole !== 'executor' && rawRole !== 'auditor') {
          return fail('非法 role：' + rawRole + '，必须是 executor 或 auditor')
        }
        const role = rawRole

        // Phase 1-1: dispatch 前强制校验 stale / dispatch_count / claim
        const sessionId = a.sessionId || 'unknown'
        const state = readAuditState(sessionId)
        if (!state.card)
          return fail(guideError(state, '没有留痕，不允许派发。'))
        if (isStale(state))
          return fail(
            guideError(state, '留痕已过期（stale），请重新提交任务卡。'),
          )
        if (state.dispatch_count >= MAX_DISPATCH)
          return fail(
            guideError(
              state,
              '派发次数已达上限 ' + MAX_DISPATCH + '，停止派发并向用户汇报。',
            ),
          )
        // 激活占位卡闸门：占位卡未补齐字段时不允许派发
        if (
          Array.isArray(state.activation_pending) &&
          state.activation_pending.length > 0
        ) {
          return fail(
            guideError(
              state,
              '激活占位卡尚未补齐（待补：' +
                state.activation_pending.join('、') +
                '）。请先补齐后重新调用 flow_submit_requirement，再来派发。',
            ),
          )
        }
        // 必须先 flow_claim 领取派发名额（claimed 标记由 claim 设置）
        if (state.claimed !== true)
          return fail(
            guideError(state, '未 claim，请先 flow_claim 领取派发名额。'),
          )

        // 派发基准必须**按卡片登记的项目根**（card.env.project）：
        // scope 是仓库根相对路径，snapshot / baseline / 裁定三处要用同一个基准，
        // 否则越界判定会自相矛盾。
        //
        // 为什么不能拿「派发时 cwd 的仓库根」当基准：授权（落卡）与执行（派发）
        // 可能不在同一个仓库/目录 —— 拿新根复核等于「换个基准重新判一次」，
        // 原本越出卡片项目根的授权路径会被判成「在新根里没越界」。
        // 口径：卡片登记了项目根时，**一律按它复核**；
        // 派发目录不在卡片项目根之内 → 明确拒绝派发并说明原因。
        const newFiles = Array.isArray(state.card.new_files)
          ? state.card.new_files
          : []
        const cardProjectRaw =
          state.card && state.card.env && typeof state.card.env.project === 'string'
            ? state.card.env.project
            : ''
        const cardProjectRoot = cardProjectRaw.trim()
          ? resolveRepoRoot(cardProjectRaw)
          : ''
        // 派发目录：显式给了就用它；没给就回落到卡片项目根
        // （卡片已经定义了「这次工作在哪个项目」，没给 cwd 不是「换个项目」）。
        const dispatchRoot = a.cwd
          ? resolveRepoRoot(a.cwd)
          : cardProjectRoot || resolveRepoRoot(process.cwd())
        if (!cardProjectRoot) {
          // 卡片没登记项目根 → 无从复核授权路径的边界（fail-open 风险）。
          // 有待复核的新文件时不得派发。
          if (newFiles.length > 0) {
            audit('decision', sessionId, {
              kind: 'dispatch_project_root_missing',
              dispatch_root: dispatchRoot,
            })
            return fail(
              formatError(
                '卡片未登记项目根（card.env.project），无法按卡片项目根复核新文件授权边界，拒绝派发。' +
                  '请重新提交带工作目录的任务卡。',
              ),
            )
          }
        } else if (!dispatchDirInsideProject(cardProjectRoot, dispatchRoot)) {
          audit('decision', sessionId, {
            kind: 'dispatch_project_root_mismatch',
            card_project_root: cardProjectRoot,
            dispatch_root: dispatchRoot,
          })
          return fail(
            formatError(
              '派发目录与卡片登记的项目根不一致（卡片项目根：' +
                cardProjectRoot +
                '；派发目录：' +
                dispatchRoot +
                '），拒绝派发：新文件授权的越界复核必须按卡片项目根进行。',
            ),
          )
        }
        const cwd = cardProjectRoot || dispatchRoot

        // 获授权的新文件在**派发时**要再核一次真实路径边界。
        //
        // 为什么：授权（落卡）与执行（派发）之间可能隔很久 —— 期间授权路径的
        // 父目录可能被换成指向仓库外的符号链接 / junction。落卡时安全，
        // 执行时文件已经写到仓库外了。
        // 口径与落卡时一致（card.js 的 checkNewFilesBoundary）：解析不出真实路径
        // 一律按保守口径拒绝 → 拒绝派发，并给出原因。
        // 复核的根 = **卡片登记的项目根**（不是派发时 cwd 的仓库根）。
        if (newFiles.length > 0) {
          const boundary = checkNewFilesBoundary(cwd, newFiles)
          if (!boundary.ok) {
            audit('decision', sessionId, {
              kind: 'new_files_boundary_violation',
              reason: boundary.reason,
            })
            return fail(
              formatError(
                '新文件授权路径复核未通过，拒绝派发：' + boundary.reason,
              ),
            )
          }
        }
        // 计数与清零在短锁内合并（不整体回写校验时的快照）
        let bypassReset = false
        await commitState(sessionId, (latest) => {
          if (latest.card_ts !== state.card_ts || JSON.stringify(latest.card) !== JSON.stringify(state.card) ||
              !latest.card || isStale(latest) || latest.activation_pending?.length || latest.dispatch_count >= MAX_DISPATCH ||
              latest.claimed !== true || latest.dispatch_count !== state.dispatch_count)
            throw new Error('派发前任务卡或名额已变化，请重新领取并核对状态')
          bindAuditVersion(sessionId, latest)
          latest.dispatch_count = (Number(latest.dispatch_count) || 0) + 1
          // 额度已消耗，需要重新 claim 才能再次派发
          latest.claimed = false
          latest.write_files = 0
          // Phase 1-1: 派发后自动清零免检，避免“忘记关免检”长期生效
          if (latest.bypass === true) {
            latest.bypass = false
            latest.bypass_ts = 0
            bypassReset = true
          }
          state.dispatch_count = latest.dispatch_count
          state.bypass = latest.bypass
        })
        if (bypassReset) {
          audit('decision', sessionId, {
            kind: 'bypass_auto_reset',
            reason: '派发后自动清零',
          })
        }

        // 声明了任务工作区但登记不可用：拒绝派发，避免改动落在主工作区后验证又 fail-closed。
        if (state.card.env && state.card.env.worktree) {
          const { resolveTaskWorkdir } = await import('../worktree.js')
          if (!resolveTaskWorkdir(state.card, { flowHome: FLOW_HOME })) {
            return fail('任务卡声明的任务工作区未登记或不可用；拒绝派发。')
          }
        }
        const prompt = buildContractPrompt(role, state.card, a.message)

        const scope = Array.isArray(state.card.scope) ? state.card.scope : []
        // 快照必须覆盖「获授权可新建的文件」：它们在派发时尚不存在，
        // snapshotFiles 会按 created:true 记录（派发时不存在 → 还原时删除）。
        const snapshotTargets = [...scope, ...newFiles]
        const entries = snapshotFiles(sessionId, snapshotTargets, cwd)
        audit('run', sessionId, {
          kind: 'snapshot',
          role,
          files: snapshotTargets.length,
          new_files: newFiles.length,
          ok: true,
        })

        // Phase 1-1: 记录「派发前基线」。
        // 使用与后续校验一致的 cwd，修正基准
        const baseline = enforceScope(snapshotTargets, cwd)
        const baselineFiles = Array.isArray(baseline.checked)
          ? baseline.checked
          : []
        // 快照 + git diff 是慢操作，必须在锁外；这里只合并 dispatch_baseline 一个字段
        await commitState(sessionId, (latest) => {
          if (latest.card_ts !== state.card_ts || JSON.stringify(latest.card) !== JSON.stringify(state.card) ||
              latest.dispatch_count !== state.dispatch_count)
            throw new Error('快照后任务卡或派发代已变化，拒绝合并旧基线')
          latest.dispatch_baseline = baselineFiles
          state.dispatch_baseline = baselineFiles
        })
        audit('run', sessionId, {
          kind: 'dispatch_baseline',
          role,
          files: state.dispatch_baseline.length,
        })

        if (a.run === true) {
          // 写入 prompt 文件，供主 Agent 读取后通过 subagent 工具派发
          const { file } = writeDispatchPrompt(sessionId, role, prompt, cwd)
          audit('run', sessionId, { kind: 'dispatch', role, prompt_file: file })
          return ok({
            ok: true,
            role,
            prompt,
            snapshot: entries,
            run: {
              prompt_file: file,
              note: '主 Agent 请读取 prompt_file 内容，使用 subagent 工具按角色派发（executor=worker, auditor=reviewer）。执行完成后调用 save_agent_result 保存结果。',
            },
          })
        }

        return ok({ ok: true, role, prompt, snapshot: entries, run: null })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_verdict',
    description:
      '记录 auditor 的裁定结果（PASS / DIRECTION / LOCAL）。只有 PASS 会把 completed_ok 置为 true。' +
      'DIRECTION 表示方向对但需返工，LOCAL 表示问题局限在局部。在向用户汇报完成前必须先落裁定，否则视为未复核。' +
      '【双轴门禁】记 PASS 前必须先 flow_audit_axes 派发 Standards/Spec 两轴、由 subagent 取证后 flow_audit_submit 提交两轴结论；任一轴 FAIL 会被拒，WARN 不硬拦。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        verdict: {
          type: 'string',
          enum: ['PASS', 'DIRECTION', 'LOCAL'],
          description: '裁定结果',
        },
        notes: { type: 'string', description: '裁定说明/证据摘要' },
        role: { type: 'string', description: '记录裁定者角色（通常 auditor）' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = readAuditState(sessionId)
        const judgedSnapshot = JSON.stringify(state)

        // 裁定闸门的分组与顺序与 docs/TOOL_CONTRACTS.md 第 1.2 节严格一致：
        //   【无条件 2 组】1 有卡 · 2 占位卡已补齐
        //   【仅 PASS 7 组】3 派发过 · 4 验证有效 · 5 验证未过期 · 6 无越界
        //                 · 7 role=auditor · 8 负对照 · 9 双轴齐且无 FAIL
        // 顺序不可调换：先证实验证有效（4/5）→ 再证改动合规（6/7）→ 再证测试有判别力（8）
        // → 再证审查到位（9）。错位会让「未验证」被「双轴未齐」掩盖，调用方拿到不可操作的下一步。
        // 另有 8e「既有负对照结论可作废」：它是**前置否决闸**（先于 3~9 求值）——
        // 标记存在就意味着旧结论不可信，任何 PASS 都不该落；先说它是因为
        // 它给出的下一步最具体（先修状态存储，再重做负对照）。
        if (!state.card)
          return fail(guideError(state, '没有留痕，无法记录裁定。'))

        const verdict = a.verdict

        // ── 门禁 2/9（无条件）：激活占位卡必须已补齐 ──
        // 否则会出现「未派发、未验证、却直接 PASS」的假闭环。
        // （先于 dispatch_count 检查：占位卡的错误信息更具体，也更可操作）
        if (
          Array.isArray(state.activation_pending) &&
          state.activation_pending.length > 0
        ) {
          audit('decision', sessionId, {
            kind: 'verdict_denied',
            reason: '激活占位卡未补齐',
            pending: state.activation_pending,
          })
          return fail(
            guideError(
              state,
              '激活占位卡尚未补齐（待补：' +
                state.activation_pending.join('、') +
                '），不能记录裁定。请先补齐后重新调用 flow_submit_requirement。',
            ),
          )
        }

        // ── 前置否决闸（仅 PASS，计入门禁 8e）：既有负对照结论必须可作废 ──
        //
        // 负对照失败/异常时必须作废上一轮的 last_falsify；**作废这一步本身失败**
        // （状态锁损坏 / 超时）时，旧结论会继续支撑 PASS。
        // 这种情况下状态里写不进「已作废」，所以作废失败会另外落一个持久标记；
        // 标记在时任何 PASS 都不许落 —— 宁可拒，也不能让旧结论冒充新证据。
        // 放在最前面是因为它给出的下一步最具体（先修状态存储，再重做负对照）。
        if (verdict === 'PASS') {
          const invalidationFailure = readFalsifyInvalidationFailure(sessionId)
          const hardDeny = readHardDenyFalsifyInvalidation(sessionId)
          // 硬拒（标记文件写不进去时的进程内兜底）与持久标记同口径：
          // 属于当前卡（或未绑定卡）时一律拒 PASS。
          const hardDenyApplies =
            hardDeny &&
            (hardDeny.card_ts === null ||
              hardDeny.card_ts === undefined ||
              Number(hardDeny.card_ts) === Number(state.card_ts))
          if (
            (invalidationFailure &&
              (invalidationFailure.card_ts === null ||
                invalidationFailure.card_ts === undefined ||
                Number(invalidationFailure.card_ts) === Number(state.card_ts))) ||
            hardDenyApplies
          ) {
            const failureReason = invalidationFailure
              ? invalidationFailure.reason || '未知原因'
              : hardDeny.reason || '未知原因'
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '既有负对照结论未能作废',
              invalidation_reason: failureReason,
              invalidation_persisted: !!invalidationFailure,
            })
            return fail(
              formatError(
                '上一次的负对照结论未能作废（状态写入失败：' +
                  failureReason +
                  '），不能记录 PASS 裁定。请先修复状态存储，再对当前卡片重新调用 flow_falsify。',
              ),
            )
          }
        }

        // ── 门禁 3/9（仅 PASS）：确实派发过 ──
        // 从未派发过任何执行，就不允许落 PASS 裁定。
        // 否则一张刚提交、什么都没跑的卡也能直接标 completed_ok=true。
        // 只施加于 PASS：DIRECTION / LOCAL 是「有问题」的裁定，不构成「完成」，
        // 允许在未派发时先记录返工意见。
        if (verdict === 'PASS' && !(Number(state.dispatch_count) > 0)) {
          audit('decision', sessionId, {
            kind: 'verdict_denied',
            reason: '尚未派发任何执行',
            dispatch_count: state.dispatch_count,
          })
          return fail(
            guideError(
              state,
              '尚未派发任何执行（dispatch_count=0），不能记录 PASS 裁定。' +
                '请先 flow_claim / flow_dispatch 派发并完成验证后再落 PASS。',
            ),
          )
        }

        // ── 门禁 4/9（仅 PASS）：验证真实有效 ──
        // 记 PASS 必须有**真实验证通过**的证据。
        // 「派发过」≠「验证过」——只查 dispatch_count 时，一张跑过但验证失败的卡
        // 照样能落 PASS（completed_ok=true），等于把验证环节架空。
        // 三个条件同时成立才放行：
        //   1) 存在 flow_run_verify 写入的 state.last_verify；
        //   2) last_verify.ok === true（真实执行退出码为 0）；
        //   3) last_verify.cmd 与**当前卡片**的 verify.cmd 一致（防止旧卡结果冒充新卡）。
        // 只施加于 PASS：DIRECTION / LOCAL 是返工意见，不要求已完成验证。
        if (verdict === 'PASS') {
          const lv = state.last_verify
          const want = cardVerifyCmd(state)
          if (!lv || typeof lv !== 'object') {
            // 区分两种「没验证」：卡片压根没写 verify.cmd（用户无从下手）
            // vs 写了但还没跑。前者必须给出可操作的下一步，否则是死路。
            if (!want) {
              audit('decision', sessionId, {
                kind: 'verdict_denied',
                reason: '卡片未指定验证命令',
              })
              return fail(
                '卡片未指定 verify.cmd，没有可核验的验证依据，不能记录 PASS 裁定。' +
                  '请重新提交带 verify.cmd 的任务卡（flow_submit_requirement），' +
                  '用 flow_run_verify 跑通后再记录裁定。',
              )
            }
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '尚未执行验证',
            })
            return fail(
              '尚未执行验证，不能记录 PASS 裁定。请先调用 flow_run_verify ' +
                '跑通卡片里的 verify.cmd，再记录裁定。',
            )
          }
          if (lv.ok !== true) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证未通过',
              exitCode: lv.exitCode,
              verify_cmd: lv.cmd,
            })
            return fail(
              formatError(
                '验证未通过（exitCode=' +
                  lv.exitCode +
                  '），不能记录 PASS 裁定。' +
                  '请先修复问题、让 verify.cmd 真实跑通（flow_run_verify），再记录裁定。',
              ),
            )
          }
          // 「证据属于当前这张卡」：旧卡的绿灯不能给新卡复用。
          // 兼容历史状态：2.15.0 之前写入的 last_verify 没有 card_ts 字段 —— 那时
          // 只能靠命令一致性把关，缺字段按「无法证明属于当前卡」处理会更安全，
          // 但会让所有升级用户手上跑通的验证立刻作废。这里取折中：
          //   缺 card_ts 时要求验证时间晚于当前卡的提交时间（证据不可能早于卡）。
          if (
            lv.card_ts !== undefined &&
            Number(lv.card_ts) !== Number(state.card_ts)
          ) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证证据属于另一张任务卡',
              verify_card_ts: lv.card_ts,
              card_ts: state.card_ts,
            })
            return fail(
              formatError(
                '现有的验证结果属于**上一张任务卡**（card_ts 不一致），不能给当前卡记 PASS 裁定。' +
                  '请对当前卡片重新执行 flow_run_verify（或 flow_falsify）后再记录裁定。',
              ),
            )
          }
          if (lv.card_ts === undefined) {
            const verifiedAt = Date.parse(String(lv.ts || ''))
            if (
              Number.isFinite(verifiedAt) &&
              Number(verifiedAt) < Number(state.card_ts || 0)
            ) {
              audit('decision', sessionId, {
                kind: 'verdict_denied',
                reason: '验证早于当前卡提交时间',
                verify_ts: lv.ts,
                card_ts: state.card_ts,
              })
              return fail(
                formatError(
                  '现有的验证结果早于当前任务卡的提交时间，不能给当前卡记 PASS 裁定。' +
                    '请重新执行 flow_run_verify 后再记录裁定。',
                ),
              )
            }
          }
          if (!want || typeof lv.cmd !== 'string' || lv.cmd.trim() !== want) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证命令与当前卡片不一致',
              verify_cmd: lv.cmd,
              card_cmd: want,
            })
            return fail(
              formatError(
                '已有的验证结果对应的命令与当前卡片的 verify.cmd 不一致，不能记录 PASS 裁定。' +
                  '请对当前卡片重新执行 flow_run_verify，再记录裁定。',
              ),
            )
          }

          // ── 门禁 5/9（仅 PASS）：验证结果未过期 ──
          // 验证结果必须绑定当时的**代码状态**（A1）。
          //
          // 前面三道判断只看「验证跑过 / 跑通了 / 命令对得上」，**不看代码变没变**。
          // 于是存在这条绕过路径：
          //   1. flow_run_verify 跑通 → last_verify = {ok:true, cmd:"npm test"}
          //   2. executor 继续改代码（甚至改坏）
          //   3. flow_verdict(PASS) → 三道全过 → 放行
          // 指纹把「验证通过」绑定到一次**可复现的运行**：验证之后再动过代码，指纹就变了。
          //
          // 非 git 目录：fail-open（Carlos Flow 支持非 Git 项目），但要在 flow_status
          // 里如实标注指纹不可用（见 R1）。
          const fpCwd =
            a.cwd ||
            (state.last_verify && state.last_verify.cwd) ||
            process.cwd()
          const fpWas = lv.fingerprint
          const fpNow = await workspaceFingerprintAsync(fpCwd, runtime)
          const legacyNonGit = fpWas == null && fingerprintKind(fpNow) === 'non_git'
          if ((!legacyNonGit && fingerprintFailed(fpWas)) || fingerprintFailed(fpNow))
            return fail(fingerprintError(!legacyNonGit && fingerprintFailed(fpWas) ? fpWas : fpNow))
          if (
            fingerprintKind(fpWas) === 'git' &&
            fingerprintKind(fpNow) === 'git' &&
            (fpNow.head !== fpWas.head || fpNow.diff_sha256 !== fpWas.diff_sha256)
          ) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证结果已过期（代码在验证后被修改）',
              fp_was: fpWas.diff_sha256,
              fp_now: fpNow.diff_sha256,
            })
            let offer
            if (context?.session_id === sessionId && context.workdir_is_local === true && context.workdir_is_read_only === false) {
              try { offer = await issueStaleOffer(sessionId, state, fpCwd) } catch { /* 不确定时只保留普通手动验证入口 */ }
            }
            return {
              ...fail(formatError('验证结果已过期（STALE）：验证通过后代码又被修改，请重新执行 flow_run_verify 再记录裁定。')),
              structuredContent: { code: 'VERIFY_STALE', detectedAt: offer?.detectedAt || Date.now(),
                ...(offer ? { expected: { caseKey: offer.caseKey }, expiresAt: offer.expiresAt } : {}),
              },
            }
          }

          // ── 门禁 6/9（仅 PASS）：无越界改动 ──
          // 越界改动必须被拦住。
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
          const scopeNow = Array.isArray(state.card.scope)
            ? state.card.scope
            : []
          // 允许集 = scope + new_files：获授权可新建的文件被创建后不得判越界。
          // scope 为空且没有新文件授权时，仍然是空 allow 集 → fail-closed。
          const newFilesNow = Array.isArray(state.card.new_files)
            ? state.card.new_files
            : []
          const allowedScope = [...scopeNow, ...newFilesNow]
          const scopeRootNow = resolveRepoRoot(state.card.env?.project || a.cwd || process.cwd())
          if (a.cwd && !dispatchDirInsideProject(scopeRootNow, resolveRepoRoot(a.cwd)))
            return fail('裁定目录与卡片项目根不一致，拒绝读取其他项目证据')
          if (pendingAuditEntries(state).some(e => !isRetryableVerdict(e, state, auditRequests.getStore())) ||
              (state.audit_pending?.kind === 'verdict' && state.audit_pending.card_ts !== state.card_ts))
            return fail('审计仍待确认，不能消费旧证据记录 PASS')
          const current = enforceScope(allowedScope, scopeRootNow)
          const introduced = introducedChanges(
            current.checked || [],
            state.dispatch_baseline,
          )
          const scopeCheck = enforceScope(allowedScope, scopeRootNow, introduced)
          if (!scopeCheck.ok) {
            audit('decision', sessionId, {
              kind: 'scope_violation',
              reason: '越界改动',
              violations: scopeCheck.violations,
              introduced: introduced.length,
            })
            return fail(
              formatError(
                '检测到越界改动，不能记录 PASS 裁定：' +
                  (scopeCheck.violations || []).join(', ') +
                  '。这些文件不在卡片 scope 白名单内。' +
                  '请把越界文件加入 scope（重新提交任务卡）后重试，或先撤销这些改动。',
              ),
            )
          }

          // 15条通用防撞规则：R11 降级断言 / R13 格式污染检查
          try {
            const diffProc = spawnSync('git', ['diff', 'HEAD'], { cwd: scopeRootNow, encoding: 'utf8', windowsHide: true })
            if (diffProc.status === 0 && diffProc.stdout) {
              const diffRules = checkGitDiffRules(diffProc.stdout)
              if (!diffRules.ok) {
                const failV = diffRules.violations.find((v) => v.level === 'FAIL')
                if (failV) {
                  audit('decision', sessionId, { kind: 'verdict_denied', rule: failV.rule, reason: failV.message })
                  return fail(`${failV.message}\n💡 提示：${failV.hint}`)
                }
              }
            }
          } catch { /* ignore git diff errors */ }

          // ── 门禁 7/9（仅 PASS）：裁定角色必须是 auditor ──
          // role 门禁绑定到会话 ID（claimed_role），而非调用方自述字符串
          if (verdict === 'PASS' && state.claimed_role !== 'auditor') {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: 'role 未绑定到 auditor 会话',
              claimed_role: state.claimed_role,
            })
            return fail(
              'PASS 裁定必须由已领取 auditor 角色的会话（flow_claim role=auditor）落下。当前会话 claimed_role=' +
                (state.claimed_role || 'null'),
            )
          }

          // ── 门禁 8/9（仅 PASS）：负对照证明测试有判别力 ──
          // 证明 verify.cmd 真的在测「本次改动」。
          //
          // 「验证通过」本身不是证据：verify.cmd 可以是 `|| true` / `echo ok`，
          // 改动前后都退 0，门禁却以为测试过了。负对照要求：
          //   · 还原到派发时（改动前）跑同一命令 → 必须失败
          //   · 还原回改动后跑同一命令 → 必须通过
          // 只有「改动前失败 + 改动后通过」才说明这个测试有判别力。
          const lf = state.last_falsify
          if (!lf || typeof lf !== 'object') {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '尚未做负对照',
            })
            return fail(
              '尚未做负对照（flow_falsify），不能记录 PASS 裁定。' +
                '请先用 flow_falsify 证明 verify.cmd 在改动前失败、改动后通过。',
            )
          }
          if (lf.verdict !== 'meaningful') {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '负对照未通过',
              falsify_verdict: lf.verdict,
            })
            return fail(
              formatError(
                '负对照未通过（' +
                  lf.verdict +
                  '）：' +
                  (lf.reason || '') +
                  ' 不能记录 PASS 裁定。请修正 verify.cmd 或改动后重试。',
              ),
            )
          }
          // 还原不完整 → 负对照结论不成立（PASS 闸不能只看 verdict）。
          //
          // 「改动前失败 + 改动后通过」只说明命令有区分度；如果工作区**没能完整回到**
          // 进入负对照时的状态，那「改动后」这一态就不是我们以为的那一态。
          // 这里再独立核一次还原回执：还原核对失败一律拒 PASS（双保险）。
          if (lf.restore && lf.restore.ok === false) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '负对照还原未通过核对',
              falsify_verdict: lf.verdict,
              restore_mismatched: lf.restore.mismatched || [],
            })
            return fail(
              formatError(
                '负对照的工作区还原未通过核对（' +
                  ((lf.restore.mismatched || []).join(', ') || '详见负对照回执') +
                  '），不能记录 PASS 裁定。请先确认工作区状态并重新做负对照。',
              ),
            )
          }
          // 证据必须属于当前卡：旧卡的负对照结论不得冒充新卡（缺 card_ts 的旧记录宽容放行）。
          if (lf.card_ts !== undefined && lf.card_ts !== state.card_ts) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '负对照证据不属于当前卡',
              falsify_card_ts: lf.card_ts,
              card_ts: state.card_ts,
            })
            return fail(
              '负对照证据不属于当前卡片（card_ts 不一致），不能记录 PASS 裁定。' +
                '请对当前卡片重新调用 flow_falsify。',
            )
          }
          // 绑定：裁定的证据必须就是负对照里「改动后」的那次运行。
          if (
            typeof lf.after === 'object' &&
            lf.after &&
            typeof lf.after.hash === 'string' &&
            state.last_verify &&
            state.last_verify.output_hash !== lf.after.hash
          ) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '验证证据与负对照不一致',
            })
            return fail(
              '已有的验证结果与负对照的运行结果不一致，不能记录 PASS 裁定。' +
                '请重新调用 flow_falsify（它会把改动后的运行写为验证证据）。',
            )
          }

          // ── 门禁 9/9（仅 PASS）：双轴审查齐且无 FAIL ──
          //
          // 位置说明（重要）：必须放在负对照**之后**。语义顺序是
          // 「先证实验证有效 → 再证审查到位」，九道门（2 无条件 + 7 仅 PASS）
          // 各自独立、互不掩盖。
          // 若前置，会让「未验证」「未派发」「未做负对照」这些更基础的问题被
          // 双轴错误信息掩盖，调用方拿到的是不可操作的下一步。
          //
          // 判定口径：
          //   · 两轴都必须有结论，且 card_ts 与当前卡一致（防旧卡审查结果冒充新卡，
          //     也防两轴跨卡拼接：卡A的 standards + 卡B的 spec 不算数）；
          //   · FAIL 硬拦（规范硬违规 / 未实现验收）；
          //   · WARN 不硬拦（坏味道是 judgement call），由主 Agent 读 audit_axes 后标注。
          const ax = state.audit_axes
          const axisOk = (a) =>
            ax && ax[a] && ax[a].verdict && ax[a].card_ts === state.card_ts
          const hasStandards = axisOk('standards')
          const hasSpec = axisOk('spec')
          if (!hasStandards || !hasSpec) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '两轴审查未齐',
              standards: ax && ax.standards ? ax.standards.verdict : null,
              spec: ax && ax.spec ? ax.spec.verdict : null,
              card_ts: state.card_ts,
            })
            return fail(
              '两轴审查未齐，不能记录 PASS 裁定。请先 flow_audit_axes 派发两轴、' +
                '由 subagent 取证后分别 flow_audit_submit 提交 Standards 与 Spec 两轴结论，再记录裁定。',
            )
          }
          const standardsFail = ax.standards.verdict === 'FAIL'
          const specFail = ax.spec.verdict === 'FAIL'
          if (standardsFail || specFail) {
            audit('decision', sessionId, {
              kind: 'verdict_denied',
              reason: '有轴不通过',
              standards: ax.standards.verdict,
              spec: ax.spec.verdict,
            })
            return fail(
              'PASS 被拒：两轴中至少一轴 FAIL（standards=' +
                ax.standards.verdict +
                ', spec=' +
                ax.spec.verdict +
                '）。请修复后重跑验证与审计。',
            )
          }
        }

        // 写入用**短锁 + card_ts CAS**：所有门禁判定都在锁外（只读快照）完成，
        // 拿锁后先核对卡片没被替换，再写。否则出现「判定用的卡 A、写进去的是卡 B」：
        // 裁定看起来合规，实际对着一张已经不存在的卡。
        const judgedCardTs = state.card_ts
        const findings = []
        const prevVerdict = state.verdict
        let cardReplaced = false
        await withStateLock(sessionId, () => {
          const latest = loadState(sessionId)
          if (JSON.stringify(latest) !== judgedSnapshot) {
            cardReplaced = true
            return
          }
          // 先取消已有 PASS，再进行可能失败的审计。
          latest.completed_ok = false
          const carriedEntries = pendingAuditEntries(latest)
          if (latest.audit_pending?.kind === 'verdict' &&
              (latest.audit_pending.verdict !== verdict || latest.audit_pending.card_ts !== judgedCardTs))
            carriedEntries.push({ ...latest.audit_pending, entries: undefined })
          latest.audit_pending = {
            kind: 'verdict',
            verdict,
            card_ts: judgedCardTs,
            entries: carriedEntries,
          }
          saveState(sessionId, latest)
          if (latest.verdict && latest.verdict !== verdict) {
            findings.push(`裁定被覆盖：${latest.verdict} → ${verdict}`)
            audit('finding', sessionId, {
              kind: 'verdict_overwrite',
              from: latest.verdict,
              to: verdict,
              tier: latest.tier,
            })
          }
          // 中断或失败可重试同一裁定；成功后清除可选 pending 字段。
          audit('resolution', sessionId, {
            kind: 'verdict',
            verdict,
            notes: a.notes,
            role: a.role,
            card_ts: judgedCardTs,
          })
          storeAuditEntries(latest, pendingAuditEntries(latest).filter(e =>
            !isRetryableVerdict(e, latest, auditRequests.getStore())))
          latest.verdict = verdict
          latest.completed_ok = verdict === 'PASS' && !latest.audit_pending
          latest.verdict_ts = Date.now()
          // 落盘裁定者角色：审计链据此回溯「这条 PASS 是谁落的」。
          latest.verdict_role = a.role === undefined ? null : a.role
          saveState(sessionId, latest)
          state.verdict = latest.verdict
          state.completed_ok = latest.completed_ok
          state.verdict_role = latest.verdict_role
        })
        // 裁定落盘后任务结束：清掉工作区运行标记，允许后续受控清理。
        {
          const env = state.card && state.card.env ? state.card.env : null
          const taskId = env && (env.worktree_task_id || (env.worktree && env.worktree.task_id))
          if (taskId) {
            try {
              const { clearTaskRunning } = await import('../worktree.js')
              clearTaskRunning(taskId, { flowHome: FLOW_HOME })
            } catch {}
          }
        }
        if (verdict === 'PASS' && state.card && state.card.quote) {
          try {
            const { LearnedRulesManager } = await import('../trigger.js')
            LearnedRulesManager.recordPositiveFeedback(state.card.quote)
          } catch {}
        }
        if (cardReplaced) {
          audit('decision', sessionId, {
            kind: 'verdict_denied',
            reason: '裁定期间任务卡被替换',
            judged_card_ts: judgedCardTs,
          })
          return fail(
            formatError(
              '裁定期间任务卡或判定证据已变化，本次裁定未写入。' +
                '请重新读 flow_status 确认当前卡，再重新走验证与裁定。',
            ),
          )
        }
        void prevVerdict

        // 裁定审计已在状态临界区内确认持久化。

        const warns = collectAxisWarnings(state)
        const result = {
          ok: true,
          verdict,
          completed_ok: state.completed_ok,
          notes: a.notes,
          verdict_role: state.verdict_role,
          // WARN 汇总：两轴里判 WARN（坏味道等 judgement call）的结论。
          // 以前 WARN 只躺在 state.audit_axes 里，主 Agent 不主动读就看不到，
          // 「带坏味道通过」在汇报里等于被吞掉 —— 现在随裁定一起返回。
          warn_count: warns.length,
        }
        if (warns.length) result.warn_findings = warns
        if (findings.length) result.findings = findings
        if (verdict === 'PASS') {
          result.qa_sheet = generateQASheet(state, a.notes, { stale: isStale(state) })
        }
        return ok(result)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
]
export { TOOLS }
