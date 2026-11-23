# 平台支持与通用安全说明

## 结论

当前**仅声明 Windows 支持**。CI（test、identity、bridge、mutation）及 release 均使用 `windows-latest`，矩阵仅保留 Windows，不使用 `continue-on-error` 掩盖失败。**macOS / Linux 验证暂停，不声明支持**。

以下通用路径与进程安全代码仍保留，避免因收窄验证范围而删除安全分支；代码存在或静态门禁通过不等于其它操作系统已经验证：

- 验证命令按平台选 shell：Windows 用 `cmd.exe /c`，POSIX 用 `/bin/sh -c`（`src/dispatch.js`）。
- 超时回收整棵进程树：Windows 用 `taskkill /T /F`，POSIX 用 `detached` 进程组 + `kill(-pid)`（`src/dispatch.js`）。
- 路径比较用平台感知的 `pathKey`：Windows 折叠大小写，其它平台保留大小写（`src/card.js`）。
- 项目身份、锁、快照、审计链都基于 Node 标准 API，没有盘符或注册表依赖；`src/` 内没有硬编码 `C:\`。
- Claude Desktop 配置目录已区分 `~/Library/Application Support`（`client/carlos.js`）。
- `scripts/check-portability.mjs` 仍在 Windows CI 中检查路径与进程树安全写法，不代表执行了 macOS / Linux 验证。

## macOS 差异记录（验证暂停，非支持承诺）

1. **临时目录 realpath**：`os.tmpdir()` 在 macOS 是 `/var/folders/...`，真实路径是 `/private/var/...`。凡是把 tmpdir 路径与「实现里存的 realpath」直接比较的地方都必须先 `fs.realpathSync`（worktree 测试已按此修正）。
2. **大小写不敏感卷（APFS 默认）**：`pathKey` 在 darwin 上保留大小写，因此 `src/A.js` 与 `src/a.js` 会被当成不同路径。方向是 fail-closed（可能多报越界，不会少报），但授权书写与落盘书写不一致时可能误拦。若需要更精确，应检测卷的大小写敏感性，而不是按平台判断。
3. **目录 fsync**：macOS/Darwin 的 `fsync(dir)` 常返回 `EINVAL`。原实现会把这种“平台不提供该能力”当成持久化失败，导致每次状态保存都报“提交未确认”。现已把 `EINVAL`/`ENOTSUP`/`ENOSYS` 视为不支持并继续（rename 已成功），其它错误仍上抛；对应回归用例 `test/verify-cas.mjs` 的 P9 只在 POSIX 上执行。极端掉电的目录项耐久仍弱于 Linux，需要更强保证时要用 `F_FULLFSYNC`。
4. **文件可执行位**：Windows 提交时 `core.fileMode` 不跟踪 exec bit。本仓库已用 `git update-index --chmod=+x` 标记 CLI 与脚本；npm 安装时也会给 `bin` 设置可执行位。直接 clone 后如遇 `Permission denied`，执行 `chmod +x client/carlos.js scripts/*.mjs`。
5. **Node 版本**：要求 Node >= 22（`engines`）。Cindy 自带运行时的话以宿主为准；自行安装时建议 Homebrew `node@22`。
6. **Cindy 插件形态**：`main.js` 跑在宿主沙箱里，只用 `cindy` API，本身与平台无关；插件安装目录由宿主决定（macOS 在 `~/Library/Application Support/...`），不要写死路径。
7. **进程组回收**：POSIX 依赖 `detached: true` 启动，若宿主以特殊方式包裹子进程，`kill(-pid)` 可能拿不到组长，会退回 `child.kill()`；这种情况下整树回收能力下降，需要在 macOS 上实测一次。

## 将来恢复 macOS 验证时的参考清单（当前不执行）

只有另行授权恢复验证后，才在本机（Apple Silicon 与 Intel 各一台更好）执行：

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

当前支持与 CI 验证范围仅为 Windows。macOS / Linux 验证暂停，下面的差异记录和参考清单不构成支持声明。本次只调整工作流与文档，不新增全量测试、实机安装或公开发布证据；历史验证结果不能冒充本次运行结果。