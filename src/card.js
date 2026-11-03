// Carlos Flow - FLOW_CARD parser / repair / validator.
// Node ESM. Self-contained: no imports.

export const CARD_MARKER = 'FLOW_CARD:';

const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  'settings.json', 'settings.local.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'requirements.txt',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
]);

const SENSITIVE_SEGMENTS = new Set([
  'migrations', 'deploy', 'deployment', 'k8s', 'kube',
  '.github', '.gitlab', 'secrets', 'certs', 'terraform',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.env',
]);

export function isSensitive(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  const normalized = rel.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter((s) => s.length > 0);
  const base = segments.length ? segments[segments.length - 1] : normalized;
  if (SENSITIVE_NAMES.has(base)) return true;
  // 只检查目录段（不含最后一段文件名）：参考实现 flow-gate.py 用 parts[:-1]
  for (const seg of segments.slice(0, -1)) {
    if (SENSITIVE_SEGMENTS.has(seg)) return true;
  }
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }
  return false;
}

export function riskTier(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return 'read_only';
  if (scope.some((p) => isSensitive(p))) return 'sensitive';
  if (scope.length === 1) return 'single_file';
  return 'cross_module';
}

export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; }
    else if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function repairJson(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw;
  s = s.replace(/\u201C/g, '\\"').replace(/\u201D/g, '\\"');
  s = s.replace(/\u2018/g, "'").replace(/\u2019/g, "'");
  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/'([^']*)'/g, '"$1"');
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  return s;
}

export function parseCard(description) {
  if (typeof description !== 'string' || description.indexOf(CARD_MARKER) === -1) {
    return { card: null, error: null };
  }
  let marker = -1;
  let idx = 0;
  while (true) {
    const found = description.indexOf(CARD_MARKER, idx);
    if (found === -1) break;
    marker = found;
    idx = found + CARD_MARKER.length;
  }
  const markerPositions = [];
  {
    let p = 0;
    while (true) {
      const found = description.indexOf(CARD_MARKER, p);
      if (found === -1) break;
      markerPositions.push(found);
      p = found + CARD_MARKER.length;
    }
  }
  for (let mi = markerPositions.length - 1; mi >= 0; mi--) {
    const i = markerPositions[mi];
    const after = description.slice(i + CARD_MARKER.length).trim();
    const rawJson = extractJsonObject(after);
    if (!rawJson) continue;
    const candidates = [rawJson, repairJson(rawJson)];
    for (const c of candidates) {
      try {
        const result = JSON.parse(c);
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          return { card: sanitizeCard(result), error: null };
        }
      } catch (_) {}
    }
  }
  return { card: null, error: 'FLOW_CARD 解析失败，请按模板重写（单行、英文双引号、值里不要出现双引号）：FLOW_CARD:{"goal":"一句话目标","quote":"用户原话摘录","scope":["只准改的文件"],"acceptance":["可判定的验收标准"],"unknowns":[],"assumptions":[],"files":[{"path":"a/b.py","line":1}],"verify":{"cmd":"pytest -q tests/x.py"},"confirmed":false}' };
}


const BOUNDARY_TAG_RE = /<\/?\s*(record|scope|goal|quote|acceptance|unknowns|assumptions|files|structure|env|verify)\s*>/gi;

function stripBoundaryTags(str) {
  if (typeof str !== 'string') return str;
  // 剥离所有 HTML 标签，不仅仅是白名单标签
  return str.replace(/<[^>]*>/g, '').trim();
}

export function sanitizeCard(card) {
  if (!card || typeof card !== 'object') return card;
  const out = { ...card };
  if (typeof out.goal === 'string') out.goal = stripBoundaryTags(out.goal);
  if (typeof out.quote === 'string') out.quote = stripBoundaryTags(out.quote);
  for (const key of ['acceptance', 'unknowns', 'assumptions']) {
    if (Array.isArray(out[key])) {
      out[key] = out[key].map((v) => (typeof v === 'string' ? stripBoundaryTags(v) : v));
    }
  }
  if (Array.isArray(out.scope)) {
    out.scope = out.scope.map((v) => (typeof v === 'string' ? stripBoundaryTags(v) : v));
  }
  if (Array.isArray(out.files)) {
    out.files = out.files.map((entry) => {
      if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
        return { ...entry, path: stripBoundaryTags(entry.path) };
      }
      return entry;
    });
  }
  if (out.verify && typeof out.verify === 'object' && !Array.isArray(out.verify)) {
    const v = { ...out.verify };
    if (typeof v.cmd === 'string') v.cmd = stripBoundaryTags(v.cmd);
    out.verify = v;
  }
  for (const key of ['structure', 'env']) {
    const v = out[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nv = { ...v };
      for (const k of Object.keys(nv)) {
        if (typeof nv[k] === 'string') nv[k] = stripBoundaryTags(nv[k]);
      }
      out[key] = nv;
    }
  }
  return out;
}

