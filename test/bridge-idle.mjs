// Bridge 空闲退出 + pid 工牌自回收 —— 回归测试
//
// 背景（2026-11-17 实测）：
//   ghost.json 一直声明着 `"idleTimeoutSeconds": 300` 与 `"lifecycle": "on-demand"`，
//   但 bridge 里从来没有任何空闲退出实现。结果是机器上常驻 14 个进程、
//   私有内存 430MB，仓库里还堆着 40 个 bridge-*.pid（36 个指向已死进程）。
//
// 本测试固化三件事：
//   1. 空闲超过阈值 → bridge 自己退出（不留常驻）
//   2. 有客户端连着时 → 不算空闲，不许退出（不能误杀在用实例）
//   3. 退出时清理自己的 pid 文件（工牌不能留在仓库里）
//
// 跑法：node test/bridge-idle.mjs
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickFreePort, assertBridgeIdentity } from "./_free-port.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BRIDGE = join(ROOT, "bridge", "mcp-bridge.js");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个 bridge，返回 { proc, port, home, pidFile } */
async function startBridge(idleMs) {
  const home = mkdtempSync(join(tmpdir(), "carlos-idle-home-"));
  const port = await pickFreePort();
  const proc = spawn(process.execPath, [BRIDGE, String(port)], {
    env: {
      ...process.env,
      CARLOS_FLOW_HOME: home,
      CARLOS_BRIDGE_TOKEN: "idle-test-token",
      CARLOS_BRIDGE_IDLE_MS: String(idleMs),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  proc.stderr.on("data", () => {}); // 丢弃，避免管道写满阻塞
  const pidFile = join(ROOT, `bridge-${port}.pid`);
  // 客户端才会写 pid 文件；这里手动写一份，模拟「客户端起过 bridge」
  const { writeFileSync } = await import("node:fs");
  try { writeFileSync(pidFile, String(proc.pid), "utf8"); } catch {}
  const id = await assertBridgeIdentity(port, home);
  return { proc, port, home, pidFile, ready: id.ok, reason: id.reason };
}

const alive = (proc) => proc.exitCode === null && proc.signalCode === null;

async function case1_idleExit() {
  // 空闲阈值 1200ms，无人连接 → 应自行退出
  const b = await startBridge(1200);
  check("样例 bridge 已就绪", b.ready, b.reason);
  const t0 = Date.now();
  for (let i = 0; i < 80 && alive(b.proc); i++) await sleep(100);
  const elapsed = Date.now() - t0;
  check("1. 空闲超过阈值后 bridge 自行退出", !alive(b.proc), `存活 ${elapsed}ms`);
  await sleep(300);
  check("2. 退出时清理自己的 pid 工牌", !existsSync(b.pidFile), b.pidFile.split(/[\\/]/).pop());
  try { rmSync(b.home, { recursive: true, force: true }); } catch {}
}

async function case2_busyNotIdle() {
  // 空闲阈值 800ms，但保持一条连接 → 不该退出
  const b = await startBridge(800);
  check("样例 bridge 已就绪（占用场景）", b.ready, b.reason);
  const sock = createConnection(b.port, "127.0.0.1");
  await new Promise((r) => { sock.on("connect", r); sock.on("error", r); });
  await sleep(2200); // 远超阈值
  check("3. 有客户端连着时不算空闲（不误杀在用实例）", alive(b.proc), "存活");
  try { sock.destroy(); } catch {}
  // 断开之后应该很快退出
  for (let i = 0; i < 60 && alive(b.proc); i++) await sleep(100);
  check("4. 连接断开后恢复空闲并退出", !alive(b.proc), "");
  try { rmSync(b.home, { recursive: true, force: true }); } catch {}
}

async function case3_disabledByEnv() {
  // CARLOS_BRIDGE_IDLE_MS=0 → 关闭空闲退出（常驻场景）
  const b = await startBridge(0);
  check("样例 bridge 已就绪（常驻场景）", b.ready, b.reason);
  await sleep(1500);
  check("5. CARLOS_BRIDGE_IDLE_MS=0 时不许自动退出", alive(b.proc), "仍存活（符合预期）");
  try { process.kill(b.proc.pid, "SIGTERM"); } catch {}
  await sleep(400);
  try { rmSync(b.home, { recursive: true, force: true }); } catch {}
}

// 启动时清理僵尸工牌 + /health 可观测字段
//
// 只删 pid 已死的工牌：活着的一律不动（pid 可能被复用，误删会掩盖真实端口占用）。
async function case4_pidSweepAndHealth() {
  const { writeFileSync, mkdtempSync: mk } = await import("node:fs");
  const tmpHome = mk(join(tmpdir(), "carlos-sweep-home-"));
  const port = await pickFreePort();
  // 造两个工牌：一个指向必然不存在的 pid（应被清），一个指向当前进程（应保留）
  const deadPort = port + 1;
  const deadFile = join(ROOT, `bridge-${deadPort}.pid`);
  const liveFile = join(ROOT, `bridge-${deadPort + 1}.pid`);
  try { writeFileSync(deadFile, "999999", "utf8"); } catch {}
  try { writeFileSync(liveFile, String(process.pid), "utf8"); } catch {}

  const proc = spawn(process.execPath, [BRIDGE, String(port)], {
    env: {
      ...process.env,
      CARLOS_FLOW_HOME: tmpHome,
      CARLOS_BRIDGE_TOKEN: "sweep-test-token",
      CARLOS_BRIDGE_IDLE_MS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  proc.stderr.on("data", () => {});
  const id = await assertBridgeIdentity(port, tmpHome);
  check("6. 清理场景 bridge 已就绪", id.ok, id.reason);
  await sleep(500);
  check("7. 启动时清掉 pid 已死的僵尸工牌", !existsSync(deadFile), `bridge-${deadPort}.pid`);
  check("8. 指向活进程的工牌不被误删", existsSync(liveFile), `bridge-${deadPort + 1}.pid`);

  // /health 必须暴露空闲策略，便于排查「它为什么退了 / 为什么不退」
  const health = await new Promise((resolve) => {
    const s = createConnection(port, "127.0.0.1");
    let buf = "";
    s.on("connect", () => s.write("GET /health\n"));
    s.on("data", (d) => { buf += d.toString(); });
    s.on("error", () => resolve(null));
    setTimeout(() => { try { s.destroy(); } catch {} resolve(buf); }, 1200);
  });
  let parsed = null;
  try { parsed = JSON.parse(String(health).trim()); } catch {}
  check(
    "9. /health 暴露 idle_ms / idle_for_ms / active_sockets",
    !!parsed && parsed.status === "ok" && typeof parsed.idle_ms === "number" &&
      typeof parsed.idle_for_ms === "number" && typeof parsed.active_sockets === "number",
    parsed ? `idle_ms=${parsed.idle_ms}` : "无响应",
  );

  try { process.kill(proc.pid, "SIGTERM"); } catch {}
  await sleep(400);
  try { unlinkSync(deadFile); } catch {}
  try { unlinkSync(liveFile); } catch {}
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}

console.log("════ Bridge 空闲退出验证 ════\n");
await case1_idleExit();
await case2_busyNotIdle();
await case3_disabledByEnv();
await case4_pidSweepAndHealth();

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail > 0 ? 1 : 0);
