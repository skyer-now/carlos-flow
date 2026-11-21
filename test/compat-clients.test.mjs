import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const CLIENT = path.join(ROOT, 'client', 'carlos.js');

describe('WorkBuddy / Codex / Trae / Qoder 多客户端兼容性与 init 命令实测', () => {
  it('1. 验证新模板文件存在且包含合法占位符', () => {
    const templates = [
      'templates/workbuddy/mcp.json',
      'templates/codex/config.toml',
      'templates/trae/mcp.json',
      'templates/qoder/mcp.json',
    ];
    for (const rel of templates) {
      const full = path.join(ROOT, rel);
      assert.ok(fs.existsSync(full), `模板文件 ${rel} 必须存在`);
      const content = fs.readFileSync(full, 'utf8');
      assert.ok(content.includes('__ROOT__'), `${rel} 必须包含 __ROOT__ 占位符`);
      if (rel.endsWith('.json')) {
        // 验证去除占位符后为合法 JSON
        const sample = content.replace(/__ROOT__/g, 'D:/test/carlos').replace(/__FLOW_HOME__/g, 'C:/Users/test/.carlos-flow');
        assert.doesNotThrow(() => JSON.parse(sample), `${rel} 渲染后必须是合法 JSON`);
      }
    }
  });

  it('2. init --target trae / qoder: 正确在当前工作目录生成配置文件', () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'carlos-compat-proj-'));
    try {
      // 执行 init --target trae
      execFileSync(process.execPath, [CLIENT, 'init', '--target', 'trae'], {
        cwd: tmpProj,
        encoding: 'utf8',
      });
      const traePath = path.join(tmpProj, '.trae', 'mcp.json');
      assert.ok(fs.existsSync(traePath), '.trae/mcp.json 必须生成');
      const traeJson = JSON.parse(fs.readFileSync(traePath, 'utf8'));
      assert.ok(traeJson.mcpServers['carlos-flow'], '必须包含 carlos-flow 服务');

      // 执行 init --target qoder
      execFileSync(process.execPath, [CLIENT, 'init', '--target', 'qoder'], {
        cwd: tmpProj,
        encoding: 'utf8',
      });
      const qoderPath = path.join(tmpProj, '.qoder', 'mcp.json');
      assert.ok(fs.existsSync(qoderPath), '.qoder/mcp.json 必须生成');
      const qoderJson = JSON.parse(fs.readFileSync(qoderPath, 'utf8'));
      assert.ok(qoderJson.mcpServers['carlos-flow'], '必须包含 carlos-flow 服务');
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});
