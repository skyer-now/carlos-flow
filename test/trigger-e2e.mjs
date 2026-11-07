#!/usr/bin/env node
// Carlos Flow 触发引擎 E2E 测试脚本
// 快速验证所有核心功能

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 仓库根目录（本文件位于 test/ 下）
const REPO_ROOT = resolve(__dirname, '..');

// 触发引擎路径
const TRIGGER_PATH = join(REPO_ROOT, 'src', 'trigger.js');

// 状态文件路径：与 trigger.js 的 TRIGGER_HOME 保持一致
const STATE_DIR = process.env.CARLOS_FLOW_HOME
  ? process.env.CARLOS_FLOW_HOME
  : join(REPO_ROOT, '.carlos-flow');
const STATE_FILE = join(STATE_DIR, 'trigger-state.json');
// 报告路径：写入临时目录，不污染发布目录（发布目录应保持干净）
const REPORT_FILE = join(tmpdir(), 'carlos-flow-trigger-e2e-results.json');

// 清理状态文件
function clearState() {
  try {
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
  } catch (e) {
    // 忽略
  }
}

// 测试工具 - 使用动态 import
async function loadTriggerEngine() {
  const mod = await import('file://' + TRIGGER_PATH);
  return mod.TriggerEngine;
}

// 测试结果存储
const results = {
  pass: [],
  fail: [],
  total: 0,
  warnings: []
};

let TriggerEngine = null;

