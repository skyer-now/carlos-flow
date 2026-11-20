export function narrate(event) {
  const reason = event.reason || '逻辑冲突';
  return {
    text: `⚠️ 抱歉，这里有点问题，建议检查一下配置：${reason}`,
    action: '查看原文'
  };
}

// 只投影白名单摘要；不读取文件、不调用宿主，也不信任 UI 自报步骤。
// observation 只由 flow_status 的本次权威验证采样提供，缺失即未知。
export function deriveWizardStatus(s = {}, observation = {}) {
  const card = s.card
  const text = (v) => typeof v === 'string' && v.trim().length > 0
  const list = (v) => Array.isArray(v) && v.length > 0 && v.every(text)
  const stamp = (v) => typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
  const currentTs = stamp(s.card_ts)
  const current = (v) => Number.isFinite(stamp(v)) && stamp(v) >= currentTs
  const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v)
  const labels = { start: '启动', goal: '说明目标', scope: '范围与验收', execution: '执行', checks: '检查与负对照', review: '独立审查', complete: '完成', problem: '处理问题' }
  const out = {
    stage: 'start', stage_label: labels.start, status: 'waiting', completed_ok: false,
    goal: card && text(card.goal) ? '已记录目标' : '尚未记录目标',
    scope_count: Array.isArray(card?.scope) ? card.scope.length : 0,
    reason: '请在原对话说明希望解决的问题。', next_responsible: '用户',
    sampled_at: Number.isFinite(observation.sampled_at) ? observation.sampled_at : null,
    warning_count: 0,
  }
  const at = (stage, reason, status = 'waiting', who = '原任务助手') => ({ ...out, stage, stage_label: labels[stage], reason, status, next_responsible: who })
  if (!card || typeof card !== 'object' || Array.isArray(card)) return out
  if (!text(card.goal)) return at('goal', '请先明确任务目标。', 'waiting', '用户')
  if (!Number.isFinite(currentTs) || currentTs <= 0 || !list(card.scope) || !list(card.acceptance) || !text(card.verify?.cmd) ||
      !Array.isArray(s.activation_pending) || s.activation_pending.length > 0) {
    return at('scope', '修改范围或验收依据尚未完整确认，不能开始执行。', 'blocked', '用户与原任务助手')
  }
  if (s.audit_pending) return at('problem', '审计记录尚未确认，不能宣称完成。', 'unknown')
  if (s.stale === true || observation.task_stale === true || s.bypass === true) return at('problem', '任务已过期或处于免检状态，需要重新确认正常流程。', 'blocked')
  const lv = s.last_verify
  const lf = s.last_falsify
  if (lf?.restore?.ok === false) return at('problem', '负对照后还原未通过核对，请先确认工作区。', 'blocked')
  if (!lv) return at('execution', '执行状态待确认；派发记录不代表工作已完成。', 'unknown')
  const bound = lv.card_ts === s.card_ts && current(lv.ts) && text(lv.cmd) && lv.cmd.trim() === card.verify.cmd.trim()
  if (!bound) return at('checks', '验证证据不属于当前任务，需要重新检查。', 'blocked')
  if (observation.verify_state === 'stale') return at('checks', '验证后内容发生变化，需要重新检查。', 'blocked')
  if (lv.ok !== true || observation.verify_state === 'fail') return at('checks', '检查未通过或验证依据不可用，不能继续。', 'blocked')
  if (observation.verify_passed !== true || observation.verify_state !== 'pass' || observation.fingerprint_available !== true || lv.exitCode !== 0 || !hash(lv.output_hash)) {
    return at('checks', '当前有效验证证据尚未确认，不能继续。', 'unknown')
  }
  // 现有负对照没有独立 card_ts；通过当前验证的命令、时间与输出哈希绑定。
  // 时间未知、空哈希、超时或仅自报 meaningful 都不构成有效负对照。
  const negative = lf && (lf.card_ts === undefined || lf.card_ts === s.card_ts) && current(lf.ts) && stamp(lv.ts) >= stamp(lf.ts) &&
    text(lf.cmd) && lf.cmd.trim() === card.verify.cmd.trim() && lf.verdict === 'meaningful' &&
    lf.before?.ok === false && Number.isInteger(lf.before?.exitCode) && lf.before.exitCode > 0 && hash(lf.before.hash) &&
    lf.after?.ok === true && lf.after.exitCode === 0 && hash(lf.after.hash) && lf.after.hash === lv.output_hash &&
    lf.restore?.ok === true && Number.isInteger(lf.restore.checked) && lf.restore.checked > 0 &&
    Array.isArray(lf.restore.mismatched) && lf.restore.mismatched.length === 0
  if (!negative) return at('checks', '负对照及还原的当前有效证据尚未齐全。', 'blocked')
  const axes = ['standards', 'spec'].map((name) => s.audit_axes?.[name])
  const axisCurrent = (axis) => axis && axis.card_ts === s.card_ts && current(axis.ts) && stamp(axis.ts) >= stamp(lv.ts)
  if (axes.some((axis) => axisCurrent(axis) && axis.verdict === 'FAIL')) return at('review', '独立审查发现问题，需先处理后重新检查。', 'blocked', '独立审查者')
  if (!axes.every((axis) => axisCurrent(axis) && ['PASS', 'WARN'].includes(axis.verdict) && text(axis.evidence))) {
    return at('review', '当前任务的两项独立审查证据尚未齐全。', 'waiting', '独立审查者')
  }
  out.warning_count = axes.filter((axis) => axis.verdict === 'WARN').length
  const final = s.completed_ok === true && s.verdict === 'PASS' && s.verdict_role === 'auditor' &&
    Number.isInteger(s.dispatch_count) && s.dispatch_count > 0 && current(s.verdict_ts) &&
    stamp(s.verdict_ts) >= Math.max(stamp(lv.ts), ...axes.map((axis) => stamp(axis.ts)))
  if (!final) return at('review', '尚无当前任务的合法独立最终裁定，不能宣称完成。', 'waiting', '独立审查者')
  return { ...at('complete', out.warning_count ? '检查与独立裁定已确认；仍有审查提醒。' : '检查与独立裁定已确认。', 'complete', '无需继续'), completed_ok: true }
}
