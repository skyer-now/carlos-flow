/**
 * 互审触发规则表（中英双语）。
 *
 * 公用工具不能只认中文；英文词用词边界，避免 read 命中 already。
 * 规则顺序即优先级：dual 命中最高；routine 只在没有 dual 时压到 none。
 */

export function word(list) {
  return list
    .map((w) => '\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
    .join('|')
}

export const RULES = [
  {
    id: 'irreversible',
    level: 'dual',
    label: '不可逆或高风险操作',
    re: new RegExp(
      '发布|上线|部署|删库|删除数据|清空数据|迁移|回滚|降级|灰度|生产环境|生产库|权限|密钥|凭据|证书|资金|付款|退款|合规|审计|' +
        word(['release', 'deploy', 'rollback', 'migration', 'drop table', 'delete data', 'permission', 'credential', 'secret', 'production']),
      'i',
    ),
  },
  {
    id: 'architecture',
    level: 'dual',
    label: '架构 / 选型 / 方案取舍',
    re: new RegExp(
      '架构|技术选型|技术栈|重构方案|迁移方案|整体设计|方案取舍|选型|是否值得|要不要换|' +
        word(['architecture', 'tech stack', 'migration plan', 'refactor plan', 'trade-off', 'tradeoff']),
      'i',
    ),
  },
  {
    id: 'commitment',
    level: 'dual',
    label: '对外承诺或结论',
    re: new RegExp(
      '对外承诺|承诺|保证|合同|报价|SLA|给客户的结论|最终结论|' +
        word(['commitment', 'guarantee', 'contract', 'sla']),
      'i',
    ),
  },
  {
    id: 'review_request',
    level: 'dual',
    label: '用户明确要求评审',
    re: new RegExp(
      '评审|评估|可行性|方案对比|对比方案|帮我判断|风险分析|影响分析|' +
        word(['review', 'evaluate', 'feasibility', 'risk analysis', 'impact analysis', 'pros and cons']),
      'i',
    ),
  },
  {
    id: 'routine',
    level: 'none',
    label: '常规核查',
    re: new RegExp(
      '^(查一下|看一下|看看|是什么|怎么用|如何用|语法|格式化|翻译|算一下|列一下|读一下)|^\\s*(?:' +
        word(['look up', 'check', 'read', 'translate', 'format', 'what is', 'how to']) +
        ')',
      'i',
    ),
  },
  {
    id: 'time_sensitive',
    level: 'single',
    label: '时效敏感事实',
    re: new RegExp(
      '最新|当前版本|最近版本|价格|政策|法规|新闻|截止|时效|今年|本月|这周|' +
        word(['latest', 'current version', 'price', 'policy', 'news', 'deadline']),
      'i',
    ),
  },
  {
    id: 'research',
    level: 'single',
    label: '调研与来源核实',
    re: new RegExp(
      '调研|查证|核实|对比|来源|文献|数据|引用|出处|' +
        word(['research', 'verify', 'compare', 'source', 'citation', 'reference']),
      'i',
    ),
  },
  {
    id: 'diagnosis',
    level: 'single',
    label: '排障结论',
    re: new RegExp(
      '根因|为什么|故障|排查|定位|复现|' + word(['root cause', 'why', 'failure', 'debug', 'reproduce']),
      'i',
    ),
  },
]