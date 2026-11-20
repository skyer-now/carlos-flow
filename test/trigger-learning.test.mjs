import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySideEffect, LearnedRulesManager, TriggerEngine } from '../src/trigger.js';

describe('在线隐式强化学习、四维复合特征与规则自适应实测', () => {
  describe('1. 四维复合特征预检 (疑问前缀 / 复合短语清洗 / 否定反转)', () => {
    it('疑问句前缀（为什么/怎么看/什么原因）即使带改动词也强制静默 (LEVEL_0)', () => {
      const questions = [
        '为什么这里的重构会导致单测报错？',
        '怎么看待重写架构的方案？',
        '什么原因导致刚才修改失败了？',
      ];
      for (const q of questions) {
        assert.equal(classifySideEffect(q), 'LEVEL_0', `疑问句 "${q}" 必须强制判定为 LEVEL_0 静默`);
      }
    });

    it('否定反转句（先别改/只是讨论/不用动代码）强制静默 (LEVEL_0)', () => {
      const negations = [
        '先别改代码，我们先讨论一下方案',
        '只是讨论一下实现细节，不用动代码',
        '随便问问，别执行修改',
      ];
      for (const n of negations) {
        assert.equal(classifySideEffect(n), 'LEVEL_0', `否定句 "${n}" 必须强制判定为 LEVEL_0 静默`);
      }
    });

    it('复合名词短语（开源实现/方案设计/重构计划）不被误判为改动', () => {
      const phrases = [
        '调研一下相关的开源实现',
        '看一下这个模块的方案设计',
        '参考下社区里的重构计划',
      ];
      for (const p of phrases) {
        assert.equal(classifySideEffect(p), 'LEVEL_0', `短语 "${p}" 必须判定为 LEVEL_0 静默`);
      }
    });
  });

  describe('2. 基于交互行为的在线隐式强化学习 (LearnedRulesManager)', () => {
    it('捕获负向信号（用户叫停/撤销）后自动将句式加入抑制池', () => {
      const sampleMsg = '我们深入探讨一下重构订单模块的利弊';
      
      // 模拟用户在叫停该触发
      LearnedRulesManager.recordNegativeFeedback(sampleMsg, 'hard_negative');
      
      // 验证后续相同或相似句式已被自动抑制（自愈生效）
      assert.ok(LearnedRulesManager.isSuppressed(sampleMsg));
      assert.equal(classifySideEffect(sampleMsg), 'LEVEL_0', '被叫停过的句式必须被自愈静默');
    });

    it('捕获正向履约信号（PASS 裁定）后自动强化并降低惩罚偏移', () => {
      const passMsg = '开始重构认证模块并补充单测';
      LearnedRulesManager.recordPositiveFeedback(passMsg);
      const data = LearnedRulesManager.load();
      assert.ok(data.boosted_patterns.length > 0, '正向句式必须被记录进强化池');
    });
  });
});
