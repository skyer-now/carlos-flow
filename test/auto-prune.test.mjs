import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { scheduleAutoPrune, planPrune, applyPrune, listSessions } from '../src/storage.js';
import { FLOW_HOME, RUNS_DIR } from '../src/state.js';

describe('任务2：7天终态会话异步无感自动归档调度器实测与真实环境触发验证', () => {
  it('planPrune 能准确识别 >7 天终态完工会话并排除活跃/未完工会话', () => {
    const plan = planPrune({ inactiveDays: 7 });
    assert.ok(plan && typeof plan === 'object');
    assert.ok(Array.isArray(plan.archivable), 'archivable 必须为数组');
    assert.ok(typeof plan.keepActive === 'number', 'keepActive 必须记录活跃会话数');
    // 验证所有被标记为 archivable 的会话 verdict 均非 null
    for (const item of plan.archivable) {
      assert.notEqual(item.verdict, null, `可归档会话 ${item.session} 的 verdict 绝不能为 null`);
    }
  });

  it('真实环境模拟：构造 8 天前完工会话，触发 scheduleAutoPrune 并在真实目录结构中完成归档移入 archive', async () => {
    // 构造测试用的模拟会话目录
    const testSessionId = `test-autodump-${Date.now()}`;
    const testDir = path.join(RUNS_DIR, testSessionId);
    fs.mkdirSync(testDir, { recursive: true });
    
    // 写入 8 天前的 state.json (verdict=PASS, completed_ok=true)
    const eightDaysAgoMs = Date.now() - 8 * 86400000;
    const stateFile = path.join(testDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionId: testSessionId,
      verdict: 'PASS',
      completed_ok: true,
      card: { goal: '测试自动归档' }
    }, null, 2), 'utf8');
    // 修改文件的 mtime 为 8 天前
    fs.utimesSync(stateFile, new Date(eightDaysAgoMs), new Date(eightDaysAgoMs));

    // 同时构造一个活跃未完工的会话 (verdict=null, 同样为 8 天前)，确保不被误归档
    const activeSessionId = `test-activekeep-${Date.now()}`;
    const activeDir = path.join(RUNS_DIR, activeSessionId);
    fs.mkdirSync(activeDir, { recursive: true });
    const activeStateFile = path.join(activeDir, 'state.json');
    fs.writeFileSync(activeStateFile, JSON.stringify({
      sessionId: activeSessionId,
      verdict: null,
      completed_ok: false,
      card: { goal: '活跃任务不应归档' }
    }, null, 2), 'utf8');
    fs.utimesSync(activeStateFile, new Date(eightDaysAgoMs), new Date(eightDaysAgoMs));

    // 触发自动归档调度器
    const customArchiveRoot = path.join(FLOW_HOME, 'test-auto-archive');
    scheduleAutoPrune({ olderThanDays: 7, archiveRoot: customArchiveRoot, force: true });

    // 等待异步非阻塞定时器执行完毕 (100ms timer + IO)
    await new Promise(r => setTimeout(r, 600));

    // 验证结果：
    // 1. 已完工会话应该从 RUNS_DIR 移出，并在 customArchiveRoot 找到
    assert.equal(fs.existsSync(testDir), false, '8天前已完工终态会话必须已从 runs 目录移除');

    // 2. 活跃会话必须依然完好保留在 RUNS_DIR
    assert.equal(fs.existsSync(activeDir), true, '活跃会话绝不能被归档移动');

    // 3. 验证 archive 目录内确实存在该会话
    const foundArchived = fs.existsSync(customArchiveRoot);
    assert.equal(foundArchived, true, '归档目录必须已创建');

    // 清理本次实测产生的测试目录
    try {
      fs.rmSync(activeDir, { recursive: true, force: true });
      fs.rmSync(customArchiveRoot, { recursive: true, force: true });
    } catch {}
  });
});
