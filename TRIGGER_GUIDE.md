# Carlos Flow 智能触发引擎使用指南

## 📋 概述

Carlos Flow 智能触发引擎是一个三层智能系统，能够自动感知用户意图并在合适的时机触发工作流。它具备以下特点：

### 核心特性

1. **动态上限控制** - 基于会话时长、任务复杂度和触发历史动态调整触发上限
2. **评分系统** - 对每个用户输入评分：关键词 50 + 上下文 30 + 意图 20，加权后满分 **38**
3. **决策引擎** - 基于评分和动态上限决定是否触发工作流（四档：`trigger` / `review` / `ignore` / `throttled`）
4. **用户反馈学习** - 记录用户接受/拒绝，持续优化触发
5. **零外部依赖** - 纯 JavaScript 实现，无需 npm 包

### 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户输入                                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│          L1: DynamicTriggerManager (动态上限)                 │
│          - 计算当前触发上限                                     │
│          - 管理历史触发记录                                     │
│          - 确保最少触发间隔                                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│        L2: TriggerScorer (评分系统)                           │
│        - 关键词匹配 (0-50 分)                                  │
│        - 上下文相关性 (0-30 分)                                │
│        - 用户意图识别 (0-20 分)                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│    L3: TriggerDecisionEngine (决策引擎)                       │
│    - 综合评分计算                                             │
│    - 触发决策 (trigger/ignore/review)                         │
│    - 用户反馈记录                                             │
└─────────────────────────────────────────────────────────────┘
```

## ⚙️ 配置说明

### 配置文件位置

| 文件 | 位置 | 说明 |
|------|------|------|
| `trigger-config.json` | `$CARLOS_FLOW_HOME/trigger-config.json` | 自定义阈值与权重；不存在则用默认值 |
| `trigger-state.json` | `$CARLOS_FLOW_HOME/trigger-state.json` | 触发历史与学习数据 |

`CARLOS_FLOW_HOME` 未设置时，默认落在 `~/.carlos-flow`（与 `src/state.js` 的 `FLOW_HOME` 同一约定）。
配置与状态**不会**写入仓库目录，也**不会**污染 npm 包。

### 默认配置参数

```json
{
  "baseTriggerLimit": 5,
  "maxTriggerLimit": 15,
  "sessionLengthCoeff": 0.5,
  "complexityCoeff": 2,
  "historyCoeff": 0.3,
  "decayRate": 0.98,
  
  "keywordWeights": {
    "work": 3,
    "flow": 3,
    "carlos": 4,
    "dispatch": 3,
    "trigger": 2,
    "start": 1,
    "run": 1,
    "execute": 2
  },
  
  "contextRelevanceWeight": 0.3,
  "userIntentWeight": 0.2,
  
  "triggerThreshold": 15,
  "autoTriggerThreshold": 25,
  "lowConfidenceThreshold": 10,
  
  "feedbackLearningRate": 0.1,
  "positiveFeedbackWeight": 1.5,
  "negativeFeedbackWeight": 0.7,
  
  "triggerWindowMinutes": 15,
  "minTriggerIntervalSeconds": 300
}
```

### 参数说明

#### 动态上限参数
- `baseTriggerLimit`: 基础触发上限（0 会话时）
- `maxTriggerLimit`: 最大触发上限（防止过度触发）
- `sessionLengthCoeff`: 会话时长系数（每小时增加量）
- `complexityCoeff`: 任务复杂度系数（基于参数）
- `historyCoeff`: 历史触发频率系数
- `decayRate`: 历史触发衰减率（随时间减弱）

#### 评分参数
- `keywordWeights`: 关键词权重配置
- `contextRelevanceWeight`: 上下文相关性权重
- `userIntentWeight`: 用户意图识别权重

#### 决策阈值
- `triggerThreshold`: 最低触发阈值（15 分以上触发）
- `autoTriggerThreshold`: 自动触发阈值（25 分以上自动）
- `lowConfidenceThreshold`: 低置信度阈值（低于此忽略）

## 🚀 使用方式

### 1. 在 `carlos.js` 中使用

智能触发引擎已集成到 `carlos.js` 客户端中。调用时自动执行触发检查：

```bash
node carlos.js flow_dispatch {"sessionId":"default"}
```

在调用 MCP 工具之前，引擎会检查用户意图并可能自动触发工作流。

### 2. 独立使用触发引擎

在 Node.js 项目中直接使用：

```javascript
import TriggerEngine from './src/trigger.js';

// 创建引擎实例
const engine = TriggerEngine.create('session-123');

// 检查是否触发
const result = engine.shouldTrigger('运行 dispatch 工作流', {
  sessionId: 'session-123',
  complexity: 1.2
});

if (result.shouldTrigger) {
  console.log('✅ 触发工作流！');
  // 执行后续流程...
} else {
  console.log('❌ 暂不触发');
}

