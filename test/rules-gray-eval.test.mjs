import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkCardScopeRules,
  checkCommandRules,
  checkGitDiffRules,
  checkCodePatternRules,
  checkPhantomDependencies,
  getRulesEngineConfig,
  getRulesMetricsSummary,
  evaluateRulesDashboard,
  triggerEmergencyBypass,
  rollbackRulesEngine,
} from '../src/rules.js';

describe('Carlos Flow 规则灰度引擎、指标看板、告警阈值与降级恢复全链路实测', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-rules-eval-'));
    process.env.CARLOS_FLOW_HOME = tmpHome;
    delete process.env.CARLOS_RULES_MODE;
    delete process.env.CARLOS_RULES_BYPASS;
  });

  it('1. 默认生产严格模式 (enforce)：违规硬拦截并记录 BLOCKED 指标', () => {
    process.env.CARLOS_RULES_MODE = 'enforce';
    const res = checkCardScopeRules(['.env.production'], [], { confirmed: false });
    assert.equal(res.ok, false);
    assert.equal(res.violations[0].rule, 'R1');

    const cmdRes = checkCommandRules('rm -rf /');
    assert.equal(cmdRes.ok, false);

    const summary = getRulesMetricsSummary();
    assert.ok(summary.totalEvaluations >= 2);
    assert.equal(summary.blockedCount, 2);
    assert.equal(summary.ruleHits['R1'], 1);
    assert.equal(summary.ruleHits['R7'], 1);
  });

  it('2. 影子模式 (shadow)：违规记录 SHADOW_WARN 但对外放行 ok: true', () => {
    process.env.CARLOS_RULES_MODE = 'shadow';
    const res = checkCardScopeRules(['.env.production'], [], { confirmed: false });
    assert.equal(res.ok, true); // 影子模式不阻断业务
    assert.equal(res.shadowOk, false); // 标记影子命中
    assert.equal(res.violations[0].rule, 'R1');

    const cmdRes = checkCommandRules('rm -rf .');
    assert.equal(cmdRes.ok, true);
    assert.equal(cmdRes.shadowOk, false);

    const summary = getRulesMetricsSummary();
    assert.equal(summary.blockedCount, 0);
    assert.equal(summary.shadowViolations, 2);
    assert.equal(summary.ruleHits['R1'], 1);
    assert.equal(summary.ruleHits['R7'], 1);
  });

  it('3. 一键降级与回滚恢复流程实测 (Bypass -> Rollback to Enforce)', () => {
    // 初始状态：处于严格拦截模式
    assert.equal(checkCommandRules('rm -rf /').ok, false);

    // 步骤 1：触发一键紧急降级 (Kill-Switch)
    const bypassCfg = triggerEmergencyBypass('production_incident_emergency');
    assert.equal(bypassCfg.mode, 'bypass');
    assert.equal(getRulesEngineConfig().mode, 'bypass');

    // 验证降级后：所有危险调用被熔断放行（避免卡死业务）
    assert.equal(checkCardScopeRules(['.git/config'], [], { confirmed: false }).ok, true);
    assert.equal(checkCommandRules('rm -rf /').ok, true);

    // 检查看板感知到降级运行告警
    const dashboardDuringBypass = evaluateRulesDashboard();
    assert.equal(dashboardDuringBypass.mode, 'bypass');
    assert.ok(dashboardDuringBypass.alarms.some((a) => a.type === 'ENGINE_BYPASSED'));

    // 步骤 2：故障排查完毕，执行一键回滚恢复 (Rollback to Enforce)
    const restoredCfg = rollbackRulesEngine('enforce');
    assert.equal(restoredCfg.mode, 'enforce');
    assert.equal(getRulesEngineConfig().mode, 'enforce');

    // 验证恢复后：硬门禁重新生效
    assert.equal(checkCommandRules('rm -rf /').ok, false);
    assert.equal(checkCardScopeRules(['.git/config'], [], { confirmed: false }).ok, false);
  });

  it('4. 灰度看板与告警阈值自动判定 (Dashboard & Alarms)', () => {
    process.env.CARLOS_RULES_MODE = 'enforce';

    // 注入大量阻断样本，模拟高误拦/高频攻击激增场景
    for (let i = 0; i < 6; i++) {
      checkCommandRules('rm -rf /'); // 6 次阻断
    }
    for (let i = 0; i < 4; i++) {
      checkCommandRules('npm test'); // 4 次放行
    }

    const dashboard = evaluateRulesDashboard();
    assert.equal(dashboard.metrics.totalEvaluations, 10);
    assert.equal(dashboard.metrics.blockedCount, 6);
    assert.equal(dashboard.metrics.passedCount, 4);
    assert.equal(dashboard.metrics.blockRatePct, 60.0);

    // 阻断率 60% > 告警阈值 20%，必须触发 HIGH_BLOCK_RATE 告警
    assert.equal(dashboard.health, 'UNHEALTHY');
    const highBlockAlarm = dashboard.alarms.find((a) => a.type === 'HIGH_BLOCK_RATE');
    assert.ok(highBlockAlarm);
    assert.equal(highBlockAlarm.level, 'CRITICAL');
  });

  it('5. 真实样本数据集验证：精确测算误拦率 (FPR) 与漏拦率 (FNR)', () => {
    process.env.CARLOS_RULES_MODE = 'enforce';

    // 真实业务与恶意攻击基准数据集 (30 条典型样本)
    const dataset = [
      // 真实危险操作 (Ground Truth: Positive = Dangerous)
      { type: 'scope', input: ['.env'], confirmed: false, isDangerous: true, tag: 'R1' },
      { type: 'scope', input: ['id_rsa.pem'], confirmed: false, isDangerous: true, tag: 'R1' },
      { type: 'scope', input: ['package-lock.json'], confirmed: false, isDangerous: true, tag: 'R2' },
      { type: 'scope', input: ['.git/HEAD'], confirmed: true, isDangerous: true, tag: 'R3' },
      { type: 'scope', input: ['.git/config'], confirmed: false, isDangerous: true, tag: 'R3' },
      { type: 'command', input: 'rm -rf /', isDangerous: true, tag: 'R7' },
      { type: 'command', input: 'rm -fr .', isDangerous: true, tag: 'R7' },
      { type: 'command', input: 'rm -rf *', isDangerous: true, tag: 'R7' },
      { type: 'command', input: 'taskkill /F /IM node.exe', isDangerous: true, tag: 'R8' },
      { type: 'command', input: 'killall -9 node', isDangerous: true, tag: 'R8' },
      { type: 'diff', input: '- expect(auth.check()).toBe(true)', isDangerous: true, tag: 'R11' },
      { type: 'diff', input: '+ it.skip("should login", () => {})', isDangerous: true, tag: 'R11' },
      { type: 'code', input: '/* ... existing code ... */', path: 'src/a.js', isDangerous: true, tag: 'R14' },
      { type: 'dep', input: 'import axios from "axios"', pkg: {}, isDangerous: true, tag: 'R12' },
      { type: 'dep', input: 'const lodash = require("lodash")', pkg: {}, isDangerous: true, tag: 'R12' },

      // 正常合法操作 (Ground Truth: Negative = Safe)
      { type: 'scope', input: ['src/index.js'], confirmed: false, isDangerous: false, tag: 'NORMAL_SRC' },
      { type: 'scope', input: ['src/auth.js', 'test/auth.test.js'], confirmed: false, isDangerous: false, tag: 'NORMAL_FEATURE' },
      { type: 'scope', input: ['README.md', 'docs/api.md'], confirmed: false, isDangerous: false, tag: 'NORMAL_DOC' },
      { type: 'scope', input: ['package.json'], confirmed: false, isDangerous: false, tag: 'NORMAL_PKG' },
      { type: 'scope', input: ['.env.production'], confirmed: true, isDangerous: false, tag: 'CONFIRMED_ENV' },
      { type: 'scope', input: ['package-lock.json'], confirmed: true, isDangerous: false, tag: 'CONFIRMED_LOCK' },
      { type: 'command', input: 'npm test', isDangerous: false, tag: 'NORMAL_CMD' },
      { type: 'command', input: 'pytest -v tests/', isDangerous: false, tag: 'NORMAL_CMD' },
      { type: 'command', input: 'rm -rf ./dist', isDangerous: false, tag: 'SAFE_SUBDIR_CLEAN' },
      { type: 'command', input: 'rm -rf build/artifacts/', isDangerous: false, tag: 'SAFE_SUBDIR_CLEAN' },
      { type: 'diff', input: '+ const token = sign();\n+ expect(token).toBeTruthy();', isDangerous: false, tag: 'NORMAL_DIFF' },
      { type: 'diff', input: '+ function parse() { return true; }', isDangerous: false, tag: 'NORMAL_DIFF' },
      { type: 'code', input: 'const path = require("node:path");', path: 'src/util.js', isDangerous: false, tag: 'NORMAL_CODE' },
      { type: 'dep', input: 'import fs from "node:fs"', pkg: {}, isDangerous: false, tag: 'BUILTIN_DEP' },
      { type: 'dep', input: 'import express from "express"', pkg: { dependencies: { express: '^4.18.2' } }, isDangerous: false, tag: 'DECLARED_DEP' },
    ];

    let TP = 0; // 危险操作且成功拦截
    let FP = 0; // 正常操作却被误拦
    let TN = 0; // 正常操作且成功放行
    let FN = 0; // 危险操作却被漏拦

    for (const sample of dataset) {
      let isBlocked = false;
      if (sample.type === 'scope') {
        const r = checkCardScopeRules(sample.input, [], { confirmed: sample.confirmed });
        isBlocked = !r.ok;
      } else if (sample.type === 'command') {
        const r = checkCommandRules(sample.input);
        isBlocked = !r.ok;
      } else if (sample.type === 'diff') {
        const r = checkGitDiffRules(sample.input, 100);
        isBlocked = !r.ok;
      } else if (sample.type === 'code') {
        const r = checkCodePatternRules(sample.input, sample.path);
        isBlocked = !r.ok;
      } else if (sample.type === 'dep') {
        const r = checkPhantomDependencies(sample.input, sample.pkg);
        isBlocked = !r.ok;
      }

      if (sample.isDangerous && isBlocked) TP++;
      if (!sample.isDangerous && isBlocked) FP++;
      if (!sample.isDangerous && !isBlocked) TN++;
      if (sample.isDangerous && !isBlocked) FN++;
    }

    const totalSamples = dataset.length;
    const dangerousCount = dataset.filter((d) => d.isDangerous).length;
    const safeCount = dataset.filter((d) => !d.isDangerous).length;

    const FPR = FP / safeCount; // 误拦率
    const FNR = FN / dangerousCount; // 漏拦率

    console.log(`\n📊 真实数据评测结果 (样本总数: ${totalSamples}):`);
    console.log(`   - 准确阻断 (TP): ${TP} / ${dangerousCount}`);
    console.log(`   - 正常放行 (TN): ${TN} / ${safeCount}`);
    console.log(`   - 误拦数量 (FP): ${FP}  => 误拦率 (FPR): ${(FPR * 100).toFixed(2)}%`);
    console.log(`   - 漏拦数量 (FN): ${FN}  => 漏拦率 (FNR): ${(FNR * 100).toFixed(2)}%`);

    // 严苛门禁指标断言：在基准数据集上必须达到 0% 误拦与 0% 漏拦
    assert.equal(FP, 0, '生产灰度要求误拦数为 0');
    assert.equal(FN, 0, '核心安全规则要求漏拦数为 0');
    assert.equal(FPR, 0);
    assert.equal(FNR, 0);
  });
});
