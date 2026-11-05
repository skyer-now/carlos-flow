// Carlos 工作流智能触发引擎
// 三层智能触发系统：动态上限、评分系统、决策引擎

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// 触发器状态/配置目录：与 state.js 的 FLOW_HOME 保持同一约定，避免污染仓库目录
const TRIGGER_HOME = process.env.CARLOS_FLOW_HOME
  ? process.env.CARLOS_FLOW_HOME
  : (process.env.CARLOS_FLOW_ROOT || join(os.homedir(), '.carlos-flow'));
const CONFIG_PATH = join(TRIGGER_HOME, 'trigger-config.json');
const STATE_PATH = join(TRIGGER_HOME, 'trigger-state.json');

// 确保目录存在（FLOW_HOME 可能尚未创建）
function ensureHome() {
  try { mkdirSync(TRIGGER_HOME, { recursive: true }); } catch { /* 目录已存在或不可写 */ }
}
const DEFAULT_CONFIG = {
  // 动态上限参数
  baseTriggerLimit: 5,              // 基础触发上限
  maxTriggerLimit: 15,              // 最大触发上限
  sessionLengthCoeff: 0.5,          // 会话时长系数（每小时增加 0.5 个）
  complexityCoeff: 2,               // 任务复杂度系数
  historyCoeff: 0.3,                // 历史触发频率系数
  decayRate: 0.98,                  // 历史触发衰减率

  // 评分参数
  keywordWeights: {
    'work': 3, 'flow': 3, 'carlos': 4, 'dispatch': 3,
    'trigger': 2, 'start': 1, 'run': 1, 'execute': 2
  },
  contextRelevanceWeight: 0.3,
  userIntentWeight: 0.2,

  // 决策阈值
  triggerThreshold: 15,             // 触发阈值（0-100）
  autoTriggerThreshold: 25,         // 自动触发阈值（高中意图时）
  lowConfidenceThreshold: 10,       // 低置信度阈值

  // 用户反馈学习
  feedbackLearningRate: 0.1,
  positiveFeedbackWeight: 1.5,
  negativeFeedbackWeight: 0.7,

  // 触发窗口
  triggerWindowMinutes: 15,         // 触发窗口期（分钟）
  minTriggerIntervalSeconds: 300    // 最少触发间隔（秒）
};

// 加载配置文件
let config = DEFAULT_CONFIG;
if (existsSync(CONFIG_PATH)) {
  try {
    const loaded = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...loaded };
  } catch (e) {
    console.warn('[Carlos Trigger] 配置加载失败:', e.message);
  }
}

// ============ 状态管理 ============
class TriggerState {
  constructor(sessionId = 'default') {
    this.sessionId = sessionId;
    this.triggerHistory = [];
    this.sessionStartTime = Date.now();
    this.lastTriggerTime = 0;
    this.impressionCount = 0; // 关联 impressionId
  }

  getSessionAgeHours() {
    return (Date.now() - this.sessionStartTime) / (1000 * 60 * 60);
  }

  save() {
    ensureHome();
    writeFileSync(STATE_PATH, JSON.stringify(this, null, 2));
  }

  static load(sessionId = 'default') {
    if (existsSync(STATE_PATH)) {
      try {
        const loaded = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
        const state = new TriggerState(sessionId);
        Object.assign(state, loaded);
        // sessionId 由调用方决定，不允许被持久化文件覆盖
        state.sessionId = sessionId;
        return state;
      } catch (e) {
        // 状态文件损坏时降级为新状态，不阻断主流程
      }
    }
    return new TriggerState(sessionId);
  }
}

// ============ L1: DynamicTriggerManager ============
class DynamicTriggerManager {
  constructor(state = null) {
    this.state = state || TriggerState.load();
    this.triggerCache = new Map();
  }

  /**
   * 计算当前动态触发上限
   * 基于会话时长、任务复杂度和历史触发频率
   *
   * 设计要点：
   * - 会话越长、任务越复杂 → 上限越高（允许更多触发）
   * - 近期触发越频繁 → 上限越低（收敛打扰），否则上限会被历史反向抬高而永不生效
   */
  calculateDynamicLimit(sessionComplexity = 1.0) {
    const sessionAge = this.state.getSessionAgeHours();
    const historyFactor = this.calculateHistoryFactor();
    const recentCount = this.countTriggersInWindow();

    // 上限 = 基础 + 会话时长增益 + 复杂度增益 - 近期频繁触发惩罚
    const rawLimit =
      config.baseTriggerLimit +
      (sessionAge * config.sessionLengthCoeff) +
      (sessionComplexity * config.complexityCoeff) -
      (recentCount * config.historyCoeff);

    const dynamicLimit = Math.max(1, Math.min(rawLimit, config.maxTriggerLimit));

    return Math.floor(dynamicLimit);
  }

