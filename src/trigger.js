// Carlos 工作流智能触发引擎
// 三层智能触发系统：动态上限、评分系统、决策引擎

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// 触发器状态/配置目录：与 state.js 的 FLOW_HOME 保持同一约定，避免污染仓库目录
const TRIGGER_HOME = (() => {
  // 与 state.js 同一套 `~` 展开：否则 CARLOS_FLOW_HOME=~/.carlos-flow 不会被展开，
  // 触发器状态/配置会写到「当前目录下的一个名叫 ~ 的目录」里。
  const raw = process.env.CARLOS_FLOW_HOME || process.env.CARLOS_FLOW_ROOT || join(os.homedir(), '.carlos-flow');
  if (typeof raw !== 'string' || raw === '') return join(os.homedir(), '.carlos-flow');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(os.homedir(), raw.slice(2));
  return raw;
})();
const CONFIG_PATH = join(TRIGGER_HOME, 'trigger-config.json');
const STATE_DIR = join(TRIGGER_HOME, 'trigger-state');
const DEFAULT_STATE_PATH = join(TRIGGER_HOME, 'trigger-state.json');

// 按会话隔离状态文件：不同会话的触发历史 / 限流状态互不影响。
// sessionId 会被清洗成安全的文件名，避免路径穿越。
// Windows 保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9 …）
// 即便带扩展名（CON.json）在 NTFS 上也无法创建，必须避开。
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeSessionId(sessionId) {
  const raw = String(sessionId || 'default');
  // 1) 清洗路径分隔符与非法字符（斜杠、背杠、冒号等）
  let safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  // 2) 不允许以点开头（避免 "." / ".." 语义）
  safe = safe.replace(/^\.+/, '_');
  if (!safe) safe = 'default';
  // 3) 避开 Windows 保留设备名
  if (WINDOWS_RESERVED.test(safe)) safe = '_' + safe;
  // 3) 追加原始 id 的短哈希：清洗后可能撞名（"a/b" 与 "a_b" 都会变成 "a_b"），
  //    用哈希保证不同 session 不会共用同一份状态文件
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  }
  const suffix = h.toString(16).padStart(8, '0').slice(0, 8);
  return safe + '-' + suffix;
}

function statePathFor(sessionId) {
  if (!sessionId || sessionId === 'default') return DEFAULT_STATE_PATH;
  return join(STATE_DIR, sanitizeSessionId(sessionId) + '.json');
}

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
  historyCoeff: 0.3,                // 历史触发频率系数（惩罚项）

  // 评分参数
  // 关键词表：只收**流程性**词汇（表示“要走门禁/工作流”），不收普通开发动词
  // （如「实现」「新增」「接口」）—— 否则每条普通需求都会命中，触发器就退化成噪声。
  // 中文词与英文词同权重：用户用中文提需求时，触发行为与英文一致。
  keywordWeights: {
    'work': 3, 'flow': 3, 'carlos': 4, 'dispatch': 3,
    'trigger': 2, 'start': 1, 'run': 1, 'execute': 2,
    // 中文流程词
    '工作流': 3, '门禁': 4, '任务卡': 3, '派发': 3, '子代理': 3,
    '流程': 2, '触发': 2, '执行': 2, '调度': 2,
    '审计': 2, '复核': 2, '留痕': 2, '裁定': 2,
  },
  contextRelevanceWeight: 0.3,
  userIntentWeight: 0.2,

  // 情绪与怀疑度感知参数 (Sentiment & Doubt Perception)
  sentimentWeights: {
    // 强烈不满与直接否定 (高权重 +15~25)
    '根本不对': 20, '完全错了': 20, '非常不满意': 25, '很失望': 20,
    '在说谎': 25, '在吹牛': 20, '不要瞎改': 25, '全搞崩了': 25,
    '不行不行': 20, '差评': 20, '怎么搞的': 18, '你在干嘛': 18,
    '不要只凭': 15, '胡说八道': 25,

    // 质问与怀疑句式 (中高权重 +10~18)
    '你确定': 15, '真的跑通': 18, '到底有没有': 15, '为什么还没有': 15,
    '怎么可能': 12, '有没有核对': 15, '不要只凭口头': 18, '到底改了没有': 18,
    '连这都不知道': 15, '为什么还在报错': 18, '反复': 10,

    // 连续标点情绪强化 (+8~15)
    '？？？': 15, '???': 15, '！！！': 10, '!!!': 10,
    '？？': 10, '??': 10, '！！': 8, '!!': 8
  },
  sentimentWeight: 0.25,            // 综合评分中情绪维度的权重

  // 决策阈值
  triggerThreshold: 15,             // 触发阈值（0-100）
  autoTriggerThreshold: 25,         // 自动触发阈值（高中意图时）
  lowConfidenceThreshold: 10,       // 低置信度阈值
  placeholderTtlMs: 5 * 60 * 1000,  // 占位卡自动老化窗口（5分钟）

  // 语义副作用分级矩阵 (LEVEL_0: READ_ONLY, LEVEL_1: EPHEMERAL, LEVEL_2: MUTATING)
  ephemeralActionWords: [
    'log', 'print', 'test:run', 'debug', 'trace', 'echo', 'status', 'check',
    '加日志', '打印', '跑单测', '排查', '调试', '查状态', '跑一下测试', '测一下', '单测',
  ],

  // 只读意图识别：命中只读词且**不含**改动动词 → 不进入工作流门禁。
  // 原因：占位卡恒为 read_only 档（scope=[]），若一个只需要只读调研的任务
  // 被激活，它的待补项（scope/acceptance/verify.cmd）永远无法被满足 ——
  // 因为只读任务本来就不需要改文件 —— 该会话会被永久锁死。
  readOnlyIntentWords: [
    'explain', 'describe', 'analyse', 'analyze', 'summarize', 'summarise',
    'what', 'why', 'how', 'understand', 'overview', 'compare', 'inspect',
    'read', '查找', '解释', '分析', '总结', '为什么', '是什么', '调研', '对比', '了解', '查看', '读一下', '看看',
    '看一下', '看下', '参考', '浏览', '评估'
  ],
  mutatingActionWords: [
    'fix', 'refactor', 'change', 'update', 'implement', 'add', 'remove',
    'modify', 'rewrite', 'migrate', 'patch', 'upgrade', 'rename',
    '修复', '重构', '修改', '更新', '实现', '新增', '删除', '重写', '迁移', '改造', '写一个', '写个',
  ],

  // 用户反馈学习
  feedbackLearningRate: 0.1,
  feedbackLearningCycle: 10,        // 每累积多少条反馈重新学习一次
  feedbackThresholdOffset: 0,       // 学习结果：负反馈多 → 抬高触发阈值
  positiveFeedbackWeight: 1.5,
  negativeFeedbackWeight: 0.7,

  // 触发窗口
  triggerWindowMinutes: 60,         // 触发窗口期（分钟）——需 ≥ 最长间隔×窗口倍数，
                                     // 否则「窗口内次数达上限」分支永远不可达
  minTriggerIntervalSeconds: 300    // 最少触发间隔（秒）
};

