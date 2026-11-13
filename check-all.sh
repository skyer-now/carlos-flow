#!/bin/bash
# Gatekeeper：提交前强制校验（语法 + 真 RPC 往返冒烟测试）
# 用法：./check-all.sh
set -u

cd "$(dirname "$0")" || exit 1

# 冒烟测试需要一个 Token；未设置时用临时值，避免因本地缺环境变量而误报失败。
export CARLOS_BRIDGE_TOKEN="${CARLOS_BRIDGE_TOKEN:-gatekeeper-local-token}"
export BRIDGE_PORT="${BRIDGE_PORT:-19099}"

echo "=== Gatekeeper: 语法校验 ==="
node --check bridge/mcp-bridge.js && echo "✅ bridge/mcp-bridge.js 语法通过"
node --check src/index.js && echo "✅ src/index.js 语法通过"
node --check smoke-test.js && echo "✅ smoke-test.js 语法通过"

echo ""
echo "=== Gatekeeper: 真 RPC 往返冒烟测试 ==="
node smoke-test.js
RESULT=$?
if [ $RESULT -eq 0 ]; then
  echo "✅ Bridge 启动正常，深度兼容性验证通过"
else
  echo "❌ 冒烟测试失败，请检查 mcp-bridge.js 的启动/转发逻辑"
  exit 1
fi

echo ""
echo "=== Gatekeeper: 全部校验完成 ==="
