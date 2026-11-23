# macOS 可移植性说明

## 结论

代码本身**已经按跨平台写**（不是 Windows 专属实现），移植到 macOS 主要是**验证与少量适配**，不是重写：

- 验证命令按平台选 shell：Windows 用 `cmd.exe /c`，POSIX 用 `/bin/sh -c`（`src/dispatch.js`）。
- 超时回收整棵进程树：Windows 用 `taskkill /T /F`，POSIX 用 `detached` 进程组 + `kill(-pid)`（`src/dispatch.js`）。
- 路径比较用平台感知的 `pathKey`：Windows 折叠大小写，其它平台保留大小写（`src/card.js`）。
- 项目身份、锁、快照、审计链都基于 Node 标准 API，没有盘符或注册表依赖；`src/` 内没有硬编码 `C:\`。
- Claude Desktop 配置目录已区分 `~/Library/Application Support`（`client/carlos.js`）。
- `scripts/check-portability.mjs` 已经在 CI 里守住「URL.pathname 取路径」「只杀外壳不杀进程树」两类跨平台坑。
- CI 的 `test` job 已加入 `macos-latest` 矩阵。

## macOS 上仍需注意的差异

1. **临时目录 realpath**：`os.tmpdir()` 在 macOS 是 `/var/folders/...`，真实路径是 `/private/var/...`。凡是把 tmpdir 路径与「实现里存的 realpath」直接比较的地方都必须先 `fs.realpathSync`（worktree 测试已按此修正）。
2. **大小写不敏感卷（APFS 默认）**：`pathKey` 在 darwin 上保留大小写，因此 `src/A.js` 与 `src/a.js` 会被当成不同路径。方向是 fail-closed（可能多报越界，不会少报），但授权书写与落盘书写不一致时可能误拦。若需要更精确，应检测卷的大小写敏感性，而不是按平台判断。
3. **目录 fsync**：macOS 上对目录 `fsync` 可能返回 `EINVAL`/`EBADF`；实现里是 best-effort（失败不改变已成功的 rename），极端掉电语义弱于 Windows 的 `FlushFileBuffers`。需要更强保证时要用 `F_FULLFSYNC`。
4. **文件可执行位**：Windows 提交时 `core.fileMode` 不跟踪 exec bit。本仓库已用 `git update-index --chmod=+x` 标记 CLI 与脚本；npm 安装时也会给 `bin` 设置可执行位。直接 clone 后如遇 `Permission denied`，执行 `chmod +x client/carlos.js scripts/*.mjs`。
5. **Node 版本**：要求 Node >= 22（`engines`）。Cindy 自带运行时的话以宿主为准；自行安装时建议 Homebrew `node@22`。
6. **Cindy 插件形态**：`main.js` 跑在宿主沙箱里，只用 `cindy` API，本身与平台无关；插件安装目录由宿主决定（macOS 在 `~/Library/Application Support/...`），不要写死路径。
7. **进程组回收**：POSIX 依赖 `detached: true` 启动，若宿主以特殊方式包裹子进程，`kill(-pid)` 可能拿不到组长，会退回 `child.kill()`；这种情况下整树回收能力下降，需要在 macOS 上实测一次。

## 建议的 macOS 验收清单

在本机（Apple Silicon 与 Intel 各一台更好）执行：

```
node --version            # >= 22
npm ci
npm run test:all
npm run check:params && npm run check:no-dead-handler && npm run check:readme
npm run check:identity && npm run check:ast && npm run check:full
node smoke-test.js        # 真 RPC：默认 4 门面
CARLOS_FLOW_TOOL_SURFACE=legacy node smoke-test.js   # 26 个底层操作
node test/worktree-isolation.test.mjs
node test/check-ast-assertions.test.mjs
```

再加一次真实任务闭环：留痕 → 领取 → 派发 → 验证 → 负对照 → 双轴 → 裁定，重点观察：
- 验证命令确实在 `/bin/sh` 下执行、失败退出码被正确识别；
- 超时后 `node` 子进程没有残留（`ps -ef | grep carlos`）；
- 状态锁在 APFS 上并发写不丢更新（`test:concurrency`）；
- 任务工作区路径与 `git worktree list` 一致，清理后 `.git/worktrees` 无残留。

## 当前状态

Windows 上已完成全量验证（`test:all`、`check:*`、`check:full` 全 0，版本 3.0.0）。**macOS 尚未实机运行**：CI 已加 `macos-latest`，但还没有一次真实 macOS 结果；上表需要在 Mac 上跑过才算验证，不能仅凭代码推断宣称「已支持」。