export function validateCard(card, options) {
  const opts = options || {};
  const findings = [];
  const scopeRaw = card ? card.scope : undefined;
  if (scopeRaw !== undefined && scopeRaw !== null && !Array.isArray(scopeRaw)) {
    return {
      ok: false,
      reason: 'scope 必须是文件路径数组',
      findings: ['scope 必须是文件路径数组（不能是单个字符串）'],
      tier: riskTier([]),
    };
  }
  const scope = Array.isArray(scopeRaw) ? scopeRaw : [];
  const tier = riskTier(scope);

  for (const p of scope) {
    if (typeof p !== 'string' || p.trim() === '') {
      findings.push('scope 里有空路径');
      return { ok: false, reason: 'scope 中有无效路径，拒绝派发（锚点 veto）', findings, tier };
    }
  }

  if (typeof opts.scopeExists === 'function') {
    for (const p of scope) {
      if (!opts.scopeExists(p)) {
        findings.push('scope 路径不存在：' + p);
        return { ok: false, reason: 'scope 中有路径在磁盘上不存在，拒绝派发（锚点 veto）', findings, tier };
      }
    }
  }

  const quote = card && typeof card.quote === 'string' ? card.quote : null;
  const norm = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const qNorm = norm(quote);
  if (qNorm) {
    const msgs = Array.isArray(opts.userMessages) ? opts.userMessages : [];
    let anchored = false;
    for (const m of msgs) {
      if (norm(m).indexOf(qNorm) !== -1) { anchored = true; break; }
    }
    if (!anchored) {
      // 永不降级：数据源不可用时直接拒绝
      findings.push('quote 无法在用户原话中定位（防替用户编需求）');
      return { ok: false, reason: 'quote 锚点校验失败：数据源不可用或 quote 不是用户原话的子串，拒绝派发', findings, tier };
    }
  }

  const required = {
    read_only: ['goal', 'quote'],
    single_file: ['goal', 'quote', 'scope'],
    cross_module: ['goal', 'quote', 'scope', 'acceptance', 'files'],
    sensitive: ['goal', 'quote', 'scope', 'acceptance'],
  }[tier] || ['goal', 'quote'];
  for (const f of required) {
    const v = card ? card[f] : undefined;
    const missing = v === undefined || v === null ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'string' && v.trim() === '');
    if (missing) findings.push('缺少必填字段：' + f + '（风险档 ' + tier + '）');
  }

  if (tier === 'cross_module' || tier === 'sensitive') {
    const files = card && Array.isArray(card.files) ? card.files : [];
    for (const entry of files) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.line !== 'number') {
        findings.push('files 每一项都必须带 path 与 line');
        break;
      }
    }
  }

  const unknowns = card && Array.isArray(card.unknowns) ? card.unknowns : [];
  const assumptions = card && Array.isArray(card.assumptions) ? card.assumptions : [];
  if ((tier === 'cross_module' || tier === 'sensitive') && unknowns.length > 0 && assumptions.length === 0) {
    findings.push('WARN: unknowns 非空但无 assumptions（只提醒，不阻断）');
  }

  if (tier === 'sensitive' && opts.confirmed !== true) {
    return { ok: false, reason: '敏感路径未确认，需先向用户确认后再提交卡片', findings, tier };
  }

  const hard = findings.filter((f) => !f.startsWith('WARN:'));
  if (hard.length > 0) {
    return { ok: false, reason: '卡片不合规：' + hard.join('；'), findings, tier };
  }

  return { ok: true, reason: 'ok', findings, tier };
}