  /**
   * 统计触发窗口内的实际触发次数（原始计数，用于上限判定）
   */
  countTriggersInWindow() {
    const windowStart = Date.now() - (config.triggerWindowMinutes * 60 * 1000);
    return this.state.triggerHistory.filter(t => t.timestamp > windowStart).length;
  }

  /**
   * 计算历史触发频率因子（衰减加权计数，用于动态上限微调）
   * 注意：返回的是加权“次数”而非平均值，量级与上限可比。
   */
  calculateHistoryFactor() {
    const now = Date.now();
    const windowStart = now - (config.triggerWindowMinutes * 60 * 1000);
    
    // 过滤窗口内的触发记录
    const recentTriggers = this.state.triggerHistory.filter(t => t.timestamp > windowStart);
    
    if (recentTriggers.length === 0) return 0;
    
    // 应用时间衰减后累加（次数量级，与上限可比）
    let weightedSum = 0;
    
    recentTriggers.forEach(trigger => {
      const age = now - trigger.timestamp;
      const decay = Math.pow(config.decayRate, age / (60 * 1000)); // 按分钟衰减
      weightedSum += decay;
    });
    
    return weightedSum;
  }

  /**
   * 记录触发事件
   */
  recordTrigger(triggerData = {}) {
    this.state.triggerHistory.push({
      timestamp: Date.now(),
      impulseScore: triggerData.impulseScore || 0,
      context: triggerData.context || 'unknown',
      userResponse: triggerData.userResponse || 'pending'
    });

    this.state.lastTriggerTime = Date.now();
    this.state.impressionCount++;
    this.state.save();

    // 清理过期记录
    this.cleanupHistory();
  }

  /**
   * 清理过期历史数据
   */
  cleanupHistory() {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24小时
    this.state.triggerHistory = this.state.triggerHistory.filter(
      t => t.timestamp > cutoff
    );
    this.state.save();
  }

  /**
   * 检查是否可以触发
   */
  canTrigger() {
    // 检查最小时间间隔
    const timeSinceLastTrigger = Date.now() - this.state.lastTriggerTime;
    if (timeSinceLastTrigger < config.minTriggerIntervalSeconds * 1000) {
      return { can: false, reason: '时间间隔不足' };
    }

    // 检查动态上限：用窗口内的实际触发次数与上限比较
    const currentLimit = this.calculateDynamicLimit();
    const triggerCountInWindow = this.countTriggersInWindow();
    
    if (triggerCountInWindow >= currentLimit) {
      return { can: false, reason: `触发次数已达上限 (${triggerCountInWindow}/${currentLimit})` };
    }

    return { can: true, limit: currentLimit, count: triggerCountInWindow };
  }

  reset() {
    this.state.triggerHistory = [];
    this.state.lastTriggerTime = 0;
    this.state.save();
  }
}

// ============ L2: TriggerScorer ============
class TriggerScorer {
  constructor() {
    this.keywordIndex = new Map();
    this.buildKeywordIndex();
  }

  /**
   * 构建关键词索引
   */
  buildKeywordIndex() {
    Object.entries(config.keywordWeights).forEach(([keyword, weight]) => {
      this.keywordIndex.set(keyword.toLowerCase(), weight);
    });
  }

  /**
   * 计算关键词匹配分数
   */
  calculateKeywordScore(message) {
    const lowerMsg = message.toLowerCase();
    let score = 0;
    let matchedKeywords = [];

    this.keywordIndex.forEach((weight, keyword) => {
      if (lowerMsg.includes(keyword)) {
        score += weight;
        matchedKeywords.push(keyword);
      }
    });

    // 标准化到 0-50 范围
    const normalizedScore = Math.min(score * 5, 50);

    return {
      score: normalizedScore,
      matchedKeywords,
      maxKeywordScore: 50
    };
  }

