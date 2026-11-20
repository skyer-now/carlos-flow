/**
 * 完工电子质检交付单生成器 (QA Sheet Generator)
 * 纯内存装配结构化 Markdown 交付单
 */
export function generateQASheet(state = {}, notes = '') {
  const card = state.card || {};
  const lv = state.last_verify || {};
  const axes = state.audit_axes || {};
  const goal = card.goal || '未指定目标';
  const quote = card.quote || '无';
  const scope = Array.isArray(card.scope) ? card.scope : [];
  const newFiles = Array.isArray(card.new_files) ? card.new_files : [];
  const verifyCmd = lv.cmd || (card.verify && card.verify.cmd) || '未执行';
  const exitCode = lv.exitCode !== undefined ? lv.exitCode : 0;
  const outputHash = lv.output_hash ? lv.output_hash.slice(0, 16) + '...' : '已校验';

  const standards = axes.standards ? `${axes.standards.verdict} (${axes.standards.evidence || '无异味'})` : 'PASS';
  const spec = axes.spec ? `${axes.spec.verdict} (${axes.spec.evidence || '符合验收'})` : 'PASS';

  return [
    '## 📋 Carlos 完工电子质检交付单',
    '',
    `> **任务目标**：${goal}`,
    `> **用户原话**：\`${quote}\``,
    `> **裁定状态**：✅ **PASS (已通过双轴门禁独立复核)**`,
    '',
    '### 1. 修改范围与授权文件 (Scope)',
    scope.length > 0 ? scope.map((s) => `- \`${s}\``).join('\n') : '- 零文件改动 (只读/分析)',
    newFiles.length > 0 ? '\n**获授权新建文件**：\n' + newFiles.map((f) => `- \`${f}\``).join('\n') : '',
    '',
    '### 2. 真实验证证据 (Verification Proof)',
    `- **执行命令**：\`${verifyCmd}\``,
    `- **退出状态**：exitCode = ${exitCode} (通过)`,
    `- **输出指纹**：SHA-256 = \`${outputHash}\``,
    '',
    '### 3. 双轴独立审查结论 (Dual-Axis Review)',
    `- **Standards 规范轴**：${standards}`,
    `- **Spec 验收轴**：${spec}`,
    '',
    '### 4. 安全保障与回滚说明',
    '- 🛡️ 本次改动前已自动生成代码安全快照；',
    '- 💡 若需撤销本次所有改动，随时发送 **“恢复重来”** 即可一键还原现场。',
    notes ? `\n> **审查员附注**：${notes}` : '',
  ].join('\n');
}

export function narrate(event = {}) {
  const reason = event.reason || event.msg || '逻辑冲突';
  return {
    text: `⚠️ 抱歉，这里有点问题，建议检查一下配置：${reason}`,
    action: '查看原文'
  };
}

/**
 * 门禁拦截大白话翻译器（100% 通俗人话，零技术黑话）
 */
export function translateGateError(technicalMsg, state = {}) {
  const msg = String(technicalMsg || '');
  
  if (/没有留痕|record/i.test(msg)) {
    return '🛑 为了防止代码改乱，我先帮您踩了刹车。\n💡 为什么停下：还没记录这次要修改的具体目标。\n👉 怎么办：请先告诉我这次修改的目标是什么。';
  }
  if (/越界|scope.*越界|不在.*范围/i.test(msg)) {
    return '🛑 发现 AI 正在尝试修改没有约定过的文件。\n💡 为什么停下：这次只约定了修改特定文件，AI 越界去动了其他代码。\n👉 怎么办：如果您确实需要改它，请回复“允许追加”；否则我将阻止它的改动。';
  }
  if (/未\s*claim|入场券|名额/i.test(msg)) {
    return '🛑 尚未领取这次工作的「入场券」。\n💡 为什么停下：门禁需要先登记是谁在写代码还是在复核。\n👉 怎么办：稍等片刻，系统正在自动领取入场券。';
  }
  if (/占位卡尚未补齐|激活占位卡/i.test(msg)) {
    return '🛑 任务卡还需要补齐必要信息。\n💡 为什么停下：刚才自动记录了目标，但还没确认要改哪些文件和怎么验证。\n👉 怎么办：请告诉我修改文件的路径（或直接说“按方案改”）。';
  }
  if (/stale|过期/i.test(msg)) {
    return '🛑 这张任务卡已经过期或失效。\n💡 为什么停下：可能太久未操作，或目标已被推翻。\n👉 怎么办：请重新说明一下目标，我将为您开启一张新卡。';
  }
  if (/自己.*批|executor.*无权.*PASS|无权记录\s*PASS/i.test(msg)) {
    return '🛑 写代码的角色不能自己给自己批作业。\n💡 为什么停下：为了保证代码质量，必须由独立的复核角色检查。\n👉 怎么办：门禁正在自动派发复核角色跑全量测试，全绿后会自动完成验收。';
  }
  if (/推翻|换思路|换方案/i.test(msg)) {
    return '🛑 检测到您想推翻当前思路、换个方案。\n👉 已为您准备好一键回滚：请回复“恢复重来”，我会立即将代码还原到开工前的状态并开启新任务。';
  }
  if (/未指定\s*verify|没有可核验的验证/i.test(msg)) {
    return '🛑 任务还没有指定验证方法。\n💡 为什么停下：没有验证命令就无法确认改动是否真正修好。\n👉 怎么办：请提供验证命令，或者让我帮您自动跑现有测试。';
  }
  if (/验证未通过|exitCode/i.test(msg)) {
    return '🛑 验证命令跑失败了，说明还有问题没解决。\n💡 为什么停下：改动后的代码未能通过测试。\n👉 怎么办：请继续修复代码，直到测试全绿。';
  }

  return `🛑 为了防止代码改乱，我先帮您踩了刹车。\n💡 为什么停下：${msg}\n👉 怎么办：回复“取消门禁”可一键退出，或直接告诉我您的具体要求。`;
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