// 测试用例
const testCases = [
  // DynamicTriggerManager 测试
  {
    name: 'DynamicTriggerManager: 基础上限计算',
    test: () => {
      clearState();
      const engine = TriggerEngine.create();
      // 强制 session 长度为 0 且无历史
      engine.triggerManager.state.sessionStartTime = Date.now();
      engine.triggerManager.state.triggerHistory = [];
      engine.triggerManager.state.lastTriggerTime = 0;
      engine.triggerManager.state.save();
      // 传入 complexity=0 以获取纯粹基础上限
      const limit = engine.triggerManager.calculateDynamicLimit(0);
      console.log(`  [DEBUG] 基础上限: ${limit}, 预期: 5`);
      return limit === 5;
    }
  },
  {
    name: 'DynamicTriggerManager: 会话时长影响',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      // 模拟会话时长增加
      const original = engine.triggerManager.state.sessionStartTime;
      engine.triggerManager.state.sessionStartTime = Date.now() - (2 * 60 * 60 * 1000); // 2小时
      const limit = engine.triggerManager.calculateDynamicLimit(1.0);
      const result = limit > 5 && limit <= 15;
      // 恢复
      engine.triggerManager.state.sessionStartTime = original;
      return result;
    }
  },
  {
    name: 'DynamicTriggerManager: 时间间隔检查',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      // 重置时间
      engine.triggerManager.state.lastTriggerTime = Date.now();
      
      const config = TriggerEngine.getConfig();
      const timeSinceLastTrigger = Date.now() - engine.triggerManager.state.lastTriggerTime;
      
      if (timeSinceLastTrigger < config.minTriggerIntervalSeconds * 1000) {
        return engine.triggerManager.canTrigger().can === false;
      }
      return true;
    }
  },

  // TriggerScorer 测试（使用英文关键词）
  {
    name: 'TriggerScorer: 关键词匹配',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'run dispatch workflow';
      const scorer = engine.scorer;
      const { score, matchedKeywords } = scorer.calculateKeywordScore(message);
      console.log(`  [DEBUG] 关键词分数: ${score}, 匹配: ${matchedKeywords.join(', ')}`);
      return score > 0 && matchedKeywords.length > 0;
    }
  },
  {
    name: 'TriggerScorer: 上下文相关性',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'workflow execution';
      const scorer = engine.scorer;
      const { score, matchedContext } = scorer.calculateContextRelevance(message, { complexity: 1.2 });
      console.log(`  [DEBUG] 上下文分数: ${score}, 匹配: ${matchedContext.join(', ')}`);
      return score > 0 && matchedContext.length > 0;
    }
  },
  {
    name: 'TriggerScorer: 用户意图识别',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'auto execute process';
      const scorer = engine.scorer;
      const { intentType, score } = scorer.calculateUserIntent(message);
      console.log(`  [DEBUG] 意图: ${intentType}, 分数: ${score}`);
      return intentType !== 'generic' && score > 0;
    }
  },

  // TriggerDecisionEngine 测试
  {
    name: 'TriggerDecisionEngine: 触发决策',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'run dispatch workflow trigger carlos';
      const result = engine.shouldTrigger(message, { sessionId: 'default' });
      console.log(`  [DEBUG] 触发决策: ${result.shouldTrigger}, 评分: ${result.score}, 置信度: ${result.confidence}`);
      return result.shouldTrigger === true;
    }
  },
  {
    name: 'TriggerDecisionEngine: 非触发决策',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const message = 'testing';
      const result = engine.shouldTrigger(message, { sessionId: 'default' });
      return result.shouldTrigger === false;
    }
  },
  {
    name: 'TriggerDecisionEngine: 评分阈值',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      const highMessage = 'carlos flow dispatch trigger run start execute workflow';
      const result = engine.shouldTrigger(highMessage);
      console.log(`  [DEBUG] 高评分触发: ${result.decision}, 分数: ${result.score}`);
      return result.decision === 'trigger' && result.score >= 25;
    }
  },

  // 集成测试
  {
    name: '集成测试: 完整流程',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      
      const message = 'run dispatch flow';
      const result = engine.shouldTrigger(message, { sessionId: 'test' });
      console.log(`  [DEBUG] 第一次触发: ${result.shouldTrigger}, 评分: ${result.score}`);
      
      if (!result.shouldTrigger) return false;
      
      // 记录触发
      engine.triggerManager.recordTrigger({ impulseScore: result.score });
      
      // 检查再次触发被限制
      const secondCheck = engine.shouldTrigger(message, { sessionId: 'test' });
      console.log(`  [DEBUG] 第二次触发: ${secondCheck.shouldTrigger}, decision: ${secondCheck.decision}, reason: ${secondCheck.reason}`);
      
      const resultValue = secondCheck.decision === 'none' || 
                          secondCheck.reason.includes('限制') || 
                          secondCheck.reason.includes('时间间隔');
      console.log(`  [DEBUG] 集成测试结果: ${resultValue}`);
      return resultValue;
    }
  },

  // 配置加载测试
  {
    name: '配置加载: 默认参数',
    test: () => {
      const config = TriggerEngine.getConfig();
      return config.baseTriggerLimit === 5 && 
             config.maxTriggerLimit === 15 &&
             config.triggerThreshold === 15;
    }
  },

  // 回归测试：上限检查必须真实生效（历史 bug：曾用 0~1 加权均值与上限比较，永不触发）
  {
    name: '回归: 窗口内触发次数达上限后被拦截',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      // canTrigger() 内部使用默认 complexity=1.0 计算上限，测试必须用相同参数
      const limit = engine.triggerManager.calculateDynamicLimit(1.0);

      // 伪造 limit 次历史触发（直接写入状态，不走 recordTrigger 的间隔限制）
      const now = Date.now();
      for (let i = 0; i < limit; i++) {
        engine.triggerManager.state.triggerHistory.push({
          timestamp: now - (i * 1000),
          impulseScore: 30,
          context: 'test',
          userResponse: 'pending'
        });
      }
      engine.triggerManager.state.lastTriggerTime = 0; // 绕过最小间隔，只测上限
      engine.triggerManager.state.save();

      const can = engine.triggerManager.canTrigger();
      console.log(`  [DEBUG] 窗口计数=${engine.triggerManager.countTriggersInWindow()}, 上限=${limit}, canTrigger=${can.can}`);
      return can.can === false && /上限/.test(can.reason || '');
    }
  },
  {
    name: '回归: 上限未达时允许触发',
    test: () => {
      const engine = TriggerEngine.create();
      engine.triggerManager.reset();
      engine.triggerManager.state.triggerHistory = [];
      engine.triggerManager.state.lastTriggerTime = 0;
      engine.triggerManager.state.save();

      const can = engine.triggerManager.canTrigger();
      console.log(`  [DEBUG] canTrigger=${can.can}, limit=${can.limit}`);
      return can.can === true;
    }
  },
  {
    name: '回归: sessionId 透传到状态层',
    test: () => {
      const engine = TriggerEngine.create('sid-A');
      const result = engine.shouldTrigger('run dispatch flow', { sessionId: 'sid-A' }, 'sid-A');
      const state = engine.triggerManager.state;
      console.log(`  [DEBUG] state.sessionId=${state.sessionId}`);
      return state.sessionId === 'sid-A';
    }
  },
  {
    name: '回归: 触发状态不写入仓库目录',
    test: () => {
      // CARLOS_FLOW_HOME 未设置时应落到 ~/.carlos-flow，而不是 cwd
      const engine = TriggerEngine.create('sid-home');
      engine.triggerManager.state.save();
      const repoLeak = join(REPO_ROOT, 'trigger-state.json');
      const homeFile = join(
        process.env.CARLOS_FLOW_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.carlos-flow'),
        'trigger-state.json'
      );
      const leaked = existsSync(repoLeak);
      const atHome = existsSync(homeFile);
      console.log(`  [DEBUG] 仓库泄漏=${leaked}, HOME命中=${atHome}`);
      return !leaked && atHome;
    }
  },
  // ---- 动态决策 → 判断 → 激活 闭环 ----
  {
    name: '激活: trigger 决策生成完整激活计划',
    test: () => {
      const sid = 'act-plan-' + Date.now();
      const engine = TriggerEngine.create(sid);
      const result = engine.shouldTrigger('run dispatch workflow', { sessionId: sid }, sid);
      const plan = result.activationPlan;
      console.log(`  [DEBUG] decision=${result.decision}, activated=${plan && plan.activated}`);
      if (!plan || plan.activated !== true) return false;
      // 必须包含：自动留痕 → 自动开卡 → 引导补齐
      const tools = plan.steps.map((s) => s.tool);
      const autoCount = plan.steps.filter((s) => s.auto === true).length;
      const manualStep = plan.steps.find((s) => s.auto === false);
      console.log(`  [DEBUG] steps=${tools.join(',')} auto=${autoCount} pending=${plan.pendingFields.join(',')}`);
      return (
        tools.includes('flow_add_user_msg') &&
        tools.includes('flow_submit_requirement') &&
        autoCount === 2 &&
        !!manualStep &&
        manualStep.needsFill.includes('scope') &&
        plan.pendingFields.length === 3 &&
        typeof plan.prompt === 'string' && plan.prompt.length > 0
      );
    }
  },
  {
    name: '激活: 非 trigger 决策不激活',
    test: () => {
      const sid = 'act-none-' + Date.now();
      const engine = TriggerEngine.create(sid);
      const result = engine.shouldTrigger('hello there', { sessionId: sid }, sid);
      const plan = result.activationPlan;
      console.log(`  [DEBUG] decision=${result.decision}, activated=${plan && plan.activated}`);
      return result.shouldTrigger === false && !!plan && plan.activated === false;
    }
  },
  {
    name: '激活: 激活动作包含 quote 锚点数据源',
    test: () => {
      const sid = 'act-anchor-' + Date.now();
      const engine = TriggerEngine.create(sid);
      const message = 'run dispatch workflow';
      const result = engine.shouldTrigger(message, { sessionId: sid }, sid);
      const step = result.activationPlan.steps.find((s) => s.tool === 'flow_add_user_msg');
      const cardStep = result.activationPlan.steps.find((s) => s.tool === 'flow_submit_requirement' && s.auto === true);
      console.log(`  [DEBUG] quote=${cardStep && cardStep.args.quote}`);
      return (
        !!step && step.args.text === message &&
        !!cardStep && cardStep.args.quote === message &&
        cardStep.args.activation === true
      );
    }
  },
  {
    name: '回归: 不同会话的触发状态互相隔离',
    test: () => {
      const a = 'iso-A-' + Date.now();
      const b = 'iso-B-' + Date.now();
      const engineA = TriggerEngine.create(a);
      // 会话 A 触发一次，撑满最短间隔
      engineA.shouldTrigger('run dispatch workflow', { sessionId: a }, a);
      const engineB = TriggerEngine.create(b);
      const resultB = engineB.shouldTrigger('run dispatch workflow', { sessionId: b }, b);
      // 两个会话应各自产生独立的状态文件（文件名带 session 哈希后缀）
      const dir = join(
        process.env.CARLOS_FLOW_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.carlos-flow'),
        'trigger-state'
      );
      const files = existsSync(dir) ? readdirSync(dir) : [];
      const aFiles = files.filter((f) => f.startsWith('iso-A-'));
      const bFiles = files.filter((f) => f.startsWith('iso-B-'));
      console.log(`  [DEBUG] B decision=${resultB.decision}, A文件=${aFiles.length}, B文件=${bFiles.length}`);
      // 会话 B 不应被会话 A 的限流影响，且两者状态文件不同
      return resultB.decision === 'trigger' && aFiles.length >= 1 && bFiles.length >= 1 &&
        aFiles[0] !== bFiles[0];
    }
  },
  {
    name: '回归: 清洗后同形的 sessionId 不共用状态文件',
    test: () => {
      // "col/a" 与 "col_a" 清洗后都变成 "col_<同一时间戳>"——
      // 必须用**同一个**时间戳，否则两次 Date.now() 相差 1ms 就不是同形，测试会假绿。
      const stamp = Date.now();
      const p = 'col/' + stamp;
      const q = 'col_' + stamp;
      const engineP = TriggerEngine.create(p);
      engineP.shouldTrigger('run dispatch workflow', { sessionId: p }, p);
      const engineQ = TriggerEngine.create(q);
      const resultQ = engineQ.shouldTrigger('run dispatch workflow', { sessionId: q }, q);
      const dir = join(
        process.env.CARLOS_FLOW_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.carlos-flow'),
        'trigger-state'
      );
      const files = existsSync(dir) ? readdirSync(dir) : [];
      // 精确匹配本次生成的文件（用同一时间戳前缀），而不是 startsWith('col_') ——
      // 后者会把历史遗留的 col_ 开头文件一并计入，可能造成「去掉哈希后缀时反而假绿」。
      const pFiles = files.filter((f) => f.startsWith('col_' + stamp));
      const distinct = new Set(pFiles).size >= 2;
      console.log(`  [DEBUG] Q decision=${resultQ.decision}, 本次col_文件数=${pFiles.length}, 目录内col_文件总数=${files.filter((f) => f.startsWith('col_')).length}`);
      // 两个同形 id 必须落在不同文件上，且互不干扰
      return distinct && resultQ.decision === 'trigger';
    }
  },
  {
    name: '回归: Windows 保留设备名不会导致状态保存异常',
    test: () => {
      // CON / NUL / AUX / COM1 在 NTFS 上即使带扩展名也无法创建；
      // 旧实现会让 writeFileSync 抛异常 → 引擎静默失效。
      const names = ['CON', 'NUL', 'aux', 'COM1'];
      const results = names.map((n) => {
        try {
          const eng = TriggerEngine.create(n + '-' + Date.now());
          eng.triggerManager.state.save();
          return true;
        } catch (e) {
          return false;
        }
      });
      console.log(`  [DEBUG] 保留名保存结果=${results.join(',')}`);
      return results.every(Boolean);
    }
  },
  {
    name: '回归: create 与 shouldTrigger 必须是同一个会话',
    test: () => {
      // 旧实现：L1 读 create(sessionId) 的状态，L2 却读 shouldTrigger 第三参的会话，
      // 不传第三参时 L2 会去读 'default'，造成跨会话历史污染。
      const sid = 'unify-' + Date.now();
      const engine = TriggerEngine.create(sid);
      const r = engine.shouldTrigger('run dispatch workflow', { complexity: 1.2 });
      console.log(`  [DEBUG] engine.sessionId=${engine.sessionId}, score=${r.score}`);
      return engine.sessionId === sid && r.score === 38;
    }
  },
  {
    name: '回归: 反馈学习真正影响触发阈值',
    test: () => {
      const sid = 'fb-' + Date.now();
      const engine = TriggerEngine.create(sid);
      // 先触发一次（占掉最短间隔），再验证反馈调整确实抬高阈值
      const first = engine.shouldTrigger('run dispatch workflow', { sessionId: sid }, sid);
      const fb = engine.recordFeedback('negative');
      const adj = fb.thresholdAdjustment;
      console.log(`  [DEBUG] first=${first.decision}, feedbackAdj=${adj}, fb=${JSON.stringify(fb.feedback)}`);
      // 负反馈 → 阈值上调（adj > 0）
      return first.decision === 'trigger' && adj > 0 &&
        engine.triggerManager.state.feedback.negative === 1;
    }
  },
  {
    name: '激活: 只读调研意图不进入工作流门禁',
    test: () => {
      // 占位卡恒为 read_only 档（scope=[]），其待补项 scope/acceptance/verify.cmd
      // 对只读任务永远无法满足 → 会把会话永久锁死。所以只读意图不得激活。
      const roCases = [
        'explain how the trigger engine works',
        '请分析一下这个仓库的结构',
        '看看这个模块是干什么的',
      ];
      const mutatingCases = [
        'analyze and refactor the trigger engine',
        '分析并修复这个 bug',
      ];
      const roOk = roCases.every((m) => TriggerEngine.isReadOnlyIntent(m) === true);
      const mutOk = mutatingCases.every((m) => TriggerEngine.isReadOnlyIntent(m) === false);
      // 且实际不产生激活计划
      const sid = 'ro-' + Date.now();
      const engine = TriggerEngine.create(sid);
      const res = engine.shouldTrigger('explain how the trigger engine works', { sessionId: sid }, sid);
      const plan = res.activationPlan;
      console.log(`  [DEBUG] ro判定=${roOk} 改动词不误伤=${mutOk} plan.activated=${plan && plan.activated}`);
      return roOk && mutOk && !!plan && plan.activated === false;
    }
  },
  {
    name: '中文: 流程词能触发、普通中文需求不误触发',
    test: () => {
      // 默认词表原本只有英文（work/flow/carlos/dispatch/trigger/start/run/execute），
      // 中文需求全部 0 分 → 触发器对中文用户等于不存在。
      // 现在内置中文流程词，但必须保证普通开发需求不误触发。
      const shouldTrigger = [
        '走门禁流程，执行 dispatch 任务',
        '执行工作流',
        '开始门禁',
        '派发 executor 子代理',
        '我要走工作流审计一下这个改动',
      ];
      const shouldNotTrigger = [
        '给登录接口加一个参数校验，如果缺少参数返回 400 错误',
        '修复一下用户头像上传失败的问题',
        '帮我看下这个函数为什么超时',
        '重构一下支付模块',
        '写一个单元测试',
      ];
      const score = (m) => {
        const sid = 'cn-' + Date.now() + Math.random();
        return TriggerEngine.create(sid).shouldTrigger(m, { sessionId: sid }, sid);
      };
      const trigOk = shouldTrigger.every((m) => score(m).decision === 'trigger');
      const notOk = shouldNotTrigger.every((m) => score(m).decision !== 'trigger');
      console.log(`  [DEBUG] 中文触发=${trigOk} 普通需求不误触发=${notOk}`);
      return trigOk && notOk;
    }
  },
  {
    name: '回归: trigger-config.json 词表是追加不是替换',
    test: () => {
      // 背景：配置加载原为浅合并 `{...DEFAULT_CONFIG, ...loaded}`，
      // 用户一旦写 `keywordWeights` 就会把默认词表（含内置中文流程词）**整个丢掉** ——
      // 「我只是加一个自定义词」反而让所有默认词失效，中文场景重新变回 0 分。
      // 正确语义：keywordWeights 合并（用户词覆盖同名项），词表数组追加去重。
      //
      // trigger.js 在**模块加载时**读配置，所以必须用独立进程测（换 CARLOS_FLOW_HOME）。
      const home = join(tmpdir(), `carlos-flow-cfg-${Date.now()}-${process.pid}`);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'trigger-config.json'),
        JSON.stringify({
          keywordWeights: { '评审': 3 },
          readOnlyIntentWords: ['讲一下'],
          mutatingActionWords: ['改造一下'],
        }),
        'utf8'
      );
      const probe = `
        const { TriggerEngine } = await import(${JSON.stringify(pathToFileURL(TRIGGER_PATH).href)});
        const c = TriggerEngine.getConfig();
        console.log(JSON.stringify({
          hasBuiltinZh: c.keywordWeights['门禁'] !== undefined,
          hasBuiltinEn: c.keywordWeights['work'] !== undefined,
          hasUser: c.keywordWeights['评审'] === 3,
          roHasDefault: c.readOnlyIntentWords.includes('explain'),
          roHasUser: c.readOnlyIntentWords.includes('讲一下'),
          mutHasDefault: c.mutatingActionWords.includes('修复'),
          mutHasUser: c.mutatingActionWords.includes('改造一下'),
        }));
      `;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        env: { ...process.env, CARLOS_FLOW_HOME: home },
        encoding: 'utf8',
      });
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
      if (!r.stdout || !r.stdout.trim()) {
        console.log(`  [DEBUG] 子进程无输出: ${(r.stderr || '').slice(0, 200)}`);
        return false;
      }
      const c = JSON.parse(r.stdout.trim().split('\n').pop());
      console.log(`  [DEBUG] 配置合并: ${JSON.stringify(c)}`);
      return c.hasBuiltinZh && c.hasBuiltinEn && c.hasUser
        && c.roHasDefault && c.roHasUser && c.mutHasDefault && c.mutHasUser;
    }
  },
  {
    name: '回归: CARLOS_FLOW_HOME 的 ~ 会被展开（不落到字面 ~ 目录）',
    test: () => {
      // 背景：README 让用户写 CARLOS_FLOW_HOME=~/.carlos-flow，但此前**没有展开** ——
      // path.normalize("~/.carlos-flow") 只是把斜杠换成反斜杠，路径仍是**字面量**，
      // 于是状态/审计链被写到「当前工作目录下的一个名叫 ~ 的目录」里（Windows 实测
      // FLOW_HOME = ~\\.carlos-flow），位置诡异、极易丢失。
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const probe = `
        import fs from 'node:fs';
        import { pathToFileURL } from 'node:url';
        const REPO = ${JSON.stringify(REPO_ROOT)};
        const { FLOW_HOME } = await import(pathToFileURL(REPO + '/src/state.js').href);
        console.log(JSON.stringify({
          expanded: !FLOW_HOME.startsWith('~') && !FLOW_HOME.includes('/~'),
          inHome: ${JSON.stringify(home)} ? FLOW_HOME.startsWith(${JSON.stringify(home)}) : true,
          flowHome: FLOW_HOME,
        }));
      `;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        env: { ...process.env, CARLOS_FLOW_HOME: '~/.carlos-flow' },
        encoding: 'utf8',
      });
      if (!r.stdout || !r.stdout.trim()) {
        console.log(`  [DEBUG] 子进程无输出: ${(r.stderr || '').slice(0, 160)}`);
        return false;
      }
      const c = JSON.parse(r.stdout.trim().split('\n').pop());
      console.log(`  [DEBUG] ~ 展开: ${JSON.stringify(c)}`);
      return c.expanded && c.inHome;
    }
  },
  {
    name: '回归: trigger-config 非法值不弄崩触发引擎',
    test: () => {
      // 背景：配置加载原为浅合并，null / 数组 / 非法 JSON 会让 config.keywordWeights
      // 变成非法值 → buildKeywordIndex() 的 Object.entries(null) 抛 TypeError →
      // 触发引擎在该进程内**每次调用都失败**（客户端 catch 掉 → 静默失去自动触发）。
      // 现在：类型不对就丢弃用户值回退默认表；JSON 非法则整体回退并告警。
      const badConfigs = [
        '{"keywordWeights": null}',
        '{"keywordWeights": [1,2]}',
        '{"readOnlyIntentWords": "not-array"}',
        '{invalid json',
      ];
      for (const raw of badConfigs) {
        const home = join(tmpdir(), `carlos-flow-badcfg-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'trigger-config.json'), raw, 'utf8');
        const probe = `
          const { TriggerEngine } = await import(${JSON.stringify(pathToFileURL(TRIGGER_PATH).href)});
          const c = TriggerEngine.getConfig();
          const r = TriggerEngine.create('badcfg').shouldTrigger('走门禁流程', {});
          console.log(JSON.stringify({
            kwOk: !!(c.keywordWeights && typeof c.keywordWeights === 'object' && !Array.isArray(c.keywordWeights)),
            zh: c.keywordWeights && c.keywordWeights['门禁'] !== undefined,
            works: !!r.decision,
          }));
        `;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
          env: { ...process.env, CARLOS_FLOW_HOME: home },
          encoding: 'utf8',
        });
        try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
        if (!r.stdout || !r.stdout.trim()) {
          console.log(`  [DEBUG] 子进程无输出（配置 ${raw}）: ${(r.stderr || '').slice(0, 160)}`);
          return false;
        }
        const c = JSON.parse(r.stdout.trim().split('\n').pop());
        console.log(`  [DEBUG] 配置 ${raw} → ${JSON.stringify(c)}`);
        if (!(c.kwOk && c.zh && c.works)) return false;
      }
      return true;
    }
  },
  {
    name: '回归: reset("*") 可重置全部会话状态',
    test: () => {
      const sid = 'rst-' + Date.now();
      TriggerEngine.create(sid).shouldTrigger('run dispatch workflow', { sessionId: sid }, sid);
      const dir = join(
        process.env.CARLOS_FLOW_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.carlos-flow'),
        'trigger-state'
      );
      const before = existsSync(dir) ? readdirSync(dir).length : 0;
      TriggerEngine.reset('*');
      const after = existsSync(dir) ? readdirSync(dir).length : 0;
      console.log(`  [DEBUG] reset 前=${before} 文件, 后=${after} 文件`);
      return after < before || after === 0;
    }
  },
];

// 运行测试
async function runTests() {
  console.log('\n🧪 Carlos Flow 智能触发引擎 E2E 测试\n');
  console.log('='.repeat(60));

  // 加载触发引擎
  try {
    TriggerEngine = await loadTriggerEngine();
    console.log('✅ 触发引擎加载成功');
  } catch (error) {
    console.error('❌ 触发引擎加载失败:', error.message);
    process.exit(1);
  }

  for (const { name, test, debug = false } of testCases) {
    results.total++;
    try {
      // 同步/异步支持
      const result = await test();
      if (result) {
        results.pass.push(name);
        console.log(`✅ ${name}`);
      } else {
        results.fail.push(name);
        console.log(`❌ ${name} (验证失败)`);
      }
    } catch (error) {
      results.fail.push(name);
      results.warnings.push(`${name}: ${error.message}`);
      console.log(`❌ ${name} (错误: ${error.message})`);
    }
  }

  // 输出总结
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 测试总结\n');
  console.log(`总测试数: ${results.total}`);
  console.log(`✅ 通过: ${results.pass.length}`);
  console.log(`❌ 失败: ${results.fail.length}`);
  console.log(`📝 警告: ${results.warnings.length}`);
  
  const passRate = (results.pass.length / results.total * 100).toFixed(1);
  console.log(`📈 通过率: ${passRate}%`);

  if (results.fail.length > 0) {
    console.log('\n❌ 失败用例:');
    for (const name of results.fail) {
      console.log(`  - ${name}`);
    }
  }

  if (results.warnings.length > 0) {
    console.log('\n⚠️ 警告:');
    for (const warn of results.warnings) {
      console.log(`  - ${warn}`);
    }
  }

  const success = results.fail.length === 0;
  if (success) {
    console.log('\n🎉 所有测试通过！');
  } else {
    console.log('\n⚠️ 部分测试失败，请检查');
  }

  // 保存报告
  try {
    writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2));
    console.log(`\n📁 详细结果已保存至: ${REPORT_FILE}`);
  } catch (e) {
    console.log(`\n⚠️ 报告保存失败: ${e.message}`);
  }

  process.exit(success ? 0 : 1);
}

// 运行测试
runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
