// Bridge 身份隔离验证 —— 端口上是「别的 bridge」时不得复用
//
// 背景：2026-11-07 的第三方审查指出 client 的 isBridgeRunning 只判
// 「端口活着且 /health 回 ok」→ 端口上若是**另一个 ROOT / 另一个 HOME** 的
// bridge，会被静默复用，导致：
//   · 调用方传入的 CARLOS_FLOW_HOME 完全失效（状态写到别人的目录）
//   · 协议不匹配导致挂死
//
// 这个脚本用**两个真实的 bridge** 验证：
//   1) 端口上是 ROOT_A 的 bridge，客户端指向 ROOT_B → 必须不复用（另起一个）
//   2) 端口上是 ROOT_A 的 bridge，客户端也指向 ROOT_A → 允许复用
//
// 跑法：node test/bridge-identity.mjs
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync as rf, readdirSync, existsSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${redact(d)}`); }
};
const redact = value => String(value).replace(/identity-test-token-[a-f0-9]+/gi, '[TOKEN]').replace(/(Bearer\s+)\S+/gi, '$1[TOKEN]');
const diagnostics = [];
const evidenceDir = process.env.CARLOS_BRIDGE_TEST_EVIDENCE_DIR;
let diagnosticSecondary = null;
const BYTE_LIMIT = 65536;
function boundedText(value) {
  let bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > BYTE_LIMIT) bytes = bytes.subarray(-BYTE_LIMIT);
  while (bytes.length && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
  return bytes.toString('utf8');
}
function secondaryFailure(stage, error) {
  if (diagnosticSecondary) return;
  diagnosticSecondary = { stage, code: boundedText(redact(error && (error.code || error.name) || 'UNKNOWN')).slice(0, 80) };
  try { console.error('诊断基础设施异常（secondary，不覆盖主结果）', diagnosticSecondary.stage, diagnosticSecondary.code); } catch {}
}
function scrub(value, depth = 0) {
  if (depth > 8) throw new TypeError('diagnostic schema depth');
  if (typeof value === 'string') return boundedText(redact(value));
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 32).map(v => scrub(v, depth + 1));
  if (typeof value !== 'object') throw new TypeError('diagnostic schema type');
  const result = {};
  for (const key of Object.keys(value).slice(0, 32)) result[key] = scrub(value[key], depth + 1);
  return result;
}
function retain(name, data) {
  let serialized;
  try {
    const row = scrub({ name, ...data });
    JSON.stringify(row);
    diagnostics.push(row);
    if (diagnostics.length > 32) diagnostics.shift();
    serialized = JSON.stringify(diagnostics, null, 2);
  } catch (e) { secondaryFailure('serialize', e); return; }
  if (evidenceDir && !diagnosticSecondary) {
    try { mkdirSync(evidenceDir, { recursive: true }); writeFileSync(join(evidenceDir, 'bridge-identity-diagnostics.json'), serialized); }
    catch (e) { secondaryFailure('persist', e); }
  }
}
function appendOutput(owned, key, chunk) {
  owned.raw[key] = Buffer.concat([owned.raw[key], Buffer.from(chunk)]).subarray(-BYTE_LIMIT);
  owned[key] = boundedText(redact(owned.raw[key].toString('utf8')));
}

/** 造一个假的「仓库根」：bridge + 完整的 src（server 有多文件依赖，缺一个就起不来） */
function makeFakeRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `carlos-root-${name}-`));
  ownedDirectories.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "bridge"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "src"))) {
    writeFileSync(join(dir, "src", f), rf(join(ROOT, "src", f)));
  }
  mkdirSync(join(dir, 'ui'), { recursive: true });
  const narrator = rf(join(ROOT, 'ui', 'narrator.js'));
  writeFileSync(join(dir, 'ui', 'narrator.js'), narrator);
  check(`fixture ${name} 必需narrator与真实源码SHA一致`, createHash('sha256').update(rf(join(dir, 'ui', 'narrator.js'))).digest('hex') === createHash('sha256').update(narrator).digest('hex'));
  writeFileSync(join(dir, "bridge", "mcp-bridge.js"), rf(join(ROOT, "bridge", "mcp-bridge.js")));
  // package.json：src/index.js 是 ESM（依赖 package.json 的 "type": "module"）
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-root", version: "1.0.0", type: "module" }, null, 2));
  // node_modules：MCP server 依赖 @modelcontextprotocol/sdk。
  //
  // 为什么必须显式带过去：Node 解析依赖是**从脚本所在目录一路向上找 node_modules**。
  // 假根目录在系统临时目录下（Windows: %TEMP%；Linux: /tmp），向上再也找不到
  // 仓库的 node_modules → `import { Server } from "@modelcontextprotocol/sdk/..."`
  // 直接解析失败 → MCP server 起不来 → bridge 不响应 → 客户端挂死到超时。
  //
  // 本地能过是**假象**：开发机用户目录下恰好有一份 node_modules（向上回溯命中），
  // CI 的纯净环境没有 → 只在 CI 红。这类「本地绿、CI 红」的根因必须消除。
  //
  // 用链接而不是复制：SDK 体积大，复制会拖慢每次测试；Windows 用 junction
  // （不需要管理员权限），POSIX 用目录软链。
  const nmSrc = join(ROOT, "node_modules");
  if (existsSync(nmSrc)) {
    try {
      symlinkSync(nmSrc, join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // 链接失败（权限/文件系统不支持）时退化为复制，保证测试仍能跑
      try { cpSync(nmSrc, join(dir, "node_modules"), { recursive: true }); } catch {}
    }
  }
  return dir;
}

console.log("\n════ Bridge 身份隔离验证 ════\n");

// 端口选一个高端口，避免撞上在跑的 19099
const PORT = 19800 + (process.pid % 150);
const TOKEN = "identity-test-token-0123456789abcdef";

let bridgeA;
let primaryError = null;
const ownedDirectories = [];
try {
const rootA = makeFakeRoot("A");
const rootB = makeFakeRoot("B");
const homeA = mkdtempSync(join(tmpdir(), "carlos-homeA-"));
ownedDirectories.push(homeA);
const homeB = mkdtempSync(join(tmpdir(), "carlos-homeB-"));
ownedDirectories.push(homeB);

/** 起一个 bridge（指定 ROOT 与 HOME） */
function startBridge(root, home, port) {
  const child = spawn(process.execPath, [join(root, "bridge", "mcp-bridge.js"), String(port)], {
    env: {
      ...process.env,
      CARLOS_BRIDGE_TOKEN: TOKEN,
      CARLOS_FLOW_MCP_ROOT: root,
      CARLOS_FLOW_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const creation = Object.freeze({ pid: child.pid, spawnfile: child.spawnfile, spawnargs: [...child.spawnargs], createdNs: process.hrtime.bigint().toString() });
  const owned = { child, creation, closed: false, stdout: '', stderr: '', raw: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } };
  const snapshot = () => retain('direct-bridgeA', { creation, stdout: owned.stdout, stderr: owned.stderr, exitCode: child.exitCode, signalCode: child.signalCode, closed: owned.closed });
  child.stdout.on('data', b => { try { appendOutput(owned, 'stdout', b); snapshot(); } catch (e) { secondaryFailure('stdout-consumer', e); } });
  child.stderr.on('data', b => { try { appendOutput(owned, 'stderr', b); snapshot(); } catch (e) { secondaryFailure('stderr-consumer', e); } });
  child.on('error', e => retain('direct-bridgeA-error', { creation, code: e.code, message: redact(e.message) }));
  child.on('close', () => { owned.closed = true; snapshot(); });
  return owned;
}

const healthOf = (port) => new Promise((res) => {
  const s = createConnection(port, "127.0.0.1");
  let buf = "";
  s.on("connect", () => s.write("GET /health\n"));
  s.on("data", (d) => { buf += d.toString(); s.end(); try { res(JSON.parse(buf.trim())); } catch { res(null); } });
  s.on("error", () => res(null));
  setTimeout(() => { s.destroy(); res(null); }, 3000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 起 ROOT_A 的 bridge ----
bridgeA = startBridge(rootA, homeA, PORT);
await sleep(2000);

const h = await healthOf(PORT);
check("bridge /health 可达", h && h.status === "ok", JSON.stringify(h));
check("/health 回传 root 身份", h && h.root === rootA, `root=${h && h.root}`);
check("/health 回传 flow_home 身份", h && h.flow_home === homeA, `flow_home=${h && h.flow_home}`);

// ---- 用例 1：客户端指向 ROOT_B，端口上是 ROOT_A 的 bridge → 必须不复用 ----
// 用**写操作**（flow_add_user_msg 会落盘）而不是读操作 ——
// 读操作不写盘，根本无法区分状态落到哪个 HOME。
const out1 = spawnSync(process.execPath, [join(ROOT, "client", "carlos.js"), "flow_add_user_msg", JSON.stringify({ sessionId: "probe-b", text: "验证状态落到哪个 HOME" })], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(PORT),
    CARLOS_FLOW_MCP_ROOT: rootB,
    CARLOS_FLOW_HOME: homeB,
    CARLOS_BRIDGE_TOKEN: TOKEN,
  },
  encoding: "utf8", windowsHide: true, maxBuffer: 65536,
  timeout: 60000,
});
const outB = out1.stdout || "";
retain('client-different-root', { status: out1.status, signal: out1.signal, error: out1.error && { code: out1.error.code, message: redact(out1.error.message) }, stdout: outB.slice(-65536), stderr: (out1.stderr || '').slice(-65536) });
const errB = out1.stderr || "";
check("指向不同 ROOT 的客户端能正常拿到结果（未挂死）",
  out1.status === 0 && outB.includes("ok"),
  `status=${out1.status} stdout=${outB.slice(0, 100)} stderr=${errB.slice(0, 200)}`);
// 关键：请求必须落到 **homeB**（客户端自己的 HOME），而不是 homeA（别人的 bridge）
// flow_add_user_msg 会创建 HOME/gate-state/runs/<sessionId>/user_msgs.jsonl
const homeBHasRun = existsSync(join(homeB, "gate-state", "runs", "probe-b"));
const homeAHasRun = existsSync(join(homeA, "gate-state", "runs", "probe-b"));
check("状态写入客户端自己的 HOME（homeB），不是别人的（homeA）",
  homeBHasRun && !homeAHasRun,
  `homeB=${homeBHasRun} homeA=${homeAHasRun}`);

// ---- 用例 2：客户端指向 ROOT_A，端口上也是 ROOT_A 的 bridge → 允许复用 ----
const out2 = spawnSync(process.execPath, [join(ROOT, "client", "carlos.js"), "flow_status", JSON.stringify({ sessionId: "probe-a" })], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(PORT),
    CARLOS_FLOW_MCP_ROOT: rootA,
    CARLOS_FLOW_HOME: homeA,
    CARLOS_BRIDGE_TOKEN: TOKEN,
  },
  encoding: "utf8", windowsHide: true, maxBuffer: 65536,
  timeout: 60000,
});
retain('client-same-root', { status: out2.status, signal: out2.signal, error: out2.error && { code: out2.error.code, message: redact(out2.error.message) }, stdout: (out2.stdout || '').slice(-65536), stderr: (out2.stderr || '').slice(-65536) });
check("指向相同 ROOT 的客户端可复用同一 bridge",
  out2.status === 0 && (out2.stdout || "").includes("has_card"),
  `status=${out2.status} stdout=${(out2.stdout || "").slice(0, 100)} stderr=${(out2.stderr || "").slice(0, 160)}`);

} catch (e) {
  primaryError = { code: boundedText(redact(e && (e.code || e.name) || 'UNKNOWN')).slice(0, 80) };
  try { console.error('主流程异常（primary）', primaryError.code); } catch {}
} finally {
// 只使用创建时持有的child对象/原生handle，不按pid工牌或端口杀陌生进程。
const ownedA = bridgeA;
if (ownedA && !ownedA.closed) {
  let timer;
  const closed = new Promise(resolve => { ownedA.child.once('close', resolve); timer = setTimeout(resolve, 1500); });
  if (ownedA.child.exitCode === null && ownedA.child.signalCode === null && ownedA.child.pid === ownedA.creation.pid && ownedA.child.spawnfile === ownedA.creation.spawnfile && JSON.stringify(ownedA.child.spawnargs) === JSON.stringify(ownedA.creation.spawnargs)) {
    try { ownedA.child.kill(); } catch (e) { secondaryFailure('direct-cleanup', e); }
  }
  await closed;
  clearTimeout(timer);
  if (!ownedA.closed) secondaryFailure('direct-close-timeout', { code: 'CLOSE_UNKNOWN' });
}
// client的detached子孙交测试外preassigned owned Job；保留ignore，避免短命pipe EPIPE。
retain('cleanup-boundary', { directClosed: ownedA && ownedA.closed, primaryError, diagnosticSecondary, delegatedClientDescendants: 'external-owned-job' });
if (!evidenceDir) for (const d of ownedDirectories) {
  try { rmSync(d, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch (e) { secondaryFailure('directory-cleanup', e); }
}
}
console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (!primaryError && !fail && diagnosticSecondary) console.error('结果分类：诊断基础设施失败，不记产品PASS');
process.exit(primaryError || fail ? 1 : diagnosticSecondary ? 2 : 0);