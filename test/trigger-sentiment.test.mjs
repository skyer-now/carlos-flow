import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TriggerScorer,
  TriggerEngine,
} from '../src/trigger.js';

describe('Carlos 智能触发引擎 · 情绪、质问与反复追问感知全场景测试 (中英混合/否定引用/反问/连续追问/防误触)', () => {
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

  it('6. 中英文混合强烈质问（Mixed Language Doubt）触发激活', () => {
    const sid = 'test-sentiment-mixed-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = 'You told me it was fixed, 但根本不对！Why is it still failing??? 马上重新核对！';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
    assert.ok(decision.score >= 15);
  });

  it('7. 否定与驳斥引用场景触发激活', () => {
    const sid = 'test-sentiment-quote-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '> 修复完成，测试全绿\n\n你在吹牛！根本没有跑通，全部报错，给我重做！';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
  });

  it('8. 反问与怀疑句式触发激活', () => {
    const sid = 'test-sentiment-rhetorical-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '你不是说已经改好了吗？为什么代码一行都没变？？？';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
  });

  it('9. 连续简短多轮追问上下文驱动激活', () => {
    const sid = 'test-sentiment-multiturn-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const context = { recentMessages: ['Did you change anything?', 'Still broken.'] };
    const decision = engine.shouldTrigger('Why???', context);
    
    assert.equal(decision.decision, 'trigger');
    assert.ok(decision.shouldTrigger === true);
  });

  it('10. 严格否定式防误触：用户明确说“先别改/不用启动工作流”时 100% 静默', () => {
    const sid = 'test-sentiment-negation-guard-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '先别改代码，也不用启动工作流，我就问问这个报错是什么意思？';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });

  it('11. 英文严格否定式防误触', () => {
    const sid = 'test-sentiment-negation-en-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = "Don't touch the code yet, just explain why this error happened.";
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });

  it('12. 只读探讨反问词防误触：纯原理探讨不误激活', () => {
    const sid = 'test-sentiment-readonly-rhetorical-' + Date.now();
    const engine = TriggerEngine.create(sid);
    
    const msg = '难道 React 状态更新不是异步的吗？请解释一下原理。';
    const decision = engine.shouldTrigger(msg);
    
    assert.equal(decision.decision, 'ignore');
    assert.equal(decision.shouldTrigger, false);
  });
});
