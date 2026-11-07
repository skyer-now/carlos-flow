#!/usr/bin/env bash
# 端到端实测：激活 → 闸门 → 放行 → 不触发 → 审计链
# 用法: bash scripts/verify-activation-e2e.sh [repo-root]
#
# 根目录默认从**脚本自身位置**推导（scripts/ → 仓库根），
# 不写死任何开发者的本机路径 —— 旧实现写死 `D:/cindy/publish-output/carlos-flow-cindy`，
# 在别人机器上会 cd 到不存在的路径；且在 opencode 包里还指向 cindy 仓（跨仓串味）。
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$ROOT" || { echo "✗ 无法进入仓库根目录: $ROOT"; exit 1; }

export CARLOS_FLOW_HOME="$(mktemp -d)"
export CARLOS_FLOW_MCP_ROOT="$ROOT"
export BRIDGE_PORT="${BRIDGE_PORT:-19655}"

C="node client/carlos.js"

echo "══ ① 激活（真实客户端进程）══"
$C flow_status '{"sessionId":"final-1","triggerMessage":"run dispatch workflow"}' 2>&1 | grep -E "判定触发|已执行激活步骤"

echo ""
echo "══ ② 服务端状态真的变了 ══"
$C flow_status '{"sessionId":"final-1"}' 2>/dev/null | grep -E '"has_card"|"tier"|"activation_pending"' -A3 | head -8

echo ""
echo "══ ③ 闸门真实拦截（claim）══"
$C flow_claim '{"sessionId":"final-1","role":"executor"}' 2>&1 | tail -1

echo ""
echo "══ ④ 闸门真实拦截（verdict / 未派发就记 PASS）══"
$C flow_verdict '{"sessionId":"final-1","verdict":"PASS"}' 2>&1 | tail -1

echo ""
echo "══ ⑤ 三项补齐 → 闸门解除 → 真实放行 ══"
$C flow_submit_requirement '{"sessionId":"final-1","goal":"给 README 补说明","quote":"run dispatch workflow","scope":["README.md"],"acceptance":["含新增段落"],"verify":{"cmd":"node -e \"process.exit(0)\""},"confirmed":true}' 2>/dev/null | grep -E '"ok":|"tier"' | head -2
$C flow_claim '{"sessionId":"final-1","role":"executor"}' 2>/dev/null | grep -E '"ok":|"objective"' | head -2

echo ""
echo "══ ⑥ 不传 triggerMessage → 完全不触发（防自伤）══"
$C flow_status '{"sessionId":"final-2","message":"run the dispatch workflow"}' 2>&1 | grep -cE "已执行激活步骤" | sed 's/^/  激活步骤出现次数: /'
$C flow_status '{"sessionId":"final-2"}' 2>/dev/null | grep -E '"has_card"' | head -1

echo ""
echo "══ ⑦ 审计链可追溯 ══"
$C flow_audit '{"sessionId":"final-1","limit":50}' 2>/dev/null | grep -E '"activation|"activation_gate_held|"activation_released|"verdict_denied' | head -6

echo ""
echo "══ ⑧ 状态落点（隔离目录，不污染真实状态）══"
echo "  CARLOS_FLOW_HOME=$CARLOS_FLOW_HOME"
ls "$CARLOS_FLOW_HOME/gate-state/runs/" 2>/dev/null | sed 's/^/  run: /'

rm -rf "$CARLOS_FLOW_HOME"
echo ""
echo "══ 完成 ══"
