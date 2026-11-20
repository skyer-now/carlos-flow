import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectProjectTestCommand } from '../src/card.js';
import { generateQASheet } from '../ui/narrator.js';

describe('TASK-101 到 TASK-104 自动验证推断与质检单生成器实测', () => {
  describe('TASK-101: 工程技术栈自探测 (detectProjectTestCommand)', () => {
    it('Node.js 项目识别 package.json 中的 scripts.test', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-node-'));
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        scripts: { test: 'vitest run' }
      }));
      const cmd = detectProjectTestCommand(tmp);
      assert.equal(cmd, 'npm test');
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('Python 项目识别 pytest.ini / tests 目录', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-python-'));
      fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]\n');
      const cmd = detectProjectTestCommand(tmp);
      assert.equal(cmd, 'pytest');
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('Rust 项目识别 Cargo.toml', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-rust-'));
      fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "test"');
      const cmd = detectProjectTestCommand(tmp);
      assert.equal(cmd, 'cargo test');
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('Go 项目识别 go.mod', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-go-'));
      fs.writeFileSync(path.join(tmp, 'go.mod'), 'module test\n');
      const cmd = detectProjectTestCommand(tmp);
      assert.equal(cmd, 'go test ./...');
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('无测试套件的项目安全返回 null', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-empty-'));
      const cmd = detectProjectTestCommand(tmp);
      assert.equal(cmd, null);
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe('TASK-103: 完工电子质检交付单生成 (generateQASheet)', () => {
    it('生成结构完整且包含5大维度的质检单', () => {
      const mockState = {
        card: {
          goal: '重构登录模块参数校验',
          quote: '修改 auth.js 里的参数校验逻辑',
          scope: ['src/auth.js', 'src/login.js'],
          new_files: ['src/validator.js'],
          verify: { cmd: 'npm test' }
        },
        last_verify: {
          cmd: 'npm test',
          exitCode: 0,
          output_hash: 'abcdef1234567890abcdef1234567890'
        },
        audit_axes: {
          standards: { verdict: 'PASS', evidence: '代码无异味，命名规范' },
          spec: { verdict: 'PASS', evidence: '验收项全部满足' }
        }
      };

      const sheet = generateQASheet(mockState, '全部测试通过，建议合入');
      assert.ok(sheet.includes('Carlos 完工电子质检交付单'));
      assert.ok(sheet.includes('重构登录模块参数校验'));
      assert.ok(sheet.includes('src/auth.js'));
      assert.ok(sheet.includes('src/validator.js'));
      assert.ok(sheet.includes('npm test'));
      assert.ok(sheet.includes('Standards 规范轴'));
      assert.ok(sheet.includes('Spec 验收轴'));
      assert.ok(sheet.includes('恢复重来'));
      assert.ok(sheet.includes('审查员附注'));
    });
  });
});
