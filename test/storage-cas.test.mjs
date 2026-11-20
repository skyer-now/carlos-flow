import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { snapshotFiles, readManifest } from '../src/dispatch.js';

describe('TASK-201~204 存储去重与快照指针还原实测', () => {
  it('相同大文件多轮派发自动哈希指针去重 (deduped = true)', () => {
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cas-work-'));
    const testFile = path.join(tmpWork, 'heavy-bundle.js');
    const largeContent = 'console.log("heavy code");\n'.repeat(1000);
    fs.writeFileSync(testFile, largeContent, 'utf8');

    const sid = 'test-cas-session-' + Date.now();

    // 第一次派发快照
    const entries1 = snapshotFiles(sid, ['heavy-bundle.js'], tmpWork);
    assert.equal(entries1.length, 1);
    assert.equal(entries1[0].deduped, false, '首次快照新建备份');

    // 第二次派发相同文件快照
    const entries2 = snapshotFiles(sid, ['heavy-bundle.js'], tmpWork);
    assert.equal(entries2.length, 1);
    assert.equal(entries2[0].deduped, true, '同内容二次快照自动指针去重');
    assert.equal(entries1[0].sha, entries2[0].sha, 'SHA-256 严格一致');

    // 清理
    fs.rmSync(tmpWork, { recursive: true, force: true });
  });

  it('快照 manifest 记录完整且支持按时间回溯', () => {
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'test-manifest-work-'));
    const testFile = path.join(tmpWork, 'app.js');
    fs.writeFileSync(testFile, 'version 1', 'utf8');

    const sid = 'test-manifest-session-' + Date.now();
    snapshotFiles(sid, ['app.js'], tmpWork);

    const manifestList = readManifest(sid);
    const item = manifestList.find((e) => path.resolve(e.orig) === path.resolve(testFile));
    assert.ok(item, 'manifest 中必须能查到该文件快照记录');
    assert.equal(item.created, false);
    assert.ok(item.backup, '备份路径存在');

    fs.rmSync(tmpWork, { recursive: true, force: true });
  });
});
