import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const cli = resolve('client/carlos.js');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carlos-init-'));
  const home = join(root, 'home'); mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), CARLOS_FLOW_HOME: join(home, '.carlos-flow') };
  const run = (...args) => spawnSync(process.execPath, [cli, 'init', ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  return { root, home, env, run };
}
test('通用导出不产生令牌和宿主配置，规则不覆盖', () => {
  const f = fixture(); writeFileSync(join(f.root, 'AGENTS.md'), '用户正文');
  const r = f.run('--target', 'generic'); assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(readFileSync(join(f.root, 'carlos-mcp.json')));
  assert.equal(config.mcpServers['carlos-flow'].command, process.execPath);
  assert.ok(config.mcpServers['carlos-flow'].args[0].endsWith('src/index.js'));
  assert.equal(existsSync(join(f.home, '.carlos-flow', 'bridge-token')), false);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), '用户正文');
});
test('显式JSON容器安全合并并幂等', () => {
  const f = fixture(), file = join(f.root, 'host.json');
  const before = { theme: '用户', mcpServers: { other: { command: 'other' }, 'carlos-flow': { command: '保留' } } };
  writeFileSync(file, JSON.stringify(before));
  for (let i = 0; i < 2; i++) assert.equal(f.run('--target', 'custom-file', '--file', file, '--container', 'mcpServers').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file)), before);
});
test('坏JSON、容器类型冲突、未知容器拒绝且原样保留', () => {
  for (const text of ['{坏', '[]', '{"mcpServers":[]}', '{"mcpServers":null}', '{\n// 用户注释\n"mcpServers":{}\n}']) {
    const f = fixture(), file = join(f.root, 'host.json'); writeFileSync(file, text);
    assert.notEqual(f.run('--target', 'custom-path', '--path', file, '--container', 'mcpServers').status, 0);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
  const f = fixture(); assert.notEqual(f.run('--target', 'custom-file', '--file', 'x.json').status, 0);
});
test('文件及父目录链接拒写', () => {
  const f = fixture(), real = join(f.root, 'real'); mkdirSync(real);
  const link = join(f.root, 'linked'); symlinkSync(real, link, 'junction');
  assert.notEqual(f.run('--target', 'custom-file', '--file', join(link, 'x.json'), '--container', 'mcpServers').status, 0);
  assert.equal(existsSync(join(real, 'x.json')), false);
});
test('all只处理已存在标记，无标记仅通用导出；未知平台不猜路径', () => {
  const f = fixture(); assert.equal(f.run('--all').status, 0);
  assert.equal(existsSync(join(f.root, '.cursor')), false);
  assert.equal(existsSync(join(f.home, '.config', 'opencode')), false);
  assert.equal(f.run('--target', 'cindy').status, 0);
  assert.equal(existsSync(join(f.home, '.cindy')), false);
});