// 加载配置文件
//
// 词表类字段必须做**合并**而不是整体替换。
// 原实现 `config = { ...DEFAULT_CONFIG, ...loaded }` 是浅合并 —— 用户一旦写了
// `keywordWeights`，就会把默认词表（含内置的中文流程词）**整个丢掉**，
// 于是「我只是加一个自定义词」反而让所有默认词失效，中文场景重新变回 0 分。
// 语义修正：
//   · keywordWeights：对象 → 合并（用户词覆盖同名默认词，其余默认词保留）
//   · readOnlyIntentWords / mutatingActionWords：数组 → 追加去重（“扩展”而非“替换”）
//   · 其余标量字段：覆盖（阈值、权重等本来就是单值）
let config = DEFAULT_CONFIG;
if (existsSync(CONFIG_PATH)) {
  try {
    const loaded = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...loaded };
    // keywordWeights 必须是**对象**才能合并。
    // 浅合并会把 null / 数组 / 数字一并带进 config.keywordWeights，
    // 而下面的 if 因假值跳过深合并 → config.keywordWeights 保持非法值 →
    // buildKeywordIndex() 的 Object.entries(null) 抛 TypeError →
    // 触发引擎在该进程内**每次调用都失败**（客户端 catch 掉 → 静默失去自动触发）。
    // 所以：类型不对就丢弃用户值、回退默认表，并在合并后再兜一次底。
    if (loaded.keywordWeights !== undefined) {
      if (loaded.keywordWeights && typeof loaded.keywordWeights === 'object' && !Array.isArray(loaded.keywordWeights)) {
        config.keywordWeights = { ...DEFAULT_CONFIG.keywordWeights, ...loaded.keywordWeights };
      } else {
        console.warn('[Carlos Trigger] keywordWeights 必须是对象，已忽略该配置项（使用默认词表）');
        config.keywordWeights = { ...DEFAULT_CONFIG.keywordWeights };
      }
    }
    for (const key of ['readOnlyIntentWords', 'mutatingActionWords']) {
      if (Array.isArray(loaded[key]) && Array.isArray(DEFAULT_CONFIG[key])) {
        config[key] = [...new Set([...DEFAULT_CONFIG[key], ...loaded[key]])];
      } else if (loaded[key] !== undefined) {
        console.warn(`[Carlos Trigger] ${key} 必须是数组，已忽略该配置项（使用默认词表）`);
        config[key] = [...DEFAULT_CONFIG[key]];
      }
    }
  } catch (e) {
    console.warn('[Carlos Trigger] 配置加载失败:', e.message);
  }
}

