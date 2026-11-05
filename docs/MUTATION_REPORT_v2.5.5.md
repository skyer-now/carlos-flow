
## 总览
# 变异测试报告

- 源仓库：`carlos-flow-cindy` / `carlos-flow-opencode`（工作副本路径已改写为占位符）
- 变异副本：临时目录（用完自动删除，不入库）
- 目的：确认测试套件能抓住「激活只打印日志」「闸门失效」「会话撞名」等退化

## 基线（未变异）

- e2e：30 通过 / 0 失败
- trigger：20 通过 / 0 失败

## M1-激活只打印日志

- 注入：把 checkTrigger 里的 callMCP 换成假返回（激活只剩日志）
- 文件：`client/carlos.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 28 通过 / 2 失败；trigger 20 通过 / 0 失败

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
- 详情：e2e 27 通过 / 3 失败；trigger 20 通过 / 0 失败

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

## M3-verdict闸门失效

- 注入：移除 flow_verdict 的 activation_pending 闸门（假闭环）
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 28 通过 / 2 失败；trigger 20 通过 / 0 失败

失败用例：
```
✗ 15e. 占位卡未补齐时 verdict 被拒（防假闭环）  未被拒绝（异常）
```
```
✗ 15f. 占位卡状态未标记为完成  completed_ok=true
```

## M4-会话撞名

- 注入：去掉 sanitizeSessionId 的哈希后缀（清洗后同形的 id 会撞名）
- 文件：`src/trigger.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 30 通过 / 0 失败；trigger 19 通过 / 1 失败

## M5-空scope绕过闸门

- 注入：移除「空 scope 提交不能解除激活闸门」的防护
- 文件：`src/index.js`
- 结果：**CAUGHT ✅**
- 详情：e2e 28 通过 / 2 失败；trigger 20 通过 / 0 失败

失败用例：
```
✗ 16d. 空 scope 提交无法解除激活闸门  pending=
```
```
✗ 16e. 绕过尝试后 claim 仍被拒  未被拒绝（异常）
```

| 变异 | 结果 | 详情 |
|---|---|---|
| M1-激活只打印日志 | CAUGHT ✅ | e2e 28/2 失败, trigger 0 失败 |
| M2-claim闸门失效 | CAUGHT ✅ | e2e 27/3 失败, trigger 0 失败 |
| M3-verdict闸门失效 | CAUGHT ✅ | e2e 28/2 失败, trigger 0 失败 |
| M4-会话撞名 | CAUGHT ✅ | e2e 30/0 失败, trigger 1 失败 |
| M5-空scope绕过闸门 | CAUGHT ✅ | e2e 28/2 失败, trigger 0 失败 |
