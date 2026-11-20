import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeltaPatch, commitState, loadState } from '../src/state.js';

describe('微内核底层优化：Delta Patching 增量状态更新实测', () => {
  it('applyDeltaPatch: 支持对象字段增量浅/深合并且不破坏其他属性', () => {
    const state = {
      sessionId: 'test-patch',
      dispatch_count: 1,
      card: {
        goal: '原目标',
        scope: ['src/a.js']
      },
      audit_axes: {
        standards: { verdict: 'PASS' }
      }
    };

    const patch = {
      dispatch_count: 2,
      card: {
        scope: ['src/a.js', 'src/b.js']
      },
      audit_axes: {
        spec: { verdict: 'PASS' }
      }
    };

    applyDeltaPatch(state, patch);

    assert.equal(state.dispatch_count, 2);
    assert.equal(state.card.goal, '原目标', '未提供的新字段保持原样');
    assert.deepEqual(state.card.scope, ['src/a.js', 'src/b.js']);
    assert.equal(state.audit_axes.standards.verdict, 'PASS', '深层对象属性保留');
    assert.equal(state.audit_axes.spec.verdict, 'PASS', '深层对象新属性合并');
  });

  it('commitState: 支持直接传入 patch 对象进行原子更新', async () => {
    const sid = 'test-commit-patch-' + Date.now();
    
    // 初始化状态
    await commitState(sid, {
      card: { goal: '初始目标', scope: ['src/index.js'] },
      dispatch_count: 0
    });

    // 增量 patch 更新
    await commitState(sid, {
      dispatch_count: 1,
      claimed: true
    });

    const latest = loadState(sid);
    assert.equal(latest.dispatch_count, 1);
    assert.equal(latest.claimed, true);
    assert.equal(latest.card.goal, '初始目标', '原有任务卡未被覆盖');
  });
});