// ============ 激活动作辅助 ============

/**
 * 只读意图识别。
 *
 * 命中只读词（explain/analyze/调研/看看…）且**不含**改动动词
 * （fix/refactor/修改/修复…）→ 判定为只读调研。
 *
 * 为什么要单独识别：智能触发引擎开的占位卡恒为 read_only 档（scope=[]），
 * 其待补项是 scope/acceptance/verify.cmd。如果一个**只需要只读调研**的任务
 * 被激活，这三项永远无法被满足（只读任务本来就不改文件）——
 * 该会话会被永久锁死，且没有任何合法路径解闸。
 */
/**
 * 复合名词与伪改动词清洗列表（如“开源实现/方案设计/架构实现/如何实现”，属于只读名词短语）
 */
const COMPOUND_NOUN_PHRASES = [
  /开源实现/g, /技术实现/g, /功能实现/g, /架构实现/g, /如何实现/g, /怎么实现/g,
  /方案设计/g, /系统设计/g, /设计方案/g, /重构计划/g, /修改建议/g, /更新说明/g
];

/**
 * 疑问前缀与否定/探讨反转词（具有最高静默优先级）
 */
const QUESTION_OR_NEGATION_PREFIXES = [
  '为什么', '为何', '怎么看', '如何看待', '是什么', '什么原因',
  '先别改', '不要改', '只是讨论', '随便问问', '不用动代码', '仅分析', '别执行'
];

const LEARNED_RULES_FILE = join(TRIGGER_HOME, 'learned-rules.json');

/**
 * 本地隐式强化学习与规则自适应管理器
 */
export class LearnedRulesManager {
  static load() {
    try {
      if (existsSync(LEARNED_RULES_FILE)) {
        return JSON.parse(readFileSync(LEARNED_RULES_FILE, 'utf8'));
      }
    } catch {}
    return { version: 1, suppressed_patterns: [], boosted_patterns: [], threshold_offset: 0 };
  }

