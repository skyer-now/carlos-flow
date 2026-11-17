// 项目级敏感路径扩展（只能追加，不能缩减）—— 回归测试
//
// 需求来源：内置敏感名单（.env / 私钥 / 锁文件 / migrations…）是安全基线，
// 但每个项目的敏感面不同（私有证书目录、对账账本目录…）。允许在仓库根放
// `.carlos.json` 追加规则，但**绝不允许**靠配置把内置基线里的项放出去。
//
// 本测试要钉死的行为：
//   1. 没配置时内置基线原样生效；
//   2. 有配置时新增规则生效，且向上层目录也能找到配置；
//   3. 否定式条目（"!x" / "-x"）被忽略 —— 门禁只许收紧；
//   4. 配置坏掉时退回内置基线（不会因为配置坏了就放宽）；
//   5. 换项目（没有配置）时扩展被清空，不会跨项目污染；
//   6. riskTier 会把新增规则算进 sensitive 档位。
//
// 跑法：node test/sensitive-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-sensitive-home-"));
process.env.CARLOS_FLOW_HOME = HOME;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
};

const {
  isSensitive,
  riskTier,
  loadProjectSensitiveConfig,
  resetSensitiveRules,
  sensitiveRulesSnapshot,
} = await import("../src/protocol.js");

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-sensitive-proj-"));
const DEEP = path.join(PROJ, "src", "feature", "nested");
fs.mkdirSync(DEEP, { recursive: true });
const CONFIG = path.join(PROJ, ".carlos.json");

const writeConfig = (obj) => {
  fs.writeFileSync(CONFIG, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
};

// 1. 无配置：内置基线
resetSensitiveRules();
check("1a. 内置基线：锁文件", isSensitive("package-lock.json"));
check("1b. 内置基线：私钥", isSensitive(".ssh/id_rsa"));
check("1c. 内置基线：扩展名", isSensitive("certs/server.pem"));
check("1d. 内置基线：目录段", isSensitive("migrations/0001_init.sql"));
check("1e. 普通源码不敏感", !isSensitive("src/main.js"));

// 2. 项目配置生效（并从深层目录向上找到仓库根的配置）
writeConfig({
  sensitive: {
    names: ["pay_api_key.txt"],
    segments: ["ledger"],
    extensions: [".vault"],
    prefixes: ["billing/ledger/"],
  },
});
const loaded = loadProjectSensitiveConfig(DEEP);
check("2a. 从深层目录向上找到 .carlos.json", loaded.loaded === true, loaded.file || "");
check("2b. names 规则生效", isSensitive("docs/pay_api_key.txt"));
check("2c. segments 规则生效", isSensitive("ledger/2026.csv"));
check("2d. extensions 规则生效（不带点也能写）", isSensitive("backup/db.vault"));
check("2e. prefixes 规则生效", isSensitive("billing/ledger/2026-01.csv"));
check("2f. prefixes 目录本身也算", isSensitive("billing/ledger"));
check("2g. 前缀之外不误伤", !isSensitive("billing/other.csv"));
check("2h. 新增规则后内置基线仍在", isSensitive(".env") && isSensitive("package.json"));

const snap = sensitiveRulesSnapshot();
check(
  "2i. 快照如实反映扩展（内置基线与扩展分开列）",
  snap.extra.names.includes("pay_api_key.txt") &&
    snap.extra.extensions.includes(".vault") &&
    snap.extra.prefixes.includes("billing/ledger/") &&
    snap.builtin.names > 0,
  `builtin=${snap.builtin.names} extra=${snap.extra.names.length + snap.extra.segments.length}`,
);

// 3. 否定式条目必须被忽略（只许收紧，不许放宽）
writeConfig({
  sensitive: {
    names: ["!package.json", "-.env", "pay_api_key.txt", "!pay_api_key.txt"],
  },
});
loadProjectSensitiveConfig(PROJ);
check("3a. 否定式无法放开内置基线（!package.json）", isSensitive("package.json"));
check("3b. 否定式无法放开内置基线（-.env）", isSensitive(".env"));
check(
  "3c. 否定式无法抵消同一份配置里的新增规则",
  isSensitive("pay_api_key.txt"),
  "「!pay_api_key.txt」被忽略",
);

// 4. 配置坏掉 → 退回内置基线，不抛错、不放宽
writeConfig("{ 这不是合法 JSON ");
const bad = loadProjectSensitiveConfig(PROJ);
check("4a. 坏配置不抛错且标记 loaded=false", bad.loaded === false && typeof bad.error === "string");
check("4b. 坏配置时内置基线仍生效", isSensitive(".env") && isSensitive(".ssh/id_rsa"));
check("4c. 坏配置时不残留上一份配置的扩展", !isSensitive("pay_api_key.txt"));

// 5. 换项目：没有配置时扩展被清空（不跨项目污染）
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), "carlos-sensitive-other-"));
writeConfig({
  sensitive: { names: ["pay_api_key.txt"] },
});
loadProjectSensitiveConfig(PROJ);
check("5a. 项目 A 里扩展生效", isSensitive("pay_api_key.txt"));
fs.rmSync(CONFIG, { force: true });
loadProjectSensitiveConfig(PROJ);
check("5b. 项目 A 删掉配置后扩展清空", !isSensitive("pay_api_key.txt"));
writeConfig({ sensitive: { names: ["pay_api_key.txt"] } });
loadProjectSensitiveConfig(PROJ);
loadProjectSensitiveConfig(OTHER);
check("5c. 切到没有配置的项目 B 后不残留项目 A 的规则", !isSensitive("pay_api_key.txt"));

// 6. riskTier 把新增规则算进 sensitive 档
loadProjectSensitiveConfig(PROJ);
check(
  "6a. 命中扩展规则时 riskTier=sensitive",
  riskTier(["pay_api_key.txt"]) === "sensitive",
  riskTier(["pay_api_key.txt"]),
);
check("6b. 普通文件仍是单文件档", riskTier(["src/main.js"]) === "single_file");

// 收尾
try { fs.rmSync(PROJ, { recursive: true, force: true }); } catch {}
try { fs.rmSync(OTHER, { recursive: true, force: true }); } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(`\n════ 结果: ${pass} 通过 / ${fail} 失败 ════`);
if (fail > 0) process.exit(1);
console.log("SENSITIVE_CONFIG_OK");
