import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = process.env.CARLOS_FLOW_MCP_ROOT || path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'client/carlos.js');

function call(tool, args, env = {}) {
  const r = spawnSync('node', [CLIENT, tool, JSON.stringify(args)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CARLOS_FLOW_MCP_ROOT: ROOT, ...env },
    windowsHide: true,
  });
  try {
    return { ok: r.status === 0, data: JSON.parse(r.stdout || '{}'), stdout: r.stdout, stderr: r.stderr, error: r.stderr || r.stdout };
  } catch {
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, error: r.stderr || r.stdout };
  }
}

describe('15条通用防撞规则集成接入全链路实测', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'test-rules-home-'));
  const env = { CARLOS_FLOW_HOME: tmpHome };

  it('1. 敏感凭据保护 (R1)：未确认时拦截，显式 confirmed: true 放行', () => {
    const sid = 'test-r1-' + Date.now();
    call('flow_add_user_msg', { sessionId: sid, text: '修改数据库密钥' }, env);

    // 拦截示例 (.env.production 属于敏感资产，未确认被拒)
    const blocked = call('flow_submit_requirement', {
      sessionId: sid,
      goal: '修改数据库密钥',
      quote: '修改数据库密钥',
      scope: ['src/card.js', '.env.production'],
      confirmed: false,
    }, env);
    assert.equal(blocked.data?.ok, false);
    assert.ok(blocked.data?.reason.includes('敏感密钥或凭据文件'));
    assert.ok(blocked.data?.reason.includes('踩了刹车'));

    // 放行示例 (使用真实存在的 src/card.js + confirmed: true)
    const passed = call('flow_submit_requirement', {
      sessionId: sid,
      goal: '修改数据库密钥',
      quote: '修改数据库密钥',
      scope: ['src/card.js'],
      confirmed: true,
    }, env);
    assert.equal(passed.data?.ok, true);
  });

  it('2. 核心依赖锁保护 (R2)：未确认时拦截 package-lock.json', () => {
    const sid = 'test-r2-' + Date.now();
    call('flow_add_user_msg', { sessionId: sid, text: '调整依赖包' }, env);

    const blocked = call('flow_submit_requirement', {
      sessionId: sid,
      goal: '调整依赖包',
      quote: '调整依赖包',
      scope: ['package-lock.json'],
      confirmed: false,
    }, env);
    assert.equal(blocked.data?.ok, false);
    assert.ok(blocked.data?.reason.includes('依赖锁文件（Lockfile）'));
  });

  it('3. Git 元数据物理隔离 (R3)：绝对阻断 .git/ 目录（不接受 confirmed）', () => {
    const sid = 'test-r3-' + Date.now();
    call('flow_add_user_msg', { sessionId: sid, text: '改动 git 配置' }, env);

    const blocked = call('flow_submit_requirement', {
      sessionId: sid,
      goal: '改动 git 配置',
      quote: '改动 git 配置',
      scope: ['.git/config'],
      confirmed: true,
    }, env);
    assert.equal(blocked.data?.ok, false);
    assert.ok(blocked.data?.reason.includes('绝对禁止直接修改 Git 内部元数据'));
  });

  it('4. 危险命令防御 (R7/R8)：flow_run_verify 拦截 rm -rf / 与全局 taskkill', () => {
    const sid = 'test-r78-' + Date.now();
    call('flow_add_user_msg', { sessionId: sid, text: '清理目录' }, env);
    const sub = call('flow_submit_requirement', {
      sessionId: sid,
      goal: '清理目录',
      quote: '清理目录',
      scope: ['src/card.js'],
      confirmed: true,
      verify: { cmd: 'rm -rf /' },
    }, env);
    assert.equal(sub.data?.ok, true);

    const blockedRm = call('flow_run_verify', { sessionId: sid }, env);
    assert.equal(blockedRm.ok, false);
    assert.ok(blockedRm.error.includes('危险删除命令'));
  });
});