  static save(data) {
    try {
      ensureHome();
      writeFileSync(LEARNED_RULES_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  /**
   * 记录负向行为信号（用户叫停/撤销/老化）
   */
  static recordNegativeFeedback(triggerMessage, reason = 'hard_negative') {
    const data = this.load();
    const text = String(triggerMessage || '').trim();
    if (!text) return;
    
    // 提炼简明正则特征（如包含核心动词与名词的模式）
    const clean = text.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!data.suppressed_patterns.includes(clean)) {
      data.suppressed_patterns.push(clean);
      if (data.suppressed_patterns.length > 50) data.suppressed_patterns.shift();
    }
    // 动态抬高惩罚阈值
    data.threshold_offset = Math.min(20, (data.threshold_offset || 0) + (reason === 'hard_negative' ? 3 : 1));
    this.save(data);
  }

  /**
   * 记录正向履约信号（正常完成 claim -> verdict PASS）
   */
  static recordPositiveFeedback(triggerMessage) {
    const data = this.load();
    const text = String(triggerMessage || '').trim();
    if (!text) return;
    const clean = text.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!data.boosted_patterns.includes(clean)) {
      data.boosted_patterns.push(clean);
      if (data.boosted_patterns.length > 50) data.boosted_patterns.shift();
    }
    // 恢复/降低阈值偏移
    if (data.threshold_offset > 0) {
      data.threshold_offset = Math.max(0, data.threshold_offset - 1);
    }
    this.save(data);
  }

  /**
   * 检查是否命中抑制模式
   */
  static isSuppressed(message) {
    const data = this.load();
    const s = String(message || '').toLowerCase();
    for (const pat of data.suppressed_patterns || []) {
      try {
        if (new RegExp(pat, 'i').test(s)) return true;
      } catch {
        if (s.includes(pat.toLowerCase())) return true;
      }
    }
    return false;
  }
}

/**
 * 语义副作用分级识别
 * LEVEL_0: READ_ONLY (只读/闲聊，0分静默)
 * LEVEL_1: EPHEMERAL (轻量排查/单测/打印，记录流水不建卡)
 * LEVEL_2: MUTATING (真实改动/重构/新增，进入工作流门禁)
 */
export function classifySideEffect(message) {
  const s = String(message || '').toLowerCase();
  if (!s) return 'LEVEL_0';

  // 0. 在线学习抑制规则拦截（历史误触句式强制静默）
  if (LearnedRulesManager.isSuppressed(s)) {
    return 'LEVEL_0';
  }

  // 1. 疑问前缀与否定反转词优先（优先静默）
  if (QUESTION_OR_NEGATION_PREFIXES.some((q) => s.startsWith(q) || s.includes(q))) {
    return 'LEVEL_0';
  }

  const ro = config.readOnlyIntentWords || [];
  const mut = config.mutatingActionWords || [];
  const eph = config.ephemeralActionWords || [];

  // 2. 复合名词清洗（消除“开源实现/方案设计”等伪改动动词误判）
  let cleanForMut = s;
  for (const reg of COMPOUND_NOUN_PHRASES) {
    cleanForMut = cleanForMut.replace(reg, '');
  }

  const hasMutating = mut.some((w) => cleanForMut.includes(String(w).toLowerCase()));
  if (hasMutating) return 'LEVEL_2';

  // 3. 检查临时排查/调试词汇
  const hasEphemeral = eph.some((w) => s.includes(String(w).toLowerCase()));
  if (hasEphemeral) return 'LEVEL_1';

  // 4. 检查只读意图词汇
  const hasReadOnly = ro.some((w) => s.includes(String(w).toLowerCase()));
  if (hasReadOnly) return 'LEVEL_0';

  return 'LEVEL_2';
}

function isReadOnlyIntent(message) {
  return classifySideEffect(message) === 'LEVEL_0';
}

/**
 * 从用户原话与命中关键词推导一个粗粒度目标。
 * 引擎无法知道真实目标，因此这只是**占位推断**，必须由 Agent 确认或改写。
 */
function deriveGoal(message, matchedKeywords = []) {
  const text = String(message || '').trim();
  const head = text.split(/[\n\r。.;；!?！？]/)[0].trim();
  const kw = matchedKeywords.length ? `（命中：${matchedKeywords.join(', ')}）` : '';
  const base = head ? head.slice(0, 60) : '待补充目标';
  return `执行 Carlos 工作流任务：${base}${kw}`;
}

/**
 * 生成给 Agent 的补全指令（激活后的第一件事）。
 */
function buildActivationPrompt(result, goal, matchedKeywords, mode = 'auto') {
  const isAuto = mode === 'auto';
  return [
    isAuto ? '【Carlos 触发引擎已激活工作流】' : '【Carlos 触发引擎建议手动启动门禁】',
    '',
    `判定：${result.decision}（评分 ${result.score} / 置信度 ${result.confidence}）`,
    `命中关键词：${matchedKeywords.length ? matchedKeywords.join(', ') : '（无直接关键词命中）'}`,
    `推断目标（占位，需确认或改写）：${goal}`,
    '',
    isAuto
      ? '已完成：用户原话已留痕，占位任务卡已提交，会话已进入门禁状态。'
      : '尚未执行任何动作（未留痕、未开卡）—— 本次评分未达自动激活条件，请自行决定是否启动门禁。',
    '',
    '接下来请：',
    '1. 与用户确认上面的目标描述是否准确；',
    isAuto
      ? '2. 补齐 scope（只准改动的文件）、acceptance（可判定的验收标准）、verify.cmd（验证命令）；'
      : '2. 若决定启动门禁：先 flow_add_user_msg 留痕，再 flow_submit_requirement 提交任务卡（需含 scope / acceptance / verify.cmd）；',
    isAuto
      ? '3. 重新调用 flow_submit_requirement 提交完整任务卡（会替换占位卡）；'
      : '3. 再调用 flow_claim / flow_dispatch 派发。',
    isAuto
      ? '4. 再调用 flow_claim / flow_dispatch 派发。'
      : '',
    '',
    isAuto
      ? '注意：在 scope / acceptance / verify.cmd 补齐之前，flow_claim 与 flow_dispatch 会拒绝派发。'
      : '注意：本次建议不会自动提交任何卡片。',
  ].join('\n');
}

// ============ 状态管理 ============
class TriggerState {
  constructor(sessionId = 'default') {
    this.sessionId = sessionId;
    this.triggerHistory = [];
    this.sessionStartTime = Date.now();
    this.lastTriggerTime = 0;
    this.impressionCount = 0; // 关联 impressionId
    this.feedback = { positive: 0, negative: 0 }; // 用户反馈（持久化）
  }

  getSessionAgeHours() {
    return (Date.now() - this.sessionStartTime) / (1000 * 60 * 60);
  }

  save() {
    ensureHome();
    const target = statePathFor(this.sessionId);
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch { /* 目录已存在或不可写 */ }
    try {
      writeFileSync(target, JSON.stringify(this, null, 2));
    } catch (e) {
      // 状态落盘失败（如保留设备名、权限不足、磁盘满）不能让引擎整体崩掉：
      // 降级为「本次不持久化」，主流程继续。
      try {
        process.stderr.write(`[carlos-trigger] 状态保存失败（${this.sessionId}）：${e && e.message ? e.message : e}
`);
      } catch { /* stderr 不可写 */ }
    }
  }

