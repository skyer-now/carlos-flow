// 推 tag 前置钩子安装器
//
// 为什么需要：
//   1. 2026-11-13 的 v2.11.1 —— 一个**没跑过任何验证**的提交被打上 tag 并推上远端，
//      里面包含一个语法错误的冒烟测试和一个只有 23 行的残缺 bridge。
//   2. 推 `v*` tag **等于**触发 npm 自动发布 —— 推错 tag 的代价远大于推错分支。
//
// 装上之后，`git push` 只要涉及 tag，就会自动跑：
//   - `./check-all.sh`（语法校验 + 真 RPC 往返冒烟测试）
//   - `npm run sync:version` 的等价校验（版本号在 4 处是否一致）
//   - tag 重名检查
// 任何一项不过，**推送被阻断**，远端不会出现带缺陷的 tag。
//
// 用法：
//   node scripts/install-hooks.mjs          # 安装
//   node scripts/install-hooks.mjs --check  # 只检查装没装 / 是否最新

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(ROOT, ".git", "hooks");
const HOOK_PATH = join(HOOKS_DIR, "pre-push");

// 钩子正文。用 bash 写（Git for Windows 自带 bash）。
// 关键：只对 **tag** 推送生效，普通分支推送不受影响。
const HOOK = `#!/bin/bash
# ============================================================
# Carlos Flow —— 推 tag 前置门禁（由 scripts/install-hooks.mjs 生成）
#
# 背景：推 v* tag 会触发 GitHub Actions 自动 npm publish。
#       没有这道门禁时，v2.11.1 那样「没跑过验证」的提交会被打 tag 推上远端。
#
# 规则：只对 **tag 推送** 生效；分支推送直接放行。
# ============================================================

set -u

# 钩子位于 .git/hooks/ —— 仓库根是它的 ../..（不是 ..，那是 .git 目录本身）
REPO_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO_ROOT/package.json" ] || REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$REPO_ROOT" || exit 1
[ -f "$REPO_ROOT/package.json" ] || { echo "❌ 找不到仓库根目录（package.json）"; exit 1; }

# 从 stdin 读待推送的 ref：<local ref> <local sha> <remote ref> <remote sha>
PUSHING_TAG=0
TAG_NAME=""
while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  if echo "$REMOTE_REF" | grep -q '^refs/tags/'; then
    PUSHING_TAG=1
    TAG_NAME="\${REMOTE_REF#refs/tags/}"
  fi
done

if [ "$PUSHING_TAG" -eq 0 ]; then
  exit 0
fi

echo "=============================================="
echo "🚧 推 tag 前置门禁：$TAG_NAME"
echo "=============================================="

# --- 1. 版本号单一真源校验（只读） ---
# 版本号散落 5 处（package.json / package-lock.json / ghost.json / TRIGGER_GUIDE.md / CHANGELOG.md），
# 漏改任一处 release 的「单包一致性检查」就会红、发布中止。
# --check 只读不写：有偏差则退出 1。
if ! node scripts/sync-version.mjs --check >/dev/null 2>&1; then
  echo "❌ 版本号未对齐（package.json / package-lock.json / ghost.json / TRIGGER_GUIDE.md / CHANGELOG.md）"
  echo "   请先运行：npm run sync:version，然后提交改动"
  exit 1
fi
# 版本已对齐但还没提交 —— tag 指向的提交里版本与工作区不一致，同样要拦。
if ! git diff --quiet -- package-lock.json ghost.json TRIGGER_GUIDE.md CHANGELOG.md; then
  echo "❌ 版本相关文件有未提交改动"
  echo "   请先提交这些改动再推 tag（tag 指向的提交必须与工作区一致）"
  exit 1
fi
echo "✅ 版本号一致性"

# --- 2. 语法校验 + 真 RPC 往返冒烟测试 ---
if ! bash ./check-all.sh; then
  echo "❌ Gatekeeper 未通过，拒绝推送 tag"
  echo "   修好后再推；这条 gate 存在的意义就是别再推坏版本。"
  exit 1
fi

# --- 3. tag 重名检查（查**远端**，不是本地） ---
# 正常流程就是「本地先 git tag 再 push」，本地存在是必然的；
# 真正要拦的是**远端已有同名 tag**（再推要么是空操作，要么需要 force）。
if git ls-remote --exit-code --tags origin "refs/tags/$TAG_NAME" >/dev/null 2>&1; then
  echo "❌ 远端已存在 tag $TAG_NAME"
  echo "   若确需覆盖：git push --force origin $TAG_NAME"
  exit 1
fi
echo "✅ tag 名在远端可用"

echo ""
echo "=============================================="
echo "✅ 全部前置门禁通过，可以推 tag：$TAG_NAME"
echo "   ⚠️  提醒：推 v* tag 会触发 npm 自动发布"
echo "=============================================="
exit 0
`;

function main() {
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    if (!existsSync(HOOK_PATH)) {
      console.log("❌ 未安装推 tag 前置钩子");
      process.exit(1);
    }
    const cur = readFileSync(HOOK_PATH, "utf8");
    const ok = cur === HOOK;
    console.log(ok ? "✅ 钩子已安装且为最新" : "⚠️ 钩子已安装但内容不是最新，重新安装即可");
    process.exit(ok ? 0 : 1);
  }

  if (!existsSync(join(ROOT, ".git"))) {
    console.error("❌ 当前目录不是 git 仓库");
    process.exit(1);
  }

  mkdirSync(HOOKS_DIR, { recursive: true });

  // 备份既有钩子（不覆盖别人的东西）
  if (existsSync(HOOK_PATH)) {
    const bak = HOOK_PATH + ".bak-" + Date.now();
    copyFileSync(HOOK_PATH, bak);
    console.log("ℹ️  已备份原钩子：" + bak);
  }

  writeFileSync(HOOK_PATH, HOOK, "utf8");
  console.log("✅ 已安装推 tag 前置钩子：" + HOOK_PATH);

  // Windows 上 git 可能在提交时丢掉可执行位，这里直接修回 100755
  try {
    execFileSync("git", ["update-index", "--chmod=+x", ".git/hooks/pre-push"], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    // .git/hooks 不在 index 里，这条会失败，属预期，忽略
  }

  console.log("");
  console.log("生效范围：只拦截 **tag 推送**；普通分支推送不受影响。");
  console.log("自检：node scripts/install-hooks.mjs --check");
}

main();
