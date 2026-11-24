// verify 领域：真实工具实现与原始契约。
import path from 'node:path'
import {
  audit,
  readAuditState,
  ok,
  fail,
  fingerprintFailed,
  fingerprintError,
  evidenceIdentity,
  hardDenyFalsifyInvalidation,
  clearHardDenyFalsifyInvalidation,
  clearFalsifyInvalidationFailure,
  invalidateLastFalsify,
  checkCommandRules,
  withStateLock,
  commitState,
  workspaceFingerprintAsync,
  runVerifyCommand,
  runNegativeControl,
  computeOutputHash,
  claimStaleOffer,
  staleCaseIdentity,
  FLOW_HOME,
} from './shared.js'
import { presentVerifyOutput } from '../verify-output.js'
import { collectVerifyFailure } from '../failure-memory.js'
import { resolveTaskWorkdir, markTaskRunning, clearTaskRunning } from '../worktree.js'
const TOOLS = [
{
    name: 'flow_run_verify',
    description:
      '执行卡片中指定的验证命令，返回执行结果（退出码、stdout、stderr）。' +
      '用于在派发 executor 后验证其工作成果，或手动触发验证。',
    inputSchema: {
      type: 'object',
      properties: {
        expected: { type: 'object', description: '可选向导领取身份；无效绝不回退手动执行', properties: { caseKey: { type: 'string' } }, required: ['caseKey'], additionalProperties: false },
        isolateHome: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = readAuditState(sessionId)
        if (!state.card) return fail('没有留痕，无法执行验证。')
        if (!state.card.verify || !state.card.verify.cmd)
          return fail('卡片未指定验证命令。')

        // 工作目录优先级：显式 cwd > 卡片提交时的项目目录 > server 进程 cwd。
        // 不能只拿 process.cwd() —— MCP server 是常驻进程，
        // 它的 cwd 是**启动时**的目录（可能是几个月前的某个旧仓库），
        // 于是 verify.cmd 会在错误的目录里跑，测试脚本找不到、路径全错，
        // 而门禁把这种失败当成了「验证不通过」（真 PASS 被误杀）。
        const cardProject =
          state.card.env && typeof state.card.env.project === 'string'
            ? state.card.env.project
            : ''
        // 任务卡声明了工作区就必须在它里面执行：
        // 登记缺失/不 ready/路径不符时 fail-closed，绝不悄悄回落到主目录后还报 PASS。
        const declaresWorktree = !!(state.card.env && state.card.env.worktree)
        const taskWorktree = resolveTaskWorkdir(state.card, { flowHome: FLOW_HOME })
        if (declaresWorktree && !taskWorktree) {
          return fail('任务卡声明的任务工作区未登记或不可用；拒绝回落到主目录执行。')
        }
        if (taskWorktree && a.cwd && path.resolve(a.cwd) !== path.resolve(taskWorktree.path)) {
          return fail('显式 cwd 与任务卡绑定的工作区不一致；拒绝在错误目录执行。')
        }
        let workdir = a.cwd || (taskWorktree ? taskWorktree.path : null) || cardProject || undefined
        // 记住「这次验证针对哪张卡」：命令跑完再写状态时，卡片可能已被替换。
        const verifiedIdentity = evidenceIdentity(state)
        const verifiedCardTs = state.card_ts
        let verifiedCmd = state.card.verify.cmd
        const hasExpected = Object.prototype.hasOwnProperty.call(a, 'expected')
        let receipt
        if (hasExpected) {
          if (!a.expected || typeof a.expected !== 'object' || Array.isArray(a.expected) ||
              Object.keys(a.expected).some(key => key !== 'caseKey') ||
              context?.session_id !== sessionId || context.workdir_is_local !== true || context.workdir_is_read_only !== false)
            return fail('向导领取身份或本地会话位置无效；不会自动重试或回退执行。')
          receipt = await claimStaleOffer(sessionId, a.expected, a.cwd, context.workdir)
          if (staleCaseIdentity(sessionId, state) !== receipt.caseKey)
            return fail('领取期间卡片或原验证已变化；领取已消耗，未执行命令，不会自动重放。')
          verifiedCmd = receipt.cmd
          workdir = receipt.cwd
        }

        // 15条通用防撞规则：R7/R8 危险命令与全局盲杀前置拦截
        const cmdRulesCheck = checkCommandRules(verifiedCmd)
        if (!cmdRulesCheck.ok) {
          const failViolation = cmdRulesCheck.violations.find((v) => v.level === 'FAIL')
          if (failViolation) {
            audit('decision', sessionId, {
              kind: 'command_denied',
              rule: failViolation.rule,
              reason: failViolation.message,
            })
            return fail(`${failViolation.message}\n💡 提示：${failViolation.hint}`)
          }
        }

        // ⚠️ 命令必须在**锁外**跑（最长 120s）。若把整段包进 withStateLock，
        // 持锁超过 staleMs（30s）就会被判陈旧并回收，另一个进程随即拿到同一把锁
        // → 两个进程同时写，比不加锁更难复现。
        let markedRunning = false
        if (taskWorktree) {
          const marked = markTaskRunning(taskWorktree.task_id, { flowHome: FLOW_HOME })
          if (!marked.ok) return fail('任务工作区运行标记写入失败：' + marked.reason)
          markedRunning = true
        }
        let result
        try {
          result = await runVerifyCommand(verifiedCmd, workdir, {
            timeoutMs: a.timeoutMs,
            isolateHome: a.isolateHome,
            sendProgress: context?.sendProgress,
            progressToken: context?.progressToken,
          })
        } finally {
          // 失败或异常不保留“运行中”，否则一次失败就会把工作区永久锁死。
          if (markedRunning && (!result || !result.ok)) {
            clearTaskRunning(taskWorktree.task_id, { flowHome: FLOW_HOME })
          }
        }
        const fingerprint = await workspaceFingerprintAsync(workdir || process.cwd(), runtime)
        const outputHash = computeOutputHash(
          result.exitCode,
          result.stdout,
          result.stderr,
        )

        // 短锁内重新读最新状态，只合并 last_verify（不覆盖别人写的其它字段）。
        let merged = false
        await commitState(sessionId, (state2) => {
          if (evidenceIdentity(state2) !== verifiedIdentity) return
          if (receipt && staleCaseIdentity(sessionId, state2) !== receipt.caseKey) return
          merged = true
          state2.last_verify = {
            ts: new Date().toISOString(),
            cmd: verifiedCmd,
            cwd: workdir || process.cwd(),
            exitCode: result.exitCode,
            ok: result.ok && !fingerprintFailed(fingerprint),
            // card_ts：把证据绑定到**当前这张卡**，防止「旧卡的验证结果」被新卡复用
            // （新卡即使写了同一条命令，也不该继承上一张卡的绿灯）。
            card_ts: receipt ? receipt.cardTs : verifiedCardTs,
            // 输出指纹：把「验证通过」绑定到一次可复现的运行，而不是「我说过了」。
            output_hash: outputHash,
            // 代码状态指纹：把「验证通过」绑定到**当时的代码状态**。
            // 没有它，验证通过后再改坏代码，flow_verdict(PASS) 仍会放行（见 A1）。
            fingerprint,
          }
          // 验证失败意味着旧裁定失效：不能让 flow_status.completed_ok 继续报绿。
          // 只清裁定字段，不碰卡、快照与审计；重新验证通过后可重新走双轴。
          if (!state2.last_verify.ok) {
            state2.completed_ok = false
            state2.verdict = null
            state2.verdict_role = null
            state2.verdict_ts = 0
          }
        })

        if (!merged) return fail('命令已执行，但卡或原验证已变化；旧结果未覆盖新证据，禁止重放。')
        if (fingerprintFailed(fingerprint)) return fail(fingerprintError(fingerprint))
        // 阶段二接线：只把明确的业务断言失败采集为“待核实经验”。
        // 语法/缺模块/权限/超时/未知 IO 一律不入库（分类函数内部拒绝）。
        // 采集失败不影响验证结果，也不向调用方谎报保存成功。
        if (!result.ok) {
          try {
            collectVerifyFailure(
              { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut },
              {
                flowHome: FLOW_HOME,
                cwd: workdir || process.cwd(),
                sessionId,
                cardTs: receipt ? receipt.cardTs : verifiedCardTs,
                cmd: verifiedCmd,
              },
            )
          } catch {}
        }
        return ok({
          ...await presentVerifyOutput(result, { flowHome: FLOW_HOME, sessionId, outputHash }),
          cwd: workdir || process.cwd(),
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
{
    name: 'flow_falsify',
    description:
      '负对照（negative control）：把工作区还原到派发时的「改动前」状态跑同一 verify.cmd，要求它**失败**；' +
      '再还原「改动后」状态跑一次，要求它**通过**。只有「改动前失败 + 改动后通过」才证明这个测试真的在测本次改动' +
      '（而不是 `|| true` / `echo ok` 这类空测试）。记 PASS 裁定前必须先做负对照。',
    inputSchema: {
      type: 'object',
      properties: {
        isolateHome: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        sessionId: { type: 'string', description: '会话 ID，默认 unknown' },
        cwd: { type: 'string', description: '工作目录，默认 process.cwd()' },
      },
    },
    handler: async (args, context, runtime) => {
      try {
        const a = args || {}
        const sessionId = a.sessionId || 'unknown'
        const state = readAuditState(sessionId)
        if (!state.card) return fail('没有留痕，无法做负对照。')
        if (!state.card.verify || !state.card.verify.cmd)
          return fail('卡片未指定验证命令，无法做负对照。')

        const cardProject =
          state.card.env && typeof state.card.env.project === 'string'
            ? state.card.env.project
            : ''
        const workdir = a.cwd || cardProject || undefined

        const falsifiedIdentity = evidenceIdentity(state, true)
        let r
        try {
          r = await runNegativeControl(
            sessionId,
            state.card.verify.cmd,
            workdir,
            {
              timeoutMs: a.timeoutMs,
              isolateHome: a.isolateHome,
              sendProgress: context?.sendProgress,
              progressToken: context?.progressToken,
            },
          )
        } catch (e) {
          // 负对照**抛异常**（如参数非法、工作区不可读）同样必须作废既有 last_falsify。
          // 否则上一次「meaningful」的旧结论会继续支撑 PASS —— 门禁就变成了
          // 「只要历史上通过过一次就永远通过」。
          const reason =
            '负对照执行异常：' + (e && e.message ? e.message : String(e));
          const invalidated = await invalidateLastFalsify(
            sessionId,
            state.card_ts,
            reason,
            falsifiedIdentity,
          )
          audit('run', sessionId, {
            kind: 'falsify_denied',
            reason: reason,
            card_ts: state.card_ts,
          })
          if (!invalidated.ok) {
            return fail(
              reason +
                '（既有负对照结论**未能作废**：' +
                invalidated.reason +
                '；' +
                (invalidated.marker === 'not_written'
                  ? '「不可 PASS」标记也写不进去，本进程内已硬拒 PASS（跨进程持久化需先修复状态存储），请修复状态存储后重新做负对照'
                  : '本会话已被标记为不可 PASS，请修复状态存储后重新做负对照') +
                '）',
            )
          }
          return fail(reason + '（既有负对照结论已作废，请修复后重新做负对照）');
        }
        if (!r.ok) {
          // 先作废，再审计；审计抛错不能保留既有 meaningful。
          const invalidated = await invalidateLastFalsify(
            sessionId,
            state.card_ts,
            r.error || '负对照无法执行',
            falsifiedIdentity,
          )
          audit('run', sessionId, {
            kind: 'falsify_denied',
            reason: r.error || '负对照无法执行',
            card_ts: state.card_ts,
          })
          if (!invalidated.ok) {
            return fail(
              (r.error || '负对照无法执行') +
                '（既有负对照结论**未能作废**：' +
                invalidated.reason +
                '；' +
                (invalidated.marker === 'not_written'
                  ? '「不可 PASS」标记也写不进去，本进程内已硬拒 PASS（跨进程持久化需先修复状态存储），请修复状态存储后重新做负对照'
                  : '本会话已被标记为不可 PASS，请修复状态存储后重新做负对照') +
                '）',
            )
          }
          return fail(r.error || '负对照无法执行')
        }

        const falsifiedCardTs = state.card_ts
        const falsifiedCmd = state.card.verify.cmd
        // 指纹要 spawn 一次 git，属于「慢操作」，必须在拿锁之前算好。
        const falsifiedFingerprint = await workspaceFingerprintAsync(
          workdir || process.cwd(), runtime,
        )

        // 负对照本身跑了两次命令（最长 240s），同样只能在锁外跑；写入段用短锁合并，
        // 只覆盖 last_falsify / last_verify 两个字段，不碰别人写的其它字段。
        let merged = false
        await commitState(sessionId, (state2) => {
          if (evidenceIdentity(state2, true) !== falsifiedIdentity) return
          merged = true
          state2.last_falsify = {
            ts: new Date().toISOString(),
            cmd: falsifiedCmd,
            cwd: workdir || process.cwd(),
            verdict: r.verdict,
            reason: r.reason,
            // 证据必须属于**当前卡片**（与 last_verify 同口径）：
            // 旧卡的负对照结论不得冒充新卡的证据。
            card_ts: falsifiedCardTs,
            before: {
              exitCode: r.before.exitCode,
              ok: r.before.ok,
              hash: r.before.hash,
            },
            after: {
              exitCode: r.after.exitCode,
              ok: r.after.ok,
              hash: r.after.hash,
            },
            // 工作区还原是否被核对通过（ok=false 表示负对照过程中改动可能没被完整写回）。
            // 还原核对结果随裁定一起暴露 —— 免得「改动消失」只留在 stderr 里。
            // 裁定闸另外独立核一次 restore.ok（还原没核对通过就不给 PASS）。
            restore: r.restore
              ? {
                  ok: r.restore.ok,
                  checked: r.restore.checked,
                  mismatched: r.restore.mismatched,
                }
              : null,
          }
          // 把「改动后」的运行写为 last_verify —— 裁定的证据绑定到这一次运行。
          state2.last_verify = {
            ts: new Date().toISOString(),
            cmd: falsifiedCmd,
            cwd: workdir || process.cwd(),
            exitCode: r.after.exitCode,
            ok: r.after.ok && !fingerprintFailed(falsifiedFingerprint),
            output_hash: r.after.hash,
            card_ts: falsifiedCardTs,
            // 代码状态指纹：负对照同样是一次「验证通过」，
            // 必须与 flow_run_verify 一样绑定代码状态，
            // 否则「先负对照、再改代码、再记 PASS」这条路径会绕过 STALE 闸门。
            fingerprint: falsifiedFingerprint,
          }
        })

        if (!merged) return fail('负对照已还原，但卡或证据已变化；旧结果未覆盖新证据，禁止重放。')
        // 本次负对照的结论已经写进状态：之前「作废旧结论失败」留下的不可 PASS 标记
        // 可以撤销（新的结论属于当前卡，且已通过证据一致性校验）。
        // 撤不掉必须**如实报告**：标记留着就一直挡着 PASS，而用户重跑负对照也清不掉。
        const clearedMarker = clearFalsifyInvalidationFailure(sessionId)
        if (!clearedMarker.ok) {
          hardDenyFalsifyInvalidation(
            sessionId,
            falsifiedCardTs,
            '旧的「不可 PASS」标记清除失败：' + clearedMarker.error,
          )
        } else {
          clearHardDenyFalsifyInvalidation(sessionId)
        }
        audit('run', sessionId, {
          kind: 'falsify',
          verdict: r.verdict,
          before_exit: r.before.exitCode,
          after_exit: r.after.exitCode,
          before_hash: r.before.hash,
          after_hash: r.after.hash,
          restore_ok: r.restore ? r.restore.ok : null,
          restore_mismatched: r.restore ? r.restore.mismatched : [],
          recovered_files: r.recovered ? r.recovered.files : 0,
        })

        if (fingerprintFailed(falsifiedFingerprint))
          return fail(fingerprintError(falsifiedFingerprint))
        const trunc = (s) =>
          typeof s === 'string' && s.length > 2000 ? s.slice(0, 2000) + '…' : s
        return ok({
          ok: true,
          verdict: r.verdict,
          reason: r.reason,
          before: {
            exitCode: r.before.exitCode,
            ok: r.before.ok,
            hash: r.before.hash,
            stdout: trunc(r.before.stdout),
            stderr: trunc(r.before.stderr),
          },
          after: {
            exitCode: r.after.exitCode,
            ok: r.after.ok,
            hash: r.after.hash,
            stdout: trunc(r.after.stdout),
            stderr: trunc(r.after.stderr),
          },
          // 工作区还原的核对结果（失败时备份已保留，下次调用会先尝试恢复）
          restore: r.restore || null,
          // 本次调用开始时恢复掉的「上一次被中断的负对照」残留
          recovered: r.recovered || null,
          note:
            (r.verdict === 'meaningful'
              ? '负对照通过：测试有判别力，可以记 PASS。'
              : '负对照未通过：不能记 PASS。' + r.reason) +
            (r.restore && r.restore.ok === false
              ? ' ⚠️ 但工作区还原未通过核对，以下文件与进入负对照前不一致：' +
                (r.restore.mismatched || []).join(', ') +
                '（备份已保留，请人工确认后修复）'
              : '') +
            (!clearedMarker.ok
              ? ' ⚠️ 旧的「不可 PASS」标记清除失败（' +
                clearedMarker.error +
                '）：标记仍在，裁定闸会继续拒 PASS，请人工删除该文件后重试。'
              : ''),
        })
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    },
  },
]
export { TOOLS }
