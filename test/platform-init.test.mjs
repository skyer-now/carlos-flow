import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
function refused(result) {
  assert.equal(typeof result.status, 'number', result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /初始化拒绝/);
  assert.equal(result.stdout, '');
}
const cli = resolve('client/carlos.js');
const fixtures = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, {recursive: true, force: true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carlos-init-')); fixtures.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const env = { ...process.env, CARLOS_FLOW_MCP_ROOT: dirname(dirname(cli)), CARLOS_INIT_TARGET: '', HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), CARLOS_FLOW_HOME: join(home, '.carlos-flow') };
  const run = (...args) => spawnSync(process.execPath, [cli, 'init', ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { root, home, env, run };
}
test('通用导出不产生令牌和宿主配置，规则不覆盖', () => {
  const f = fixture(); writeFileSync(join(f.root, 'AGENTS.md'), '用户正文');
  const r = f.run('--target', 'generic'); assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(readFileSync(join(f.root, 'carlos-mcp.json')));
  assert.equal(config.mcpServers['carlos-flow'].command, process.execPath);
  assert.equal(config.mcpServers['carlos-flow'].args[0], join(dirname(dirname(cli)), 'src', 'index.js'));
  assert.equal(existsSync(join(f.home, '.carlos-flow', 'bridge-token')), false);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(JSON.parse(r.stdout), config);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), '用户正文');
});
test('显式JSON容器安全合并并幂等', () => {
  const f = fixture(), file = join(f.root, 'host.json');
  const before = { theme: '用户', mcpServers: { other: { command: 'other' }, 'carlos-flow': { command: '保留' } } };
  writeFileSync(file, JSON.stringify(before));
  const original = readFileSync(file);
  for (let i = 0; i < 2; i++) {
    assert.equal(f.run('--target', 'custom-file', '--file', file, '--container', 'mcpServers').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(file)), before);
    assert.deepEqual(readFileSync(file), original);
  }
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
test('新配置合并、两组别名与未知容器原字节保护', () => {
  for (const target of ['custom-file', 'custom-path']) {
    for (const flag of ['--file', '--path']) {
      const f = fixture(), file = join(f.root, 'host.json');
      writeFileSync(file, '{"theme":"用户","mcpServers":{"other":{"command":"保留"}}}');
      const r = f.run('--target', target, flag, file, '--container', 'mcpServers');
      assert.equal(r.status, 0, r.stderr);
      const value = JSON.parse(readFileSync(file));
      assert.equal(value.theme, '用户'); assert.equal(value.mcpServers.other.command, '保留');
      assert.equal(value.mcpServers['carlos-flow'].command, process.execPath);
      const bytes = readFileSync(file);
      assert.notEqual(f.run('--target', target, flag, file, '--container', '__proto__').status, 0);
      assert.deepEqual(readFileSync(file), bytes);
    }
  }
});
test('文件链接拒写且保留实际目标', (t) => {
  const f = fixture(), real = join(f.root, 'real.json'), link = join(f.root, 'link.json');
  writeFileSync(real, '{"用户":true}');
  try { symlinkSync(real, link, 'file'); } catch (e) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('宿主不允许创建文件链接，未验证此分支'); return; }
    throw e;
  }
  assert.notEqual(f.run('--target', 'custom-file', '--file', link, '--container', 'mcpServers').status, 0);
  assert.equal(readFileSync(real, 'utf8'), '{"用户":true}');
});
test('已有Cursor标记才合并，其余宿主与两份规则不覆盖', () => {
  const f = fixture(); mkdirSync(join(f.root, '.cursor'));
  writeFileSync(join(f.root, 'AI-DEV-CONSTRAINTS.md'), '用户约束');
  const r = f.run('--all'); assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(readFileSync(join(f.root, '.cursor', 'mcp.json'))).mcpServers['carlos-flow']);
  for (const target of ['opencode', 'qoder', 'claude', 'claude-code']) assert.equal(f.run('--target', target).status, 0);
  for (const dir of ['.qoder', '.claude', '.vscode', '.cline']) assert.equal(existsSync(join(f.root, dir)), false);
  assert.equal(readFileSync(join(f.root, 'AI-DEV-CONSTRAINTS.md'), 'utf8'), '用户约束');
  assert.deepEqual(readdirSync(f.home), []);
});
test('servers容器完整合并与原字节幂等', () => {
  const f = fixture(), file = join(f.root, 'host.json');
  writeFileSync(file, '{"主题":"用户","servers":{"other":{"command":"保留"}}}');
  const r = f.run('--target', 'custom-path', '--path', file, '--container', 'servers');
  assert.equal(r.status, 0, r.stderr);
  const value = JSON.parse(readFileSync(file));
  assert.equal(value.主题, '用户'); assert.equal(value.servers.other.command, '保留');
  assert.equal(value.servers['carlos-flow'].command, process.execPath);
  assert.equal(Object.hasOwn(value, 'mcpServers'), false);
  const bytes = readFileSync(file);
  assert.equal(f.run('--target', 'custom-file', '--file', file, '--container', 'servers').status, 0);
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readdirSync(f.root).sort(), ['home', 'host.json']);
});
test('两种容器失败明确回执且保留原字节', () => {
  for (const container of ['servers', 'mcpServers']) {
    for (const text of ['{坏', '[]', `{"${container}":null}`, `{"${container}":[]}`, `{"${container}":true}`, `{"${container}":{},/*注释*/"用户":true}`, `{"${container}":{},}`]) {
      const f = fixture(), file = join(f.root, 'host.json'); writeFileSync(file, text);
      refused(f.run('--target', 'custom-file', '--file', file, '--container', container));
      assert.equal(readFileSync(file, 'utf8'), text);
      assert.deepEqual(readdirSync(f.root).sort(), ['home', 'host.json']);
    }
  }
  const f = fixture(), file = join(f.root, 'host.json');
  writeFileSync(file, '{}');
  for (const args of [[], ['--container', 'unknown']]) refused(f.run('--target', 'custom-file', '--file', file, ...args));
  assert.equal(readFileSync(file, 'utf8'), '{}');
  const jsonc = join(f.root, 'host.jsonc'); writeFileSync(jsonc, '{}');
  refused(f.run('--target', 'custom-file', '--file', jsonc, '--container', 'servers'));
  assert.equal(readFileSync(jsonc, 'utf8'), '{}');
});
test('深层父链junction与链接点点路径均拒绝', () => {
  const f = fixture(), real = join(f.root, 'real'); mkdirSync(join(real, 'nested'), { recursive: true });
  const link = join(f.root, 'linked'); symlinkSync(real, link, 'junction');
  const file = join(real, 'nested', 'host.json'); writeFileSync(file, '{"用户":true}');
  refused(f.run('--target', 'custom-file', '--file', join(link, 'nested', 'host.json'), '--container', 'servers'));
  // 保留原始“链接/..”，不能先resolve再把链接证据抹掉。
  refused(f.run('--target', 'custom-file', '--file', link + '/../outside.json', '--container', 'servers'));
  assert.equal(existsSync(join(f.root, 'outside.json')), false);
  assert.equal(readFileSync(file, 'utf8'), '{"用户":true}');
});
// 只拦截真实文件API的注入时机；不伪造stat身份，不把攻击失败变成close失败。
function parentReplacement(phase) {
  const f = fixture(), parent = join(f.root, 'parent'), moved = join(f.root, 'moved'); mkdirSync(parent);
  const file = join(parent, 'host.json'); writeFileSync(file, '{"原配置":true}');
  const hook = join(f.root, 'race-hook.mjs');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSync = fs.fsyncSync, originalClose = fs.closeSync, originalOpen = fs.openSync, originalWrite = fs.writeSync;
let pending, once = false, syncCount = 0, closeCount = 0, attempts = 0, completed = 0;
const trace = (stage, details = {}) => originalWrite(2, 'CARLOS_RACE_TRACE ' + JSON.stringify({stage, ...details}) + '\\n');
const failure = (stage, error, details = {}) => trace(stage, {code: error.code, message: error.message, stack: error.stack, ...details});
trace('loaded', {phase: ${JSON.stringify(phase)}});
process.once('exit', (code) => trace('summary', {code, syncCount, closeCount, attempts, completed}));
const inject = () => {
  if (once) return;
  once = true; attempts++; trace('injection-start');
  let operation = 'rename';
  try {
    fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(moved)});
    trace('rename-complete'); operation = 'mkdir';
    fs.mkdirSync(${JSON.stringify(parent)});
    trace('mkdir-complete'); operation = 'write';
    fs.writeFileSync(${JSON.stringify(file)}, '并发文件不得覆盖');
    completed++; trace('injection-complete');
  } catch (error) {
    // 外部攻击者自己的错误只进证据，不改变原生open/close的返回语义。
    failure('injection-error', error, {operation});
  }
};
fs.openSync = function(...args) {
  if (${JSON.stringify(phase)} === 'before-lock' && String(args[0]) === ${JSON.stringify(file + '.carlos-init.lock')}) inject();
  return originalOpen(...args);
};
fs.fsyncSync = function(fd) {
  syncCount++; trace('fsync-start', {fd});
  try { originalSync(fd); } catch (error) { failure('fsync-error', error); throw error; }
  pending = fd; trace('fsync-complete', {fd});
};
fs.closeSync = function(fd) {
  closeCount++;
  try { originalClose(fd); } catch (error) { failure('close-error', error); throw error; }
  if (${JSON.stringify(phase)} === 'after-temp-close' && fd === pending) inject();
};
syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = '--import=' + pathToFileURL(hook).href;
  const child = f.run('--target', 'custom-file', '--file', file, '--container', 'servers');
  const diagnostic = JSON.stringify({
    phase, status: child.status, signal: child.signal,
    error: child.error ? { message: child.error.message, code: child.error.code, stack: child.error.stack } : null,
    stdout: child.stdout, stderr: child.stderr,
  }, null, 2);
  const events = (child.stderr || '').split(/\r?\n/).filter((line) => line.startsWith('CARLOS_RACE_TRACE '))
    .map((line) => JSON.parse(line.slice('CARLOS_RACE_TRACE '.length)));
  const summary = events.find((event) => event.stage === 'summary');
  assert.ok(events.some((event) => event.stage === 'loaded'), '注入模块未加载：' + diagnostic);
  assert.ok(summary, '缺少注入计数回执：' + diagnostic);
  assert.equal(summary.attempts, 1, '父目录替换未触发：' + diagnostic);
  assert.equal(child.error, undefined, diagnostic);
  assert.equal(typeof child.status, 'number', diagnostic);
  assert.equal(events.filter((event) => event.stage === 'close-error').length, 0, diagnostic);
  return {child, events, summary, diagnostic, file, moved};
}
function assertReplacedParentRejected({child, events, summary, diagnostic, file, moved}) {
  assert.equal(summary.completed, 1, '父目录替换未完成，不能冒充被生产检查拒绝：' + diagnostic);
  assert.equal(events.filter((event) => event.stage === 'injection-error').length, 0, diagnostic);
  assert.notEqual(child.status, 0, diagnostic);
  assert.match(child.stderr, /初始化拒绝.*父目录链在合并期间变化/, diagnostic);
  assert.equal(child.stdout, '', diagnostic);
  assert.ok(existsSync(join(moved, 'host.json')), '注入后原配置位置不符：' + diagnostic);
  assert.equal(readFileSync(join(moved, 'host.json'), 'utf8'), '{"原配置":true}', diagnostic);
  assert.equal(readFileSync(file, 'utf8'), '并发文件不得覆盖', diagnostic);
}
test('捕获父身份后、打开独占锁前实际替换父目录，必须拒绝发布', (t) => {
  const result = parentReplacement('before-lock');
  assertReplacedParentRejected(result);
  t.diagnostic('早期真实替换回执（不代表晚期覆盖）：' + JSON.stringify(result.summary));
});
test('写临时文件期间父目录被替换时拒绝发布', (t) => {
  const result = parentReplacement('after-temp-close');
  const {child, events, summary, diagnostic, file, moved} = result;
  const errors = events.filter((event) => event.stage === 'injection-error');
  if (process.platform === 'win32' && summary.completed === 0 && errors.length === 1 &&
      errors[0].operation === 'rename' && errors[0].code === 'EPERM' &&
      !events.some((event) => event.stage === 'rename-complete')) {
    // 只有明确的Windows攻击rename受阻可标未覆盖，不将OS阻止记作guard通过。
    assert.equal(child.status, 0, diagnostic);
    assert.equal(existsSync(moved), false, diagnostic);
    const config = JSON.parse(readFileSync(file));
    assert.equal(config.原配置, true, diagnostic);
    assert.equal(config.servers['carlos-flow'].command, process.execPath, diagnostic);
    t.skip('晚期成功替换未覆盖：Windows以EPERM阻止攻击rename；不是生产guard PASS。' + diagnostic);
    return;
  }
  assertReplacedParentRejected(result);
  t.diagnostic('晚期真实替换回执：' + JSON.stringify(summary));
});
// 故障发生在原生close调用之前；不再模拟“已经关闭却由攻击逻辑抛错”。
function publicationFault(mode) {
  const f = fixture(), file = join(f.root, 'host.json');
  const original = '{"用户配置":"保留"}'; writeFileSync(file, original);
  const hook = join(f.root, 'fault-hook.mjs');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, unlink = fs.unlinkSync, rename = fs.renameSync, write = fs.writeSync;
const kinds = new Map();
const counts = {injected:0, tempClose:0, nativeTempClose:0, lockClose:0, tempUnlink:0, lockUnlink:0, rename:0};
const emit = (stage) => write(2, 'CARLOS_FAULT_TRACE ' + JSON.stringify({stage, ...counts}) + '\\n');
const fail = (message, code) => { const error = new Error(message); error.code = code; throw error; };
fs.openSync = function(...args) {
  const fd = open(...args), name = String(args[0]);
  kinds.set(fd, name.endsWith('.carlos-init.lock') ? 'lock' : name.includes('.carlos-') && name.endsWith('.tmp') ? 'temp' : 'other');
  return fd;
};
fs.closeSync = function(fd) {
  const kind = kinds.get(fd);
  if (kind === 'temp') {
    counts.tempClose++;
    if (${JSON.stringify(mode)} === 'close' && counts.injected === 0) {
      counts.injected++; emit('close-failure-before-native'); fail('测试临时文件关闭失败', 'EIO');
    }
    counts.nativeTempClose++;
  }
  if (kind === 'lock') counts.lockClose++;
  const result = close(fd); kinds.delete(fd); return result;
};
fs.fsyncSync = function(fd) {
  if (${JSON.stringify(mode)} === 'cleanup' && kinds.get(fd) === 'temp') {
    counts.injected++; emit('sync-primary-failure'); fail('测试刷盘首错', 'EIO');
  }
  return sync(fd);
};
fs.unlinkSync = function(name) {
  if (String(name).endsWith('.carlos-init.lock')) counts.lockUnlink++;
  if (String(name).includes('.carlos-') && String(name).endsWith('.tmp')) {
    counts.tempUnlink++;
    if (${JSON.stringify(mode)} === 'cleanup') { emit('unlink-cleanup-failure'); fail('测试临时清理失败', 'EACCES'); }
  }
  return unlink(name);
};
fs.renameSync = function(...args) { counts.rename++; return rename(...args); };
process.once('exit', () => emit('summary'));
emit('loaded'); syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = '--import=' + pathToFileURL(hook).href;
  const child = f.run('--target', 'custom-file', '--file', file, '--container', 'servers');
  const diagnostic = JSON.stringify({mode, status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr, stdout: child.stdout});
  const lines = (child.stderr || '').split(/\r?\n/);
  const events = lines.filter((line) => line.startsWith('CARLOS_FAULT_TRACE ')).map((line) => JSON.parse(line.slice('CARLOS_FAULT_TRACE '.length)));
  const counts = events.find((event) => event.stage === 'summary');
  assert.ok(events.some((event) => event.stage === 'loaded'), diagnostic);
  assert.ok(counts, diagnostic); assert.equal(counts.injected, 1, diagnostic);
  assert.equal(child.error, undefined, diagnostic); assert.equal(child.status, 1, diagnostic);
  assert.equal(child.stdout, '', diagnostic); assert.equal(counts.rename, 0, diagnostic);
  assert.equal(counts.tempClose, 1, '临时描述符不能重复关闭：' + diagnostic);
  assert.equal(counts.lockClose, 1, '不能跳过锁关闭：' + diagnostic);
  assert.equal(counts.tempUnlink, 1, '不能跳过临时文件清理：' + diagnostic);
  assert.equal(counts.lockUnlink, 1, '单个清理失败不能跳过锁清理：' + diagnostic);
  assert.equal((child.stderr || '').includes('EBADF'), false, diagnostic);
  assert.equal(readFileSync(file, 'utf8'), original, diagnostic);
  assert.equal(existsSync(file + '.carlos-init.lock'), false, diagnostic);
  const additional = lines.filter((line) => line.startsWith('初始化清理附加信息：'))
    .flatMap((line) => JSON.parse(line.slice('初始化清理附加信息：'.length)));
  const remaining = readdirSync(f.root).filter((name) => name.includes('.carlos-') && name.endsWith('.tmp'));
  return {child, counts, diagnostic, lines, additional, remaining};
}
test('临时文件close失败仅关闭一次，保留首错且不发布', (t) => {
  const result = publicationFault('close');
  const {counts, diagnostic, lines, additional, remaining} = result;
  assert.equal(counts.nativeTempClose, 0, diagnostic);
  assert.deepEqual(lines.filter((line) => line.startsWith('初始化拒绝：')), [
    '初始化拒绝：测试临时文件关闭失败；请使用 --target generic 导出并手工核对。',
  ], diagnostic);
  if (remaining.length) {
    assert.equal(remaining.length, 1, diagnostic);
    assert.equal(additional.length, 1, diagnostic);
    assert.equal(additional[0].stage, '清理临时文件', diagnostic);
    assert.ok(['EPERM', 'EACCES'].includes(additional[0].code), diagnostic);
  } else assert.deepEqual(additional, [], diagnostic);
  t.diagnostic('关闭前故障注入回执：' + JSON.stringify(counts));
});
test('临时清理失败不覆盖刷盘首错，锁仍关闭并清理', (t) => {
  const {counts, diagnostic, lines, additional, remaining} = publicationFault('cleanup');
  assert.equal(counts.nativeTempClose, 1, diagnostic);
  assert.deepEqual(lines.filter((line) => line.startsWith('初始化拒绝：')), [
    '初始化拒绝：测试刷盘首错；请使用 --target generic 导出并手工核对。',
  ], diagnostic);
  assert.deepEqual(additional, [{stage: '清理临时文件', code: 'EACCES', message: '测试临时清理失败'}], diagnostic);
  assert.equal(remaining.length, 1, diagnostic);
  t.diagnostic('首错与清理故障独立回执：' + JSON.stringify(counts));
});
test('旧配置读取首错不被随后close失败覆盖，且不进入发布', (t) => {
  const f = fixture(), file = join(f.root, 'host.json');
  const original = Buffer.from('{"用户配置":"原字节保留"}'); writeFileSync(file, original);
  const hook = join(f.root, 'read-fault-hook.mjs');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, read = fs.readFileSync, close = fs.closeSync, rename = fs.renameSync, write = fs.writeSync;
let targetFd;
const counts = {readFailure:0, closeFailure:0, publishOpen:0, rename:0};
const stages = [];
const emit = (stage) => write(2, 'CARLOS_READ_FAULT_TRACE ' + JSON.stringify({stage, ...counts, stages}) + '\\n');
const fail = (message, code) => { const error = new Error(message); error.code = code; throw error; };
fs.openSync = function(...args) {
  const fd = open(...args), name = String(args[0]);
  if (name === ${JSON.stringify(file)}) targetFd = fd;
  if (name.endsWith('.carlos-init.lock') || name.includes('.carlos-') && name.endsWith('.tmp')) counts.publishOpen++;
  return fd;
};
fs.readFileSync = function(...args) {
  if (typeof args[0] === 'number' && args[0] === targetFd) {
    counts.readFailure++; stages.push('read-failure'); fail('测试旧配置读取首错', 'EIO');
  }
  return read(...args);
};
fs.closeSync = function(fd) {
  if (fd === targetFd) {
    // 在原生调用之前失败，描述符未被假装成“关闭后抛错”。
    counts.closeFailure++; stages.push('close-failure'); fail('测试旧配置关闭次错', 'EACCES');
  }
  return close(fd);
};
fs.renameSync = function(...args) { counts.rename++; return rename(...args); };
process.once('exit', () => emit('summary'));
emit('loaded'); syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = '--import=' + pathToFileURL(hook).href;
  const child = f.run('--target', 'custom-file', '--file', file, '--container', 'servers');
  const diagnostic = JSON.stringify({status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr, stdout: child.stdout});
  const lines = (child.stderr || '').split(/\r?\n/);
  const events = lines.filter((line) => line.startsWith('CARLOS_READ_FAULT_TRACE '))
    .map((line) => JSON.parse(line.slice('CARLOS_READ_FAULT_TRACE '.length)));
  assert.ok(events.some((event) => event.stage === 'loaded'), diagnostic);
  const summary = events.find((event) => event.stage === 'summary');
  assert.ok(summary, diagnostic);
  assert.deepEqual(summary, {stage: 'summary', readFailure: 1, closeFailure: 1, publishOpen: 0, rename: 0, stages: ['read-failure', 'close-failure']}, diagnostic);
  assert.equal(child.error, undefined, diagnostic); assert.equal(child.status, 1, diagnostic);
  assert.equal(child.stdout, '', diagnostic);
  assert.deepEqual(lines.filter((line) => line.startsWith('初始化拒绝：')), [
    '初始化拒绝：测试旧配置读取首错；请使用 --target generic 导出并手工核对。',
  ], diagnostic);
  const additional = lines.filter((line) => line.startsWith('初始化清理附加信息：'))
    .flatMap((line) => JSON.parse(line.slice('初始化清理附加信息：'.length)));
  assert.deepEqual(additional, [{stage: '关闭旧配置', code: 'EACCES', message: '测试旧配置关闭次错'}], diagnostic);
  assert.equal((child.stderr || '').includes('EBADF'), false, diagnostic);
  assert.deepEqual(readFileSync(file), original, diagnostic);
  assert.deepEqual(readdirSync(f.root).sort(), ['home', 'host.json', 'read-fault-hook.mjs'], diagnostic);
  t.diagnostic('读取首错与关闭次错回执：' + JSON.stringify(summary));
});
test('all只处理已存在标记，无标记仅通用导出；未知平台不猜路径', () => {
  const f = fixture(); assert.equal(f.run('--all').status, 0);
  assert.equal(existsSync(join(f.root, '.cursor')), false);
  assert.equal(existsSync(join(f.home, '.config', 'opencode')), false);
  assert.equal(f.run('--target', 'cindy').status, 0);
  assert.equal(existsSync(join(f.home, '.cindy')), false);
});
// ===== 平台识别与双向接入（先装平台 / 先装 Carlos 两种顺序）=====
const appData = (f) => join(f.home, 'AppData');
function seed(file, text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; }
test('discover 只读列出平台：含真实路径与格式，且零写入', () => {
  const f = fixture();
  const claude = seed(join(appData(f), 'Claude', 'claude_desktop_config.json'), '{"mcpServers":{}}');
  const codex = seed(join(f.home, '.codex', 'config.toml'), 'model = "x"\n');
  const before = readFileSync(claude); const codexBefore = readFileSync(codex);
  const r = f.run('--discover');
  assert.equal(r.status, 0, r.stderr);
  const { platforms } = JSON.parse(r.stdout);
  const byId = Object.fromEntries(platforms.map((p) => [p.id, p]));
  assert.equal(byId['claude-desktop'].installed, true);
  assert.equal(byId['claude-desktop'].injectable, true);
  assert.equal(byId['claude-desktop'].path, claude);
  assert.equal(byId.codex.installed, true);
  assert.equal(byId.codex.injectable, false);
  assert.match(byId.codex.note, /TOML/);
  assert.equal(byId['vscode-settings'].installed, false);
  assert.deepEqual(readFileSync(claude), before);
  assert.deepEqual(readFileSync(codex), codexBefore);
  assert.deepEqual(readdirSync(f.home).sort(), ['AppData', '.codex'].sort());
});
test('discover 不可混合其他参数', () => {
  const f = fixture();
  refused(f.run('--discover', '--target', 'generic'));
  refused(f.run('--discover', '--all'));
});
test('先装平台后装 Carlos：--target 直接接入已存在的严格JSON平台并保留其他服务', () => {
  const f = fixture();
  const file = seed(join(appData(f), 'Claude', 'claude_desktop_config.json'),
    JSON.stringify({ theme: '用户', mcpServers: { other: { command: 'other' } } }));
  const r = f.run('--target', 'claude-desktop');
  assert.equal(r.status, 0, r.stderr);
  const value = JSON.parse(readFileSync(file));
  assert.equal(value.theme, '用户');
  assert.equal(value.mcpServers.other.command, 'other');
  assert.equal(value.mcpServers['carlos-flow'].command, process.execPath);
  const out = JSON.parse(r.stdout);
  assert.equal(out.platform.status, 'injected');
  const bytes = readFileSync(file);
  assert.equal(f.run('--target', 'claude-desktop').status, 0);
  assert.deepEqual(readFileSync(file), bytes, '重复接入必须幂等');
});
test('VS Code 走 servers 容器；已装平台的容器不被混用', () => {
  const f = fixture();
  const file = seed(join(appData(f), 'Code', 'User', 'mcp.json'), '{"servers":{"other":{"command":"keep"}}}');
  const r = f.run('--target', 'vscode');
  assert.equal(r.status, 0, r.stderr);
  const value = JSON.parse(readFileSync(file));
  assert.equal(value.servers.other.command, 'keep');
  assert.equal(value.servers['carlos-flow'].command, process.execPath);
  assert.equal(Object.hasOwn(value, 'mcpServers'), false);
});
test('平台未安装时不猜路径、不创建目录，退回通用导出', () => {
  const f = fixture();
  const r = f.run('--target', 'qoder');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).platform.status, 'not_installed');
  assert.equal(existsSync(join(appData(f), 'Qoder')), false);
  assert.match(r.stderr, /未安装/);
});
test('JSONC/TOML 平台只输出片段，绝不改写原文件', () => {
  const f = fixture();
  const settings = seed(join(appData(f), 'Code', 'User', 'settings.json'), '{\n  // 用户注释\n  "a": 1,\n}\n');
  const toml = seed(join(f.home, '.codex', 'config.toml'), 'model = "x"\n');
  const sBefore = readFileSync(settings), tBefore = readFileSync(toml);
  for (const [target, file, before] of [['vscode-settings', settings, sBefore], ['codex', toml, tBefore]]) {
    const r = f.run('--target', target);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.platform.status, 'deferred');
    assert.ok(out.platform.snippet.mcpServers['carlos-flow'].command);
    assert.deepEqual(readFileSync(file), before, target + ' 原文件必须零改动');
    assert.match(r.stderr, /降级为手工导入/);
  }
});
test('--all 仅注入已存在的严格JSON平台，非严格格式与未安装平台零写入', () => {
  const f = fixture();
  const claude = seed(join(appData(f), 'Claude', 'claude_desktop_config.json'), '{"mcpServers":{"other":{"command":"keep"}}}');
  const settings = seed(join(appData(f), 'Code', 'User', 'settings.json'), '{\n  // 注释\n  "a": 1,\n}\n');
  const sBefore = readFileSync(settings);
  const r = f.run('--all');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const byId = Object.fromEntries(out.platforms.map((p) => [p.id, p]));
  assert.equal(byId['claude-desktop'].status, 'injected');
  assert.equal(byId['vscode-settings'].status, 'deferred');
  assert.equal(byId.codex.status, 'not_installed');
  assert.equal(JSON.parse(readFileSync(claude)).mcpServers.other.command, 'keep');
  assert.equal(JSON.parse(readFileSync(claude)).mcpServers['carlos-flow'].command, process.execPath);
  assert.deepEqual(readFileSync(settings), sBefore);
  for (const dir of ['Qoder', 'Trae', 'Trae CN']) assert.equal(existsSync(join(appData(f), dir)), false);
});
