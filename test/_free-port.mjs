// 测试专用：拿一个「此刻确定空闲」的本地端口。
//
// 为什么需要（2026-11-17 实测的污染事故）：
//   旧写法是 `19100 + (process.pid % 400)` —— 400 个槽位、几百次运行，
//   必然撞上**上一个测试残留的 bridge**。撞上之后请求会被那个旧 bridge 接走，
//   它的 CARLOS_FLOW_HOME 是旧的（甚至是真实的 ~/.carlos-flow），
//   于是测试自己全绿，脏数据却写进了真实状态目录：
//     实测 840 个会话目录里 587 个是测试残留，其中 330 个的 env.project
//     直接指向开发仓库，今天 928 条审计事件里 723 条（78%）是测试噪音。
//
// 现在的做法：绑 0 号端口让操作系统分配（保证不与任何现存监听冲突），
// 读到端口号后立刻关闭，把这个号交给 bridge 用。
// 仍然存在极小的「关掉到 bridge 绑定之间被别人抢走」的窗口，
// 因此调用方还应校验 /health 里的 flow_home（见 assertBridgeIdentity）。
import { createServer } from "node:net";
import { createConnection } from "node:net";

/** 取一个当前空闲的 TCP 端口号 */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 读 bridge 的 /health（失败返回 null） */
export function readBridgeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const s = createConnection(port, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => { try { s.destroy(); } catch {} finish(null); }, timeoutMs);
    s.on("connect", () => s.write("GET /health\n"));
    s.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\n").find((x) => x.trim().startsWith("{"));
      if (line) {
        clearTimeout(timer);
        try { s.end(); } catch {}
        let j = null;
        try { j = JSON.parse(line); } catch {}
        finish(j);
      }
    });
    s.on("error", () => { clearTimeout(timer); finish(null); });
  });
}

/**
 * 确认端口上的 bridge 就是**本次测试**启动的那一个。
 *
 * 判据是 flow_home 一致：不同 flow_home 等价于「别人的 bridge」，
 * 一旦复用就会把状态写到别人的目录里（这正是污染事故的成因）。
 * 返回 { ok, health, reason }。
 */
export async function assertBridgeIdentity(port, expectFlowHome, retries = 40) {
  for (let i = 0; i < retries; i++) {
    const h = await readBridgeHealth(port);
    if (h && h.status === "ok") {
      const same = String(h.flow_home || "") === String(expectFlowHome || "");
      return {
        ok: same,
        health: h,
        reason: same
          ? "身份一致"
          : `端口 ${port} 上的 bridge 属于另一个 FLOW_HOME（${h.flow_home || "(空)"}），本次期望 ${expectFlowHome}`,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, health: null, reason: `端口 ${port} 上没有任何 bridge 响应 /health` };
}
