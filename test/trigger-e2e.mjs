#!/usr/bin/env node
// Carlos Flow 触发引擎 E2E 测试脚本
// 快速验证所有核心功能

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 仓库根目录（本文件位于 test/ 下）
const REPO_ROOT = resolve(__dirname, '..');

// 触发引擎路径
const TRIGGER_PATH = join(REPO_ROOT, 'src', 'trigger.js');

// 状态文件路径：与 trigger.js 的 TRIGGER_HOME 保持一致
const STATE_DIR = process.env.CARLOS_FLOW_HOME
  ? process.env.CARLOS_FLOW_HOME
  : join(REPO_ROOT, '.carlos-flow');
const STATE_FILE = join(STATE_DIR, 'trigger-state.json');
const REPORT_FILE = join(__dirname, 'trigger-e2e-results.json');

// 清理状态文件
function clearState() {
  try {
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
  } catch (e) {
    // 忽略
  }
}

// 测试工具 - 使用动态 import
async function loadTriggerEngine() {
  const mod = await import('file://' + TRIGGER_PATH);
  return mod.TriggerEngine;
}

// 测试结果存储
const results = {
  pass: [],
  fail: [],
  total: 0,
  warnings: []
};

let TriggerEngine = null;

// 测试用例
const testCases = [
  // DynamicTriggerManager 测试
  {
    name: 'DynamicTriggerManager: 基础上限计算',
    test: () => {
      clearState();
      const engine = TriggerEngine.create();
      // 强制 session 长度为 0 且无历史
      engine.triggerManager.state.sessionStartTime = Date.now();
      engine.triggerManager.state.triggerHistory = [];
      engine.triggerManager.state.lastTriggerTime = 0;
      engine.triggerManager.state.save();
      // 传入 complexity=0 以获取纯粹基础上限
      const limit = engine.triggerManager.calculateDynamicLimit(0);
      console.log(`  [DEBUG] 基础上限: ${limit}, 预期: 5`);
      return limit === 5;
    }
  },
  {
    name: 'DynamicTriggerManager: 会话时长影响',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      // 模拟会话时长增加
      const original = engine.triggerManager.state.sessionStartTime;
      engine.triggerManager.state.sessionStartTime = Date.now() - (2 * 60 * 60 * 1000); // 2小时
      const limit = engine.triggerManager.calculateDynamicLimit(1.0);
      const result = limit > 5 && limit <= 15;
      // 恢复
      engine.triggerManager.state.sessionStartTime = original;
      return result;
    }
  },
  {
    name: 'DynamicTriggerManager: 时间间隔检查',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      // 重置时间
      engine.triggerManager.state.lastTriggerTime = Date.now();
      
      const config = TriggerEngine.getConfig();
      const timeSinceLastTrigger = Date.now() - engine.triggerManager.state.lastTriggerTime;
      
      if (timeSinceLastTrigger < config.minTriggerIntervalSeconds * 1000) {
        return engine.triggerManager.canTrigger().can === false;
      }
      return true;
    }
  },

  // TriggerScorer 测试（使用英文关键词）
  {
    name: 'TriggerScorer: 关键词匹配',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'run dispatch workflow';
      const scorer = engine.scorer;
      const { score, matchedKeywords } = scorer.calculateKeywordScore(message);
      console.log(`  [DEBUG] 关键词分数: ${score}, 匹配: ${matchedKeywords.join(', ')}`);
      return score > 0 && matchedKeywords.length > 0;
    }
  },
  {
    name: 'TriggerScorer: 上下文相关性',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'workflow execution';
      const scorer = engine.scorer;
      const { score, matchedContext } = scorer.calculateContextRelevance(message, { complexity: 1.2 });
      console.log(`  [DEBUG] 上下文分数: ${score}, 匹配: ${matchedContext.join(', ')}`);
      return score > 0 && matchedContext.length > 0;
    }
  },
  {
    name: 'TriggerScorer: 用户意图识别',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'auto execute process';
      const scorer = engine.scorer;
      const { intentType, score } = scorer.calculateUserIntent(message);
      console.log(`  [DEBUG] 意图: ${intentType}, 分数: ${score}`);
      return intentType !== 'generic' && score > 0;
    }
  },

  // TriggerDecisionEngine 测试
  {
    name: 'TriggerDecisionEngine: 触发决策',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'run dispatch workflow trigger carlos';
      const result = engine.shouldTrigger(message, { sessionId: 'default' });
      console.log(`  [DEBUG] 触发决策: ${result.shouldTrigger}, 评分: ${result.score}, 置信度: ${result.confidence}`);
      return result.shouldTrigger === true;
    }
  },
  {
    name: 'TriggerDecisionEngine: 非触发决策',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'testing';
      const result = engine.shouldTrigger(message, { sessionId: 'default' });
      return result.shouldTrigger === false;
    }
  },
  {
    name: 'TriggerDecisionEngine: 评分阈值',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const highMessage = 'carlos flow dispatch trigger run start execute workflow';
      const result = engine.shouldTrigger(highMessage);
      console.log(`  [DEBUG] 高评分触发: ${result.decision}, 分数: ${result.score}`);
      return result.decision === 'trigger' && result.score >= 25;
    }
  },

  // 集成测试
  {
    name: '集成测试: 完整流程',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      
      const message = 'run dispatch flow';
      const result = engine.shouldTrigger(message, { sessionId: 'test' });
      console.log(`  [DEBUG] 第一次触发: ${result.shouldTrigger}, 评分: ${result.score}`);
      
      if (!result.shouldTrigger) return false;
      
      // 记录触发
      engine.triggerManager.recordTrigger({ impulseScore: result.score });
      
      // 检查再次触发被限制
      const secondCheck = engine.shouldTrigger(message, { sessionId: 'test' });
      console.log(`  [DEBUG] 第二次触发: ${secondCheck.shouldTrigger}, decision: ${secondCheck.decision}, reason: ${secondCheck.reason}`);
      
      const resultValue = secondCheck.decision === 'none' || 
                          secondCheck.reason.includes('限制') || 
                          secondCheck.reason.includes('时间间隔');
      console.log(`  [DEBUG] 集成测试结果: ${resultValue}`);
      return resultValue;
    }
  },

  // 配置加载测试
  {
    name: '配置加载: 默认参数',
    test: () => {
      const config = TriggerEngine.getConfig();
      return config.baseTriggerLimit === 5 && 
             config.maxTriggerLimit === 15 &&
             config.triggerThreshold === 15;
    }
  },

  // 回归测试：上限检查必须真实生效（历史 bug：曾用 0~1 加权均值与上限比较，永不触发）
  {
    name: '回归: 窗口内触发次数达上限后被拦截',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      // canTrigger() 内部使用默认 complexity=1.0 计算上限，测试必须用相同参数
      const limit = engine.triggerManager.calculateDynamicLimit(1.0);

      // 伪造 limit 次历史触发（直接写入状态，不走 recordTrigger 的间隔限制）
      const now = Date.now();
      for (let i = 0; i < limit; i++) {
        engine.triggerManager.state.triggerHistory.push({
          timestamp: now - (i * 1000),
          impulseScore: 30,
          context: 'test',
          userResponse: 'pending'
        });
      }
      engine.triggerManager.state.lastTriggerTime = 0; // 绕过最小间隔，只测上限
      engine.triggerManager.state.save();

      const can = engine.triggerManager.canTrigger();
      console.log(`  [DEBUG] 窗口计数=${engine.triggerManager.countTriggersInWindow()}, 上限=${limit}, canTrigger=${can.can}`);
      return can.can === false && /上限/.test(can.reason || '');
    }
  },
  {
    name: '回归: 上限未达时允许触发',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      engine.triggerManager.state.triggerHistory = [];
      engine.triggerManager.state.lastTriggerTime = 0;
      engine.triggerManager.state.save();

      const can = engine.triggerManager.canTrigger();
      console.log(`  [DEBUG] canTrigger=${can.can}, limit=${can.limit}`);
      return can.can === true;
    }
  },
  {
    name: '回归: sessionId 透传到状态层',
    test: () => {
      const engine = TriggerEngine.create('sid-A');
      const result = engine.shouldTrigger('run dispatch flow', { sessionId: 'sid-A' }, 'sid-A');
      const state = engine.triggerManager.state;
      console.log(`  [DEBUG] state.sessionId=${state.sessionId}`);
      return state.sessionId === 'sid-A';
    }
  },
  {
    name: '回归: 触发状态不写入仓库目录',
    test: () => {
      // CARLOS_FLOW_HOME 未设置时应落到 ~/.carlos-flow，而不是 cwd
      const engine = TriggerEngine.create('sid-home');
      engine.triggerManager.state.save();
      const repoLeak = join(REPO_ROOT, 'trigger-state.json');
      const homeFile = join(
        process.env.CARLOS_FLOW_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.carlos-flow'),
        'trigger-state.json'
      );
      const leaked = existsSync(repoLeak);
      const atHome = existsSync(homeFile);
      console.log(`  [DEBUG] 仓库泄漏=${leaked}, HOME命中=${atHome}`);
      return !leaked && atHome;
    }
  },
];