  static load(sessionId = 'default') {
    const target = statePathFor(sessionId);
    if (existsSync(target)) {
      try {
        const loaded = JSON.parse(readFileSync(target, 'utf8'));
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
   * 记录触发事件
   */
  recordTrigger(triggerData = {}) {
    this.state.triggerHistory.push({
      timestamp: Date.now(),
      impulseScore: triggerData.impulseScore || 0,
      context: triggerData.context || 'unknown',
      userResponse: triggerData.userResponse || 'pending',
      user_msg: triggerData.user_msg || (triggerData.context && triggerData.context.message) || null,
      ...triggerData,
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
  canTrigger(sessionComplexity = 1.0) {
    // 检查最小时间间隔
    const timeSinceLastTrigger = Date.now() - this.state.lastTriggerTime;
    if (timeSinceLastTrigger < config.minTriggerIntervalSeconds * 1000) {
      return { can: false, reason: '时间间隔不足' };
    }

    // 检查动态上限：用窗口内的实际触发次数与上限比较
    const currentLimit = this.calculateDynamicLimit(sessionComplexity);
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
    const workFlowKeywords = ['work', 'flow', 'dispatch', 'executor', 'auditor',
      '工作流', '门禁', '派发', '审计', '复核', '任务卡'];
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
   *
   * @param {string} message 用户输入
   * @param {number} historyCount 当前会话的触发历史条数（由 L3 传入）
   *        —— 评分层不再自己去磁盘读状态，避免与 L1 读到不同会话
   */
  calculateUserIntent(message, historyCount = 0) {
    // 简单实现：基于用户行为模式
    const userIntentCandidates = {
      'workflow': ['dispatch', 'run', 'execute', 'trigger', 'start', '执行', '派发', '触发', '工作流', '门禁'],
      'automation': ['auto', 'automate', 'workflow', 'process', '自动', '流程', '调度'],
      'management': ['manage', 'control', 'monitor', 'track', '管理', '监控']
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

    // 基于会话历史调整（活跃用户意图分上浮）
    if (historyCount > 10) {
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
   * 计算情绪与怀疑度分数 (Sentiment & Doubt Scorer)
   *
   * @param {string} message 用户输入
   * @param {string[]} [recentMessages] 上下文最近历史消息（用于追问/疲劳强化）
   */
  calculateSentimentScore(message, recentMessages = []) {
    const lowerMsg = String(message || '').toLowerCase();
    let score = 0;
    let matchedPatterns = [];

    // 1. 词表匹配
    if (config.sentimentWeights) {
      Object.entries(config.sentimentWeights).forEach(([keyword, weight]) => {
        if (lowerMsg.includes(keyword.toLowerCase())) {
          score += weight;
          matchedPatterns.push(keyword);
        }
      });
    }

    // 2. 连续质问标点强化（如？？？、？？、！！！）
    if (/[?？]{2,}/.test(message)) {
      score += 15;
      matchedPatterns.push('连续问号');
    }
    if (/^[?？\s!！]+$/.test(message.trim())) {
      score += 15; // 纯标点质问刷屏
      matchedPatterns.push('标点刷屏');
    }

    // 3. 上下文反复追问强化：若上一轮也是质问/否定，追加怀疑权重 (+10)
    if (Array.isArray(recentMessages) && recentMessages.length > 0) {
      const lastMsg = String(recentMessages[recentMessages.length - 1] || '');
      if (/[?？]|不行|不对|怎么|为什么|搞什么|错误|改了没有/.test(lastMsg)) {
        score += 10;
        matchedPatterns.push('连续追问上下文');
      }
    }

    // 标准化到 0-40 范围
    const normalizedScore = Math.min(score, 40);

    return {
      score: normalizedScore,
      rawScore: score,
      matchedPatterns,
      level: normalizedScore >= 20 ? 'high_doubt' : (normalizedScore > 0 ? 'mild_doubt' : 'neutral'),
      maxSentimentScore: 40
    };
  }

  /**
   * 综合评分
   *
   * @param {string} message 用户输入
   * @param {object} context 上下文（complexity, recentMessages 等）
   * @param {number} historyCount 当前会话触发历史条数（由 L3 传入，保证与 L1 同会话）
   */
  calculateImpulseScore(message, context = {}, historyCount = 0) {
    const keywordResult = this.calculateKeywordScore(message);
    const contextResult = this.calculateContextRelevance(message, context);
    const intentResult = this.calculateUserIntent(message, historyCount);
    const sentimentResult = this.calculateSentimentScore(message, context.recentMessages || []);

    // 基础三项权重（保持与原基线完全一致，不压缩流程词权重）
    const baseScore = 
      keywordResult.score * (1 - config.contextRelevanceWeight - config.userIntentWeight) +
      contextResult.score * config.contextRelevanceWeight +
      intentResult.score * config.userIntentWeight;

    // 情绪与怀疑度额外叠加增益（0-15分），在用户不满或质问时为触发增力
    const sentimentBonus = (sentimentResult.score / (sentimentResult.maxSentimentScore || 40)) * 15;
    const totalScore = Math.min(100, Math.round(baseScore + sentimentBonus));

    return {
      score: totalScore,
      breakdown: {
        keyword: keywordResult,
        context: contextResult,
        intent: intentResult,
        sentiment: sentimentResult
      },
      confidence: this.calculateConfidence(keywordResult, contextResult, intentResult, sentimentResult)
    };
  }

  /**
   * 计算置信度
   */
  calculateConfidence(keyword, context, intent, sentiment = null) {
    const allMatched = keyword.matchedKeywords.length + 
                      context.matchedContext.length + 
                      (intent.intentType !== 'generic' ? 1 : 0) +
                      (sentiment && sentiment.matchedPatterns.length > 0 ? 1 : 0);
    
    if (allMatched === 0) return 0.3; // 低置信度
    if (allMatched <= 2) return 0.6;  // 中等置信度
    return 0.9; // 高置信度
  }
}

// ============ L3: TriggerDecisionEngine ============
class TriggerDecisionEngine {
  constructor(triggerManager = null, scorer = null, sessionId = null) {
    this.triggerManager = triggerManager || new DynamicTriggerManager();
    this.scorer = scorer || new TriggerScorer();
    // 会话维度：L1（上限/历史）与 L2（评分）必须读同一个会话，
    // 否则会出现「上限算的是 A 会话、历史算的是 B 会话」的串扰。
    this.sessionId = sessionId || (this.triggerManager && this.triggerManager.state && this.triggerManager.state.sessionId) || 'default';
  }

  /**
   * 主触发决策
   * 基于评分和动态上限决定是否触发
   *
   * @param {string} message 用户输入
   * @param {object} context 上下文
   * @param {string} [sessionId] 会话 ID；省略时使用引擎实例自己的会话
   */
  shouldTrigger(message, context = {}, sessionId = null) {
    // 会话统一到一处：显式传入 > 引擎实例会话 > default
    const sid = sessionId || this.sessionId;
    // 1. 先计算触发评分（即使被限流，评分与置信度也要如实返回，不能丢成 0/undefined）
    const historyCount = Array.isArray(this.triggerManager.state.triggerHistory)
      ? this.triggerManager.state.triggerHistory.length
      : 0;
    const impulseResult = this.scorer.calculateImpulseScore(message, context, historyCount);
    const score = impulseResult.score;

    // 2. 检查是否可以触发（上限和时间间隔）
    const complexity = Number(context.complexity) || 1.0;
    const canTrigger = this.triggerManager.canTrigger(complexity);
    if (!canTrigger.can) {
      const throttled = {
        shouldTrigger: false,
        reason: canTrigger.reason,
        score,
        confidence: impulseResult.confidence,
        breakdown: impulseResult.breakdown,
        decision: 'throttled',
        action: null,
      };
      // 被限流时不激活（决策不是 trigger）
      throttled.activationPlan = this.buildActivationPlan(throttled, message, sid);
      return throttled;
    }

    // 3. 决策逻辑
    let baseThreshold = score >= config.autoTriggerThreshold && impulseResult.confidence >= 0.8
      ? config.autoTriggerThreshold
      : config.triggerThreshold;

    // 情绪与怀疑度自适应：高怀疑度时（high_doubt）自动下调阈值 20%，让防线更敏锐
    const sentimentLevel = impulseResult.breakdown?.sentiment?.level;
    if (sentimentLevel === 'high_doubt') {
      baseThreshold = Math.max(8, baseThreshold - 5);
    }

    // 反馈学习：负反馈多 → 抬高触发阈值（更保守）；正反馈多 → 降低阈值（更灵敏）
    // 两个来源：当前会话即时反馈 + 配置持久化偏移
    const feedbackAdj = this.getFeedbackThresholdAdjustment() + (Number(config.feedbackThresholdOffset) || 0);
    const effectiveThreshold = Math.max(1, baseThreshold + feedbackAdj);

    let decision;
    let action = null;

    if (score >= effectiveThreshold) {
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

    // 5. 空闲时异步调度自动归档（7天终态会话无感冷冻）
    try {
      import('./storage.js').then((m) => m.scheduleAutoPrune?.()).catch(() => {});
    } catch {}

    const outcome = {
      shouldTrigger: decision === 'trigger',
      decision,
      score,
      confidence: impulseResult.confidence,
      action,
      breakdown: impulseResult.breakdown,
      reason: decision === 'trigger' ? '触发评分达标' : `评分${score}低于阈值${effectiveThreshold}`
    };
    // 决策 → 激活：把判定翻译成可执行的 MCP 动作序列
    outcome.activationPlan = this.buildActivationPlan(outcome, message, sid);
    return outcome;
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
      // 自动档需要「分数达标」且「置信度足够」两道条件
      recommendedAction: (score >= config.autoTriggerThreshold && impulseResult.confidence >= 0.8) ? 'auto' : 'manual'
    };
  }

  /**
   * 构建激活计划（动态决策 → 判断 → 激活 的最后一跳）
   *
   * 判断层已经决定了「要不要触发」，这一层把决定翻译成**可执行的 MCP 动作序列**：
   *   - 自动步骤（auto: true）：参数完整，可直接执行
   *   - 引导步骤（auto: false）：需要 Agent 补齐字段后再执行
   *
   * 激活后不会直接放开派发：占位卡会被标记 activation_pending，
   * 在 scope / acceptance / verify.cmd 补齐之前，flow_claim / flow_dispatch 一律拒绝。
   */
  buildActivationPlan(result, message, sessionId = 'default') {
    if (!result || result.decision !== 'trigger') {
      return { activated: false, reason: '决策不是 trigger，不激活' };
    }

    // 只读调研不进入工作流门禁（否则该会话永远无法解闸，见 isReadOnlyIntent 注释）
    if (isReadOnlyIntent(message)) {
      return {
        activated: false,
        reason: '只读调研意图，不进入工作流门禁（占位卡的待补项对只读任务永远无法满足）',
        decision: result.decision,
        score: result.score,
        confidence: result.confidence,
        steps: [],
        pendingFields: [],
      };
    }

    const matched = (result.breakdown && result.breakdown.keyword &&
      result.breakdown.keyword.matchedKeywords) || [];
    const goal = deriveGoal(message, matched);

    // 自动步骤 1：写入用户原话（quote 锚点的唯一数据源，必须先于开卡）
    const steps = [
      {
        tool: 'flow_add_user_msg',
        auto: true,
        reason: '写入用户原话，作为任务卡 quote 锚点校验的数据源',
        args: { sessionId, text: String(message || '') },
      },
      // 自动步骤 2：提交 read_only 占位卡 —— 会话进入「已留痕」门禁态
      {
        tool: 'flow_submit_requirement',
        auto: true,
        reason: '开卡：将会话置为已留痕状态，审计链记录 activation 事件',
        args: {
          sessionId,
          goal,
          quote: String(message || ''),
          scope: [],
          acceptance: [],
          confirmed: false,
          activation: true,
        },
      },
      // 引导步骤：Agent 补齐后重新提交完整卡
      {
        tool: 'flow_submit_requirement',
        auto: false,
        reason: '补齐字段后重新提交完整任务卡，替换占位卡',
        needsFill: ['scope', 'acceptance', 'verify.cmd'],
        args: {
          sessionId,
          goal,
          quote: String(message || ''),
          scope: ['<只准改动的文件>'],
          acceptance: ['<可判定的验收标准>'],
          verify: { cmd: '<验证命令>' },
          confirmed: false,
        },
      },
    ];

    return {
      activated: true,
      decision: result.decision,
      score: result.score,
      confidence: result.confidence,
      matchedKeywords: matched,
      goal,
      steps,
      pendingFields: ['scope', 'acceptance', 'verify.cmd'],
      prompt: buildActivationPrompt(
        result, goal, matched,
        (result.action && result.action.recommendedAction) === 'auto' ? 'auto' : 'manual'
      ),
    };
  }

  /**
   * 记录用户反馈（持久化到会话状态，进程退出也不丢）
   *
   * feedbackType: 'positive'（用户接受了这次触发）/ 'negative'（拒绝了）
   */
  recordFeedback(feedbackType) {
    const type = feedbackType === 'positive' ? 'positive' : 'negative';
    const state = this.triggerManager.state;
    if (!state.feedback) state.feedback = { positive: 0, negative: 0 };
    state.feedback[type] = (Number(state.feedback[type]) || 0) + 1;
    state.save();

    // 达到一个学习周期就自动更新阈值（之前是无调用点的死代码）
    const total = state.feedback.positive + state.feedback.negative;
    if (total >= config.feedbackLearningCycle) {
      this.updateFeedbackWeights();
    }
    return { ok: true, feedback: { ...state.feedback }, thresholdAdjustment: this.getFeedbackThresholdAdjustment() };
  }

  /**
   * 根据正/负反馈计算触发阈值的调整量
   * 负反馈多 → 抬高阈值（更保守）；正反馈多 → 降低阈值（更灵敏）
   */
  getFeedbackThresholdAdjustment() {
    const fb = this.triggerManager.state.feedback || { positive: 0, negative: 0 };
    const positive = Number(fb.positive) || 0;
    const negative = Number(fb.negative) || 0;
    const total = positive + negative;
    if (total === 0) return 0;
    // 净负反馈比例 → 调整量（范围约 [-learningRate*10, +learningRate*10]）
    const negativeRatio = negative / total;
    const adj = Math.round((negativeRatio - 0.5) * 2 * config.feedbackLearningRate * 10);
    return adj;
  }

  /**
   * 更新反馈学习结果：把正/负反馈比写回配置里的阈值偏移
   */
  updateFeedbackWeights() {
    const fb = this.triggerManager.state.feedback || { positive: 0, negative: 0 };
    const total = (Number(fb.positive) || 0) + (Number(fb.negative) || 0);
    if (total === 0) return { ok: false, reason: '尚无反馈记录' };

    const negativeRatio = (Number(fb.negative) || 0) / total;
    // 持久化的学习结果：负反馈占多数 → 提高触发阈值
    const learned = Math.max(0, Math.round((negativeRatio - 0.5) * 2 * config.feedbackLearningRate * 10));
    config.feedbackThresholdOffset = learned;
    config.positiveFeedbackWeight = Number((1 + (1 - negativeRatio)).toFixed(3));
    config.negativeFeedbackWeight = Number((1 + negativeRatio).toFixed(3));

    this.saveConfig();
    return { ok: true, thresholdOffset: learned, positive: fb.positive, negative: fb.negative };
  }

  saveConfig() {
    ensureHome();
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  /**
   * 从当前会话历史中提取代码文件路径（多轮上下文消解，供手机端简短指令继承）
   */
  resolveContextScope(sessionId, cwd = null) {
    if (!sessionId) return [];
    try {
      const hist = this.triggerManager.state;
      const recent = (hist.triggerHistory || []).slice(-10);
      const candidates = new Set();
      // 正则匹配源码相对路径（如 src/auth.js, client/carlos.js, package.json 等）
      const pathRegex = /(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/g;
      
      for (const item of recent) {
        const text = JSON.stringify(item);
        let m;
        while ((m = pathRegex.exec(text)) !== null) {
          const p = m[0];
          if (!p.startsWith('http://') && !p.startsWith('https://')) {
            candidates.add(p);
          }
        }
      }
      return Array.from(candidates);
    } catch {
      return [];
    }
  }

  /**
   * 检查并老化未派发的过期占位卡
   */
  checkPlaceholderExpiry(sessionId, state) {
    if (!state || !state.card || !Array.isArray(state.activation_pending) || state.activation_pending.length === 0) {
      return { expired: false };
    }
    // 必须是从未派发（dispatch_count === 0）的纯占位卡
    if (Number(state.dispatch_count) > 0) {
      return { expired: false };
    }
    const cardTs = Number(state.card_ts) || 0;
    const now = Date.now();
    const ttl = Number(config.placeholderTtlMs) || 300000;
    if (cardTs > 0 && now - cardTs > ttl) {
      return { expired: true, cardTs, elapsedMs: now - cardTs };
    }
    return { expired: false };
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
export { TriggerScorer, TriggerDecisionEngine, DynamicTriggerManager };

export const TriggerEngine = {
  /**
   * 创建触发引擎实例
   */
  create(sessionId = 'default') {
    const state = TriggerState.load(sessionId);
    return new TriggerDecisionEngine(
      new DynamicTriggerManager(state),
      new TriggerScorer(),
      sessionId
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
   * 语义副作用分级
   */
  classifySideEffect(message) {
    return classifySideEffect(message);
  },

  /**
   * 会话上下文路径提取
   */
  resolveContextScope(sessionId, cwd = null) {
    const engine = this.create(sessionId);
    return engine.resolveContextScope(sessionId, cwd);
  },

  /**
   * 检查占位卡是否老化
   */
  checkPlaceholderExpiry(sessionId, state) {
    const engine = this.create(sessionId);
    return engine.checkPlaceholderExpiry(sessionId, state);
  },

  /**
   * 只读意图判定（供测试与外部查询）
   */
  isReadOnlyIntent(message) {
    return isReadOnlyIntent(message);
  },

  /**
   * 重置引擎状态
   * 默认只重置 'default' 会话；传 sessionId 可重置指定会话；
   * 传 '*' 重置全部会话（包含 trigger-state/ 目录下的所有会话文件）。
   */
  reset(sessionId = 'default') {
    if (sessionId === '*') {
      // 清空所有会话文件（默认会话 + trigger-state/ 目录）
      try { rmSync(DEFAULT_STATE_PATH, { force: true }); } catch { /* 不存在 */ }
      try {
        if (existsSync(STATE_DIR)) {
          for (const f of readdirSync(STATE_DIR)) {
            if (f.endsWith('.json')) {
              try { rmSync(join(STATE_DIR, f), { force: true }); } catch { /* 忽略 */ }
            }
          }
        }
      } catch { /* 目录不存在 */ }
      return { ok: true, scope: 'all' };
    }
    TriggerState.load(sessionId).reset();
    return { ok: true, scope: sessionId };
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
