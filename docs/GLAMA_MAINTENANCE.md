# Glama 维护者识别核对

核对日期：2026-11-26。本次只修正仓库元数据，不把本地修改视为 Glama 已同步成功。

## 已确认的事实

- 官方 schema 为 <https://glama.ai/mcp/schemas/server.json>。
- 原配置引用的 `https://glama.ai/mcp/glama.schema.json` 返回 HTTP 404，现已修正。
- 官方 schema 要求 `maintainers` 是不重复的 GitHub 用户名数组；本仓库保留唯一真实维护者 `skyer-now`，不添加虚构人员。
- 官方 schema 未禁止额外字段，因此保留原配置中的名称、描述、仓库等信息。
- 核对时 Glama 页面数据返回 `maintainerCount: 0`。这不证明 `maintainers` 用户名错误，也不能证明修改 schema 链接就能修复这个计数；该指标与认领名单之间的具体计算关系尚未核实。

## 发布修改后如何确认

1. 先确认 GitHub 默认分支的 `glama.json` 已包含修正，不能只检查本地文件。
2. 按 [Glama 官方说明](https://glama.ai/blog/2025-07-08-what-is-glamajson)，更新文件后再次经过服务器页面的 Claim ownership 流程，触发读取最新配置。
3. 服务器页面：<https://glama.ai/mcp/servers/skyer-now/carlos-flow>。核对实际登录的 GitHub 身份、认领状态及同步后的维护者显示；若要求新授权，先核对权限，不扩大现有授权范围。
4. 若认领已成功但计数仍为 0，保留页面显示与配置证据，向 Glama 核实计数口径，不伪造维护者或反复调用未经证实的同步接口。

本配置变更不包含额外账号授权、发布工作流修改或未经验证的 Glama sync API 调用。维护者识别、维护活跃度标签和 A/B 评级是不同问题，不能把其中一项变化当作升 A 的保证。只有完成推送、重新认领并核对服务端显示后，才能报告同步结果。

## 本地检查

```sh
node --test test/community-docs.test.mjs
```

该检查覆盖元数据和文档约束；不代替 Glama 服务端同步确认或 GitHub 在线设置验证。
