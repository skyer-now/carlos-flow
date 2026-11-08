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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync as rf, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${d}`); }
};

/** 造一个假的「仓库根」：bridge + 完整的 src（server 有多文件依赖，缺一个就起不来） */
function makeFakeRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `carlos-root-${name}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "bridge"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "src"))) {
    writeFileSync(join(dir, "src", f), rf(join(ROOT, "src", f)));
  }
  writeFileSync(join(dir, "bridge", "mcp-bridge.js"), rf(join(ROOT, "bridge", "mcp-bridge.js")));
  // package.json：src/index.js 是 ESM（依赖 package.json 的 "type": "module"）
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-root", version: "1.0.0", type: "module" }, null, 2));
  return dir;
}

console.log("\n════ Bridge 身份隔离验证 ════\n");

// 端口选一个高端口，避免撞上在跑的 19099
const PORT = 19800 + (process.pid % 150);
const TOKEN = "identity-test-token-0123456789abcdef";

const rootA = makeFakeRoot("A");
const rootB = makeFakeRoot("B");
const homeA = mkdtempSync(join(tmpdir(), "carlos-homeA-"));
const homeB = mkdtempSync(join(tmpdir(), "carlos-homeB-"));

/** 起一个 bridge（指定 ROOT 与 HOME） */
function startBridge(root, home, port) {
  return spawn(process.execPath, [join(root, "bridge", "mcp-bridge.js"), String(port)], {
    env: {
      ...process.env,
      CARLOS_BRIDGE_TOKEN: TOKEN,
      CARLOS_FLOW_MCP_ROOT: root,
      CARLOS_FLOW_HOME: home,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
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
const bridgeA = startBridge(rootA, homeA, PORT);
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
  encoding: "utf8",
  timeout: 60000,
});
const outB = out1.stdout || "";
const errB = out1.stderr || "";
check("指向不同 ROOT 的客户端能正常拿到结果（未挂死）",
  out1.status === 0 && outB.includes("ok"),
  `status=${out1.status} stdout=${outB.slice(0, 100)} stderr=${errB.slice(0, 200)}`);
// 关键：请求必须落到 **homeB**（客户端自己的 HOME），而不是 homeA（别人的 bridge）
const homeBHasRun = existsSync(join(homeB, "gate-state"));
const homeAHasRun = existsSync(join(homeA, "gate-state"));
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
  encoding: "utf8",
  timeout: 60000,
});
check("指向相同 ROOT 的客户端可复用同一 bridge",
  out2.status === 0 && (out2.stdout || "").includes("has_card"),
  `status=${out2.status} stdout=${(out2.stdout || "").slice(0, 100)} stderr=${(out2.stderr || "").slice(0, 160)}`);

try { bridgeA.kill(); } catch {}
await sleep(300);
for (const d of [rootA, rootB, homeA, homeB]) {
  try { rmSync(d, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch {}
}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail === 0 ? 0 : 1);