// rules.js — Carlos Flow 15 条通用与 AI 编程专属防撞规则引擎（Node ESM，零外部依赖）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 动态获取当前 FLOW_HOME 根目录（优先实时环境变量，回落至默认 ~/.carlos-flow）
 */
function resolveFlowHome() {
  const envHome = process.env.CARLOS_FLOW_HOME;
  if (envHome) {
    if (envHome.startsWith('~/') || envHome.startsWith('~\\') || envHome === '~') {
      return path.normalize(path.join(os.homedir(), envHome.slice(1)));
    }
    return path.normalize(envHome);
  }
  return path.normalize(path.join(os.homedir(), '.carlos-flow'));
}

/**
 * 15 条规则定义与元数据
 */
export const RULES_METADATA = [
  // 维度 1：通用资产与凭据防泄露规则 (R1 ~ R3)
  { id: 'R1', name: '密钥与凭据文件保护', category: 'asset_security', level: 'FAIL' },
  { id: 'R2', name: '核心包依赖锁文件保护', category: 'asset_security', level: 'FAIL' },
  { id: 'R3', name: 'Git 元数据目录物理隔离', category: 'asset_security', level: 'FAIL' },

  // 维度 2：跨平台与环境防踩坑规则 (R4 ~ R6)
  { id: 'R4', name: '个人绝对路径硬编码检测', category: 'portability', level: 'WARN' },
  { id: 'R5', name: 'Windows 反斜杠转义吞字符检测', category: 'portability', level: 'WARN' },
  { id: 'R6', name: '符号链接 / Junction 逃逸阻断', category: 'portability', level: 'FAIL' },

  // 维度 3：破坏性操作与进程安全规则 (R7 ~ R10)
  { id: 'R7', name: '危险递归根目录清空拦截', category: 'destructive_ops', level: 'FAIL' },
  { id: 'R8', name: '无差别全局盲杀进程拦截', category: 'destructive_ops', level: 'FAIL' },
  { id: 'R9', name: '后台常驻进程控制台黑窗防护', category: 'destructive_ops', level: 'WARN' },
  { id: 'R10', name: '临时文件退出回收清理', category: 'destructive_ops', level: 'WARN' },

  // 维度 4：AI 编程恶习专属防御规则 (R11 ~ R15)
  { id: 'R11', name: '降级断言凑假绿拦截', category: 'agent_anti_cheat', level: 'FAIL' },
  { id: 'R12', name: '幻觉引入幽灵依赖拦截', category: 'agent_anti_cheat', level: 'FAIL' },
  { id: 'R13', name: '盲目重写全局格式预警', category: 'agent_anti_cheat', level: 'WARN' },
  { id: 'R14', name: '注释掩盖未实现代码拦截', category: 'agent_anti_cheat', level: 'FAIL' },
  { id: 'R15', name: '测试文件修改与负对照证伪隔离', category: 'agent_anti_cheat', level: 'FAIL' },
];

// R1: 敏感凭据文件名与目录段
const CREDENTIAL_NAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed448',
  '.npmrc', '.netrc', '.pgpass', 'credentials', 'known_hosts', 'authorized_keys',
]);
const CREDENTIAL_EXTENSIONS = new Set(['.pem', '.key', '.keystore', '.p12', '.pfx', '.crt']);
const CREDENTIAL_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg']);

// R2: 依赖锁文件
const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'poetry.lock', 'composer.lock',
]);

/**
 * 灰度引擎运行时配置加载与获取
 * 模式说明：
 * - enforce: 生产严格模式（对 FAIL 规则执行硬阻断）
 * - shadow: 影子模式（仅记录审计日志，全量放行不阻断业务）
 * - bypass / disabled: 一键降级熔断（关闭所有拦截与规则校验）
 */
