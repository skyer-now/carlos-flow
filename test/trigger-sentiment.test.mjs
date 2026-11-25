import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TriggerScorer,
  TriggerEngine,
} from '../src/trigger.js';

describe('Carlos 智能触发引擎 · 情绪、质问与反复追问感知测试', () => {
  it('1. 识别强烈不满与否定词汇，情绪评分显著增加', () => {
    const scorer = new TriggerScorer();
    const res = scorer.calculateSentimentScore('你改的根本不对，完全错了，对你很失望！');
    assert.ok(res.score >= 25, `情绪得分应 >= 25，实际得分: ${res.score}`);
    assert.equal(res.level, 'high_doubt');
    assert.ok(res.matchedPatterns.length >= 2, '应匹配多个负面情绪词');
  });

  it('2. 识别怀疑与质问句式', () => {
    const scorer = new TriggerScorer();
    const res = scorer.calculateSentimentScore('你确定真的跑通了吗？到底改了没有？');
    assert.ok(res.score >= 20, `情绪得分应 >= 20，实际得分: ${res.score}`);
    assert.ok(res.matchedPatterns.some(p => p.includes('确定') || p.includes('真的跑通')));
  });

  it('3. 识别连续标点（连续问号/感叹号）与纯问号情绪强化', () => {
    const scorer = new TriggerScorer();
    const res1 = scorer.calculateSentimentScore('？？？');
    assert.ok(res1.score >= 15, `纯问号得分应 >= 15，实际: ${res1.score}`);

    const res2 = scorer.calculateSentimentScore('为什么还在报错？？？连这都不知道！！！');
    assert.ok(res2.score >= 20, `标点强化得分应 >= 20，实际: ${res2.score}`);
  });

  it('4. 上下文追问强化：连续多轮质问自动追加疲劳/怀疑权重', () => {
    const scorer = new TriggerScorer();
    const historyMsgs = [
      '你到底改了没有？',
      '怎么还是不对？'
    ];
    const res = scorer.calculateSentimentScore('怎么回事？？？', historyMsgs);
    assert.ok(res.score >= 25, `连续追问追加权重后得分应 >= 25，实际: ${res.score}`);
  });

  it('5. 情绪驱动动态阈值自调节：高怀疑度时触发阈值自动下调、敏锐激活', () => {
    const sid = 'test-sentiment-trigger-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    // 带有高怀疑度的流程问题
    const msg = '你怎么搞的，根本不对！马上用工作流给我重新修复并验证一遍？？？';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
    assert.ok(decision.score >= 20, `综合评分应达标，实际: ${decision.score}`);
    assert.ok(decision.breakdown.sentiment, '返回结果应包含 sentiment 情绪维度');
    assert.ok(decision.breakdown.sentiment.score > 0);
  });

  it('6. 防误触测试：纯只读提问中出现单个问号不误触发', () => {
    const sid = 'test-sentiment-readonly-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '请问这个架构设计是什么原理？';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });

  it('7. 防误触测试：日常普通对话与探讨不误激活', () => {
    const sid = 'test-sentiment-chat-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '今天天气不错，下午我们开个会讨论一下需求。';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });
});