  /**
   * 计算上下文相关性分数
   */
  calculateContextRelevance(message, context = {}) {
    // 简单实现：基于工作流相关关键词
    const workFlowKeywords = ['work', 'flow', 'dispatch', 'executor', 'auditor'];
    const lowerMsg = message.toLowerCase();
    
    let contextScore = 0;
    let matchedContext = [];
    
    workFlowKeywords.forEach(keyword => {
      if (lowerMsg.includes(keyword)) {
        contextScore += 3;
        matchedContext.push(keyword);
      }
    });

    // 基于上下文复杂度调整
    if (context.complexity) {
      contextScore *= context.complexity;
    }

    // 标准化到 0-30 范围
    const normalizedScore = Math.min(contextScore * 3, 30);

    return {
      score: normalizedScore,
      matchedContext,
      maxContextScore: 30
    };
  }

  /**
   * 计算用户意图分数
   */
  calculateUserIntent(message, sessionId = 'default') {
    // 简单实现：基于用户行为模式
    const userIntentCandidates = {
      'workflow': ['dispatch', 'run', 'execute', 'trigger', 'start'],
      'automation': ['auto', 'automate', 'workflow', 'process'],
      'management': ['manage', 'control', 'monitor', 'track']
    };

    const lowerMsg = message.toLowerCase();
    let intentScore = 0;
    let intentType = 'generic';

    Object.entries(userIntentCandidates).forEach(([type, keywords]) => {
      const hasKeyword = keywords.some(k => lowerMsg.includes(k));
      if (hasKeyword) {
        intentScore += 20;
        intentType = type;
      }
    });

    // 基于会话历史调整
    const state = TriggerState.load(sessionId);
    if (state.triggerHistory.length > 10) {
      intentScore *= 1.2; // 活跃用户
    }

    // 标准化到 0-20 范围
    const normalizedScore = Math.min(intentScore, 20);

    return {
      score: normalizedScore,
      intentType,
      maxIntentScore: 20
    };
  }

  /**
   * 综合评分
   */
  calculateImpulseScore(message, context = {}, sessionId = 'default') {
    const keywordResult = this.calculateKeywordScore(message);
    const contextResult = this.calculateContextRelevance(message, context);
    const intentResult = this.calculateUserIntent(message, sessionId);

    const totalScore = 
      keywordResult.score * (1 - config.contextRelevanceWeight - config.userIntentWeight) +
      contextResult.score * config.contextRelevanceWeight +
      intentResult.score * config.userIntentWeight;

    return {
      score: Math.round(totalScore),
      breakdown: {
        keyword: keywordResult,
        context: contextResult,
        intent: intentResult
      },
      confidence: this.calculateConfidence(keywordResult, contextResult, intentResult)
    };
  }

  /**
   * 计算置信度
   */
  calculateConfidence(keyword, context, intent) {
    const allMatched = keyword.matchedKeywords.length + 
                      context.matchedContext.length + 
                      (intent.intentType !== 'generic' ? 1 : 0);
    
    if (allMatched === 0) return 0.3; // 低置信度
    if (allMatched <= 2) return 0.6;  // 中等置信度
    return 0.9; // 高置信度
  }
}

// ============ L3: TriggerDecisionEngine ============
class TriggerDecisionEngine {
  constructor(triggerManager = null, scorer = null) {
    this.triggerManager = triggerManager || new DynamicTriggerManager();
    this.scorer = scorer || new TriggerScorer();
    this.feedbackCache = new Map();
  }

  /**
   * 主触发决策
   * 基于评分和动态上限决定是否触发
   */
  shouldTrigger(message, context = {}, sessionId = 'default') {
    // 1. 检查是否可以触发（上限和时间间隔）
    const canTrigger = this.triggerManager.canTrigger();
    if (!canTrigger.can) {
      return { 
        shouldTrigger: false, 
        reason: canTrigger.reason, 
        score: 0,
        decision: 'throttled'
      };
    }

    // 2. 计算触发评分
    const impulseResult = this.scorer.calculateImpulseScore(message, context, sessionId);
    
    // 3. 决策逻辑
    const score = impulseResult.score;
    const threshold = score >= config.autoTriggerThreshold && impulseResult.confidence >= 0.8 
      ? config.autoTriggerThreshold 
      : config.triggerThreshold;

    let decision = 'none';
    let action = null;

    if (score >= threshold) {
      decision = 'trigger';
      action = this.buildTriggerAction(impulseResult);
    } else if (score < config.lowConfidenceThreshold) {
      decision = 'ignore';
    } else {
      decision = 'review';
    }

    // 4. 记录触发历史
    if (decision === 'trigger') {
      this.triggerManager.recordTrigger({
        impulseScore: score,
        context,
        userResponse: 'pending'
      });
    }

    return {
      shouldTrigger: decision === 'trigger',
      decision,
      score,
      confidence: impulseResult.confidence,
      action,
      breakdown: impulseResult.breakdown,
      reason: decision === 'trigger' ? '触发评分达标' : `评分${score}低于阈值${threshold}`
    };
  }

