// Carlos Flow - FLOW_CARD parser / repair / validator.
// Node ESM. 只依赖 Node 内置模块（fs），不依赖任何第三方包。

import fs from 'node:fs';
import { join, isAbsolute } from 'node:path';

export const CARD_MARKER = 'FLOW_CARD:';

const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  'settings.json', 'settings.local.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'requirements.txt',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
  // 凭证与私钥：与 protocol.js 保持同一份口径。
  // .ssh/id_rsa、.npmrc、.aws/credentials 这类凭证一律按敏感文件处理。
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed448',
  '.npmrc', '.netrc', '.pgpass', 'credentials', 'known_hosts', 'authorized_keys',
]);

const SENSITIVE_SEGMENTS = new Set([
  'migrations', 'deploy', 'deployment', 'k8s', 'kube',
  '.github', '.gitlab', 'secrets', 'certs', 'terraform',
  // 凭证目录：只检查目录段，'.ssh' 能拦住 .ssh/id_rsa。
  '.ssh', '.aws', '.gnupg', '.docker', '.azure', '.gcloud',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.env',
  // 密码库与签名材料：与 protocol.js 保持一致。
  '.kdbx', '.kdb', '.gpg', '.asc', '.crt', '.cer', '.der',
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

// new_files 的路径归一化：统一分隔符、去掉前导 "./" 与结尾 "/"。
// 卡片里的路径是「仓库根相对路径」，比较前必须先归一化，
// 否则 "./a/b" 与 "a/b" 会被当成两个不同的授权。
//
// 归一化 / 判定 helper 的可见性：
//   · normalizeRelPath / isAbsoluteLikePath / escapesRootPath / resolveRelUnderRoot
//     只在本文件内使用（外部没有调用方，导出即为 Speculative Generality）；
//   · realTargetPath / checkNewFilesBoundary 有**真实调用方**
//     （src/dispatch.js 的还原边界闸、src/index.js 的派发时复核），因此导出。
function normalizeRelPath(p) {
  if (typeof p !== 'string') return ''
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// 绝对路径判定（不依赖 node:path，card.js 保持零第三方依赖）。
//   · POSIX：/xxx
//   · Windows：C:/xxx 或 C:\xxx
//   · UNC：//server/share
function isAbsoluteLikePath(p) {
  if (typeof p !== 'string') return false;
  const s = p.replace(/\\/g, '/');
  return s.startsWith('/') || /^[A-Za-z]:\//.test(s) || /^[A-Za-z]:$/.test(s);
}

// 路径是否试图逃出根目录：出现 '..' 段即视为逃逸企图（保守拒绝）。
function escapesRootPath(p) {
  if (typeof p !== 'string') return false;
  return p.replace(/\\/g, '/').split('/').some((seg) => seg === '..');
}

// 把 root + rel 归一化成不含 '.'/'..' 的绝对形式（纯字符串实现）。
// 用于校验 new_files 解析后是否仍落在仓库根内。
//
// 绝对性必须保留：POSIX 下根是 "/repo" 时结果不能变成 "repo/..." ——
// 否则后面的真实路径解析会拿相对路径去解析，落点就判不准了。
function resolveRelUnderRoot(root, rel) {
  const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const joined = base + '/' + String(rel || '').replace(/\\/g, '/');
  const isAbs = joined.startsWith('/');
  const out = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

// ---- new_files 授权：唯一实现 ----------------------------------------------
//
// 为什么规则只有一份：授权规则要同时回答「路径在不在仓库内」「是不是已存在」
// 「父目录在不在」「和 scope 是不是同一路径」「大小写算不算同一个」，
// 多份副本必然漂移 —— 漂移的后果是**门禁口径自相矛盾**
//（落卡时判在仓库内、执行时判在仓库外）。
// 因此规则本体只放在这里，卡片层（validateCard）与提交层
// （src/index.js 的两条入口 / appendScope 分支）都调用同一份。
//
// 口径来源：docs/TOOL_CONTRACTS.md §3.1「新增：新文件授权（new_files）」。

// 路径键（**全仓唯一一把**，平台感知）：卡片校验层、越界检测层、scope 追加层共用。
//
// 为什么平台感知：win32 文件系统本身大小写不敏感，POSIX 敏感。
// 授权写法与落盘写法大小写不同时（授权 "Docs/Note.md"、落盘 "docs/note.md"）
// 两层必须给出同一个答案，否则已授权的文件会被误判成越界；
// 反过来在 POSIX 上，"docs/note.md" 与 "Docs/Note.md" 是**两个不同文件**，
// 折叠大小写会把真的越界当成授权内 —— 门禁只能收紧，不能放宽。
// 所以：win32 折叠大小写，其它平台原样保留。
export function pathKey(p) {
  const raw = String(p === null || p === undefined ? '' : p).replace(/\\/g, '/');
  const isAbs = raw.startsWith('/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const norm = (isAbs ? '/' : '') + out.join('/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

// 根路径前缀：拼接子路径时避免出现重复斜杠。
function rootPrefix(rootKeyValue) {
  return rootKeyValue.endsWith('/') ? rootKeyValue : rootKeyValue + '/';
}

// 目标路径的**真实落点**：沿途的符号链接 / junction 全部解析后的路径。
// 目标本身不存在时，用「最深的已存在祖先」的真实路径 + 余下路径段拼出。
//
// 返回 { path } 表示解析成功；返回 { error } 表示解析失败（非「不存在」），
// 调用方按保守口径拒绝 —— 解析不出来就证明不了落在仓库内。
//
// 为什么是**一份**：卡片层（授权路径的真实边界判定）与还原层（写回/删除前的
// 边界闸）都要回答「这条路径真实落在哪里」。两份实现一旦漂移，就会出现
// 「落卡时判定在仓库内、执行/还原时判定在仓库外」这种自相矛盾。
// src/dispatch.js 的 restoreGuard 调用这一份。
export function realTargetPath(target) {
  const raw = String(target === null || target === undefined ? '' : target).replace(/\\/g, '/');
  if (!raw) return { error: '无法定位已存在的祖先目录：' + String(target) };
  let cur = raw;
  const tail = [];
  for (;;) {
    // 盘符根要用 "C:/" 探测（"C:" 是「当前盘目录」，不是盘根）。
    const probe = /^[A-Za-z]:$/.test(cur) ? cur + '/' : cur;
    try {
      const real = fs.realpathSync(probe);
      let out = real.replace(/\\/g, '/');
      for (const seg of tail) out = out.replace(/\/+$/, '') + '/' + seg;
      return { path: out };
    } catch (e) {
      const code = e && e.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return { error: (e && e.message) ? e.message : String(e) };
      }
    }
    const idx = cur.lastIndexOf('/');
    if (idx < 0) break; // 单段相对路径：没有父目录可退
    const parent = idx === 0 ? cur.slice(0, 1) : cur.slice(0, idx);
    if (parent === cur) break;
    tail.unshift(cur.slice(idx + 1));
    cur = parent;
  }
  return { error: '无法定位已存在的祖先目录：' + String(target) };
}

// 仓库边界的**真实路径**判定：符号链接 / junction 逃逸防线。
//
// 目标路径按「沿途全部解析」后的真实落点判定是否仍在仓库根内：
// 父目录是符号链接或 junction 且指向仓库外时必须拒绝（否则文件会落到仓库外）。
// 真实路径解析失败（权限不足 / 特殊文件系统）按保守口径拒绝。
function realBoundaryCheck(rootAbs, targetAbs) {
  let rootReal = null;
  try {
    rootReal = fs.realpathSync(rootAbs);
  } catch (e) {
    return {
      ok: false,
      reason:
        '无法解析仓库根的真实路径（按保守口径拒绝）：' +
        ((e && e.message) ? e.message : String(e)),
    };
  }
  const target = realTargetPath(targetAbs);
  if (target.error) {
    return {
      ok: false,
      reason: '新文件授权路径无法解析真实路径（按保守口径拒绝）：' + target.error,
    };
  }
  const rootRealKey = pathKey(rootReal);
  const targetRealKey = pathKey(target.path);
  if (
    targetRealKey !== rootRealKey &&
    !targetRealKey.startsWith(rootPrefix(rootRealKey))
  ) {
    return {
      ok: false,
      reason:
        '新文件授权路径经符号链接或 junction 落在仓库之外：' +
        targetRealKey,
    };
  }
  return { ok: true };
}

// 已登记的新文件授权的**真实路径复核**（派发时用）。
//
// 为什么需要：授权（落卡）与执行（派发）之间可能隔很久 —— 期间授权路径的
// 父目录可能被换成指向仓库外的符号链接 / junction。落卡时安全，执行时
// 文件已经写到仓库外了。
// 口径与落卡时**完全一致**（同一份 realBoundaryCheck）：解析不出真实路径
// 一律按保守口径拒绝，宁可不派发，也不能把文件写到仓库外。
//
// 真实调用方：src/index.js 的 flow_dispatch（派发前复核已登记的 new_files）。
export function checkNewFilesBoundary(root, files) {
  const rootNorm =
    typeof root === 'string'
      ? root.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      : '';
  if (!rootNorm) {
    return {
      ok: false,
      reason:
        '新文件授权复核缺少仓库根上下文（无法判定路径是否落在仓库内），按保守口径拒绝',
    };
  }
  if (!Array.isArray(files) || files.length === 0) return { ok: true };
  const rootKey = pathKey(rootNorm);
  for (const p of files) {
    if (typeof p !== 'string' || !p.trim()) {
      return { ok: false, reason: '新文件授权复核遇到无效路径：' + String(p) };
    }
    const rel = normalizeRelPath(p);
    if (!rel || isAbsoluteLikePath(rel) || escapesRootPath(rel)) {
      return {
        ok: false,
        reason: '新文件授权路径必须是仓库内相对路径：' + p,
      };
    }
    const resolved = resolveRelUnderRoot(rootNorm, rel);
    const key = pathKey(resolved);
    if (!(key === rootKey || key.startsWith(rootPrefix(rootKey)))) {
      return {
        ok: false,
        reason: '新文件授权路径越出仓库（必须是仓库内相对路径）：' + p,
      };
    }
    const boundary = realBoundaryCheck(rootNorm, resolved);
    if (!boundary.ok) return { ok: false, reason: boundary.reason };
  }
  return { ok: true };
}

// 用户原话定位：与 quote 锚点**同一口径**（归一化空白后做子串匹配）。
function normalizeAnchor(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function anchoredInUserWords(reason, userMessages) {
  const target = normalizeAnchor(reason);
  if (!target) return false;
  const msgs = Array.isArray(userMessages) ? userMessages : [];
  for (const m of msgs) {
    if (normalizeAnchor(m).indexOf(target) !== -1) return true;
  }
  return false;
}

// new_files 授权：前置条件（确认 / 仓库根 / scope / 授权说明 / 数组形状）。
//
// 拆出来是为了让主流程 validateNewFiles 只剩「逐项路径规则 + 锚定」两件事。
// 返回 { ok:true, ctx } 或 { ok:false, reason, findings }。
function newFilesPreconditions(raw, scope, root, opts) {
  const findings = [];
  const reject = (reason, detail) => {
    if (detail) findings.push(detail);
    return { ok: false, reason: reason, findings: findings };
  };

  // ① 用户确认：不能只靠自述 confirmed —— 还必须有能在用户原话中定位的授权说明。
  if (opts.confirmed !== undefined && opts.confirmed !== true) {
    return reject(
      '新文件授权需要用户明确确认 confirmed=true',
      '新文件授权未获用户确认',
    );
  }

  // ② 仓库根是**硬上下文**：缺了就无法判定「是否落在仓库内」→ 保守拒绝。
  const rootRaw = typeof root === 'string' ? root.trim() : '';
  if (!rootRaw) {
    return reject(
      '新文件授权校验缺少仓库根上下文（无法判定路径是否落在仓库内），按保守口径拒绝',
      '缺少仓库根上下文',
    );
  }
  const rootNorm = rootRaw.replace(/\\/g, '/').replace(/\/+$/, '');
  const rootKey = pathKey(rootNorm);

  // ③ 空 scope = fail-closed：不允许在「什么都不许改」的卡上开新文件的口子。
  const scopeArr = Array.isArray(scope) ? scope : [];
  if (scopeArr.length === 0) {
    return reject(
      'scope 为空时不允许授权新文件（空 scope 按 fail-closed 处理）',
      '空 scope 不能授权新文件',
    );
  }

  // ④ 授权说明必须非空。
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (!reason) {
    return reject(
      '新文件授权必须提供非空授权说明 newFilesReason',
      '新文件授权缺少授权说明',
    );
  }

  // ⑤ 数组本身必须是非空路径数组。
  if (!Array.isArray(raw) || raw.length === 0) {
    return reject(
      '新文件授权必须是非空路径数组（newFiles）',
      'newFiles 必须是非空路径数组',
    );
  }

  const scopeKeys = new Set();
  for (const p of scopeArr) {
    if (typeof p !== 'string' || !p.trim()) continue;
    scopeKeys.add(pathKey(resolveRelUnderRoot(rootNorm, normalizeRelPath(p))));
  }

  return {
    ok: true,
    ctx: {
      rootNorm: rootNorm,
      rootKey: rootKey,
      scopeKeys: scopeKeys,
      reason: reason,
      findings: findings,
    },
  };
}

// 单个新文件路径的规则判定（词法越界 / 重复 / 真实路径边界 / 磁盘状态）。
// 返回 null = 通过；否则返回 { reason, detail }。
function checkNewFileEntry(p, ctx, opts) {
  const reject = (reason, detail) => ({ reason: reason, detail: detail });

  if (typeof p !== 'string' || !p.trim()) {
    return reject('新文件授权包含无效路径', '新文件授权包含无效路径');
  }
  const rel = normalizeRelPath(p);
  if (!rel) {
    return reject('新文件授权包含无效路径', '新文件授权包含无效路径');
  }
  if (isAbsoluteLikePath(rel)) {
    return reject(
      '新文件授权路径必须是仓库内相对路径：' + p,
      '新文件授权路径必须是仓库内相对路径：' + p,
    );
  }
  if (escapesRootPath(rel)) {
    return reject(
      '新文件授权路径越出仓库：' + p,
      '新文件授权路径越出仓库：' + p,
    );
  }
  const resolved = resolveRelUnderRoot(ctx.rootNorm, rel);
  const key = pathKey(resolved);
  if (!(key === ctx.rootKey || key.startsWith(rootPrefix(ctx.rootKey)))) {
    return reject(
      '新文件授权路径越出仓库（必须是仓库内相对路径）：' + p,
      '新文件授权路径越出仓库：' + p,
    );
  }
  if (ctx.scopeKeys.has(key)) {
    return reject(
      '新文件授权路径与 scope 重复：' + p,
      '新文件授权路径与 scope 重复：' + p,
    );
  }

  // 真实路径边界：父目录是符号链接 / junction 且指向仓库外时必须拒绝。
  // 只做词法比较不够 —— 「<root>/link/new.txt」里的 link 可能是仓库外的目录。
  const boundary = realBoundaryCheck(ctx.rootNorm, resolved);
  if (!boundary.ok) {
    return reject(boundary.reason, boundary.reason);
  }

  // 磁盘状态只在**落卡时**检查：卡片层复核时文件可能已被执行者创建。
  if (opts.existence !== false) {
    // 用 lstat（**不跟随链接**）：目标本身是符号链接时也算「已存在」——
    // 跟过去写会把内容写到链接指向的地方（仓库外）。
    let st = null;
    let exists = false;
    try {
      st = fs.lstatSync(resolved);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      if (st && st.isSymbolicLink()) {
        return reject(
          '新文件授权路径已存在且是符号链接（拒绝经链接写到别处）：' + p,
          '新文件授权路径已存在且是符号链接：' + p,
        );
      }
      if (st && st.isDirectory()) {
        return reject(
          '新文件授权路径已存在且是目录（目录请放入 scope）：' + p,
          '新文件授权路径已存在且是目录：' + p,
        );
      }
      return reject(
        '新文件授权路径已存在（已存在文件请放入 scope）：' + p,
        '新文件授权路径已存在：' + p,
      );
    }
    const slash = resolved.lastIndexOf('/');
    const parent = slash > 0 ? resolved.slice(0, slash) : ctx.rootNorm;
    let parentOk = false;
    try {
      parentOk = fs.statSync(parent).isDirectory();
    } catch {
      parentOk = false;
    }
    if (!parentOk) {
      return reject(
        '新文件授权路径的父目录不存在（本轮只授权文件，不授权新建目录）：' + p,
        '新文件授权路径的父目录不存在：' + p,
      );
    }
  }
  return null;
}

// new_files 授权校验（卡片层与提交层共用的唯一实现）。
//
// raw    ：待授权的新文件路径数组（仓库根相对路径）
// scope  ：既有 scope（用于重复判定 + 空 scope fail-closed）
// root   ：仓库根（**必填**：缺了就无法判定路径是否落在仓库内 → 保守拒绝）
// options：
//   confirmed   —— 用户确认；给了就必须为 true
//   reason      —— 授权说明（必填非空）
//   userMessages—— 用户原话数据源（授权说明必须能在其中定位）
//   anchor      —— 是否强制「授权说明可在用户原话中定位」（默认 true）
//   existence   —— 是否检查磁盘状态（已存在/父目录不存在）；默认 true
//
// 返回：{ ok, files, findings, reason }
export function validateNewFiles(raw, scope, root, options) {
  const opts = options || {};
  const pre = newFilesPreconditions(raw, scope, root, opts);
  if (!pre.ok) {
    return { ok: false, reason: pre.reason, findings: pre.findings, files: [] };
  }
  const ctx = pre.ctx;
  const findings = ctx.findings;

  // 逐项路径规则。
  const seen = new Set();
  const files = [];
  for (const p of raw) {
    const bad = checkNewFileEntry(p, ctx, opts);
    if (bad) {
      findings.push(bad.detail);
      return { ok: false, reason: bad.reason, findings: findings, files: [] };
    }
    const rel = normalizeRelPath(p);
    // 同一份授权列表里出现**同一个路径**（写法不同也算同一个）：
    // './a.txt' 与 'a.txt'、'a/b.txt' 与 'a\\b.txt' 归一化后是同一条授权。
    // 重复授权会让「授权了几条」「快照覆盖了哪些文件」两处口径对不上，
    // 事后无法回答「这条文件到底被哪一条授权覆盖」—— 因此直接拒绝。
    // 判定用平台感知的路径键（pathKey）：win32 上大小写不同算同一个，
    // POSIX 上大小写不同是**两个不同文件**，不算重复。
    const key = pathKey(resolveRelUnderRoot(ctx.rootNorm, rel));
    if (seen.has(key)) {
      const detail = '新文件授权里有重复路径：' + p;
      findings.push(detail);
      return { ok: false, reason: detail, findings: findings, files: [] };
    }
    seen.add(key);
    files.push(rel);
  }

  // 授权说明必须能在用户原话中定位（与 quote 同级锚定）。
  // 自述 confirmed 不算数：说明必须真的出现在用户说过的话里。
  if (opts.anchor !== false && !anchoredInUserWords(ctx.reason, opts.userMessages)) {
    findings.push('新文件授权说明未在用户原话中定位');
    return {
      ok: false,
      reason: '新文件授权说明无法在用户原话中定位（与 quote 同级锚定），拒绝派发',
      findings: findings,
      files: [],
    };
  }

  return { ok: true, files: files, findings: findings, reason: ctx.reason };
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
  if (Array.isArray(out.new_files)) {
    out.new_files = out.new_files.map((v) => (typeof v === 'string' ? stripBoundaryTags(v) : v));
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
    // 拒绝「整个目录」作为改动范围：scope=["."] 等价于授权修改整个 cwd，
    // 会把合同边界放大到仓库全量；而 enforceScope(".") 又会把任意改动判越界。
    // 这里直接拒绝 "." / ".." 及其路径形式。
    const normPath = p.trim().replace(/\\/g, '/').replace(/\/+$/, '') || p.trim();
    if (normPath === '.' || normPath === '..' || normPath.endsWith('/.') || normPath.endsWith('/..')) {
      findings.push('scope 不能包含整个目录（"." / ".."）—— 必须精确到文件');
      return { ok: false, reason: 'scope 中有指向整个目录的路径，拒绝派发（合同边界 veto）', findings, tier };
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

  // ---- new_files：获授权可新建的文件（派发时尚不存在）----
  //
  // 与 scope 严格分离，**不放宽** scope 的既有语义：
  //   · scope 里的路径必须**已经存在**（上面的存在性校验一字未改）；
  //   · new_files 里的路径**本来就不该存在**，它表达的是「这次允许新建哪些文件」。
  //
  // 规则本体只有一份（validateNewFiles），卡片层与提交层都调用它 ——
  // 两份副本必然漂移（改一处漏一处）。
  const newFilesRaw = card ? card.new_files : undefined;
  if (newFilesRaw !== undefined && newFilesRaw !== null) {
    if (!Array.isArray(newFilesRaw)) {
      findings.push('new_files 必须是文件路径数组');
      return { ok: false, reason: 'new_files 必须是文件路径数组', findings, tier };
    }
    if (newFilesRaw.length > 0) {
      // 卡片层校验**不依赖可选参数**：缺仓库根等上下文时按保守口径拒绝
      //（否则无法判定「是否落在仓库内」，等于默默放宽了范围）。
      const repoRoot = typeof opts.repoRoot === 'string' ? opts.repoRoot.trim() : '';
      if (!repoRoot) {
        findings.push('卡片含 new_files 但校验缺少仓库根上下文（按保守口径拒绝）');
        return {
          ok: false,
          reason: '卡片含 new_files 但校验缺少仓库根上下文，拒绝派发（范围 veto）',
          findings: findings,
          tier: tier,
        };
      }
      const checked = validateNewFiles(newFilesRaw, scope, repoRoot, {
        reason: typeof card.new_files_reason === 'string' ? card.new_files_reason : '',
        // 锚点在校验入口（提交/追加）已强制：说明必须能在用户原话中定位。
        anchor: false,
        // 卡片层复核不查磁盘状态：文件可能已被执行者创建（那不是卡片的问题）。
        existence: false,
      });
      if (!checked.ok) {
        for (const f of checked.findings) findings.push(f);
        return { ok: false, reason: checked.reason, findings: findings, tier: tier };
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

  // 文本类数组字段：元素必须是可读文本。
  // 这些字段「长度>0」不等于「已填」——acceptance=[""] / [null] / [0] / [{}]
  // 都是「长度>0 但内容无效」的伪填充，必须判为「未填」。
  const TEXT_ARRAY_FIELDS = new Set(['acceptance', 'unknowns', 'assumptions', 'scope']);

  const required = {
    read_only: ['goal', 'quote'],
    single_file: ['goal', 'quote', 'scope'],
    cross_module: ['goal', 'quote', 'scope', 'acceptance', 'files'],
    sensitive: ['goal', 'quote', 'scope', 'acceptance'],
  }[tier] || ['goal', 'quote'];
  for (const f of required) {
    const v = card ? card[f] : undefined;
    let missing;
    if (v === undefined || v === null) {
      missing = true;
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        missing = true;
      } else if (TEXT_ARRAY_FIELDS.has(f)) {
        // 文本类数组：**每一个**元素都必须是有效的非空字符串才算「已填」。
        // 严格口径（every 而非 some）：验收标准里混入 null / 数字 / 空串是笔误，
        // 只会污染落盘的卡片并原样进入 executor 的合同文本 —— 应该报错让作者改，
        // 而不是「有一条真条目就算填了」。
        missing = !v.every((x) => typeof x === 'string' && x.trim() !== '');
      } else {
        // 其他数组（如 files）：元素结构另有校验，这里只看长度。
        missing = false;
      }
    } else if (typeof v === 'string') {
      missing = v.trim() === '';
    } else {
      missing = false;
    }
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

/**
 * 自动探测项目技术栈对应的验证命令 (Auto-Verify)
 * 扫描指定目录（默认 cwd 或 git root），返回最适宜的测试命令字符串，无法探测时返回 null
 */
export function detectProjectTestCommand(targetCwd = null) {
  const root = targetCwd || process.cwd();
  try {
    // 1. Node.js 生态检测 (package.json)
    const pkgPath = join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const scripts = pkg.scripts || {};
        if (scripts.test && !scripts.test.includes('no test specified')) {
          return 'npm test';
        }
        if (scripts['test:all']) return 'npm run test:all';
        if (scripts['test:e2e']) return 'npm run test:e2e';
        if (scripts.jest) return 'npx jest';
        if (scripts.vitest) return 'npx vitest run';
      } catch { /* 忽略解析错误 */ }
    }

    // 2. Python 生态检测
    if (fs.existsSync(join(root, 'pytest.ini')) || fs.existsSync(join(root, 'setup.cfg')) || fs.existsSync(join(root, 'pyproject.toml')) || fs.existsSync(join(root, 'tests'))) {
      return 'pytest';
    }

    // 3. Rust 生态检测
    if (fs.existsSync(join(root, 'Cargo.toml'))) {
      return 'cargo test';
    }

    // 4. Go 生态检测
    if (fs.existsSync(join(root, 'go.mod'))) {
      return 'go test ./...';
    }
  } catch {
    return null;
  }

  return null;
}

