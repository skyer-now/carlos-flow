import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TriggerScorer,
  TriggerEngine,
} from '../src/trigger.js';

describe('Carlos 智能触发引擎 · 情绪、质问与反复追问感知测试 (中英双语对齐)', () => {
  it('1. 识别中文强烈不满与否定词汇，情绪评分显著增加', () => {
    const scorer = new TriggerScorer();
    const res = scorer.calculateSentimentScore('你改的根本不对，完全错了，对你很失望！');
    assert.ok(res.score >= 25, `中文情绪得分应 >= 25，实际得分: ${res.score}`);
    assert.equal(res.level, 'high_doubt');
    assert.ok(res.matchedPatterns.length >= 2, '应匹配多个中文负面情绪词');
  });

  it('2. 识别英文强烈不满与否定词汇（English Frustration & Negation）', () => {
    const scorer = new TriggerScorer();
    const res = scorer.calculateSentimentScore('This is totally wrong and completely broken, stop lying!');
    assert.ok(res.score >= 25, `英文情绪得分应 >= 25，实际得分: ${res.score}`);
    assert.equal(res.level, 'high_doubt');
    assert.ok(res.matchedPatterns.some(p => p === 'totally wrong' || p === 'completely broken' || p === 'stop lying'));
  });

  it('3. 识别中文怀疑与质问句式', () => {
    const scorer = new TriggerScorer();
    const res = scorer.calculateSentimentScore('你确定真的跑通了吗？到底改了没有？');
    assert.ok(res.score >= 20, `中文质问得分应 >= 20，实际得分: ${res.score}`);
    assert.ok(res.matchedPatterns.some(p => p.includes('确定') || p.includes('真的跑通')));
  });

  it('4. 识别英文怀疑与质问句式（English Doubt & Questioning）', () => {
    const scorer = new TriggerScorer();
    const res = scorer.calculateSentimentScore('Are you sure? Did you even test it? Why is it still failing?');
    assert.ok(res.score >= 20, `英文质问得分应 >= 20，实际得分: ${res.score}`);
    assert.ok(res.matchedPatterns.some(p => p === 'are you sure' || p === 'did you even test' || p === 'why is it still failing'));
  });

  it('5. 识别连续标点（连续问号/感叹号）与纯问号情绪强化', () => {
    const scorer = new TriggerScorer();
    const res1 = scorer.calculateSentimentScore('？？？');
    assert.ok(res1.score >= 15, `纯问号得分应 >= 15，实际: ${res1.score}`);

    const res2 = scorer.calculateSentimentScore('why is it failing??? not even aware of this!!!');
    assert.ok(res2.score >= 20, `英文标点强化得分应 >= 20，实际: ${res2.score}`);
  });

  it('6. 英文上下文追问强化：连续多轮英文质问自动追加疲劳/怀疑权重', () => {
    const scorer = new TriggerScorer();
    const historyMsgs = [
      'Did you actually change anything?',
      'Why is it still broken?'
    ];
    const res = scorer.calculateSentimentScore('What are you doing???', historyMsgs);
    assert.ok(res.score >= 25, `英文连续追问追加权重后得分应 >= 25，实际: ${res.score}`);
  });

  it('7. 情绪驱动动态阈值自调节（中文质问）：高怀疑度时触发阈值自动下调、敏锐激活', () => {
    const sid = 'test-sentiment-trigger-zh-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '你怎么搞的，根本不对！马上用工作流给我重新修复并验证一遍？？？';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
    assert.ok(decision.score >= 20, `综合评分应达标，实际: ${decision.score}`);
    assert.ok(decision.breakdown.sentiment, '返回结果应包含 sentiment 情绪维度');
    assert.ok(decision.breakdown.sentiment.score > 0);
  });

  it('8. 情绪驱动动态阈值自调节（英文质问）：高怀疑度时触发阈值自动下调、敏锐激活', () => {
    const sid = 'test-sentiment-trigger-en-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = 'This is totally wrong! Are you sure you ran the tests? Dispatch workflow to fix it immediately???';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
    assert.ok(decision.score >= 20, `英文综合评分应达标，实际: ${decision.score}`);
    assert.equal(decision.breakdown.sentiment.level, 'high_doubt');
  });

  it('9. 英文防误触测试：纯只读提问中出现单个问号不误触发', () => {
    const sid = 'test-sentiment-readonly-en-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = 'What is the main architecture design of this project?';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });

  it('10. 英文防误触测试：日常普通对话与探讨不误激活', () => {
    const sid = 'test-sentiment-chat-en-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = 'Good morning, let us schedule a team meeting this afternoon to discuss the roadmap.';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });
});
