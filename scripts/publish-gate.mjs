// 发布闸 —— 判断「本次 tag 版本是否值得发到 npm」
//
// 为什么单独抽成脚本：
//   1. 原实现把 semver 比较的**退出码方向写反了**，导致「版本更高」被拦截、
//      「版本更低」被放行，与发布闸的本意完全相反（补历史 tag 会把 latest 拉回旧版，
//      正是这道闸要防的事）。抽成脚本后可以写单元测试锁住方向。
//   2. 判定逻辑必须能离线测试，不能只能在 CI 里用真实 npm registry 验证。
//
// 判定规则（唯一真源，workflow 只调用本脚本）：
//   registry 没有任何已发布版本            → 允许发布
//   本次版本 严格大于 registry 的 latest    → 允许发布
//   否则（等于或小于）                     → 跳过 npm publish，只建 GitHub Release
//
// 用法：
//   node scripts/publish-gate.mjs                  # 读 package.json 版本 + 查 npm
//   node scripts/publish-gate.mjs --version 2.11.2 --latest 2.11.0
//   node scripts/publish-gate.mjs --count 12
//
// 输出：向 $GITHUB_OUTPUT 写 publish=true/false（若有该环境变量），并打印人话结论。
//
// ===== 发布暂停开关 =====
//   RELEASE_PAUSED=1  → 停止所有 npm publish（仅建 GitHub Release）
//   RELEASE_PAUSED=0  → 恢复正常发布（由 deploy 方决定是否启用）
//   本机操作时默认开闸，仅 CI 触发推送时带开关才生效

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 语义化版本比较：a > b 返回正数，a < b 返回负数，相等返回 0 */
export function semverCompare(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 纯函数：给定版本与 registry 现状，返回是否允许发布 */
export function decidePublish({ version, latest, count }) {
  if (!latest || !count || count <= 1) {
    return { publish: true, reason: "registry 暂无已发布版本 —— 允许发布" };
  }
  if (version === latest) {
    return {
      publish: false,
      reason: `本次版本 ${version} 等于已发布最新版 ${latest} —— 跳过 npm publish（仅建 Release）`,
    };
  }
  if (semverCompare(version, latest) > 0) {
    return {
      publish: true,
      reason: `本次版本 ${version} 高于已发布最新版 ${latest} —— 允许发布`,
    };
  }
  return {
    publish: false,
    reason: `本次版本 ${version} 不高于已发布最新版 ${latest} —— 跳过 npm publish（仅建 Release）`,
  };
}

/** 发布暂停指令：RELEASE_PAUSED 为非空非 0 时禁止 npm publish */
export function releasePaused() {
  const v = String(process.env.RELEASE_PAUSED || "").trim().toLowerCase();
  if (!v || v === "0" || v === "false") return false;
  return true;
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {
    return "";
  }
}

function npmQuery(args) {
  try {
    // Windows 上 npm 是 npm.cmd，必须走 shell 才能执行；
    // 这里查询的全是固定的包名/字段名，不含用户输入，无注入风险。
    return execFileSync("npm", args, {
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function main() {
  const version = argOf("--version") || pkgVersion();
  const latest = argOf("--latest") ?? npmQuery(["view", "carlos-flow", "dist-tags.latest", "--prefer-online"]);
  const countRaw = argOf("--count") ?? npmQuery(["view", "carlos-flow", "versions", "--json", "--prefer-online"]);
  let count = Number(countRaw) || 0;
  if (!count && countRaw) {
    try {
      count = JSON.parse(countRaw).length;
    } catch {
      count = 0;
    }
  }

  if (releasePaused()) {
    const reason = "RELEASE_PAUSED 已设置 → 停止所有 npm publish（仅建 Release）";
    console.log(`本次版本：${version} ｜ registry latest：${latest || "(无)"} ｜ 已发布版本数：${count}`);
    console.log(reason);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "publish=false\n");
    console.log("publish=false");
    return;
  }

  const { publish, reason } = decidePublish({
    version,
    latest: latest || "",
    count,
  });

  console.log(`本次版本：${version} ｜ registry latest：${latest || "(无)"} ｜ 已发布版本数：${count}`);
  console.log(`${publish ? "✓" : "✗"} ${reason}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  }
  console.log(`publish=${publish}`);
}

// 仅在「直接运行本文件」时执行 main()；被 import 时只导出纯函数供测试使用。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
