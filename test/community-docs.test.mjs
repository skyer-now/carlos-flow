import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const hasPlaceholderEmail = text => /[\w.+-]+@<YOUR_DOMAIN>/i.test(text);

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'GitHub Issue template needs YAML frontmatter');
  const entries = match[1].split(/\r?\n/).map(line => {
    const field = line.match(/^([a-z]+): (.+)$/);
    assert.ok(field, `unexpected metadata line: ${line}`);
    const raw = field[2];
    // 模板只使用单行普通字符串或 JSON 双引号字符串，避免复杂 YAML 语法。
    assert.ok(raw.startsWith('"') || !/[:#{}\[\]&*!|>'"%@`]/.test(raw));
    return [field[1], raw.startsWith('"') ? JSON.parse(raw) : raw];
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
  return Object.fromEntries(entries);
}

test('security policy follows the latest release instead of a stale version table', () => {
  const text = read('SECURITY.md');
  assert.match(text, /releases\/latest/);
  assert.match(text, /package\.json/);
  assert.doesNotMatch(text, /2\.7\.x.*当前发布版/);
  assert.equal(hasPlaceholderEmail(text), false);
  assert.match(text, /security\/advisories\/new/);
  assert.match(text, /入口暂时不可用/);
  assert.match(text, /请勿.*公开 Issue/);
});

test('community conduct does not invent an email, GitHub DM or private Issue channel', () => {
  const text = read('CODE_OF_CONDUCT.md');
  assert.equal(hasPlaceholderEmail(text), false);
  assert.doesNotMatch(text, /GitHub 私信任意维护者|所有举报将\*\*保密处理/);
  assert.match(text, /Report content/);
  assert.match(text, /Issue 是公开的，不是保密渠道/);
  assert.match(text, /SECURITY\.md/);
});

test('placeholder email detection has positive and negative controls', () => {
  assert.equal(hasPlaceholderEmail('security@<YOUR_DOMAIN>'), true);
  assert.equal(hasPlaceholderEmail('conduct@<YOUR_DOMAIN>'), true);
  assert.equal(hasPlaceholderEmail('本项目不提供联系邮箱'), false);
});

test('Issue templates have valid simple YAML metadata and required guidance', () => {
  for (const file of ['bug_report.md', 'feature_request.md']) {
    const text = read(`.github/ISSUE_TEMPLATE/${file}`);
    const meta = frontmatter(text);
    assert.deepEqual(Object.keys(meta).sort(), ['about', 'assignees', 'labels', 'name', 'title']);
    for (const key of ['name', 'about', 'title']) assert.ok(meta[key].trim());
    assert.equal(meta.labels, '');
    assert.equal(meta.assignees, '');
    assert.match(text, /版本/);
    assert.match(text, /Windows/);
    assert.match(text, /SECURITY\.md/);
    assert.match(text, /个人信息/);
  }
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.md');
  assert.match(bug, /Node\.js/);
  assert.match(bug, /复现步骤/);
  assert.match(bug, /脱敏日志/);
});

test('PR checklist requests real test evidence and scope/security review', () => {
  const text = read('.github/pull_request_template.md');
  for (const phrase of ['实际运行的命令和结果', '未运行的检查及原因', '改动只包含', 'fail-closed', 'Windows']) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test('Glama declares the official schema and only the existing maintainer', () => {
  const config = JSON.parse(read('glama.json'));
  assert.equal(config.$schema, 'https://glama.ai/mcp/schemas/server.json');
  assert.deepEqual(config.maintainers, ['skyer-now']);
  assert.equal(new Set(config.maintainers).size, config.maintainers.length);
  for (const name of config.maintainers) assert.match(name, /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i);
});