  /**
   * 构建触发动作
   */
  buildTriggerAction(impulseResult) {
    const { score, breakdown } = impulseResult;
    
    return {
      type: 'workflow_trigger',
      score,
      triggeredBy: breakdown.keyword.matchedKeywords.join(', '),
      confidence: impulseResult.confidence,
      recommendedAction: score >= config.autoTriggerThreshold ? 'auto' : 'manual'
    };
  }

  /**
   * 记录用户反馈
   */
  recordFeedback(feedbackType) {
    // feedbackType: 'positive' 或 'negative'
    this.triggerManager.state.save();
    this.feedbackCache.set(Date.now(), feedbackType);
  }

  /**
   * 更新用户反馈权重
   */
  updateFeedbackWeights() {
    const feedbacks = Array.from(this.feedbackCache.values());
    if (feedbacks.length === 0) return;

    const positiveCount = feedbacks.filter(f => f === 'positive').length;
    const negativeCount = feedbacks.filter(f => f === 'negative').length;
    const total = feedbacks.length;

    if (total > 0) {
      const positiveRatio = positiveCount / total;
      // 调整权重
      config.positiveFeedbackWeight = Math.max(1.0, config.positiveFeedbackWeight + (positiveRatio - 0.5) * config.feedbackLearningRate);
      config.negativeFeedbackWeight = Math.max(0.5, config.negativeFeedbackWeight + (0.5 - positiveRatio) * config.feedbackLearningRate);
      
      this.saveConfig();
    }
  }

  saveConfig() {
    ensureHome();
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  /**
   * 获取触发统计
   */
  getStats() {
    return {
      totalTriggers: this.triggerManager.state.triggerHistory.length,
      currentLimit: this.triggerManager.calculateDynamicLimit(),
      recentActivity: this.triggerManager.state.triggerHistory.slice(-10)
    };
  }
}

// ============ 导出接口 ============
export const TriggerEngine = {
  /**
   * 创建触发引擎实例
   */
  create(sessionId = 'default') {
    const state = TriggerState.load(sessionId);
    return new TriggerDecisionEngine(
      new DynamicTriggerManager(state),
      new TriggerScorer()
    );
  },

  /**
   * 用户消息处理（单例模式）
   * sessionId 优先取 context.sessionId，默认 'default'
   */
  processUserMessage(message, context = {}) {
    const sessionId = context.sessionId || 'default';
    const engine = this.create(sessionId);
    return engine.shouldTrigger(message, context, sessionId);
  },

  /**
   * 获取当前配置
   */
  getConfig() {
    return { ...config };
  },

  /**
   * 重置引擎状态
   */
  reset() {
    TriggerState.load().reset();
  },

  /**
   * 获取统计信息
   */
  getStats() {
    const engine = this.create();
    return engine.getStats();
  }
};

// ============ 命令行接口 ============
// import.meta.url 是 file:// URL，process.argv[1] 是本地路径，不能直接 endsWith 比较
const isCliEntry = (() => {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const entry = process.argv[1];
    return !!entry && resolve(selfPath) === resolve(entry);
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  // 测试模式
  const testMessage = process.argv[2] || '运行 carlos 工作流';
  const context = { complexity: 1.2 };
  
  console.log('[Carlos Trigger] 测试模式');
  console.log('输入:', testMessage);

  const engine = TriggerEngine.create();
  const result = engine.shouldTrigger(testMessage, context);

  console.log('\n决策结果:');
  console.log('- 是否触发:', result.shouldTrigger ? '是' : '否');
  console.log('- 决策:', result.decision);
  console.log('- 评分:', result.score);
  console.log('- 置信度:', result.confidence);
  console.log('- 理由:', result.reason);

  if (result.action) {
    console.log('\n触发动作:');
    console.log('- 类型:', result.action.type);
    console.log('- 推荐操作:', result.action.recommendedAction);
  }
}

export default TriggerEngine;