// 运行测试
async function runTests() {
  console.log('\n🧪 Carlos Flow 智能触发引擎 E2E 测试\n');
  console.log('='.repeat(60));

  // 加载触发引擎
  try {
    TriggerEngine = await loadTriggerEngine();
    console.log('✅ 触发引擎加载成功');
  } catch (error) {
    console.error('❌ 触发引擎加载失败:', error.message);
    process.exit(1);
  }

  for (const { name, test, debug = false } of testCases) {
    results.total++;
    try {
      // 同步/异步支持
      const result = await test();
      if (result) {
        results.pass.push(name);
        console.log(`✅ ${name}`);
      } else {
        results.fail.push(name);
        console.log(`❌ ${name} (验证失败)`);
      }
    } catch (error) {
      results.fail.push(name);
      results.warnings.push(`${name}: ${error.message}`);
      console.log(`❌ ${name} (错误: ${error.message})`);
    }
  }

  // 输出总结
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 测试总结\n');
  console.log(`总测试数: ${results.total}`);
  console.log(`✅ 通过: ${results.pass.length}`);
  console.log(`❌ 失败: ${results.fail.length}`);
  console.log(`📝 警告: ${results.warnings.length}`);
  
  const passRate = (results.pass.length / results.total * 100).toFixed(1);
  console.log(`📈 通过率: ${passRate}%`);

  if (results.fail.length > 0) {
    console.log('\n❌ 失败用例:');
    for (const name of results.fail) {
      console.log(`  - ${name}`);
    }
  }

  if (results.warnings.length > 0) {
    console.log('\n⚠️ 警告:');
    for (const warn of results.warnings) {
      console.log(`  - ${warn}`);
    }
  }

  const success = results.fail.length === 0;
  if (success) {
    console.log('\n🎉 所有测试通过！');
  } else {
    console.log('\n⚠️ 部分测试失败，请检查');
  }

  // 保存报告
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2));
    console.log(`\n📁 详细结果已保存至: ${REPORT_FILE}`);
  } catch (e) {
    console.log(`\n⚠️ 报告保存失败: ${e.message}`);
  }

  process.exit(success ? 0 : 1);
}

// 运行测试
runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
