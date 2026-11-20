import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TriggerEngine, classifySideEffect } from '../src/trigger.js';
import { translateGateError } from '../ui/narrator.js';

describe('智能向导与触发引擎进阶特性验证', () => {
  describe('1. 语义副作用分级矩阵 (LEVEL_0 / LEVEL_1 / LEVEL_2)', () => {
    it('纯只读消息判定为 LEVEL_0 并强制静默 (0分)', () => {
      const readOnlyMsgs = [
        '分析一下登录接口的性能瓶颈',
        '为什么这里的测试会报错？',
        '帮我看看当前代码架构',
        '解释一下这段逻辑的含义',
        '调研一下相关的开源实现',
        '对比一下方案A和方案B的优缺点',
      ];

      for (const msg of readOnlyMsgs) {
        const level = classifySideEffect(msg);
        assert.equal(level, 'LEVEL_0', `消息 "${msg}" 应该被判定为 LEVEL_0`);
        assert.equal(TriggerEngine.isReadOnlyIntent(msg), true);

        const res = TriggerEngine.processUserMessage(msg, { sessionId: 'test-readonly-sid' });
        assert.equal(res.shouldTrigger, false);
        assert.equal(res.decision, 'ignore');
        assert.equal(res.score, 0);
      }
    });

    it('临时排查与单测判定为 LEVEL_1', () => {
      const ephemeralMsgs = [
        '加几行日志排查一下',
        '打印一下当前的上下文状态',
        '跑单测看看结果',
        '调试一下接口响应',
      ];

      for (const msg of ephemeralMsgs) {
        const level = classifySideEffect(msg);
        assert.equal(level, 'LEVEL_1', `消息 "${msg}" 应该被判定为 LEVEL_1`);
      }
    });

    it('真实改动与重构判定为 LEVEL_2 并正常触发判定', () => {
      const mutatingMsgs = [
        '重构用户登录认证模块',
        '修改 auth.js 里的参数校验逻辑',
        '新增一个鉴权拦截中间件',
        '修复密码加密越界漏洞',
      ];

      for (const msg of mutatingMsgs) {
        const level = classifySideEffect(msg);
        assert.equal(level, 'LEVEL_2', `消息 "${msg}" 应该被判定为 LEVEL_2`);
      }
    });
  });

  describe('2. 多轮上下文代码路径消解 (手机端短指令继承)', () => {
    it('能从当前会话历史中提取真实相对路径', () => {
      const sid = 'test-context-scope-' + Date.now();
      const engine = TriggerEngine.create(sid);

      // 模拟前序对话
      engine.triggerManager.recordTrigger({
        user_msg: '我们讨论一下修改 src/trigger.js 和 ui/narrator.js 的方案',
        context: { message: '涉及 src/index.js 的调用' },
      });

      const extracted = TriggerEngine.resolveContextScope(sid);
      assert.ok(extracted.includes('src/trigger.js'));
      assert.ok(extracted.includes('ui/narrator.js'));
      assert.ok(extracted.includes('src/index.js'));
    });
  });

  describe('3. 占位卡 5 分钟无派发自动老化 (Auto-Discard)', () => {
    it('未派发的占位卡超时后判定为 expired: true', () => {
      const sid = 'test-expiry-' + Date.now();
      const state = {
        card: { goal: '测试占位' },
        card_ts: Date.now() - 360000, // 6分钟前
        dispatch_count: 0,
        activation_pending: ['scope', 'acceptance'],
      };

      const res = TriggerEngine.checkPlaceholderExpiry(sid, state);
      assert.equal(res.expired, true);
    });

    it('已有真实派发的卡片不被静默老化 (保持门禁严肃性)', () => {
      const sid = 'test-no-expiry-' + Date.now();
      const state = {
        card: { goal: '已开工任务' },
        card_ts: Date.now() - 360000,
        dispatch_count: 1, // 已派发
        activation_pending: [],
      };

      const res = TriggerEngine.checkPlaceholderExpiry(sid, state);
      assert.equal(res.expired, false);
    });
  });

  describe('4. 门禁拦截 100% 通俗大白话翻译', () => {
    it('各种典型拦截均输出人话说明，零技术黑话', () => {
      const t1 = translateGateError('ERROR: record missing, dispatch forbidden');
      assert.ok(t1.includes('🛑 为了防止代码改乱，我先帮您踩了刹车。'));
      assert.ok(t1.includes('还没记录这次要修改的具体目标'));

      const t2 = translateGateError('ERROR: scope 路径越界违背锚点约束');
      assert.ok(t2.includes('发现 AI 正在尝试修改没有约定过的文件'));
      assert.ok(t2.includes('回复“允许追加”'));

      const t3 = translateGateError('ERROR: executor 角色无权落定 PASS 裁定');
      assert.ok(t3.includes('写代码的角色不能自己给自己批作业'));
    });
  });
});
