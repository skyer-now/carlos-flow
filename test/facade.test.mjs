import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('四大高阶复合门面工具 (High-Level Facades) 专项测试', () => {
  const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
  const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
  const SCRIPT = path.join(ROOT_DIR, 'client', 'carlos.js');
  const CWD = ROOT_DIR;

  function runCli(tool, args) {
    return new Promise((resolve, reject) => {
      const p = spawn('node', [SCRIPT, tool, JSON.stringify(args)], {
        cwd: CWD,
        encoding: 'utf8',
        windowsHide: true,
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => {
        try {
          resolve({ code, out: JSON.parse(out || '{}'), rawOut: out, err });
        } catch {
          resolve({ code, out: null, rawOut: out, err });
        }
      });
      p.on('error', reject);
    });
  }

  it('1. carlos_task: 支持 submit / claim / dispatch 门面调用', async () => {
    const sid = 'test-facade-task-' + Date.now();

    // 留痕
    await runCli('flow_add_user_msg', { sessionId: sid, text: '高阶门面任务测试' });

    // carlos_task submit
    const submitRes = await runCli('carlos_task', {
      action: 'submit',
      sessionId: sid,
      goal: '测试高阶门面',
      quote: '高阶门面任务测试',
      userMessages: ['高阶门面任务测试'],
      scope: ['src/index.js'],
      acceptance: ['功能正常'],
      verify: { cmd: 'npm test' },
      cwd: CWD,
    });
    assert.equal(submitRes.out?.ok, true, 'carlos_task submit 必须返回 ok: true');

    // carlos_task claim
    const claimRes = await runCli('carlos_task', {
      action: 'claim',
      sessionId: sid,
      role: 'executor',
      cwd: CWD,
    });
    assert.equal(claimRes.out?.ok, true, 'carlos_task claim 必须返回 ok: true');
    assert.equal(claimRes.out?.role, 'executor');

    // carlos_task dispatch
    const dispatchRes = await runCli('carlos_task', {
      action: 'dispatch',
      sessionId: sid,
      role: 'executor',
      cwd: CWD,
    });
    assert.equal(dispatchRes.out?.ok, true, 'carlos_task dispatch 必须返回 ok: true');
  });

  it('2. carlos_manage: 支持 status / cancel / revert 门面调用', async () => {
    const sid = 'test-facade-manage-' + Date.now();
    await runCli('flow_add_user_msg', { sessionId: sid, text: '运维门面测试' });
    await runCli('carlos_task', {
      action: 'submit',
      sessionId: sid,
      goal: '测试运维门面',
      quote: '运维门面测试',
      userMessages: ['运维门面测试'],
      scope: ['src/state.js'],
      cwd: CWD,
    });

    // carlos_manage status
    const statusRes = await runCli('carlos_manage', {
      action: 'status',
      sessionId: sid,
      cwd: CWD,
    });
    assert.equal(statusRes.out?.ok, true);
    assert.equal(statusRes.out?.has_card, true);

    // carlos_manage cancel
    const cancelRes = await runCli('carlos_manage', {
      action: 'cancel',
      sessionId: sid,
      reason: '门面测试撤销',
      cwd: CWD,
    });
    assert.equal(cancelRes.out?.ok, true);
    assert.equal(cancelRes.out?.cancelled, true);

    // 再次查状态确认已清空
    const afterStatus = await runCli('carlos_manage', {
      action: 'status',
      sessionId: sid,
      cwd: CWD,
    });
    assert.equal(afterStatus.out?.has_card, false);
  });

  it('3. carlos_verify & carlos_review 路由分发准确', async () => {
    const sid = 'test-facade-verify-review-' + Date.now();
    await runCli('flow_add_user_msg', { sessionId: sid, text: '校验门面测试' });
    await runCli('carlos_task', {
      action: 'submit',
      sessionId: sid,
      goal: '测试校验门面',
      quote: '校验门面测试',
      userMessages: ['校验门面测试'],
      scope: ['src/index.js'],
      cwd: CWD,
    });
    
    // carlos_verify check_scope
    const scopeRes = await runCli('carlos_verify', {
      action: 'check_scope',
      sessionId: sid,
      paths: ['src/index.js'],
      cwd: CWD,
    });
    assert.equal(scopeRes.out?.ok, true);

    // carlos_review guard
    const guardRes = await runCli('carlos_review', {
      action: 'guard',
      sessionId: sid,
      cwd: CWD,
    });
    // 未审查时 guard 正常以错误退出（exitCode=1 且包含两轴未齐提示）
    assert.equal(guardRes.code, 1);
    assert.ok(guardRes.err?.includes('两轴') || guardRes.err?.includes('为什么被拦'));
  });
});
