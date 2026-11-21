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
} from '../src/rules.js';

describe('Carlos Flow 规则灰度引擎、指标采集与一键降级实测', () => {
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

  it('3. 一键降级熔断开关 (bypass)：跳过所有规则校验并记录 BYPASS', () => {
    process.env.CARLOS_RULES_BYPASS = 'true';
    const res = checkCardScopeRules(['.git/config'], [], { confirmed: false });
    assert.equal(res.ok, true); // 即使 R3 也被熔断放行
    assert.equal(res.violations.length, 0);

    const cmdRes = checkCommandRules('rm -rf /');
    assert.equal(cmdRes.ok, true);

    const summary = getRulesMetricsSummary();
    assert.equal(summary.bypassedCount, 2);
    assert.equal(summary.blockedCount, 0);
  });

  it('4. 真实样本数据集验证：精确测算误拦率 (FPR) 与漏拦率 (FNR)', () => {
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
