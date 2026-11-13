#!/bin/bash
echo "=== Gatekeeper: 语法校验 ==="
node --check bridge/mcp-bridge.js && echo "✅ bridge/mcp-bridge.js 语法通过"
node --check src/index.js && echo "✅ src/index.js 语法通过"

echo ""
echo "=== Gatekeeper: 启动性能冒烟测试 ==="
node smoke-test.js
RESULT=$?
if [ $RESULT -eq 0 ]; then
  echo "✅ Bridge 启动正常，冒烟测试通过"
else
  echo "❌ 冒烟测试失败，请检查 mcp-bridge.js 的启动逻辑"
  exit 1
fi

echo ""
echo "=== Gatekeeper: 全部校验完成 ==="
