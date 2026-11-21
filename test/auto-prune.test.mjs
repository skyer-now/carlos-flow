import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scheduleAutoPrune, planPrune, applyPrune } from '../src/storage.js';

describe('任务2：7天终态会话异步无感自动归档调度器实测', () => {
  it('planPrune 与 applyPrune 能正确识别终态并执行归档', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-prune-home-'));
    const tmpArchive = path.join(tmpHome, 'archive');

    const plan = planPrune({ inactiveDays: 7 });
    assert.ok(plan && Array.isArray(plan.archivable));

    // 执行归档 (dryRun)
    const resDry = applyPrune(plan, { apply: false, archiveRoot: tmpArchive });
    assert.equal(resDry.apply, false);
    assert.ok(Array.isArray(resDry.archived));

    // 执行 scheduleAutoPrune 调度器
    scheduleAutoPrune({ olderThanDays: 7, archiveRoot: tmpArchive });

    // 清理
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
});
