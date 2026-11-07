#!/bin/bash
# 模拟「一个从没见过本项目的用户」在干净环境安装：
#   1. 从 npm 装包（真实 registry）
#   2. 检查包内容完整性
#   3. 触发器模板是合法 JSON 且可被引擎读取
#   4. MCP server 能启动并响应真实 JSON-RPC
#   5. 审计：包内无个人私有路径
#
# 跨平台注意：路径**绝不内插进 node -e 字符串**（Windows 路径含反斜杠与空格会被拆坏），
# 一律通过环境变量传给 node 进程。
#
# 用法: bash scripts/verify-install-e2e.sh
#   环境变量：CARLOS_FLOW_PKG（默认 carlos-flow）
#             CARLOS_FLOW_VERSION（默认取本仓 package.json 的版本）
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="${CARLOS_FLOW_PKG:-carlos-flow}"
# 版本默认取本仓 package.json —— 写死版本号会在每次发版后立刻过期
# （旧实现写死旧版本号，包名写死已废弃的旧包名 → 验证的是不存在的包）
PKG_VERSION="${CARLOS_FLOW_VERSION:-$(node -p "require('${SCRIPT_DIR}/../package.json').version")}"

echo "══ ① 从 npm 安装 $PKG_NAME@$PKG_VERSION ══"
# 用独立 prefix 模拟「干净环境」，不污染系统全局
PREFIX="$(mktemp -d)"
if ! npm install -g --prefix "$PREFIX" "$PKG_NAME@$PKG_VERSION" >/dev/null 2>&1; then
  echo "  ✗ 安装失败（npm install -g --prefix $PREFIX $PKG_NAME@$PKG_VERSION）"
  exit 1
fi
# npm 在不同平台下的全局目录布局不同，逐个探测
PKG_ROOT=""
for cand in \
  "$PREFIX/lib/node_modules/$PKG_NAME" \
  "$PREFIX/node_modules/$PKG_NAME" \
  "$PREFIX/Lib/node_modules/$PKG_NAME" \
  "$PREFIX/lib/node_modules"; do
  if [ -e "$cand/package.json" ]; then PKG_ROOT="$cand"; break; fi
done
if [ -z "$PKG_ROOT" ]; then
  echo "  ✗ 找不到已安装的包目录（探测过 $PREFIX 下多个布局）"
  exit 1
fi
echo "  ✓ 安装到 $PKG_ROOT"

echo ""
echo "══ ② 包内容完整性 ══"
MISSING=0
for f in package.json README.md README.en.md README.zh.md CHANGELOG.md TRIGGER_GUIDE.md \
         src/index.js client/carlos.js trigger-config.usable.json trigger-config.example.json; do
  if [ -e "$PKG_ROOT/$f" ]; then echo "  ✓ $f"; else echo "  ✗ 缺失 $f"; MISSING=1; fi
done

echo ""
echo "══ ③ 触发器模板是合法 JSON 且可被引擎读取 ══"
export CARLOS_FLOW_HOME="$(mktemp -d)"
cp "$PKG_ROOT/trigger-config.usable.json" "$CARLOS_FLOW_HOME/trigger-config.json"
export PKG_ROOT_ENV="$PKG_ROOT"
node --input-type=module -e "
const { TriggerEngine } = await import(new URL('file:///' + process.env.PKG_ROOT_ENV.replace(/\\\\/g,'/') + '/src/trigger.js').href);
const c = TriggerEngine.getConfig();
console.log('  默认中文词「门禁」在：', c.keywordWeights['门禁'] !== undefined ? '✓' : '✗');
console.log('  模板自定义词「评审」生效：', c.keywordWeights['评审'] === 3 ? '✓' : '✗');
" 2>&1 | grep -E "✓|✗"

echo ""
echo "══ ④ MCP server 能启动并响应真实 JSON-RPC ══"
node --input-type=module -e "
import { spawn } from 'node:child_process';
const root = process.env.PKG_ROOT_ENV.replace(/\\\\/g,'/');
const child = spawn(process.execPath, [root + '/src/index.js'], {
  env: { ...process.env, CARLOS_FLOW_HOME: process.env.CARLOS_FLOW_HOME },
  stdio: ['pipe','pipe','pipe'],
});
let buf = ''; const pending = new Map(); let id = 1;
child.stdout.on('data', d => { buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0,i); buf = buf.slice(i+1);
    if(!l.trim()) continue; try { const m = JSON.parse(l);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
const req = (method, params) => new Promise(r => { const rid = id++; pending.set(rid, r);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:rid,method,params})+'\n');
  setTimeout(()=>{ if(pending.has(rid)){pending.delete(rid);r({error:'TIMEOUT'});} }, 20000); });
await req('initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'install-e2e',version:'1'}});
const list = await req('tools/list', {});
const n = (list.result?.tools||[]).length;
console.log('  tools/list →', n, '个工具', n >= 15 ? '✓' : '✗');
const st = await req('tools/call', {name:'flow_status', arguments:{sessionId:'install-e2e'}});
const parsed = JSON.parse(st.result?.content?.[0]?.text || '{}');
console.log('  flow_status →', parsed.has_card === false ? '✓ 正常响应' : '✗');
const tr = await req('tools/call', {name:'flow_trigger_check', arguments:{sessionId:'install-e2e', message:'走门禁流程，执行 dispatch 任务'}});
const tp = JSON.parse(tr.result?.content?.[0]?.text || '{}');
console.log('  flow_trigger_check（中文）→', tp.decision, 'score=' + tp.score, tp.activated ? '✓ 已激活' : '✗');
child.kill(); process.exit(tp.activated ? 0 : 1);
" 2>&1 | grep -E "✓|✗"

echo ""
echo "══ ⑤ 审计：包内无个人私有路径 ══"
# 模式用变量拼接写成 —— 否则这段脚本**自己就含字面量**，
# grep 会把它自己扫出来，审计永远失败（上一版就是这么坏的）。
# 拼���后的完整形态与下面的清单一致。
PERSONAL_A="D:"; PERSONAL_A="${PERSONAL_A}/cindy"
PERSONAL_B="C:"; PERSONAL_B="${PERSONAL_B}/Users/EDY"
PERSONAL_C="D:"; PERSONAL_C="${PERSONAL_C}/dev-env"
PERSONAL_D="/home/"; PERSONAL_D="${PERSONAL_D}edy"
# CHANGELOG.md 例外：它是**版本历史**，刻意保留被修复路径的原样描述以便追溯，
# 不是「仍在生效的配置」。除此之外，包内任何文件都不得出现个人路径。
HITS="$(grep -rl -e "${PERSONAL_A}" -e "${PERSONAL_B}" -e "${PERSONAL_C}" -e "${PERSONAL_D}" \
        "$PKG_ROOT" 2>/dev/null | grep -v node_modules | grep -v 'CHANGELOG.md' | head -5)"
if [ -n "$HITS" ]; then
  echo "  ✗ 上列文件仍含个人私有路径："
  echo "$HITS" | sed 's/^/      /'
else
  echo "  ✓ 包内无个人私有路径"
fi

rm -rf "$PREFIX" "$CARLOS_FLOW_HOME"
echo ""
echo "══ 完成 ══"
