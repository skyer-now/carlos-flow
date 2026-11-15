export function narrate(event) {
  const reason = event.reason || '逻辑冲突';
  return {
    text: `⚠️ 抱歉，这里有点问题，建议检查一下配置：${reason}`,
    action: '查看原文'
  };
}
