// Host 的 taskView 带 session 查询；只作展示路由，不构成工具身份或权限。
const pageQuery = new URLSearchParams(location.search);
const taskPage = pageQuery.has('session');
const $ = (s) => document.querySelector(s);

// 默认值：**不得包含任何开发者的本机路径**。
// 之前的默认值是某台开发机上的本机路径（且目录名根本不存在），
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

function setupSettings() {
$('#settings-shell').hidden = false;
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
}

function setupWizard() {
  $('#wizard-shell').hidden = false;
  const sid = pageQuery.get('session');
  if (!sid || sid.length > 200 || pageQuery.has('device')) {
    $('#wizard-reason').textContent = '任务位置不可用；本向导仅支持本机任务。不会载入配置或执行操作。';
    return;
  }
  const channel = new BroadcastChannel('carlos-task-wizard');
  const labels = { start: '启动', goal: '说明目标', scope: '确认范围与验收', execution: '执行', checks: '真实检查与负对照', review: '独立审查', complete: '完成', problem: '处理问题' };
  const reasons = { start: '请在原对话说明希望解决的问题。', goal: '请在原对话明确目标。', scope: '请在原对话确认范围与验收方法；未确认不执行。', execution: '执行状态待确认，派发不代表完成。', checks: '等待真实检查、有效负对照和还原核对；失败或未知不能继续。', review: '等待当前任务独立审查及合法最终裁定。', complete: '后端检查与独立裁定已确认。', problem: '存在阻断或未知结果，先在原对话处理，不自动重试。' };
  channel.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === 'wizard-draft-received' && data.sid === sid) {
      $('#draft-state').textContent = '草稿已交给展示通信，尚未发送给助手或成为任务卡。请回原对话点击现有原生意图卡；助手会准备下一阶段确认。';
      return;
    }
    if (data && data.type === 'wizard-confirmation' && data.sid === sid) {
      $('#wizard-confirm').textContent = '确认资格不可用，展示记录读取未确认；没有当前可点卡的证明。请在原对话重新准备意图，不自动执行或重放。';
      return;
    }
    if (!data || data.type !== 'wizard-display' || data.sid !== sid || !data.wizard) return;
    const w = data.wizard;
    if (!Object.prototype.hasOwnProperty.call(labels, w.stage)) return;
    $('#wizard-stage').textContent = labels[w.stage];
    const intents = { clarify: '读取草稿并澄清目标', 'confirm-scope': '讨论范围与验收意图', execute: '协调下一项执行', check: '协调真实检查及还原核对', review: '协调独立审查', finish: '复核结果或处理问题' };
    const intent = intents[data.intent] || '未确认意图';
    const confirmation = data.cached ? 'unknown' : ['unavailable', 'pending', 'requested', 'consumed', 'expired', 'unknown'].includes(data.confirmation) ? data.confirmation : 'unknown';
    const confirmationText = {
      unavailable: '确认资格不可用，当前没有可点确认卡。请在原对话讨论，由原助手下一次回复重新生成意图卡；不自动执行或重放。',
      pending: `本次观察待原生确认：${intent}。请回原对话单击准确意图卡；此处不是实时资格保证。`,
      requested: `已请求原助手协调：${intent}。不是执行完成，请等待原对话，不重复点击。`,
      consumed: `本次意图已消费：${intent}。等待原助手下一阶段卡，不能重放。`,
      expired: '确认已过期，当前不能继续。请在原对话重新准备意图，不自动重放。',
      unknown: `上次意图：${intent}；当前确认资格未知。缓存不能证明存在可点卡，请查看原对话的新卡，不自动执行。`,
    };
    $('#wizard-confirm').textContent = confirmationText[confirmation];
    $('#wizard-reason').textContent = reasons[w.stage];
    const count = Number.isInteger(w.scope_count) && w.scope_count >= 0 ? w.scope_count : 0;
    $('#wizard-summary').textContent = `${w.goal === '已记录目标' ? '已记录目标' : '尚未记录目标'}；修改范围共 ${count} 项。${w.warning_count > 0 ? '仍有审查提醒。' : ''}`;
    $('#wizard-sample').textContent = Number.isFinite(w.sampled_at) ? `采样时间：${new Date(w.sampled_at).toLocaleString('zh-CN')}。${data.cached ? '这是展示缓存，可能已经过期。' : '这是工具调用时观察，不是实时状态。'}` : '采样时间未知，不能宣称完成。';
    document.querySelectorAll('[data-stage]').forEach((item) => {
      const active = item.dataset.stage === w.stage || (w.stage === 'problem' && item.dataset.stage === 'complete');
      item.style.fontWeight = active ? '700' : '400';
      item.setAttribute('aria-current', active ? 'step' : 'false');
    });
  };
  async function displayRequest() {
    $('#wizard-refresh-note').textContent = '正在请求最近展示缓存；要新采样，请让原助手在当前对话查询状态。';
    try {
      await fetch('/wake');
      channel.postMessage({ type: 'wizard-display-request', sid });
    } catch (e) {
      $('#wizard-refresh-note').textContent = '展示通信未确认；请查看原对话。不自动执行或重试。';
    }
  }
  $('#draft-propose').onclick = () => {
    const draft = { goal: $('#draft-goal').value.slice(0, 1000), scope: $('#draft-scope').value.slice(0, 1000), acceptance: $('#draft-acceptance').value.slice(0, 1000) };
    channel.postMessage({ type: 'wizard-draft-proposal', sid, draft });
    $('#draft-state').textContent = '正在交接未可信草稿；尚未发送给助手。请回现有原生意图卡确认读取草稿，不需要输入技术命令。';
  };
  for (const key of ['goal', 'scope', 'acceptance']) $('#draft-' + key).oninput = () => { $('#draft-state').textContent = '草稿已修改，尚未发送；不会写任务卡或批准扩大范围。'; };
  $('#wizard-refresh').onclick = displayRequest;
  displayRequest();
}
// 在任何配置读取或保存事件注册之前分支，非法任务查询也不退回设置。
if (taskPage) setupWizard();
else setupSettings();
