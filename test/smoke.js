// Carlos Flow - 端到端冒烟测试（Node ESM，零外部依赖）
// 运行: node scripts/smoke.js
//
// 隔离：CARLOS_FLOW_HOME 指向临时目录，绝不碰真实的 D:/opencode-backups。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

// ---- 环境隔离：必须在导入 state.js 之前 ----
const FLOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-flow-smoke-'));
process.env.CARLOS_FLOW_HOME = FLOW_HOME;

// ---- 临时项目 ----
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-flow-smoke-proj-'));
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'src', 'auth.py'), 'def login(u, p):\n    return True\n', 'utf8');

const SID = 'smoke-session';

try {
  const { parseCard, validateCard } = await import('../src/card.js');
  const { loadState, saveState, defaultState, audit } = await import('../src/state.js');

  // 1. 造一张卡
  const description = [
    '请把登录接口加上参数校验。',
    '',
    'FLOW_CARD:{"goal":"给登录接口加参数校验","quote":"给登录接口加参数校验",' +
    '"scope":["src/auth.py"],"acceptance":["缺少参数时返回 400"],' +
    '"unknowns":[],"assumptions":[],"files":[{"path":"src/auth.py","line":1}],' +
    '"verify":{"cmd":"pytest -q"},"confirmed":false}',
  ].join('\n');

  // 2. 解析
  const parsed = parseCard(description);
  assert.ok(parsed.card, 'parseCard 未产出卡片: ' + parsed.error);
  assert.strictEqual(parsed.card.goal, '给登录接口加参数校验');
  console.log('step 1 parseCard OK  goal=' + parsed.card.goal + '  tier-scope=' + JSON.stringify(parsed.card.scope));

  // 3. 校验（scopeExists 用真实磁盘判断）
  const validated = validateCard(parsed.card, {
    scopeExists: (p) => fs.existsSync(path.join(PROJ, p)),
    userMessages: ['给登录接口加参数校验'],
  });
  assert.ok(validated.ok, 'validateCard 未通过: ' + validated.reason);
  console.log('step 2 validateCard OK  tier=' + validated.tier + '  reason=' + validated.reason);

  // 4. 落盘 + 审计
  saveState(SID, Object.assign(defaultState(), {
    card: parsed.card,
    card_ts: Date.now(),
    tier: validated.tier,
  }));
  audit('run', SID, { phase: 'smoke', tier: validated.tier });
  console.log('step 3 saveState + audit OK');

  // 5. 读回，验证卡片存活
  const back = loadState(SID);
  assert.ok(back.card, 'loadState 未读回卡片');
  assert.deepStrictEqual(back.card, parsed.card);
  assert.strictEqual(back.tier, validated.tier);
  console.log('step 4 loadState OK  卡片往返一致, tier=' + back.tier);

  console.log('SMOKE_OK');
  console.log('FLOW_HOME (temp) = ' + FLOW_HOME);
  console.log('PROJ (temp) = ' + PROJ);
} catch (e) {
  console.error('SMOKE_FAIL: ' + ((e && e.stack) || e));
  process.exit(1);
}
