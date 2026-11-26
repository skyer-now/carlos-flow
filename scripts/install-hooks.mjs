// 提交与推 tag 前置钩子安装器
//
// 为什么需要：
//   1. 每次 `git commit` 前自动执行单包一致性守卫（check-repo-parity / check:full / lang-audit），
//      确保首页特性、中英介绍、版本号、产物规范 100% 对齐，未对齐直接阻断提交。
//   2. 2026-11-13 的 v2.11.1 —— 一个**没跑过任何验证**的提交被打上 tag 并推上远端，
//      里面包含一个语法错误的冒烟测试和一个只有 23 行的残缺 bridge。
//   3. 推 `v*` tag **等于**触发 npm 自动发布 —— 推错 tag 的代价远大于推错分支。
//
// 装上之后：
//   - `git commit` 时自动执行 pre-commit：校验版本号、首页文档与产物体检，不合格直接阻断提交。
//   - `git push` 只要涉及 tag，就会自动跑 pre-push：Gatekeeper 冒烟测试、版本号单一真源校验、tag 重名检查。
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
const PRE_PUSH_PATH = join(HOOKS_DIR, "pre-push");
const PRE_COMMIT_PATH = join(HOOKS_DIR, "pre-commit");

// pre-commit 钩子正文：每次 git commit 时执行
const PRE_COMMIT_HOOK = `#!/bin/bash
# ============================================================
# Carlos Flow —— 提交前前置门禁（由 scripts/install-hooks.mjs 生成）
#
# 规则：每次本地 git commit 前自动执行，检查版本号与首页介绍一致性、
#       产物全面体检与语言体检，不合规直接阻断提交。
# ============================================================

set -u

REPO_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO_ROOT/package.json" ] || REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$REPO_ROOT" || exit 1
[ -f "$REPO_ROOT/package.json" ] || { echo "❌ 找不到仓库根目录（package.json）"; exit 1; }

echo "=============================================="
echo "🚧 提交前自动检查（pre-commit hook 自动执行）"
echo "=============================================="

# 1. 检查版本号单一真源（只读检查）
if ! node scripts/sync-version.mjs --check >/dev/null 2>&1; then
  echo "❌ pre-commit 失败：版本号未对齐（package.json / lock / ghost.json / TRIGGER_GUIDE.md / CHANGELOG.md）"
  echo "   请运行：npm run sync:version"
  exit 1
fi

# 2. 单包一致性与首页特性介绍检查
if ! node scripts/check-repo-parity.mjs >/dev/null 2>&1; then
  echo "❌ pre-commit 失败：单包一致性或首页中英文特性标题未对齐"
  echo "   请运行：node scripts/check-repo-parity.mjs 查看具体不一致项"
  exit 1
fi

# 3. 产物全面体检
if ! node scripts/full-audit.mjs >/dev/null 2>&1; then
  echo "❌ pre-commit 失败：对外产物体检未通过"
  echo "   请运行：npm run check:full"
  exit 1
fi

# 4. 产物语言体检（必须 100% 中文）
if ! node scripts/lang-audit.mjs >/dev/null 2>&1; then
  echo "❌ pre-commit 失败：产物注释或提交信息含英文叙述"
  echo "   请运行：npm run check:lang"
  exit 1
fi

echo "✅ 提交前自动检查全部通过（pre-commit hook 放行）"
echo "=============================================="
exit 0
`;

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
# 真正要拦的是**远端已有同名 tag**。
#
# 但远端已有 tag 不等于一律不能推 —— 有一种合法场景：
#   「上次发布在门禁阶段失败 → tag 已推上去但 npm 没收到 → 修好后重推同一个 tag」。
# 区分标准：**该版本是否已经发布到 npm**。
#   · 已发布  → 移动 tag 会让 npm 版本与 git tag 对不上 → 拦
#   · 未发布  → 是失败恢复路径 → 放行（并明确告知）
if git ls-remote --exit-code --tags origin "refs/tags/$TAG_NAME" >/dev/null 2>&1; then
  VERSION="\${TAG_NAME#v}"
  PUBLISHED="$(npm view carlos-flow versions --json --prefer-online 2>/dev/null || echo '')"
  if echo "$PUBLISHED" | grep -q "\"$VERSION\""; then
    echo "❌ tag $TAG_NAME 对应的版本 $VERSION 已发布到 npm，不能移动"
    echo "   移动 tag 会让 npm 版本与 git tag 对不上（用户装到的代码与仓库不符）"
    echo "   若确需继续，请先发新版本号"
    exit 1
  fi
  echo "⚠️  远端已存在 tag $TAG_NAME，但该版本**未发布到 npm**"
  echo "   （这是「上次发布在门禁阶段失败 → 修好后重推」的标准恢复路径，允许覆盖）"
fi
echo "✅ tag 名可用"

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
    let ok = true;
    if (!existsSync(PRE_PUSH_PATH) || readFileSync(PRE_PUSH_PATH, "utf8") !== HOOK) {
      console.log("❌ 未安装推 tag 前置钩子 (pre-push) 或内容不是最新");
      ok = false;
    } else {
      console.log("✅ 推 tag 前置钩子 (pre-push) 已安装且为最新");
    }

    if (!existsSync(PRE_COMMIT_PATH) || readFileSync(PRE_COMMIT_PATH, "utf8") !== PRE_COMMIT_HOOK) {
      console.log("❌ 未安装提交前前置钩子 (pre-commit) 或内容不是最新");
      ok = false;
    } else {
      console.log("✅ 提交前前置钩子 (pre-commit) 已安装且为最新");
    }

    process.exit(ok ? 0 : 1);
  }

  if (!existsSync(join(ROOT, ".git"))) {
    console.error("❌ 当前目录不是 git 仓库");
    process.exit(1);
  }

  mkdirSync(HOOKS_DIR, { recursive: true });

  // 备份既有钩子（不覆盖别人的东西）
  if (existsSync(PRE_PUSH_PATH)) {
    const bak = PRE_PUSH_PATH + ".bak-" + Date.now();
    copyFileSync(PRE_PUSH_PATH, bak);
    console.log("ℹ️  已备份原 pre-push 钩子：" + bak);
  }
  writeFileSync(PRE_PUSH_PATH, HOOK, "utf8");
  console.log("✅ 已安装推 tag 前置钩子：" + PRE_PUSH_PATH);

  if (existsSync(PRE_COMMIT_PATH)) {
    const bak = PRE_COMMIT_PATH + ".bak-" + Date.now();
    copyFileSync(PRE_COMMIT_PATH, bak);
    console.log("ℹ️  已备份原 pre-commit 钩子：" + bak);
  }
  writeFileSync(PRE_COMMIT_PATH, PRE_COMMIT_HOOK, "utf8");
  console.log("✅ 已安装提交前自动检查钩子：" + PRE_COMMIT_PATH);

  console.log("");
  console.log("生效范围：");
  console.log("  1. git commit 时自动执行 pre-commit（版本号与首页介绍一致性、产物体检、语言体检）");
  console.log("  2. git push tag 时自动执行 pre-push（Gatekeeper 冒烟、tag 重名校验）");
  console.log("自检：node scripts/install-hooks.mjs --check");
}

main();
