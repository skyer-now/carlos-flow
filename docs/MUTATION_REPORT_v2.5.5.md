# 变异测试报告（v2.5.5 · P0 修复后重新生成）

- 生成时间：2026-11-06T02:23:18.505Z
- 生成方式：`node scripts/mutation-check.mjs`（P0-2 基线红即 exit 1；P0-3 每轮独立 BRIDGE_PORT + 目录删除容错 + 收尾清理残留 bridge；套件输出无法解析时 fail-closed 退出）
- 被测代码：carlos-flow-cindy 工作树（HEAD 5b0bb4b + 本轮 P0-1..P0-7 及追加 A/B 的改动，未提交）
- **基线套件**（未变异）：smoke + e2e-carlos(54) + p0-gates(15) + trigger-e2e(25) + concurrency(3)，全绿
- **结论：13/13 变异体全部被抓住**（M1–M13），其中 M12（跨进程锁失效）由 concurrency 套件检出（泄漏=1）
- ⚠️ 残留风险：并发套件的**检出**并非 100%（见 CHANGES.md「遗留风险」），且高负载下该套件偶发启动失败；
  此时 mutation-check 会 fail-closed 报错退出（不会误判成「变异体逃逸」）。

---


## 总览
# 变异测试报告

- 源仓库：`carlos-flow-cindy` / `carlos-flow-opencode`（工作副本路径已改写为占位符）
- 变异副本：临时目录（用完自动删除，不入库）
- 目的：确认测试套件能抓住「激活只打印日志」「闸门失效」「会话撞名」等退化

## 基线（未变异）

- e2e：54 通过 / 0 失败
- trigger：25 通过 / 0 失败
- concurrency：3 通过 / 0 失败

## M1-激活只打印日志

- 注入：把 checkTrigger 里的 callMCP 换成假返回（激活只剩日志）
- 文件：`client/carlos.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 52 通过 / 2 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 17b. 激活真实改变了服务端状态（非仅打印日志）  has_card=false pending=
```
```
✗ 17c. 客户端激活后闸门生效  已拒绝
```

## M2-claim闸门失效

- 注入：移除 flow_claim 的 activation_pending 闸门
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 50 通过 / 4 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 15c. 占位卡未补齐时 claim 被拒  未被拒绝（异常）
```
```
✗ 16e. 绕过尝试后 claim 仍被拒  未被拒绝（异常）
```
```
✗ 17c. 客户端激活后闸门生效  未被拒绝（异常）
```
```
✗ 19b. 半补齐后 claim 仍被拒  未被拒绝（异常）
```

## M3-verdict闸门失效

- 注入：移除 flow_verdict 的 activation_pending 闸门（占位卡可记 PASS）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 53 通过 / 1 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 15e. 占位卡未补齐时 verdict 被拒（防假闭环）  已拒绝
```

## M4-会话撞名

- 注入：去掉 sanitizeSessionId 的哈希后缀（清洗后同形的 id 会撞名）
- 文件：`src/trigger.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 54 通过 / 0 失败；trigger 24 通过 / 1 失败；concurrency 3 通过 / 0 失败

## M5-scope不算补齐项

- 注入：把 scope 从「当前缺失项」里剔除（scope 未补也不算缺）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 51 通过 / 3 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 15b. flow_status 暴露 activation_pending  pending=acceptance,verify.cmd
```
```
✗ 16d. 空 scope 提交无法解除激活闸门  pending=acceptance,verify.cmd
```
```
✗ 17b. 激活真实改变了服务端状态（非仅打印日志）  has_card=true pending=acceptance,verify.cmd
```

## M6-半补齐绕过闸门

- 注入：已激活会话改成「只要提交就解闸」（移除幂等派生）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 49 通过 / 5 失败；trigger 25 通过 / 0 失败；concurrency 2 通过 / 1 失败

失败用例：
```
✗ 16d. 空 scope 提交无法解除激活闸门  pending=
```
```
✗ 16e. 绕过尝试后 claim 仍被拒  未被拒绝（异常）
```
```
✗ 19a. 只补 scope 不足以解除闸门  pending=
```
```
✗ 19b. 半补齐后 claim 仍被拒  未被拒绝（异常）
```
```
✗ 22. 审计链含 activation / activation_released / activation_gate_held  kinds=activation_gate_activated,record,accepted,activation,activation_gate_unlocked,activation_released,claimed,verdict_denied
```

## M9-闸门派生回退

