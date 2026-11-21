import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const isolated = mkdtempSync(path.join(tmpdir(), 'carlos-knowledge-'));
process.env.CARLOS_FLOW_HOME = path.join(isolated, 'flow');
process.env.HOME = process.env.USERPROFILE = path.join(isolated, 'home');
mkdirSync(process.env.HOME, { recursive: true });
const { validateAgentMesh } = await import('../src/card.js');
const { loadFailureMemory, saveFailureMemory, inferProactiveGuidelines, buildContractPrompt } = await import('../src/dispatch.js');

describe('P2 本地错误自愈知识库与 P3 多 Agent 权限网格实测', () => {
  describe('P2 本地错误自愈知识库 (Failure Memory)', () => {
    it('能够保存并加载历史踩坑规则', () => {
      saveFailureMemory({ rule: 'Windows 下路径拼接必须使用 path.join', tag: 'path' });
      const mem = loadFailureMemory();
      assert.ok(Array.isArray(mem.rules));
      const hasRule = mem.rules.some((r) => r.text.includes('Windows 下路径拼接'));
      assert.ok(hasRule, '规则必须被持久化在知识库中');
    });

    it('派发执行者时能够自动在 Prompt 注入历史避坑经验', () => {
      saveFailureMemory('避免使用未加锁的并发写入');
      const tips = inferProactiveGuidelines(['src/state.js']);
      assert.ok(tips.includes('历史避坑经验'));
      assert.ok(tips.includes('避免使用未加锁的并发写入'));
    });
  });

  describe('P3 多 Agent 细粒度权限网格 (validateAgentMesh & Prompt)', () => {
    it('合法网格划分：子 Agent 范围在全局 scope 内通过', () => {
      const globalScope = ['ui/settings.html', 'src/api.js', 'test/app.test.js'];
      const agents = {
        'ui-dev': { allowed_scope: ['ui/settings.html'] },
        'core-dev': { allowed_scope: ['src/api.js'] },
      };
      const res = validateAgentMesh(agents, globalScope);
      assert.equal(res.ok, true);
      assert.ok(res.agents['ui-dev']);
    });

    it('越界网格划分：子 Agent 范围超出全局 scope 时被拒', () => {
      const globalScope = ['src/api.js'];
      const agents = {
        'ui-dev': { allowed_scope: ['ui/unauthorized.html'] },
      };
      const res = validateAgentMesh(agents, globalScope);
      assert.equal(res.ok, false);
      assert.ok(res.reason.includes('越出任务卡全局 scope 范围'));
    });

    it('buildContractPrompt: 支持为指定子 Agent 生成专属 boundaries', () => {
      const card = {
        goal: '团队协同开发',
        scope: ['src/api.js', 'ui/settings.html'],
        agents: {
          'ui-dev': { allowed_scope: ['ui/settings.html'] },
        },
      };
      const prompt = buildContractPrompt('executor', card, '', { subAgent: 'ui-dev' });
      assert.ok(prompt.includes('task boundaries: ui/settings.html'));
      assert.ok(!prompt.includes('src/api.js'));
    });
  });
});
