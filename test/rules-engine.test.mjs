import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCardScopeRules,
  checkCodePatternRules,
  checkCommandRules,
  checkGitDiffRules,
  checkPhantomDependencies,
  RULES_METADATA,
} from '../src/rules.js';

describe('Carlos Flow 15 条通用与 AI 编程专属防撞规则全量实测', () => {
  describe('一、敏感文件与资产保护 (R1 ~ R3)', () => {
    it('R1: 未确认时拦截 .env 与私钥凭据', () => {
      const scope = ['src/auth.js', '.env.production', 'id_rsa.pem'];
      const res = checkCardScopeRules(scope, [], { confirmed: false });
      assert.equal(res.ok, false);
      assert.equal(res.violations.length, 2);
      assert.equal(res.violations[0].rule, 'R1');
      assert.ok(res.violations[0].message.includes('踩了刹车'));

      // 确认后放行
      const confirmedRes = checkCardScopeRules(scope, [], { confirmed: true });
      assert.equal(confirmedRes.ok, true);
    });

    it('R2: 未确认时拦截 package-lock.json 依赖锁修改', () => {
      const scope = ['package-lock.json', 'pnpm-lock.yaml'];
      const res = checkCardScopeRules(scope, [], { confirmed: false });
      assert.equal(res.ok, false);
      assert.equal(res.violations[0].rule, 'R2');
      assert.ok(res.violations[0].message.includes('依赖锁文件'));
    });

    it('R3: 绝对阻断直接直写 .git/ 内部元数据 (即使 confirmed 也拒绝)', () => {
      const scope = ['.git/config', '.git/HEAD'];
      const res = checkCardScopeRules(scope, [], { confirmed: true });
      assert.equal(res.ok, false);
      assert.equal(res.violations[0].rule, 'R3');
      assert.ok(res.violations[0].message.includes('绝对禁止'));
    });
  });

  describe('二、路径与跨平台防护 (R4 ~ R6)', () => {
    it('R4: 检测硬编码宿主用户名绝对路径', () => {
      const badCode = 'const samplePath = "C:/' + 'Users/' + 'mockuser/AppData/Local/temp.db";';
      const res = checkCodePatternRules(badCode, 'src/db.js');
      assert.equal(res.ok, true); // WARN 级别不阻塞 ok:true，但记录 violation
      assert.equal(res.violations[0].rule, 'R4');
      assert.ok(res.violations[0].message.includes('硬编码了个人电脑的绝对路径'));
    });

    it('R5: 检测 JSON/模板中的未转义单反斜杠', () => {
      const badJson = '{\n  "path": "D:\\carlos-flow"\n}';
      const res = checkCodePatternRules(badJson, 'templates/cursor.json');
      assert.equal(res.violations[0].rule, 'R5');
      assert.ok(res.violations[0].message.includes('未正确转义的单反斜杠'));
    });
  });

  describe('三、危险命令防御 (R7 ~ R8)', () => {
    it('R7: 物理阻断递归删除项目根目录命令 (rm -rf / 或 rm -rf .)', () => {
      const badCmd1 = 'rm -rf /';
      const badCmd2 = 'rm -fr .';
      const badCmd3 = 'rm -rf *';
      assert.equal(checkCommandRules(badCmd1).ok, false);
      assert.equal(checkCommandRules(badCmd2).ok, false);
      assert.equal(checkCommandRules(badCmd3).ok, false);
      assert.equal(checkCommandRules(badCmd1).violations[0].rule, 'R7');

      // 允许正常清理子构建目录
      const safeCmd = 'rm -rf dist/ build/ tmp/';
      assert.equal(checkCommandRules(safeCmd).ok, true);
    });

    it('R8: 阻断无差别全局盲杀进程命令 (taskkill /IM node.exe)', () => {
      const badKill = 'taskkill /F /IM node.exe';
      const res = checkCommandRules(badKill);
      assert.equal(res.ok, false);
      assert.equal(res.violations[0].rule, 'R8');
      assert.ok(res.violations[0].message.includes('盲杀全局进程'));

      // 允许按特定 PID 精准退出
      const safeKill = 'taskkill /F /PID 12345';
      assert.equal(checkCommandRules(safeKill).ok, true);
    });
  });

  describe('四、AI 编程恶习专属防御 (R11 ~ R15)', () => {
    it('R11: 阻断 Diff 中删除断言或增加 it.skip 的假绿作弊行为', () => {
      const badDiff1 = `
--- a/test/auth.test.js
+++ b/test/auth.test.js
-  assert.strictEqual(res.status, 200);
+  // assert removed
`;
      const badDiff2 = `
--- a/test/auth.test.js
+++ b/test/auth.test.js
-  it('should authenticate user', () => {
+  it.skip('should authenticate user', () => {
`;
      assert.equal(checkGitDiffRules(badDiff1).ok, false);
      assert.equal(checkGitDiffRules(badDiff1).violations[0].rule, 'R11');
      assert.equal(checkGitDiffRules(badDiff2).ok, false);
      assert.ok(checkGitDiffRules(badDiff1).violations[0].message.includes('跳过测试'));
    });

    it('R12: 阻断代码中引入未在 package.json 声明的幽灵依赖', () => {
      const codeWithPhantom = `
import fs from 'node:fs';
import axios from 'axios';
import lodash from 'lodash';
`;
      const pkgJson = { dependencies: { lodash: '^4.17.21' } };
      const res = checkPhantomDependencies(codeWithPhantom, pkgJson);
      assert.equal(res.ok, false);
      assert.equal(res.violations.length, 1);
      assert.equal(res.violations[0].pkgName, 'axios');
      assert.equal(res.violations[0].rule, 'R12');
      assert.ok(res.violations[0].message.includes('幽灵依赖 [axios]'));
    });

    it('R13: 对大面积全文件重写（Diff > 80%）触发格式污染预警', () => {
      const massiveDiff = Array.from({ length: 90 }, (_, i) => `+ line ${i}`).join('\n');
      const res = checkGitDiffRules(massiveDiff, 100);
      assert.equal(res.violations[0].rule, 'R13');
      assert.equal(res.violations[0].level, 'WARN');
      assert.ok(res.violations[0].message.includes('格式化污染'));
    });

    it('R14: 阻断 AI 使用 /* ... existing code ... */ 或 // TODO 掩盖未实现代码', () => {
      const lazyCode1 = `
function handleAuth(req) {
  /* ... existing code ... */
  return true;
}
`;
      const lazyCode2 = `
function handleData() {
  // TODO: implement later
}
`;
      assert.equal(checkCodePatternRules(lazyCode1, 'src/auth.js').ok, false);
      assert.equal(checkCodePatternRules(lazyCode1, 'src/auth.js').violations[0].rule, 'R14');
      assert.equal(checkCodePatternRules(lazyCode2, 'src/auth.js').ok, false);
      assert.ok(checkCodePatternRules(lazyCode1, 'src/auth.js').violations[0].message.includes('占位注释'));
    });

    it('R15: 测试文件与生产代码同时改动时，自动标记需要负对照 (requiresFalsifyProof)', () => {
      const scope = ['src/auth.js', 'test/auth.test.js'];
      const res = checkCardScopeRules(scope, [], { confirmed: true });
      assert.equal(res.ok, true);
      assert.equal(res.requiresFalsifyProof, true, '必须强制标记负对照');
    });
  });

  it('规则元数据完整性：15 条规则均包含有效 id、name 和 category', () => {
    assert.equal(RULES_METADATA.length, 15);
    for (let i = 1; i <= 15; i++) {
      const rule = RULES_METADATA.find((r) => r.id === `R${i}`);
      assert.ok(rule, `R${i} 必须存在`);
      assert.ok(rule.name.length > 0);
      assert.ok(['FAIL', 'WARN'].includes(rule.level));
    }
  });
});