export function getRulesEngineConfig() {
  const envMode = (process.env.CARLOS_RULES_MODE || '').toLowerCase();
  const isKillSwitch = process.env.CARLOS_RULES_BYPASS === '1' || process.env.CARLOS_RULES_BYPASS === 'true';

  let config = {
    mode: isKillSwitch ? 'bypass' : (envMode || 'enforce'), // enforce | shadow | bypass
    strictRules: ['R3', 'R7', 'R8', 'R9'],
    confirmableRules: ['R1', 'R2', 'R12', 'R14', 'R15'],
    advisoryRules: ['R4', 'R5', 'R10', 'R13'],
  };

  const home = resolveFlowHome();
  const configFile = path.join(home, 'rules-config.json');
  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config = { ...config, ...parsed };
      if (isKillSwitch) config.mode = 'bypass';
    }
  } catch {
    // 忽略配置文件读取故障，退回默认值
  }

  return config;
}

/**
 * 记录规则指标与命中日志 (包含影子模式与硬拦截)
 */
export function recordRuleMetrics(event = {}) {
  const home = resolveFlowHome();
  const metricsDir = path.join(home, 'gate-audit', 'metrics');
  const metricsFile = path.join(metricsDir, 'rules-metrics.jsonl');
  const entry = {
    ts: new Date().toISOString(),
    ...event,
  };

  try {
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.appendFileSync(metricsFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // 避免指标写入故障阻断核心业务
  }
}

/**
 * 获取累计规则指标统计 (用于误拦率与漏拦率实时核算)
 */
export function getRulesMetricsSummary() {
  const home = resolveFlowHome();
  const metricsFile = path.join(home, 'gate-audit', 'metrics', 'rules-metrics.jsonl');
  const summary = {
    totalEvaluations: 0,
    blockedCount: 0,
    shadowViolations: 0,
    bypassedCount: 0,
    ruleHits: {},
    recentEvents: [],
  };

  if (!fs.existsSync(metricsFile)) {
    return summary;
  }

  try {
    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean);
    summary.totalEvaluations = lines.length;

    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.decision === 'BLOCKED') summary.blockedCount++;
        if (ev.decision === 'SHADOW_WARN') summary.shadowViolations++;
        if (ev.decision === 'BYPASS') summary.bypassedCount++;

        if (ev.rule) {
          summary.ruleHits[ev.rule] = (summary.ruleHits[ev.rule] || 0) + 1;
        }
      } catch {}
    }
    summary.recentEvents = lines.slice(-20).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}

  return summary;
}

/**
 * 检查任务卡中的文件白名单 (R1 ~ R3, R15)
 */