// 记录用户反馈
engine.recordFeedback('positive'); // 用户接受
engine.recordFeedback('negative'); // 用户拒绝
```

### 3. 通过 CLI 客户端集成

触发引擎已集成到 `client/carlos.js`：每次调用 MCP 工具前先做一次触发检查，命中时在 stderr 打印评分与置信度。

```bash
node client/carlos.js flow_dispatch '{"sessionId":"my-task","role":"executor"}'
# stderr: [Carlos Trigger] 评分 37 · 置信度 0.9 · 命中 work, flow, dispatch
```

> **当前定位**：触发引擎是**库级能力**（`src/trigger.js`），由客户端集成调用；
> 它**尚未**作为独立的 MCP 工具暴露给宿主 Agent。如果你需要 `flow_trigger_check` 之类的
> MCP 工具入口，请自行在 `src/index.js` 的 `TOOLS` 数组中注册一个包装工具。

## 📊 评分计算详解

### 总分计算公式

```
总分 = 关键词分 × 0.5 + 上下文分 × 0.3 + 意图分 × 0.2
```

### 各维度分数范围

| 维度 | 基础分数 | 权重 | 贡献上限 |
|------|----------|------|----------|
| 关键词匹配 | 0-50 | 0.5 | 25 |
| 上下文相关性 | 0-30 | 0.3 | 9 |
| 用户意图识别 | 0-20 | 0.2 | 4 |
| **总计** | - | - | **38** |

### 决策逻辑

```javascript
if (score >= autoTriggerThreshold && confidence >= 0.8) {
  // ✅ 自动触发
  decision = 'trigger';
} else if (score >= triggerThreshold) {
  // ⚠️ 需人工确认
  decision = 'review';
} else if (score < lowConfidenceThreshold) {
  // ❌ 忽略
  decision = 'ignore';
}
```

## 🔄 动态上限计算

### 公式

```
动态上限 = clamp(
  baseTriggerLimit +
  (会话时长小时数 × sessionLengthCoeff) +
  (任务复杂度 × complexityCoeff) -
  (窗口内触发次数 × historyCoeff),
  1, maxTriggerLimit
)
```

> **设计要点**：会话越长、任务越复杂 → 上限越高（允许更多触发）；
> 近期触发越频繁 → 上限越低（收敛打扰）。
> 历史项是**惩罚项**而非增益项 —— 若为增益，触发次数会把上限反向抬高，封顶逻辑将自我抵消而永不生效。

### 示例

- 新会话（0 小时），复杂度 1.0，无历史 → 上限 = 5 + 0 + 2 - 0 = **7**
- 2 小时会话，复杂度 1.2，窗口内 3 次触发 → 上限 = 5 + 1 + 2.4 - 0.9 = **7**
- 5 小时会话，复杂度 1.5，窗口内 0 次触发 → 上限 = 5 + 2.5 + 3 = **10**

### 上限判定

```
窗口内触发次数 = countTriggersInWindow()   // 原始计数
if (窗口内触发次数 >= 动态上限) → 拒绝触发
```

> 注：判定用的是**原始次数**，不是衰减加权均值。衰减加权值（`calculateHistoryFactor()`）
> 仅用于上限微调，量级与上限不可比。

## 📈 用户反馈学习

系统记录用户反馈并及时调整权重：

```javascript
// 用户接受触发
engine.recordFeedback('positive');

// 用户拒绝触发
engine.recordFeedback('negative');

// 自动调整权重
engine.updateFeedbackWeights();
```

学习周期：每 10 次反馈后更新参数，避免过度拟合。

## 🎯 最佳实践

### 1. 响应式设计

- 高频触发场景：调高 `maxTriggerLimit`
- 低频场景：降低 `triggerThreshold` 优化灵敏度
- 生产环境：设置 `minTriggerIntervalSeconds >= 300`

### 2. 关键词优化

根据实际业务调整 `keywordWeights`：

```json
"keywordWeights": {
  "deploy": 4,
  "test": 3,
  "check": 2,
  "run": 1
}
```

### 3. 上下文感知

为不同任务类型设置不同复杂度参数：

```bash
# 高风险任务
node carlos.js flow_dispatch --complexity 1.5

# 常规任务
node carlos.js flow_dispatch --complexity 1.0
```

## 🔧 高级功能

### 自定义评分算法

```javascript
class CustomScorer extends TriggerScorer {
  calculateKeywordScore(message) {
    // 覆盖关键词匹配逻辑
    // ...
  }
}

// 使用自定义打分器
const customEngine = new TriggerDecisionEngine(
  new DynamicTriggerManager(),
  new CustomScorer()
);
```

### 持久化状态

```javascript
const state = TriggerState.load('session-id');
// 修改状态
state.triggerHistory = [...];
state.save(); // 持久化到 disk
```

## 🐛 故障排查

### 问题 1: 触发不灵敏

**症状**: 明显意图但评分低于阈值

**解决**:
1. 检查关键词权重配置
2. 降低 `triggerThreshold`
3. 增加 `contextRelevanceWeight`

### 问题 2: 触发过于频繁

**症状**: 短时间内多次触发

**解决**:
1. 调高 `minTriggerIntervalSeconds`
2. 调低 `sessionLengthCoeff`
3. 调高 `historyCoeff`（它是**惩罚项**，调高会更快收紧上限）
4. 调低 `baseTriggerLimit`

### 问题 3: 评分总是 0

**症状**: 所有消息都匹配不到关键词

**解决**:
1. 检查消息是否包含配置关键词
2. 验证 `keywordWeights` 是否生效
3. 查看日志调试匹配过程

### 问题 4: 触发引擎没生效（客户端无任何提示）

**症状**: 调用 `client/carlos.js` 时看不到 `[Carlos Trigger]` 日志

**解决**:
1. 确认 `src/trigger.js` 存在且与 `client/carlos.js` 同版本
2. 确认客户端用的是**动态 import**（ESM 下 `require()` 不存在，会被 try/catch 静默吞掉）
3. 直接运行 `node src/trigger.js "你的消息"` 验证引擎本体

## 📚 相关资源

- [测试脚本](test/trigger-e2e.mjs) - E2E 测试套件（15 项，含 4 项回归用例）
- [核心代码](src/trigger.js) - 触发引擎实现
- [集成示例](client/carlos.js) - 客户端集成代码
- [E2E 测试报告](../../trigger-e2e-test-report.md) - 详细测试报告

## 📄 许可证

MIT License

---

**版本**: v2.5.4  
**更新日期**: 2026-11-05
