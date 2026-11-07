const $ = (s) => document.querySelector(s);

// 默认值：**不得包含任何开发者的本机路径**。
// 之前的默认值是 `D:/cindy/carlos-flow-mcp`（某台开发机的路径，且目录名根本不存在），
// 用户开箱就看到一个无效路径。现在：
//   · mcpRoot 留空 → 留空即可（插件会回退到包内自带的 src/）
//   · flowHome 用平台无关的写法（~/.carlos-flow 由运行时展开）
const DEFAULTS = {
  mcpRoot: '',
  flowHome: '~/.carlos-flow',
  bridgePort: 19099
};

async function load() {
  try {
    const cfg = await (await fetch('/config')).json();
    $('#mcpRoot').value = cfg.CARLOS_FLOW_MCP_ROOT || DEFAULTS.mcpRoot;
    $('#flowHome').value = cfg.CARLOS_FLOW_HOME || DEFAULTS.flowHome;
    $('#bridgePort').value = cfg.BRIDGE_PORT || DEFAULTS.bridgePort;
    status('已加载当前配置');
  } catch (e) {
    reset();
    status('使用默认值');
  }
}

function status(text) {
  $('#status').textContent = text;
}

function reset() {
  $('#mcpRoot').value = DEFAULTS.mcpRoot;
  $('#flowHome').value = DEFAULTS.flowHome;
  $('#bridgePort').value = DEFAULTS.bridgePort;
}

$('#save').onclick = async () => {
  const payload = {
    CARLOS_FLOW_MCP_ROOT: $('#mcpRoot').value.trim() || DEFAULTS.mcpRoot,
    CARLOS_FLOW_HOME: $('#flowHome').value.trim() || DEFAULTS.flowHome,
    BRIDGE_PORT: parseInt($('#bridgePort').value, 10) || DEFAULTS.bridgePort
  };
  status('保存中…');
  try {
    const r = await fetch('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.ok) {
      status('已保存，重启 Cindy 生效');
    } else {
      status(`保存失败（HTTP ${r.status}）`);
    }
  } catch (e) {
    status('保存失败');
  }
};

$('#reset').onclick = () => {
  reset();
  status('已恢复默认值');
};

load();