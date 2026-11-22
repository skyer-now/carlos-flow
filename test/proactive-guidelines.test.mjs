import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离必须先于模块导入：否则 inferProactiveGuidelines 会读真实用户的 FLOW_HOME。
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-proactive-'));
process.env.CARLOS_FLOW_HOME = path.join(isolated, 'flow');
process.env.HOME = process.env.USERPROFILE = path.join(isolated, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

const { buildContractPrompt, inferProactiveGuidelines } = await import('../src/dispatch.js');

describe('P0 事前代码规范注入与 MCP 原语扩展实测', () => {
  it('inferProactiveGuidelines: 针对 API 与 Controller 自动注入接口安全规范', () => {
    const scope = ['src/api/user.js', 'src/controllers/auth.js'];
    const tips = inferProactiveGuidelines(scope, { cwd: isolated });
    assert.ok(tips.includes('接口安全'));
    assert.ok(tips.includes('强类型校验'));
  });

  it('inferProactiveGuidelines: 针对存储与状态文件自动注入并发事务规范', () => {
    const scope = ['src/state.js', 'src/storage.js'];
    const tips = inferProactiveGuidelines(scope, { cwd: isolated });
    assert.ok(tips.includes('存储与状态'));
    assert.ok(tips.includes('加锁互斥'));
  });

  it('inferProactiveGuidelines: 针对 CLI 与跨平台工具自动注入路径与黑窗防护规范', () => {
    const scope = ['bridge/mcp-bridge.js', 'client/carlos.js'];
    const tips = inferProactiveGuidelines(scope, { cwd: isolated });
    assert.ok(tips.includes('跨平台健壮性'));
    assert.ok(tips.includes('windowsHide: true'));
  });

  it('buildContractPrompt: 派发 executor 时成功在 Prompt 末尾装配事前规范', () => {
    const card = {
      goal: '修复登录并发锁',
      scope: ['src/state.js', 'src/api/auth.js'],
      verify: { cmd: 'npm test' }
    };
    // 显式给出工作目录：不传时按设计不注入，避免读到错误项目的记忆。
    const prompt = buildContractPrompt('executor', card, '请重点测试锁竞争', { cwd: isolated });
    assert.ok(prompt.includes('objective: 修复登录并发锁'));
    assert.ok(prompt.includes('proactive guidelines'));
    assert.ok(prompt.includes('接口安全'));
    assert.ok(prompt.includes('存储与状态'));
    assert.ok(prompt.includes('请重点测试锁竞争'));
  });

  it('buildContractPrompt: 没有任何工作目录时不注入记忆（不猜进程目录）', () => {
    const card = { goal: 'x', scope: ['src/a.js'], verify: { cmd: 'npm test' } };
    const prompt = buildContractPrompt('executor', card, '');
    assert.ok(!prompt.includes('历史避坑经验'));
  });
});
// 不留下临时状态目录。
after(() => {
  try { fs.rmSync(isolated, { recursive: true, force: true }); } catch {}
});
