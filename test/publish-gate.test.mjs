// 发布闸单元测试 —— 锁住「版本更高才放行」这个方向
//
// 为什么必须有这个测试：
//   2026-11-13，release.yml 里的 semver 比较把退出码方向写反了 ——
//   「版本更高」走的是「不高于」分支被拦截，「版本更低」反而被放行。
//   当时的检查全是绿的（因为没人测这个方向），结果 v2.11.2 被拦在 npm 之外。
//   这个测试就是那道「方向锁」。
//
// 运行：node test/publish-gate.test.mjs

import assert from "node:assert";
import { decidePublish, semverCompare, releasePaused } from "../scripts/publish-gate.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.error("  ✗ " + name + " —— " + e.message);
    process.exitCode = 1;
  }
}

console.log("▶ 发布闸：语义化版本比较");
check("2.11.2 > 2.11.0", () => assert.ok(semverCompare("2.11.2", "2.11.0") > 0));
check("2.11.0 > 2.10.0", () => assert.ok(semverCompare("2.11.0", "2.10.0") > 0));
check("2.11.0 == 2.11.0", () => assert.strictEqual(semverCompare("2.11.0", "2.11.0"), 0));
check("2.10.0 < 2.11.0", () => assert.ok(semverCompare("2.10.0", "2.11.0") < 0));
check("2.9.0 < 2.10.0", () => assert.ok(semverCompare("2.9.0", "2.10.0") < 0));

console.log("▶ 发布闸：暂停开关");
check("RELEASE_PAUSED=1 → 禁止发布", () => {
  process.env.RELEASE_PAUSED = "1";
  const r = releasePaused();
  assert.strictEqual(r, true);
  delete process.env.RELEASE_PAUSED;
});
check("RELEASE_PAUSED=0 → 允许发布", () => {
  process.env.RELEASE_PAUSED = "0";
  const r = releasePaused();
  assert.strictEqual(r, false);
  delete process.env.RELEASE_PAUSED;
});
check("RELEASE_PAUSED 未设置 → 允许发布", () => {
  delete process.env.RELEASE_PAUSED;
  const r = releasePaused();
  assert.strictEqual(r, false);
});

console.log("▶ 发布闸：放行 / 拦截方向");
check("registry 无版本 → 放行", () => {
  const r = decidePublish({ version: "2.11.2", latest: "", count: 0 });
  assert.strictEqual(r.publish, true);
});
check("版本更高 → 放行（补历史 tag 必须被拦住）", () => {
  const r = decidePublish({ version: "2.11.2", latest: "2.11.0", count: 12 });
  assert.strictEqual(r.publish, true);
});
check("版本等于 latest → 拦截", () => {
  const r = decidePublish({ version: "2.11.0", latest: "2.11.0", count: 12 });
  assert.strictEqual(r.publish, false);
});
check("版本更低（补历史 tag）→ 拦截，防止 latest 被拉回旧版", () => {
  const r = decidePublish({ version: "2.10.0", latest: "2.11.0", count: 12 });
  assert.strictEqual(r.publish, false);
});
check("版本更低但只发布过 1 个版本 → 放行（首发场景）", () => {
  const r = decidePublish({ version: "2.10.0", latest: "2.11.0", count: 1 });
  assert.strictEqual(r.publish, true);
});

console.log(
  process.exitCode ? "\n❌ 发布闸测试失败" : `\n✅ 发布闸测试全部通过（${passed} 条）`,
);
