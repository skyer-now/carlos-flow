# 调研与方案互审（advisory review）

面向“只读调研 / 方案建议”的轻量互审，补充 T2 双轴只覆盖“写文件”的空白。

## 边界（先看这里）

- **不改变** T0/T1/T2 路由，**不参与** `flow_verdict` 的 PASS 门禁，也不读写 `card` / `audit_axes`。
- **不能拦截自由文本回答**：插件只能强制结构化交付物（`flow_advisory_axes` → `submit` → `guard`）。要拦截模型每一句回答，需要宿主在消息出口加钩子，这是宿主能力，不是插件承诺。
- 审核者是只读的：零文件改动、不重跑长测；无法核实就写“未验证”。

## 什么时候触发

纯规则判定（`src/advisory-rules.js`，中英双语，<5ms，无模型调用）：

| 级别 | 场景 |
|---|---|
| `dual` | 不可逆/高风险（发布、回滚、迁移、权限、密钥、生产）、架构与选型决策、对外承诺、用户明确要求评审 |
| `single` | 时效敏感事实（最新版本、价格、政策）、调研与来源核实、排障根因 |
| `none` | 常规核查（查一下/看一下/读一下/翻译/格式/是什么、look up/check/read/translate） |

降噪：

- 同一主题 30 分钟内不重复 dual，降级为 single；
- 24 小时内 dual 最多 6 次，超限降级并说明；
- `routine` 只在没有 dual 命中时生效（“查一下发布流程”仍会审）。

判定结果永远带 `matched_rules` 与 `reason`，可以解释为什么审/为什么不审。

## 两轴

- **Evidence（调研轴）**：是否真的查了；来源能否定位（file:line / URL + 抓取时间）；结论与证据是否一一对应；时效；有没有主动找反证。
- **Feasibility（方案轴）**：至少两个选项（含“不做”）；依赖、版本、平台、权限、数据迁移；影响面与最坏情况；可逆性与回滚是否经过验证；验收标准。

## 证据与判定约束

- PASS 必须带证据（≥8 字符的 file:line / URL / 命令摘要），否则拒绝；
- 声明 `status` 为 `done` / `verified` 时必须有 `evidence_ref`，否则 guard 拦下；
- 任一轴 FAIL 直接拦；WARN 不拦，但必须随结论一起汇报；
- 两轴证据高度雷同（jaccard ≥ 0.8）视为未独立取证，拒绝；
- 单次互审 30 分钟有效；过期后 submit / guard 都拒绝。

## 选轴与保守升级

- 显式 `artifact: research | plan` 优先；
- 未显式时按 `report` 结构推断（有 options/recommendation/rollback → plan；有 claims/sources → research）；
- 有结构化报告但类型推断不出来 → **升级为 dual**（宁可多审一次，也不静默降级）；
- 没有任何 report 的普通调研 → 单轴 evidence。

## canary（防形式化审核）

`flow_advisory_axes` 支持 `canary: true`：在方案轴 prompt 里放入一个已知缺陷（“本方案没有回滚步骤”）。
审核者若给 PASS 且 findings/证据里没有提到回滚/恢复/不可逆，guard 判为“canary 未被识别（疑似形式化审核）”。
用于自测与抽检，不建议在真实交付里默认开启。

## 用法

```js
// 1) 判定 + 生成两轴合同
carlos_review { action: 'advisory_axes', sessionId, question, claims, report, artifact }
// → advisory_id + 两段 prompt（自己派 2 个只读 subagent）

// 2) 分轴提交（绑定 advisory_id）
carlos_review { action: 'advisory_submit', sessionId, advisoryId, axis: 'evidence', verdict: 'PASS', evidence: 'src/a.js:10 + npm test 输出哈希' }

// 3) 交付前自查
carlos_review { action: 'advisory_guard', sessionId, advisoryId }
```

## 与 T2 双轴的关系

| | T2 双轴 | 调研/方案互审 |
|---|---|---|
| 触发 | 落 PASS 裁定 | 调研/方案交付前 |
| 绑定 | `card_ts`（任务卡） | `advisory_id` + 30 分钟有效期 |
| 轴 | standards / spec | evidence / feasibility |
| 门禁 | 硬门禁（PASS 必须齐） | 交付检查（guard 返回未通过） |
| 相互影响 | 无 | 无（不写 `audit_axes`） |

## 已知未做

- 宿主出口钩子（强制拦截自由文本）未实现；
- 证据引用目前是自由文本，尚未与“真实工具调用/命令哈希”自动核对；
- canary 目前按调用方显式开启，未做自动随机抽样。