export function checkCardScopeRules(scope = [], newFiles = [], options = {}) {
  const config = getRulesEngineConfig();
  const allFiles = [...(scope || []), ...(newFiles || [])].map((s) => String(s).replace(/\\/g, '/'));
  const violations = [];

  // 一键降级熔断开关直接放行
  if (config.mode === 'bypass') {
    recordRuleMetrics({ hook: 'scope', decision: 'BYPASS', filesCount: allFiles.length });
    return { ok: true, violations: [], requiresFalsifyProof: false };
  }

  for (const file of allFiles) {
    const base = path.basename(file).toLowerCase();
    const ext = path.extname(file).toLowerCase();
    const segments = file.toLowerCase().split('/').filter(Boolean);

    // R3: Git 元数据目录隔离 (绝对禁止)
    if (file === '.git' || file.startsWith('.git/') || segments.includes('.git')) {
      violations.push({
        rule: 'R3',
        file,
        level: 'FAIL',
        message: '🛑 绝对禁止直接修改 Git 内部元数据（.git/ 目录）。',
        hint: '所有版本控制操作必须通过 Git 原生命令管理，AI 严禁直写 .git/ 内部文件。',
      });
      continue;
    }

    // R1: 密钥与凭据保护 (需 confirmed: true)
    const isCred = CREDENTIAL_NAMES.has(base) || CREDENTIAL_EXTENSIONS.has(ext) || segments.some((seg) => CREDENTIAL_SEGMENTS.has(seg));
    if (isCred && options.confirmed !== true) {
      violations.push({
        rule: 'R1',
        file,
        level: 'FAIL',
        message: '🛑 检测到修改敏感密钥或凭据文件，我先帮您踩了刹车。',
        hint: `文件 [${file}] 属于核心敏感凭据。如果您确认要修改，请在开卡时显式声明 confirmed=true。`,
      });
    }

    // R2: 依赖锁文件保护 (需 confirmed: true 或明确依赖任务)
    if (LOCK_FILES.has(base) && options.confirmed !== true) {
      violations.push({
        rule: 'R2',
        file,
        level: 'FAIL',
        message: '🛑 检测到 AI 尝试修改依赖锁文件（Lockfile），已自动拦截。',
        hint: `文件 [${file}] 控制项目依赖版本。日常功能开发不应随意改动它；若确实在升级依赖，请显式确认授权。`,
      });
    }
  }

  // R15: 测试文件与生产代码混合改动时，标记需要负对照 (falsify) 强校验
  const hasTests = allFiles.some((f) => /\.(test|spec)\.[a-zA-Z0-9]+$/i.test(f) || /(^|\/)tests?\//i.test(f));
  const hasSrc = allFiles.some((f) => !/\.(test|spec)\.[a-zA-Z0-9]+$/i.test(f) && !/(^|\/)tests?\//i.test(f));

  const hasFail = violations.some((v) => v.level === 'FAIL');

  // 影子模式：记录命中日志但对外返回 ok: true
  if (config.mode === 'shadow') {
    if (hasFail) {
      violations.forEach((v) => recordRuleMetrics({ hook: 'scope', decision: 'SHADOW_WARN', rule: v.rule, file: v.file }));
    } else {
      recordRuleMetrics({ hook: 'scope', decision: 'PASS', filesCount: allFiles.length });
    }
    return {
      ok: true,
      shadowOk: !hasFail,
      violations,
      requiresFalsifyProof: hasTests && hasSrc,
    };
  }

  // 生产严格模式
  if (hasFail) {
    violations.filter((v) => v.level === 'FAIL').forEach((v) => recordRuleMetrics({ hook: 'scope', decision: 'BLOCKED', rule: v.rule, file: v.file }));
  } else {
    recordRuleMetrics({ hook: 'scope', decision: 'PASS', filesCount: allFiles.length });
  }

  return {
    ok: !hasFail,
    violations,
    requiresFalsifyProof: hasTests && hasSrc,
  };
}

/**
 * 检查代码文本与配置模式 (R4, R5, R14)
 */
export function checkCodePatternRules(codeText = '', filePath = '') {
  const config = getRulesEngineConfig();
  if (config.mode === 'bypass') {
    return { ok: true, violations: [] };
  }

  const text = String(codeText || '');
  const violations = [];

  // R4: 个人宿主绝对路径硬编码检测
  const userPathRegex = /(?:[A-Za-z]:[\\\/](?:Users|home)[\\\/]|(?:\/Users\/|\/home\/))[^\s'"\\\/]+/i;
  if (userPathRegex.test(text) && !filePath.includes('.tmp') && !filePath.includes('test/')) {
    violations.push({
      rule: 'R4',
      level: 'WARN',
      message: '⚠️ 检测到代码中硬编码了个人电脑的绝对路径（如 C:\\Users\\...）。',
      hint: '写死个人主机路径会导致代码在 CI 或其他人电脑上运行报错，请改用相对路径或 path.join 解析。',
    });
  }

  // R5: Windows 反斜杠转义吞字符检测（在 JSON 模板或 JS 路径字面量中）
  if (filePath.endsWith('.json') || filePath.endsWith('.json.template')) {
    const rawBackslashRegex = /"(?:[^"\\]|\\.)*?\\(?:[^"\\/bfnrtu]|u(?![\da-fA-F]{4}))/g;
    if (rawBackslashRegex.test(text)) {
      violations.push({
        rule: 'R5',
        level: 'WARN',
        message: '⚠️ 检测到配置中包含未正确转义的单反斜杠（如 \\carlos）。',
        hint: '在 JSON/模板中未转义的反斜杠会被当成转义符吃掉，请改用平台无关的正斜杠 / 或双反斜杠 \\\\。',
      });
    }
  }

  // R14: 注释掩盖未实现代码拦截 (AI 偷懒占位符)
  const lazyPatterns = [
    /\/\*\s*\.{3}\s*(?:existing|rest of|remaining)\s*code\s*\.{3}\s*\*\//i,
    /\/\/\s*\.{3}\s*(?:remains unchanged|existing code)/i,
    /\/\/\s*TODO:\s*(?:implement later|add implementation here|fill in)/i,
    /#\s*\.{3}\s*(?:existing code|rest of implementation)/i,
  ];
  for (const pattern of lazyPatterns) {
    if (pattern.test(text)) {
      violations.push({
        rule: 'R14',
        level: 'FAIL',
        message: '🛑 检测到 AI 使用了占位注释掩盖未实现的核心代码。',
        hint: 'AI 留下了类似 /* ... existing code ... */ 或 // TODO 的占位符，已阻止该残缺代码合入。',
      });
      break;
    }
  }

  const hasFail = violations.some((v) => v.level === 'FAIL');
  if (config.mode === 'shadow' && hasFail) {
    violations.forEach((v) => recordRuleMetrics({ hook: 'code_pattern', decision: 'SHADOW_WARN', rule: v.rule, filePath }));
    return { ok: true, shadowOk: false, violations };
  }

  return {
    ok: !hasFail,
    violations,
  };
}

/**
 * 检查验证命令与命令行危险操作 (R7, R8, R9)
 */
export function checkCommandRules(cmdText = '') {
  const config = getRulesEngineConfig();
  if (config.mode === 'bypass') {
    recordRuleMetrics({ hook: 'command', decision: 'BYPASS', cmd: cmdText });
    return { ok: true, violations: [] };
  }

  const cmd = String(cmdText || '').trim();
  const violations = [];

  // R7: 危险递归根目录清空拦截（精准匹配 rm -rf /、rm -rf .、rm -rf *、rm -rf ~，不误杀 rm -rf ./dist 或 rm -rf build）
  const dangerousRmRegex = /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|-rf|-fr)\s+(\/|\.|\.\.|\*|~\/?|\.\/\*|\/\*)(\s+|$)/i;
  if (dangerousRmRegex.test(cmd)) {
    violations.push({
      rule: 'R7',
      level: 'FAIL',
      message: '🛑 检测到试图递归清空项目根目录或全局目录的危险删除命令。',
      hint: '严禁对整个项目根执行 rm -rf /* 或 rm -rf .，如需清理构建产物请指定具体子目录（如 rm -rf dist/）。',
    });
  }

  // R8: 无差别全局盲杀进程拦截
  const blindKillRegex = /(?:taskkill\s+(?:\/F\s+)?\/IM\s+(?:node|python|git|code|electron)\.exe|killall\s+(?:-9\s+)?(?:node|python|git))/i;
  if (blindKillRegex.test(cmd)) {
    violations.push({
      rule: 'R8',
      level: 'FAIL',
      message: '🛑 检测到尝试无差别盲杀全局进程的命令（如 taskkill /IM node.exe）。',
      hint: '盲杀进程会导致当前工作软件（如 OpenCode/Cindy）被意外强杀崩溃，请指定具体 PID 退出。',
    });
  }

  const hasFail = violations.some((v) => v.level === 'FAIL');
  if (config.mode === 'shadow' && hasFail) {
    violations.forEach((v) => recordRuleMetrics({ hook: 'command', decision: 'SHADOW_WARN', rule: v.rule, cmd }));
    return { ok: true, shadowOk: false, violations };
  }

  if (hasFail) {
    violations.forEach((v) => recordRuleMetrics({ hook: 'command', decision: 'BLOCKED', rule: v.rule, cmd }));
  } else {
    recordRuleMetrics({ hook: 'command', decision: 'PASS', cmd });
  }

  return {
    ok: !hasFail,
    violations,
  };
}

/**
 * 检查 Git Diff 变动特征 (R11 降级断言, R13 格式污染)
 */
export function checkGitDiffRules(diffText = '', totalOriginalLines = 100) {
  const config = getRulesEngineConfig();
  if (config.mode === 'bypass') {
    return { ok: true, violations: [] };
  }

  const diff = String(diffText || '');
  const violations = [];

  // R11: 降级断言凑假绿检测（检查被删除/修改的测试断言）
  const deletedAssertionRegex = /^-\s*(?:expect\(|assert\.|assert\(|self\.assert|it\.skip|describe\.skip|@pytest\.mark\.skip)/m;
  const addedSkipRegex = /^\+\s*(?:it\.skip|describe\.skip|@pytest\.mark\.skip|test\.skip)/m;
  
  if (deletedAssertionRegex.test(diff) || addedSkipRegex.test(diff)) {
    violations.push({
      rule: 'R11',
      level: 'FAIL',
      message: '🛑 检测到 Git Diff 中存在跳过测试（skip）或删除核心断言的作弊行为。',
      hint: 'AI 尝试通过删弱测试断言来凑测试全绿假象，已被门禁当场阻断，请真实修复业务代码。',
    });
  }

  // R13: 盲目重写全局格式预警（变动行数占全文件 80% 以上）
  const diffLines = diff.split('\n');
  const changedLines = diffLines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
  if (totalOriginalLines > 50 && (changedLines / totalOriginalLines) > 0.8) {
    violations.push({
      rule: 'R13',
      level: 'WARN',
      message: '⚠️ 检测到该文件的修改行数超过总行数的 80%，可能混入了全文件格式化污染。',
      hint: '过大的格式化 Diff 会严重干扰人类代码审查，建议仅保留核心业务改动的 Diff。',
    });
  }

  const hasFail = violations.some((v) => v.level === 'FAIL');
  if (config.mode === 'shadow' && hasFail) {
    violations.forEach((v) => recordRuleMetrics({ hook: 'diff', decision: 'SHADOW_WARN', rule: v.rule }));
    return { ok: true, shadowOk: false, violations };
  }

  return {
    ok: !hasFail,
    violations,
  };
}

/**
 * 检查依赖包引入是否属于幽灵依赖 (R12)
 */
export function checkPhantomDependencies(codeText = '', packageJson = {}) {
  const config = getRulesEngineConfig();
  if (config.mode === 'bypass') {
    return { ok: true, violations: [] };
  }

  const text = String(codeText || '');
  const declaredDeps = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
    // Node.js 内置核心模块白名单
    'fs', 'path', 'os', 'child_process', 'crypto', 'net', 'http', 'https', 'readline', 'url', 'util', 'events', 'stream', 'assert', 'buffer', 'process',
    'node:fs', 'node:path', 'node:os', 'node:child_process', 'node:crypto', 'node:net', 'node:http', 'node:https', 'node:readline', 'node:url', 'node:util', 'node:events', 'node:stream', 'node:assert', 'node:buffer', 'node:process', 'node:test',
  ]);

  const importRegex = /(?:import\s+(?:[\w*\s{},]+from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
  const violations = [];
  let m;

  while ((m = importRegex.exec(text)) !== null) {
    const pkg = m[1] || m[2];
    if (!pkg) continue;
    // 忽略相对路径和绝对路径引入
    if (pkg.startsWith('.') || pkg.startsWith('/') || /^[a-zA-Z]:/.test(pkg)) continue;
    
    // 提取包名（处理 @org/pkg 或 pkg/subpath）
    const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
    if (!declaredDeps.has(pkgName)) {
      violations.push({
        rule: 'R12',
        level: 'FAIL',
        pkgName,
        message: `🛑 检测到代码中引入了未在 package.json 声明的幽灵依赖 [${pkgName}]。`,
        hint: `AI 产生了依赖幻觉，试图引用未安装的包 [${pkgName}]。请先在 package.json 中安装或改用内置模块。`,
      });
    }
  }

  const hasFail = violations.length > 0;
  if (config.mode === 'shadow' && hasFail) {
    violations.forEach((v) => recordRuleMetrics({ hook: 'phantom_dep', decision: 'SHADOW_WARN', rule: v.rule, pkgName: v.pkgName }));
    return { ok: true, shadowOk: false, violations };
  }

  return {
    ok: !hasFail,
    violations,
  };
}
