# Carlos Flow v2.16.3 发布说明

## 发布状态

2026-11-18：**本提交为2.16.3发布候选；是否正式发布以对应Release和npm registry最终结果为准**。v2.16.2 的 Release 运行 **44350798299** 失败，未发布；旧 **v2.16.2 tag 保留**，不移动或删除。

## 审计锁修复与证据边界

- 已证明并修复旧释放序列中「删除 owner → 删除共享锁目录」的空目录替换竞态：真实 peer 可在空目录窗口替换共享路径，旧释放者随后 `rmdir` 返回 `ENOTEMPTY`；审计追加已落盘，但回执 `persisted` 为 false。证据不支持断言旧释放者已真实误删非空新锁。**这项竞态已证实，不代表已找到 Release 失败的唯一原始首因；唯一原始首因仍未知。**
- owner 增加唯一 token，以完整 owner 内容核对身份；释放时先将**整个目录** rename 到唯一私有 retired 路径，再清理私有目录，不在共享路径上先删 owner。
- 共享冲突只在确认 owner 仍属于自己时有界重试；目录已移走、移动结果不确定或 owner 改变后，不盲目重试共享路径。死 owner 回收重新核对身份后整目录移走，私有路径采用随机唯一标识。
- 使用 AggregateError 保留业务执行、retire、回收及 candidate 清理的错误，避免清理失败覆盖原始失败。若追加可能已完成，错误明确提示勿盲重试，不能把报错简单解释为「没有写入」。
- 回归包含真实 peer 进程的替换窗口、互斥和清理验证，以及故障注入下的错误聚合与身份变化断言；不是仅靠 mock 或运行未崩溃判断成功。

## 冻结候选的既有验证结果

以下完整变异验证及 280 秒完整回归针对版本元数据更新前、与本候选功能代码相同的冻结版本。完整变异验证不是历史约 85 分钟结果的复用，也不代表版本元数据更新后重跑了完整变异测试。版本更新后的门禁结果另列如下，二者适用范围不混同。

### 完整变异验证

耗时 **5629.692 秒（约 93.83 分钟）**，真实退出码 0：**11/11 baseline、26/26 DETECTED**；286 次 mutant suite 加 11 次 baseline，共 **297 次 suite**；invalid suite 0、INVALID 0、SURVIVED 0，26 项均有语义检出证据。

M17（date 参数失效）的 roll 日志在预期日期读取失败后还出现 `TypeError`（读取 undefined.hash），该附带异常不隐瞒；独立 audit 日志已有 `date=2020-01-01` 应读到 0 条、实际读到 3 条的日期语义断言失败，因此**并非依靠 TypeError 计为检出**。

### 独立完整回归

最终完整 `&&` 链 **280 秒、11 条顶层命令全部退出 0**：test:all、test:package、check:full、check:claims、check:params、check:no-dead-handler、check:portability、check:anchors、check:readme、check:lang、test:lang。

- test:all 的 **23 个子 suite** 均实际完成；冻结 audit 测试为 31 通过/0 失败。
- 真实包级 `npm pack → 临时安装 → MCP 握手及门禁正负例` 为 **22 通过/0 失败**，不是 `--local` 路径。
- 首轮曾因隔离环境路径使用正斜杠导致 trigger 路径字符串比较假阴性，首轮不能称为全绿。原记录保留；只把隔离环境改为 Windows 原生路径、未改源码，随后重跑完整链通过。
- 独立回归的语言检查针对临时中文提交，不替代原仓库语言检查。

### 版本更新后的门禁

版本元数据更新至 2.16.3 后，Carlos 完整 fixed 验证退出码为 **0**；版本负对照退出码为 **1**，还原后验证退出码为 **0**，还原核验覆盖 **8 个文件**。这证明版本更新后的相应门禁通过，不将其等同于元数据更新后重跑上述 297 次 suite 的完整变异验证。

## 版本一致性与安全边界

package.json 为版本真源，经既有 scripts/sync-version.mjs 同步至 package-lock.json、ghost.json 与 TRIGGER_GUIDE.md；插件清单除 version 外不变，触发指南仅同步版本，不混入向导功能。

功能冻结版本的原始字节 SHA-256：

- src/state.js：`2ddcbe05132a7ac6a63b01b9f36964a4fd570a1eb04a993f1746e3bb92c6501d`
- test/audit-chain.mjs：`2b85c9252f0333f4e1f7a8d55cfa49b763e14a0b0ddb10c8723e35f8e8bdbad6`

不能仅凭 tag 或工作流启动就宣布发布成功；正式发布状态以对应 Release 和 npm registry 的最终结果为准。

既有安全边界不变：不承诺硬件级 exactly-once，plain 链不抵抗恶意重算；既有维护漂移、长方法、冗余 catch、有限 parser 与宿主工具覆盖边界的 WARN 不因功能测试通过而消失。