- 注入：把「已激活会话」的待补项改回上一轮 pending 传递（并发丢更新时会失效）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 49 通过 / 5 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 16b. 补齐后 activation_pending 清空  pending=scope,acceptance,verify.cmd
```
```
✗ 16c. 补齐后 claim 放行  ERROR: 激活占位卡尚未补齐（待补：scope、acceptance、verify.cmd）。请先补齐后重新调用 flow_submit_requirement，再来领取派发名额。
```
```
✗ 19a. 只补 scope 不足以解除闸门  pending=scope,acceptance,verify.cmd
```
```
✗ 19d. 三项补齐后闸门解除  pending=scope,acceptance,verify.cmd
```
```
✗ 22. 审计链含 activation / activation_released / activation_gate_held  kinds=activation_gate_activated,record,accepted,activation,activation_gate_held,verdict_denied
```

## M10-普通卡也上闸

- 注入：普通卡（无 activation 且此前未被锁）也被上闸 —— 会误伤 T1 只读调研
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 53 通过 / 1 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 19f. 普通卡不上激活闸门（不误伤只读调研）  pending=scope,acceptance,verify.cmd
```

## M11-占位卡硬编码三项

- 注入：占位卡待补项退回硬编码三项（服务端派生失效）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 53 通过 / 1 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 19e. 占位卡待补项由服务端从卡片内容派生（非硬编码三项）  pending=scope,acceptance,verify.cmd
```

## M12-跨进程锁失效

- 注入：把锁文件改成非排他创建（'wx' → 'a'），跨进程排他性失效 → 读-改-写重新变成非原子
- 文件：`src/state.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 54 通过 / 0 失败；trigger 25 通过 / 0 失败；concurrency 2 通过 / 1 失败

## M13-只读意图误判

- 注入：把只读意图判定改为「命中只读词就算只读」（含改动动词时误判 → 会永久锁死）
- 文件：`src/trigger.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 54 通过 / 0 失败；trigger 24 通过 / 1 失败；concurrency 3 通过 / 0 失败

## M7-空scope fail-open

- 注入：enforceScope 在空 scope 时直接返回 ok:true（任意路径都算未越界）
- 文件：`src/dispatch.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 53 通过 / 1 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 21. 空 scope 对任意改动都判越界（fail-closed）  ok=true violations=[]
```

## M8-未派发可记PASS

- 注入：移除 flow_verdict 的 dispatch_count 检查（未派发也能记 PASS）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 53 通过 / 1 失败；trigger 25 通过 / 0 失败；concurrency 3 通过 / 0 失败

失败用例：
```
✗ 20a. 未派发直接 PASS 被拒  已拒绝
```

| 变异 | 结果 | 详情 |
|---|---|---|
| M1-激活只打印日志 | CAUGHT ✅ | e2e 52/2 失败, trigger 0 失败, concurrency 0 失败 |
| M2-claim闸门失效 | CAUGHT ✅ | e2e 50/4 失败, trigger 0 失败, concurrency 0 失败 |
| M3-verdict闸门失效 | CAUGHT ✅ | e2e 53/1 失败, trigger 0 失败, concurrency 0 失败 |
| M4-会话撞名 | CAUGHT ✅ | e2e 54/0 失败, trigger 1 失败, concurrency 0 失败 |
| M5-scope不算补齐项 | CAUGHT ✅ | e2e 51/3 失败, trigger 0 失败, concurrency 0 失败 |
| M6-半补齐绕过闸门 | CAUGHT ✅ | e2e 49/5 失败, trigger 0 失败, concurrency 1 失败 |
| M9-闸门派生回退 | CAUGHT ✅ | e2e 49/5 失败, trigger 0 失败, concurrency 0 失败 |
| M10-普通卡也上闸 | CAUGHT ✅ | e2e 53/1 失败, trigger 0 失败, concurrency 0 失败 |
| M11-占位卡硬编码三项 | CAUGHT ✅ | e2e 53/1 失败, trigger 0 失败, concurrency 0 失败 |
| M12-跨进程锁失效 | CAUGHT ✅ | e2e 54/0 失败, trigger 0 失败, concurrency 1 失败 |
| M13-只读意图误判 | CAUGHT ✅ | e2e 54/0 失败, trigger 1 失败, concurrency 0 失败 |
| M7-空scope fail-open | CAUGHT ✅ | e2e 53/1 失败, trigger 0 失败, concurrency 0 失败 |
| M8-未派发可记PASS | CAUGHT ✅ | e2e 53/1 失败, trigger 0 失败, concurrency 0 失败 |
