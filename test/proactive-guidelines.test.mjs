import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractPrompt, inferProactiveGuidelines } from '../src/dispatch.js';

describe('P0 事前代码规范注入与 MCP 原语扩展实测', () => {
  it('inferProactiveGuidelines: 针对 API 与 Controller 自动注入接口安全规范', () => {
    const scope = ['src/api/user.js', 'src/controllers/auth.js'];
    const tips = inferProactiveGuidelines(scope);
    assert.ok(tips.includes('接口安全'));
    assert.ok(tips.includes('强类型校验'));
  });

  it('inferProactiveGuidelines: 针对存储与状态文件自动注入并发事务规范', () => {
    const scope = ['src/state.js', 'src/storage.js'];
    const tips = inferProactiveGuidelines(scope);
    assert.ok(tips.includes('存储与状态'));
    assert.ok(tips.includes('加锁互斥'));
  });

  it('inferProactiveGuidelines: 针对 CLI 与跨平台工具自动注入路径与黑窗防护规范', () => {
    const scope = ['bridge/mcp-bridge.js', 'client/carlos.js'];
    const tips = inferProactiveGuidelines(scope);
    assert.ok(tips.includes('跨平台健壮性'));
    assert.ok(tips.includes('windowsHide: true'));
  });

  it('buildContractPrompt: 派发 executor 时成功在 Prompt 末尾装配事前规范', () => {
    const card = {
      goal: '修复登录并发锁',
      scope: ['src/state.js', 'src/api/auth.js'],
      verify: { cmd: 'npm test' }
    };
    const prompt = buildContractPrompt('executor', card, '请重点测试锁竞争');
    assert.ok(prompt.includes('objective: 修复登录并发锁'));
    assert.ok(prompt.includes('proactive guidelines'));
    assert.ok(prompt.includes('接口安全'));
    assert.ok(prompt.includes('存储与状态'));
    assert.ok(prompt.includes('请重点测试锁竞争'));
  });
});
